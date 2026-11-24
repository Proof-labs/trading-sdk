//! Signing, submission and order helpers.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use proof_trading_sdk::gateway::{
    CommittedReceipt, ErrorKind as GatewayErrorKind, MaintenanceMode, PreAdmissionRefusal,
    RetryAfter, SubmissionOutcome, TxHash,
};
use proof_trading_sdk::types::{
    Action, AtomicBasketLeg, MarketConfig, MarketId, OrderEntry, OrderId, PlaceOrder,
    PositionEpoch, Side, TriggerLimb,
};
use proof_trading_sdk::{crypto, sign_action, SignActionError, Signer};
use proof_trading_sdk::{decode_exec_error_kind, DecodedExecErrorKind, ErrorKind};

use crate::actions;
use crate::address::Address;
use crate::error::{Error, Result};
use crate::event::{CancelReason, Event, OrderCancellation, OrderPlacement};
use crate::info::{ClientConfig, InfoClient};
use crate::nonce::NonceAllocator;

/// Signed wire bytes, ready to submit exactly once.
///
/// `hash` is the chain's transaction hash, computed locally, so it is known
/// before the gateway answers. The bytes include the signature and are kept
/// out of `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct SignedTx {
    pub bytes: Vec<u8>,
    pub hash: TxHash,
    pub seq: u64,
}

impl fmt::Debug for SignedTx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignedTx")
            .field("hash", &self.hash)
            .field("seq", &self.seq)
            .field("len", &self.bytes.len())
            .finish()
    }
}

/// Why the engine refused a transaction.
///
/// `Unknown` keeps the number for a code this SDK predates. [`ErrorKind`] grows
/// with the engine; match the kinds you handle and fall through on the rest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EngineError {
    Known(ErrorKind),
    Unknown(u32),
}

impl EngineError {
    /// Classify a nonzero engine `code`. `log` tells a pre-renumbering
    /// open-interest 50 from slippage.
    #[must_use]
    pub fn new(code: u32, log: Option<&str>) -> Self {
        match decode_exec_error_kind(code, log) {
            Some(DecodedExecErrorKind::Known(kind)) => Self::Known(kind),
            Some(DecodedExecErrorKind::SlippageExceeded) => {
                Self::Known(ErrorKind::SlippageExceeded)
            }
            Some(DecodedExecErrorKind::LegacyOpenInterestLimitExceeded) => {
                Self::Known(ErrorKind::OpenInterestLimitExceeded)
            }
            None => Self::Unknown(code),
        }
    }

    /// The engine's numeric code.
    #[must_use]
    pub fn code(self) -> u32 {
        match self {
            Self::Known(kind) => kind.code(),
            Self::Unknown(code) => code,
        }
    }

    /// The order a cancel, amend or replace named no longer rests (filled,
    /// cancelled or never placed).
    #[must_use]
    pub fn is_order_not_found(self) -> bool {
        matches!(
            self,
            Self::Known(ErrorKind::OrderNotFound | ErrorKind::ClientOrderIdNotFound)
        )
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Known(kind) => write!(f, "{} ({})", kind.name(), kind.code()),
            Self::Unknown(code) => write!(f, "engine error {code}"),
        }
    }
}

/// A committed transaction's result: where it landed, whether it worked, and
/// what it did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Receipt {
    pub hash: TxHash,
    /// The block it executed in.
    pub height: u64,
    /// `None` is success.
    pub error: Option<EngineError>,
    /// The engine's log, unchanged.
    pub log: String,
    /// What the transaction did, in emission order: [`Event::OrdersPlaced`],
    /// [`Event::Fill`], [`Event::OrdersCancelled`], ... One transaction can
    /// emit several fills and position updates. `OrdersPlaced` reports every
    /// order of a placement, rested, executed or rejected.
    pub events: Vec<Event>,
}

impl Receipt {
    #[must_use]
    pub fn is_success(&self) -> bool {
        self.error.is_none()
    }

    /// What each order of a `PlaceOrders` did, in the order sent; empty when
    /// the transaction placed none.
    #[must_use]
    pub fn placements(&self) -> &[OrderPlacement] {
        self.events
            .iter()
            .find_map(|e| match e {
                Event::OrdersPlaced(p) => Some(p.orders.as_slice()),
                _ => None,
            })
            .unwrap_or(&[])
    }

    /// What each entry of a `CancelOrders` or `CancelClientOrders` did, in
    /// the order sent; empty when the transaction requested no cancel.
    #[must_use]
    pub fn cancellations(&self) -> &[OrderCancellation] {
        self.events
            .iter()
            .find_map(|e| match e {
                Event::OrdersCancelled(c) if c.reason == CancelReason::UserRequested => {
                    Some(c.orders.as_slice())
                }
                _ => None,
            })
            .unwrap_or(&[])
    }
}

/// The event that reports an order action's results.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListKind {
    Placed,
    Cancelled,
}

/// What an order action sent: the event reporting it and how many orders.
#[derive(Clone, Copy, Debug)]
struct Sent {
    list: ListKind,
    entries: usize,
}

impl Sent {
    const PLACE: Self = Self::list(ListKind::Placed, 1);
    const CANCEL: Self = Self::list(ListKind::Cancelled, 1);

    const fn list(list: ListKind, entries: usize) -> Self {
        Self { list, entries }
    }

    /// What `action` sends, if it is a list action.
    fn of(action: &Action) -> Option<Self> {
        let (list, entries) = match action {
            Action::PlaceOrders(p) => (ListKind::Placed, p.orders.as_slice().len()),
            Action::CancelOrders(c) => (ListKind::Cancelled, c.order_ids.as_slice().len()),
            Action::CancelClientOrders(c) => {
                (ListKind::Cancelled, c.client_order_ids.as_slice().len())
            }
            _ => return None,
        };
        Some(Self::list(list, entries))
    }
}

/// Check an executed code-0 receipt's order results. Every order action is a
/// batch, a single order a batch of one, so a rejected order is reported in
/// [`Receipt::placements`] / [`Receipt::cancellations`] and never fails the
/// transaction.
///
/// An order event that does not parse, or (when `sent` says what was sent) a
/// list with the wrong number of entries, is [`Error::OrderResultUnreadable`]:
/// the transaction executed, so it is never read as success or re-signed.
fn read_order_lists(receipt: Receipt, sent: Option<Sent>) -> Result<Receipt> {
    if receipt.error.is_some() {
        return Ok(receipt);
    }
    let malformed = receipt.events.iter().find_map(|e| match e {
        Event::Malformed(raw) if raw.kind == "orders_placed" || raw.kind == "orders_cancelled" => {
            Some(raw.kind.clone())
        }
        _ => None,
    });
    if let Some(kind) = malformed {
        return Err(unreadable(
            receipt,
            format!("its {kind} event does not parse"),
        ));
    }
    if let Some(sent) = sent {
        let reported = match sent.list {
            ListKind::Placed => receipt.placements().len(),
            ListKind::Cancelled => receipt.cancellations().len(),
        };
        if reported != sent.entries {
            let reason = format!("{} sent, {reported} reported", sent.entries);
            return Err(unreadable(receipt, reason));
        }
    }
    Ok(receipt)
}

fn unreadable(receipt: Receipt, reason: String) -> Error {
    Error::OrderResultUnreadable {
        receipt: Box::new(receipt),
        reason,
    }
}

/// The reduce-only market entry flattening a position held on `side` for
/// `size`.
fn close_entry(market: MarketId, side: Side, size: u64) -> OrderEntry {
    let side = match side {
        Side::Buy => Side::Sell,
        Side::Sell => Side::Buy,
    };
    OrderEntry {
        reduce_only: true,
        ..actions::market_entry(market, side, size, None)
    }
}

/// What [`ExchangeClient::close_position`] did.
#[derive(Clone, Debug, PartialEq, Eq)]
#[must_use]
pub enum CloseOutcome {
    /// The close was sent. [`Submitted::placement`] is its outcome, which can
    /// be rejected (code 12 when unaffordable, 35 when the position went flat
    /// first).
    Sent(Submitted),
    /// The account held no position on the market, so nothing was sent.
    NothingToClose,
}

impl From<CommittedReceipt> for Receipt {
    fn from(r: CommittedReceipt) -> Self {
        Self {
            hash: r.hash,
            height: r.height.get(),
            error: (r.code != 0).then(|| EngineError::new(r.code, Some(&r.log))),
            log: r.log,
            events: r.events.into_iter().map(Event::from).collect(),
        }
    }
}

/// Why the gateway turned a submission away before admitting it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum RefusalReason {
    /// Missing or wrong API key.
    Unauthorized,
    /// Too many requests; see [`Submitted::retry_after`].
    RateLimited,
    /// Trading is paused.
    Paused,
    /// Only cancels are accepted.
    CancelOnly,
    /// The gateway or its verifier is overloaded or unavailable.
    Unavailable,
    /// The request itself was malformed.
    InvalidRequest,
}

impl From<PreAdmissionRefusal> for RefusalReason {
    fn from(r: PreAdmissionRefusal) -> Self {
        match r {
            PreAdmissionRefusal::Unauthorized => Self::Unauthorized,
            PreAdmissionRefusal::RateLimited => Self::RateLimited,
            PreAdmissionRefusal::Maintenance(MaintenanceMode::Paused) => Self::Paused,
            PreAdmissionRefusal::Maintenance(MaintenanceMode::CancelOnly) => Self::CancelOnly,
            PreAdmissionRefusal::Overloaded | PreAdmissionRefusal::VerifierUnavailable => {
                Self::Unavailable
            }
            PreAdmissionRefusal::InvalidRequest | PreAdmissionRefusal::InvalidEncoding => {
                Self::InvalidRequest
            }
        }
    }
}

/// Where one submission ended up. Exhaustive: a trading loop should decide
/// every case.
///
/// Only `Committed` executed. `Rejected` and `Refused` never will. `Pending`
/// may still execute.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TxStatus {
    /// Executed in a block. Check [`Receipt::error`]: `None` is success.
    Committed(Receipt),
    /// Refused at `CheckTx`. It will never execute. `log` is the engine's
    /// reason as text, which can name what the code alone does not; `None`
    /// when the engine gave none.
    Rejected {
        error: EngineError,
        log: Option<String>,
    },
    /// Admitted with no verdict yet. Reconcile with
    /// [`ExchangeClient::wait_for_receipt`]; never re-sign.
    Pending,
    /// Turned away by the gateway before admission. It did not execute.
    Refused(RefusalReason),
}

/// The answer to one submission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Submitted {
    pub tx: SignedTx,
    pub status: TxStatus,
    /// How long the gateway asked callers to wait before the next request,
    /// if it said. An unreadable `Retry-After` reads as one second, never as
    /// "retry now".
    pub retry_after: Option<Duration>,
}

impl Submitted {
    /// Executed in a block with code 0.
    #[must_use]
    pub fn is_success(&self) -> bool {
        matches!(&self.status, TxStatus::Committed(r) if r.is_success())
    }

    /// Admitted, but no verdict yet.
    #[must_use]
    pub fn is_pending(&self) -> bool {
        matches!(self.status, TxStatus::Pending)
    }

    /// Why the engine refused the transaction, at `CheckTx` or in the block.
    #[must_use]
    pub fn error(&self) -> Option<EngineError> {
        match &self.status {
            TxStatus::Committed(r) => r.error,
            TxStatus::Rejected { error, .. } => Some(*error),
            _ => None,
        }
    }

    /// The committed receipt, if the transaction executed.
    #[must_use]
    pub fn receipt(&self) -> Option<&Receipt> {
        match &self.status {
            TxStatus::Committed(r) => Some(r),
            _ => None,
        }
    }

    /// Each order's outcome, in the order sent; `None` without an executed
    /// verdict (pending, or refused as a whole).
    #[must_use]
    pub fn placements(&self) -> Option<&[OrderPlacement]> {
        self.receipt()
            .filter(|r| r.is_success())
            .map(Receipt::placements)
    }

    /// The outcome of a single order call ([`Self::placements`]).
    #[must_use]
    pub fn placement(&self) -> Option<&OrderPlacement> {
        self.placements()?.first()
    }

    /// Each cancel's outcome, in order; `None` without an executed verdict.
    #[must_use]
    pub fn cancellations(&self) -> Option<&[OrderCancellation]> {
        self.receipt()
            .filter(|r| r.is_success())
            .map(Receipt::cancellations)
    }

    /// The outcome of a single cancel ([`Self::cancellations`]).
    #[must_use]
    pub fn cancellation(&self) -> Option<&OrderCancellation> {
        self.cancellations()?.first()
    }
}

/// An unreadable `Retry-After` must never mean "retry now".
const INVALID_RETRY_AFTER: Duration = Duration::from_secs(1);

fn retry_after(hint: Option<RetryAfter>) -> Option<Duration> {
    hint.map(|h| match h {
        RetryAfter::DelaySeconds(s) => Duration::from_secs(s),
        RetryAfter::At(at) => at
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO),
        RetryAfter::Invalid => INVALID_RETRY_AFTER,
    })
}

fn status(outcome: SubmissionOutcome<PreAdmissionRefusal>) -> TxStatus {
    match outcome {
        SubmissionOutcome::Committed(r) => TxStatus::Committed(r.into()),
        SubmissionOutcome::CheckTxRejected { code, log, .. } => TxStatus::Rejected {
            error: EngineError::new(code.get(), Some(&log)),
            log: Some(log).filter(|l| !l.is_empty()),
        },
        SubmissionOutcome::Pending { .. } => TxStatus::Pending,
        SubmissionOutcome::RejectedBeforeAdmission { refusal, .. } => {
            TxStatus::Refused(refusal.into())
        }
    }
}

/// Signs and submits actions for one account through the gateway.
///
/// Cheap to clone. Clones share the connection pool *and* the nonce
/// allocator, so hand a clone to every task that trades with this key.
///
/// Each submit is one `POST /exchange` with no hidden retry. The order helpers
/// are the [`crate::actions`] builders with this client's address, submitted
/// at once. To trade as a delegated agent for another owner, or to gate
/// submission yourself, build the action with [`crate::actions`].
///
/// # Did it execute?
///
/// - An `Err` from [`Self::sign`] means nothing was sent.
/// - [`Error::Unconfirmed`] from [`Self::send`] (or any helper) means no
///   verdict came back and the transaction may still execute. It carries the
///   [`SignedTx`]: reconcile its hash with [`Self::wait_for_receipt`], or
///   resend the same bytes; never sign the action again.
/// - [`Error::OrderResultUnreadable`] means it executed but its order results
///   did not read: reconcile its hash, never sign it again. Any other `Err`
///   means nothing executed.
/// - `Ok` carries a [`TxStatus`] that says which.
///
/// [`Self::submit`] is `sign` then `send`, so its `Err` is either. Call the two
/// yourself when the difference matters.
#[derive(Clone)]
pub struct ExchangeClient {
    inner: Arc<Inner>,
}

struct Inner {
    info: InfoClient,
    signer: Arc<dyn Signer>,
    public_key: [u8; 32],
    address: Address,
    chain_id: [u8; 32],
    network: String,
    nonces: NonceAllocator,
}

impl fmt::Debug for ExchangeClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExchangeClient")
            .field("address", &self.inner.address)
            .field("network", &self.inner.network)
            .finish_non_exhaustive()
    }
}

/// A receipt read that means "not committed yet" (404, the node's JSON-RPC
/// not-found) or a transient failure. Anything else (401, 403, 429, a
/// malformed answer) is returned, not hidden behind a timeout.
fn still_pending(kind: GatewayErrorKind) -> bool {
    match kind {
        GatewayErrorKind::HttpStatus(status) => status == 404 || status >= 500,
        GatewayErrorKind::RpcUnavailable
        | GatewayErrorKind::Transport
        | GatewayErrorKind::Timeout => true,
        _ => false,
    }
}

/// First receipt poll delay; each poll adds [`RECEIPT_POLL_STEP`] up to
/// [`RECEIPT_POLL_MAX`]. Matches the TypeScript SDK.
const RECEIPT_POLL_START: Duration = Duration::from_millis(200);
const RECEIPT_POLL_STEP: Duration = Duration::from_millis(100);
const RECEIPT_POLL_MAX: Duration = Duration::from_millis(600);

impl ExchangeClient {
    /// Build a client signing for `config`'s chain id. Makes no request.
    /// Use [`Self::connect`] to check the chain against the gateway first.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] if `config` has no chain id or is invalid.
    pub fn new(config: &ClientConfig, signer: impl Signer + 'static) -> Result<Self> {
        let network = config
            .chain_id()
            .ok_or_else(|| {
                Error::Config(
                    "ExchangeClient::new needs a chain id; use connect() to read it".into(),
                )
            })?
            .to_owned();
        Ok(Self::build(
            InfoClient::new(config)?,
            Arc::new(signer),
            network,
            NonceAllocator::new(),
        ))
    }

    /// Read the gateway's chain and bind signatures to it. If `config` names
    /// a chain id, the gateway must serve that chain. The nonce allocator
    /// starts above the highest nonce the engine remembers for this key, so a
    /// restart never signs behind its predecessor.
    ///
    /// # Errors
    ///
    /// An invalid `config`, a read failure from [`InfoClient::chain_status`]
    /// or [`InfoClient::recent_nonces`], or [`Error::ChainMismatch`].
    pub async fn connect(config: &ClientConfig, signer: impl Signer + 'static) -> Result<Self> {
        let info = InfoClient::new(config)?;
        let chain = info.chain_status().await?;
        if let Some(expected) = config.chain_id() {
            if expected != chain.network {
                return Err(Error::ChainMismatch {
                    expected: expected.to_owned(),
                    actual: chain.network,
                });
            }
        }
        let address = Address::from_public_key(&signer.public_key());
        let floor = info.recent_nonces(address).await?.into_iter().max();
        let nonces = floor.map_or_else(NonceAllocator::new, NonceAllocator::starting_after);
        Ok(Self::build(info, Arc::new(signer), chain.network, nonces))
    }

    fn build(
        info: InfoClient,
        signer: Arc<dyn Signer>,
        network: String,
        nonces: NonceAllocator,
    ) -> Self {
        let public_key = signer.public_key();
        Self {
            inner: Arc::new(Inner {
                info,
                address: Address::from_public_key(&public_key),
                public_key,
                chain_id: crypto::chain_id_from_string(&network),
                network,
                signer,
                nonces,
            }),
        }
    }

    /// This account's address.
    #[must_use]
    pub fn address(&self) -> Address {
        self.inner.address
    }

    /// The signer's Ed25519 public key.
    #[must_use]
    pub fn public_key(&self) -> [u8; 32] {
        self.inner.public_key
    }

    /// The network signatures are bound to (e.g. `exchange-devnet-1`).
    #[must_use]
    pub fn network(&self) -> &str {
        &self.inner.network
    }

    /// The read client sharing this client's connection pool.
    #[must_use]
    pub fn info(&self) -> &InfoClient {
        &self.inner.info
    }

    /// The `/ws` feed of this client's gateway, with its API key and this
    /// account's signed `accountEvents` auth. Adjust it with the `with_*`
    /// setters before [`crate::WsClient::connect`].
    #[cfg(feature = "ws")]
    #[must_use]
    pub fn ws_config(&self) -> crate::WsConfig {
        let auth = crate::AccountAuth::new(Arc::clone(&self.inner.signer), &self.inner.network);
        crate::WsConfig::for_gateway(self.inner.info.config()).with_account_auth(auth)
    }

    /// The nonce allocator every [`Self::sign`] draws from.
    #[must_use]
    pub fn nonces(&self) -> &NonceAllocator {
        &self.inner.nonces
    }

    // -- sign / submit ------------------------------------------------------

    /// Sign `action` with the next nonce. Pure CPU, no I/O: an `Err` means
    /// nothing was sent.
    ///
    /// # Errors
    ///
    /// [`Error::NonceWindow`] if the allocator would run too far ahead of the
    /// clock, [`Error::Encode`] or [`Error::Signer`].
    pub fn sign(&self, action: &Action) -> Result<SignedTx> {
        let seq = self.inner.nonces.next()?;
        self.sign_with_seq(action, seq)
    }

    /// Sign `action` with a caller-chosen `seq`. The caller guarantees it is
    /// unique for this key.
    ///
    /// # Errors
    ///
    /// [`Error::Encode`] or [`Error::Signer`].
    pub fn sign_with_seq(&self, action: &Action, seq: u64) -> Result<SignedTx> {
        let inner = &*self.inner;
        let bytes =
            sign_action(&*inner.signer, &inner.chain_id, action, seq).map_err(|e| match e {
                SignActionError::Encode(m) => Error::Encode(m),
                SignActionError::Signer(e) => Error::Signer(e),
            })?;
        Ok(SignedTx {
            hash: TxHash::of_signed_bytes(&bytes),
            bytes,
            seq,
        })
    }

    /// `POST /exchange` the signed bytes once. No retry.
    ///
    /// # Errors
    ///
    /// [`Error::Unconfirmed`] when the bytes may have reached the gateway but
    /// no verdict came back (transport failure, 5xx, unreadable answer): look
    /// `tx.hash` up with [`Self::wait_for_receipt`], or resend the same `tx`
    /// (same nonce, so it executes at most once). Signing the action again
    /// creates a second transaction. [`Error::OrderResultUnreadable`] means it
    /// executed but its order results did not read: reconcile, never re-sign.
    /// Other errors mean it was not sent.
    pub async fn send(&self, tx: &SignedTx) -> Result<Submitted> {
        self.send_orders(tx, None).await
    }

    /// [`Self::send`], reading an executed result's order results as `sent`
    /// says ([`read_order_lists`]).
    async fn send_orders(&self, tx: &SignedTx, sent: Option<Sent>) -> Result<Submitted> {
        let s = self
            .inner
            .info
            .gateway()
            .submit_signed_bytes_with_evidence(&tx.bytes)
            .await
            .map_err(|e| {
                if e.reconcile_hash.is_some() {
                    Error::Unconfirmed {
                        tx: tx.clone(),
                        source: Box::new(e.into()),
                    }
                } else {
                    e.into()
                }
            })?;
        let wait = retry_after(s.retry_after);
        let status = match status(s.outcome) {
            TxStatus::Committed(receipt) => TxStatus::Committed(read_order_lists(receipt, sent)?),
            other => other,
        };
        Ok(Submitted {
            tx: tx.clone(),
            status,
            retry_after: wait,
        })
    }

    /// Sign and send an order action, reading its result as `sent`.
    async fn submit_orders(&self, action: &Action, sent: Sent) -> Result<Submitted> {
        self.send_orders(&self.sign(action)?, Some(sent)).await
    }

    /// Sign `action` with a fresh nonce and submit it.
    ///
    /// # Errors
    ///
    /// [`Error::NonceWindow`], [`Error::Encode`] or [`Error::Signer`] before
    /// anything is sent, then whatever [`Self::send`] returns.
    pub async fn submit(&self, action: &Action) -> Result<Submitted> {
        self.send_orders(&self.sign(action)?, Sent::of(action))
            .await
    }

    /// [`Self::submit`], then wait up to `timeout` for a pending result to
    /// commit. A refused or already-committed result returns immediately.
    ///
    /// # Errors
    ///
    /// [`Error::NonceWindow`], [`Error::Encode`] or [`Error::Signer`] before
    /// anything is sent, then whatever [`Self::send`] returns.
    /// [`Error::ReceiptTimeout`] if a pending result does not commit in time,
    /// [`Error::OrderResultUnreadable`] if it committed but its order results did
    /// not read, or [`Error::Unconfirmed`] carrying the transaction if the wait
    /// failed otherwise.
    pub async fn submit_and_wait(&self, action: &Action, timeout: Duration) -> Result<Submitted> {
        let mut submitted = self.submit(action).await?;
        if submitted.is_pending() {
            let receipt = match self.wait_for_receipt(submitted.tx.hash, timeout).await {
                Ok(receipt) => receipt,
                Err(e @ (Error::ReceiptTimeout { .. } | Error::OrderResultUnreadable { .. })) => {
                    return Err(e)
                }
                Err(e) => {
                    return Err(Error::Unconfirmed {
                        tx: submitted.tx,
                        source: Box::new(e),
                    })
                }
            };
            submitted.status = TxStatus::Committed(receipt);
        }
        Ok(submitted)
    }

    /// Poll `GET /v1/tx/{hash}` until the transaction commits or `timeout`
    /// passes. Not found is not failure: it returns
    /// [`Error::ReceiptTimeout`], and the transaction may still land later.
    ///
    /// # Errors
    ///
    /// [`Error::ReceiptTimeout`] at the deadline, including one that passes
    /// mid-request. A 404, a 5xx or a transport
    /// failure is retried until then; any other failure is returned at once.
    /// The receipt's order results are read as [`Self::send`] reads them,
    /// without knowing what was sent: rejected orders are reported in their
    /// results, and an order event that does not parse is
    /// [`Error::OrderResultUnreadable`].
    pub async fn wait_for_receipt(&self, hash: TxHash, timeout: Duration) -> Result<Receipt> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut delay = RECEIPT_POLL_START;
        loop {
            let poll = self.inner.info.gateway().committed_receipt(hash);
            match tokio::time::timeout_at(deadline, poll).await {
                Ok(Ok(receipt)) => return read_order_lists(receipt.into(), None),
                // Not found yet, not indexed yet, or transient: keep polling.
                Ok(Err(e)) if still_pending(e.kind) => {}
                Ok(Err(e)) => return Err(e.into()),
                Err(_elapsed) => return Err(Error::ReceiptTimeout { hash }),
            }
            tokio::time::sleep_until((tokio::time::Instant::now() + delay).min(deadline)).await;
            if tokio::time::Instant::now() >= deadline {
                return Err(Error::ReceiptTimeout { hash });
            }
            delay = (delay + RECEIPT_POLL_STEP).min(RECEIPT_POLL_MAX);
        }
    }

    // -- order helpers --------------------------------------------------------

    /// [`actions::limit_order`] for this account. Adjust the fields
    /// (`post_only`, `client_order_id`, `time_in_force`, ...) before
    /// [`Self::place_order`].
    #[must_use]
    pub fn limit_order(
        &self,
        market: MarketId,
        side: Side,
        price: u64,
        quantity: u64,
    ) -> PlaceOrder {
        actions::limit_order(self.address(), market, side, price, quantity)
    }

    /// Place one order for this account, limit ([`Self::limit_order`],
    /// [`actions::order_entry`]) or market ([`actions::market_entry`]): a
    /// batch of one. [`Submitted::placement`] is its outcome; a rejected order
    /// does not fail the transaction.
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn place_order(&self, order: impl Into<OrderEntry>) -> Result<Submitted> {
        let action = actions::place_entry(self.address(), order.into());
        self.submit_orders(&action, Sent::PLACE).await
    }

    /// Place 1 to 100 limit or market orders under one signature, each placed
    /// or refused on its own ([`actions::place_orders`]). The transaction
    /// succeeds; [`Receipt::placements`] says what each order did.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for no orders or more than 100, else as
    /// [`Self::submit`].
    pub async fn place_orders(&self, orders: Vec<OrderEntry>) -> Result<Submitted> {
        let sent = Sent::list(ListKind::Placed, orders.len());
        self.submit_orders(&actions::place_orders(self.address(), orders)?, sent)
            .await
    }

    /// Cancel 1 to 100 orders by exchange order id, each on its own
    /// ([`actions::cancel_orders`]); [`Receipt::cancellations`] says what
    /// each did.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for no ids or more than 100, else as
    /// [`Self::submit`].
    pub async fn cancel_orders(&self, order_ids: Vec<OrderId>) -> Result<Submitted> {
        let sent = Sent::list(ListKind::Cancelled, order_ids.len());
        self.submit_orders(&actions::cancel_orders(self.address(), order_ids)?, sent)
            .await
    }

    /// Cancel 1 to 100 orders by client order id, each on its own
    /// ([`actions::cancel_client_orders`]); [`Receipt::cancellations`] says
    /// what each did.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for no ids or more than 100, else as
    /// [`Self::submit`].
    pub async fn cancel_client_orders(&self, client_order_ids: Vec<u64>) -> Result<Submitted> {
        let sent = Sent::list(ListKind::Cancelled, client_order_ids.len());
        self.submit_orders(
            &actions::cancel_client_orders(self.address(), client_order_ids)?,
            sent,
        )
        .await
    }

    /// Immediate-or-cancel at the best available prices
    /// ([`actions::market_order`]), a batch of one: a rejected order is its outcome
    /// ([`Submitted::placement`]).
    /// For a worst price, pass [`actions::market_entry`] to
    /// [`Self::place_order`].
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn market_order(
        &self,
        market: MarketId,
        side: Side,
        quantity: u64,
    ) -> Result<Submitted> {
        self.submit_orders(
            &actions::market_order(self.address(), market, side, quantity),
            Sent::PLACE,
        )
        .await
    }

    /// Cancel by exchange order id ([`actions::cancel_order`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_order(&self, order_id: OrderId) -> Result<Submitted> {
        self.submit_orders(
            &actions::cancel_order(self.address(), order_id),
            Sent::CANCEL,
        )
        .await
    }

    /// Cancel by client order id ([`actions::cancel_order_by_client_id`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_order_by_client_id(&self, client_order_id: u64) -> Result<Submitted> {
        self.submit_orders(
            &actions::cancel_order_by_client_id(self.address(), client_order_id),
            Sent::CANCEL,
        )
        .await
    }

    /// Cancel every resting order, or only those on `market`
    /// ([`actions::cancel_all_orders`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_all_orders(&self, market: Option<MarketId>) -> Result<Submitted> {
        self.submit(&actions::cancel_all_orders(self.address(), market))
            .await
    }

    /// Change a resting order's price and/or total quantity in place
    /// ([`actions::amend_order`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn amend_order(
        &self,
        order_id: OrderId,
        new_price: Option<u64>,
        new_quantity: Option<u64>,
    ) -> Result<Submitted> {
        self.submit(&actions::amend_order(
            self.address(),
            order_id,
            new_price,
            new_quantity,
        ))
        .await
    }

    /// Atomically cancel exchange order `order_id` and place `order`
    /// ([`actions::cancel_replace_order`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_replace_order(
        &self,
        order_id: OrderId,
        order: PlaceOrder,
    ) -> Result<Submitted> {
        self.submit(&actions::cancel_replace_order(order_id, order))
            .await
    }

    /// Atomically cancel the order with `client_order_id` and place `order`
    /// ([`actions::cancel_replace_order_by_client_id`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_replace_order_by_client_id(
        &self,
        client_order_id: u64,
        order: PlaceOrder,
    ) -> Result<Submitted> {
        self.submit(&actions::cancel_replace_order_by_client_id(
            client_order_id,
            order,
        ))
        .await
    }

    /// Flatten this account's position on `market`: reads the position, then
    /// sends a reduce-only market entry on the other side for its size
    /// ([`actions::market_entry`]). A flat account sends nothing and returns
    /// [`CloseOutcome::NothingToClose`]. A refused close is its entry in
    /// [`Receipt::placements`], code 35 when the position went flat before the
    /// close ran. The size and `NothingToClose` come from the account read,
    /// which can trail a fill made just before; the close never sends more
    /// than the position read.
    ///
    /// # Errors
    ///
    /// A failed account read (as [`InfoClient::account`]), then as
    /// [`Self::submit`].
    pub async fn close_position(&self, market: MarketId) -> Result<CloseOutcome> {
        let account = self.info().account(self.address()).await?;
        let Some(held) = account
            .positions
            .iter()
            .find(|p| p.market == market && p.size > 0)
        else {
            return Ok(CloseOutcome::NothingToClose);
        };
        let entry = close_entry(market, held.side, held.size);
        self.place_order(entry).await.map(CloseOutcome::Sent)
    }
}

/// Helpers for the actions a bot submits besides orders: No on binary books,
/// position triggers, agents, sub-accounts, withdrawals and baskets.
impl ExchangeClient {
    /// Buy No at `price` on an event's binary book ([`actions::buy_no`]).
    /// `market` is the book's config, as [`InfoClient::markets`] reads it.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] when `market` is not a prediction-binary book,
    /// or for a price of 0 or `$1` or more, before anything is signed; then
    /// as [`Self::submit`].
    pub async fn buy_no(
        &self,
        market: &MarketConfig,
        price: u64,
        quantity: u64,
    ) -> Result<Submitted> {
        let order = actions::buy_no(self.address(), market, price, quantity)?;
        self.place_order(order).await
    }

    /// Sell No at `price` on an event's binary book ([`actions::sell_no`]).
    ///
    /// # Errors
    ///
    /// As [`Self::buy_no`].
    pub async fn sell_no(
        &self,
        market: &MarketConfig,
        price: u64,
        quantity: u64,
    ) -> Result<Submitted> {
        let order = actions::sell_no(self.address(), market, price, quantity)?;
        self.place_order(order).await
    }

    /// Replace the bracket on this account's position generation
    /// `expected_position_epoch` ([`actions::set_position_triggers`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn set_position_triggers(
        &self,
        market: MarketId,
        expected_position_epoch: PositionEpoch,
        stop_loss: Option<TriggerLimb>,
        take_profit: Option<TriggerLimb>,
    ) -> Result<Submitted> {
        self.submit(&actions::set_position_triggers(
            self.address(),
            market,
            expected_position_epoch,
            stop_loss,
            take_profit,
            None,
        ))
        .await
    }

    /// Drop the bracket on that position generation
    /// ([`actions::cancel_position_triggers`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_position_triggers(
        &self,
        market: MarketId,
        expected_position_epoch: PositionEpoch,
    ) -> Result<Submitted> {
        self.submit(&actions::cancel_position_triggers(
            self.address(),
            market,
            expected_position_epoch,
        ))
        .await
    }

    /// Let `agent_public_key` trade for this account ([`actions::approve_agent`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn approve_agent(&self, agent_public_key: [u8; 32]) -> Result<Submitted> {
        self.submit(&actions::approve_agent(self.address(), agent_public_key))
            .await
    }

    /// Withdraw an agent's approval ([`actions::revoke_agent`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn revoke_agent(&self, agent_public_key: [u8; 32]) -> Result<Submitted> {
        self.submit(&actions::revoke_agent(self.address(), agent_public_key))
            .await
    }

    /// Create sub-account `sub_account_id` of this account
    /// ([`actions::create_sub_account`]); its address is
    /// [`actions::sub_account_address`].
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for a name over 32 bytes, before anything is
    /// signed; then as [`Self::submit`].
    pub async fn create_sub_account(
        &self,
        sub_account_id: crate::SubAccountId,
        name: &str,
    ) -> Result<Submitted> {
        self.submit(&actions::create_sub_account(
            self.address(),
            sub_account_id,
            name,
        )?)
        .await
    }

    /// Move `amount` micro-USDC between this account and one of its
    /// sub-accounts ([`actions::sub_account_transfer`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn sub_account_transfer(
        &self,
        from: Address,
        to: Address,
        amount: u64,
    ) -> Result<Submitted> {
        self.submit(&actions::sub_account_transfer(
            self.address(),
            from,
            to,
            amount,
        ))
        .await
    }

    /// Request a withdrawal of `amount` micro-USDC to a Solana account
    /// ([`actions::withdraw_request`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn withdraw_request(
        &self,
        amount: u64,
        solana_destination: [u8; 32],
    ) -> Result<Submitted> {
        self.submit(&actions::withdraw_request(
            self.address(),
            amount,
            solana_destination,
        ))
        .await
    }

    /// Fill every leg in full or none ([`actions::atomic_basket_order`]).
    /// [`Receipt::placements`] says what each leg did, in order; a failed
    /// basket is the receipt's error with every leg rejected.
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn atomic_basket_order(
        &self,
        legs: Vec<AtomicBasketLeg>,
        max_slippage_bps: u32,
    ) -> Result<Submitted> {
        self.submit(&actions::atomic_basket_order(
            self.address(),
            legs,
            max_slippage_bps,
        ))
        .await
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic)]
    use super::*;
    use crate::event::PlacementOutcome;
    use proof_trading_sdk::{codec, LocalSigner};

    fn client() -> ExchangeClient {
        ExchangeClient::new(&ClientConfig::devnet(), LocalSigner::from_bytes(&[7; 32])).unwrap()
    }

    #[test]
    fn signatures_verify_against_the_bound_chain_only() {
        let c = client();
        let tx = c
            .sign(&actions::cancel_all_orders(c.address(), None))
            .unwrap();
        let raw = codec::decode_tx_raw(&tx.bytes).unwrap();
        let verify = |chain: &str| {
            crypto::verify_signature(
                &crypto::chain_id_from_string(chain),
                &raw.pubkey,
                &raw.signature,
                raw.action_type,
                raw.seq,
                &raw.payload,
            )
            .is_ok()
        };
        assert!(verify("exchange-devnet-1"));
        assert!(!verify("exchange-mainnet-1"));
    }

    #[test]
    fn helpers_fill_this_accounts_owner() {
        let c = client();
        let order = c.limit_order(4, Side::Sell, 1, 1);
        assert_eq!(Address::from(order.owner), c.address());
        assert!(!order.post_only && !order.reduce_only);
    }

    #[test]
    fn debug_never_prints_signed_bytes() {
        let c = client();
        let tx = c
            .sign(&actions::place_order(c.limit_order(1, Side::Buy, 1, 1)))
            .unwrap();
        let shown = format!("{tx:?}");
        assert!(shown.contains("hash") && !shown.contains("bytes"));
    }

    fn receipt(events: Vec<Event>) -> Receipt {
        Receipt {
            hash: TxHash::of_signed_bytes(&[1]),
            height: 9,
            error: None,
            log: String::new(),
            events,
        }
    }

    fn committed(events: Vec<Event>) -> Submitted {
        let c = client();
        Submitted {
            tx: c
                .sign(&actions::cancel_all_orders(c.address(), None))
                .unwrap(),
            status: TxStatus::Committed(receipt(events)),
            retry_after: None,
        }
    }

    fn read(events: Vec<Event>, sent: Option<Sent>) -> Result<Receipt> {
        read_order_lists(receipt(events), sent)
    }

    fn placed(outcomes: &[PlacementOutcome]) -> Event {
        Event::OrdersPlaced(crate::event::OrdersPlaced {
            owner: Address([1; 20]),
            orders: outcomes
                .iter()
                .map(|&outcome| OrderPlacement {
                    market: 1,
                    client_order_id: None,
                    outcome,
                })
                .collect(),
        })
    }

    fn cancelled(reason: CancelReason, orders: Vec<OrderCancellation>) -> Event {
        Event::OrdersCancelled(crate::event::OrdersCancelled {
            owner: Address([1; 20]),
            reason,
            orders,
        })
    }

    fn refused_cancel(error: EngineError) -> OrderCancellation {
        OrderCancellation::Refused {
            target: proof_trading_sdk::types::CancelTarget::OrderId(5),
            error,
        }
    }

    fn executed(order_id: OrderId) -> PlacementOutcome {
        PlacementOutcome::Executed {
            order_id,
            requested_quantity: 5,
            filled_quantity: 5,
            unfilled: None,
        }
    }

    /// The receipt an unreadable result carries, or a panic naming what came back.
    fn unreadable_receipt(read: Result<Receipt>) -> Receipt {
        match read {
            Err(Error::OrderResultUnreadable { receipt, .. }) => *receipt,
            other => panic!("expected OrderResultUnreadable, got {other:?}"),
        }
    }

    #[test]
    fn a_market_entry_reports_its_outcome_in_its_entry() {
        let no_liquidity = PlacementOutcome::Executed {
            order_id: 4,
            requested_quantity: 5,
            filled_quantity: 0,
            unfilled: Some(proof_trading_sdk::types::UnfilledReason::NoLiquidity),
        };
        // Nothing filled is still an executed order, not an error.
        let filled_none = read(vec![placed(&[no_liquidity])], Some(Sent::PLACE)).unwrap();
        assert!(filled_none.is_success());
        let margin = EngineError::new(12, None);
        let refused = read(
            vec![placed(&[PlacementOutcome::Rejected(margin)])],
            Some(Sent::PLACE),
        )
        .unwrap();
        assert!(refused.is_success(), "a refused entry never fails the list");
        assert_eq!(
            refused.placements()[0].outcome,
            PlacementOutcome::Rejected(margin)
        );
    }

    #[test]
    fn a_close_is_a_reduce_only_market_entry_on_the_other_side() {
        for (held, side) in [(Side::Buy, Side::Sell), (Side::Sell, Side::Buy)] {
            let e = close_entry(2, held, 7);
            assert_eq!(
                (e.market, e.side, e.quantity, e.reduce_only),
                (2, side, 7, true)
            );
            assert_eq!(
                e.kind,
                proof_trading_sdk::types::OrderKind::Market { worst_price: None }
            );
        }

        // A position gone flat before the close ran is its entry's refusal.
        let gone = EngineError::new(35, None);
        let refused = read(
            vec![placed(&[PlacementOutcome::Rejected(gone)])],
            Some(Sent::PLACE),
        )
        .unwrap();
        assert_eq!(
            refused.placements()[0].outcome,
            PlacementOutcome::Rejected(gone)
        );
    }

    #[test]
    fn basket_legs_read_from_orders_placed() {
        let legs = committed(vec![placed(&[executed(3), executed(4)])]);
        let receipt = legs.receipt().unwrap();
        assert!(receipt.is_success());
        assert_eq!(
            receipt
                .placements()
                .iter()
                .map(|p| p.outcome)
                .collect::<Vec<_>>(),
            [executed(3), executed(4)]
        );

        // A failed basket fails the transaction and reports each leg with it.
        let slipped = EngineError::new(50, None);
        let mut failed = committed(vec![placed(&[
            PlacementOutcome::Rejected(slipped),
            PlacementOutcome::Rejected(slipped),
        ])]);
        if let TxStatus::Committed(r) = &mut failed.status {
            r.error = Some(slipped);
        }
        assert_eq!(failed.error(), Some(slipped));
        assert_eq!(failed.receipt().unwrap().placements().len(), 2);
    }

    #[test]
    fn submitted_gives_each_outcome_only_with_an_executed_verdict() {
        let margin = EngineError::new(12, None);
        let one = committed(vec![placed(&[PlacementOutcome::Rejected(margin)])]);
        assert_eq!(
            one.placement().map(|p| p.outcome),
            Some(PlacementOutcome::Rejected(margin))
        );
        assert_eq!(one.placements().map(<[_]>::len), Some(1));
        assert!(one.cancellation().is_none());

        let mut refused = committed(Vec::new());
        if let TxStatus::Committed(r) = &mut refused.status {
            r.error = Some(EngineError::new(21, None));
        }
        assert!(refused.placements().is_none(), "refused as a whole");
        let pending = Submitted {
            status: TxStatus::Pending,
            ..committed(Vec::new())
        };
        assert!(pending.placement().is_none(), "no verdict yet");
    }

    #[test]
    fn every_order_action_is_a_batch_its_orders_report() {
        let margin = EngineError::new(12, None);
        let one = read(
            vec![placed(&[PlacementOutcome::Rejected(margin)])],
            Some(Sent::PLACE),
        )
        .unwrap();
        assert!(one.is_success(), "a batch of one keeps code 0");
        assert_eq!(
            one.placements()[0].outcome,
            PlacementOutcome::Rejected(margin)
        );

        let not_found = EngineError::new(2, None);
        let cancel = cancelled(CancelReason::UserRequested, vec![refused_cancel(not_found)]);
        let cancel = read(vec![cancel], Some(Sent::CANCEL)).unwrap();
        assert!(cancel.is_success());
        assert_eq!(cancel.cancellations().len(), 1);

        let entries = [PlacementOutcome::Rejected(margin), executed(3)];
        let list = read(
            vec![placed(&entries)],
            Some(Sent::list(ListKind::Placed, 2)),
        )
        .unwrap();
        assert!(list.is_success());
        assert_eq!(list.placements().len(), 2);

        // Reconciled by hash, without knowing what was sent, reads the same.
        let reconciled = read(vec![placed(&[PlacementOutcome::Rejected(margin)])], None).unwrap();
        assert!(reconciled.is_success());
    }

    #[test]
    fn an_executed_result_that_does_not_read_is_never_success() {
        let margin = EngineError::new(12, None);
        let malformed = Event::Malformed(proof_trading_sdk::gateway::TxEvent {
            kind: "orders_placed".into(),
            attributes: Vec::new(),
        });
        let two = placed(&[PlacementOutcome::Rejected(margin), executed(3)]);
        let other_reason = cancelled(CancelReason::Liquidation, vec![refused_cancel(margin)]);
        for (events, sent) in [
            (vec![malformed.clone()], Sent::PLACE),
            (Vec::new(), Sent::PLACE),
            (vec![two.clone()], Sent::PLACE),
            (vec![other_reason], Sent::CANCEL),
            (vec![two], Sent::list(ListKind::Placed, 3)),
        ] {
            let receipt = unreadable_receipt(read(events, Some(sent)));
            assert_eq!((receipt.height, receipt.error), (9, None));
        }
        // Without knowing what was sent, a list that does not parse still is.
        unreadable_receipt(read(vec![malformed], None));

        let err = read(Vec::new(), Some(Sent::CANCEL)).unwrap_err();
        let shown = err.to_string();
        assert!(shown.contains("executed at height 9") && shown.contains("do not sign it again"));
    }

    #[test]
    fn offline_requires_a_chain_id() {
        let err = ExchangeClient::new(
            &ClientConfig::new("https://api.dev.proof.trade"),
            LocalSigner::from_bytes(&[1; 32]),
        )
        .unwrap_err();
        assert!(matches!(err, Error::Config(_)));
    }
}
