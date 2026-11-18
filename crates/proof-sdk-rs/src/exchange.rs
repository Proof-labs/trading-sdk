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
use crate::event::{CancelReason, Event, OrderCancellation, OrderPlacement, PlacementOutcome};
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

/// A list of one reports its refusal in its list event with code 0; surface
/// it as the transaction's error, as the single-order actions always did.
fn single_refusal(mut submitted: Submitted) -> Submitted {
    if let TxStatus::Committed(receipt) = &mut submitted.status {
        if receipt.error.is_none() {
            let refused = match (receipt.placements(), receipt.cancellations()) {
                (
                    [OrderPlacement {
                        outcome: PlacementOutcome::Rejected(error),
                        ..
                    }],
                    _,
                )
                | (_, [OrderCancellation::Refused { error, .. }]) => Some(*error),
                _ => None,
            };
            receipt.error = refused.map(|e| EngineError::new(e.code(), Some(&receipt.log)));
        }
    }
    submitted
}

/// A close of `held` (side and size), or of nothing when flat: the engine
/// answers a flat close with code 35, which [`nothing_to_close`] reads.
fn close_action(owner: Address, market: MarketId, held: Option<(Side, u64)>) -> Action {
    let (side, size) = held.unwrap_or((Side::Buy, 1));
    actions::close_position(owner, market, side, size)
}

/// A close with no position to reduce is a success with nothing done; every
/// other refusal stays the receipt's error.
fn nothing_to_close(submitted: Submitted) -> Submitted {
    let mut submitted = single_refusal(submitted);
    if let TxStatus::Committed(receipt) = &mut submitted.status {
        if receipt.error == Some(EngineError::Known(ErrorKind::ReduceOnlyWouldIncrease)) {
            receipt.error = None;
        }
    }
    submitted
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
///   resend the same bytes; never sign the action again. Any other `Err`
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
    /// creates a second transaction. Other errors mean it was not sent.
    pub async fn send(&self, tx: &SignedTx) -> Result<Submitted> {
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
        Ok(Submitted {
            tx: tx.clone(),
            status: status(s.outcome),
            retry_after: retry_after(s.retry_after),
        })
    }

    /// Sign `action` with a fresh nonce and submit it.
    ///
    /// # Errors
    ///
    /// [`Error::NonceWindow`], [`Error::Encode`] or [`Error::Signer`] before
    /// anything is sent, then whatever [`Self::send`] returns.
    pub async fn submit(&self, action: &Action) -> Result<Submitted> {
        self.send(&self.sign(action)?).await
    }

    /// [`Self::submit`], then wait up to `timeout` for a pending result to
    /// commit. A refused or already-committed result returns immediately.
    ///
    /// # Errors
    ///
    /// [`Error::NonceWindow`], [`Error::Encode`] or [`Error::Signer`] before
    /// anything is sent, then whatever [`Self::send`] returns.
    /// [`Error::ReceiptTimeout`] if a pending result does not commit in time,
    /// or [`Error::Unconfirmed`] carrying the transaction if the wait failed
    /// otherwise.
    pub async fn submit_and_wait(&self, action: &Action, timeout: Duration) -> Result<Submitted> {
        let mut submitted = self.submit(action).await?;
        if submitted.is_pending() {
            let receipt = match self.wait_for_receipt(submitted.tx.hash, timeout).await {
                Ok(receipt) => receipt,
                Err(e @ Error::ReceiptTimeout { .. }) => return Err(e),
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
    pub async fn wait_for_receipt(&self, hash: TxHash, timeout: Duration) -> Result<Receipt> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut delay = RECEIPT_POLL_START;
        loop {
            let poll = self.inner.info.gateway().committed_receipt(hash);
            match tokio::time::timeout_at(deadline, poll).await {
                Ok(Ok(receipt)) => return Ok(receipt.into()),
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

    /// Place one limit order ([`actions::place_order`]). A refused order is
    /// the receipt's error, as for any refused transaction.
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn place_order(&self, order: PlaceOrder) -> Result<Submitted> {
        self.submit(&actions::place_order(order))
            .await
            .map(single_refusal)
    }

    /// Place 1 to 100 limit orders under one signature, each placed or
    /// refused on its own ([`actions::place_orders`]). The transaction
    /// succeeds; [`Receipt::placements`] says what each order did.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for no orders or more than 100, else as
    /// [`Self::submit`].
    pub async fn place_orders(&self, orders: Vec<OrderEntry>) -> Result<Submitted> {
        self.submit(&actions::place_orders(self.address(), orders)?)
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
        self.submit(&actions::cancel_orders(self.address(), order_ids)?)
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
        self.submit(&actions::cancel_client_orders(
            self.address(),
            client_order_ids,
        )?)
        .await
    }

    /// Immediate-or-cancel at the best available prices
    /// ([`actions::market_order`]). A refused order is the receipt's error.
    /// For a worst price, use [`Self::place_entry`] with
    /// [`actions::market_entry`].
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
        self.submit(&actions::market_order(
            self.address(),
            market,
            side,
            quantity,
        ))
        .await
        .map(single_refusal)
    }

    /// Place one order of any kind, limit or market
    /// ([`actions::place_entry`]). A refused order is the receipt's error.
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn place_entry(&self, entry: OrderEntry) -> Result<Submitted> {
        self.submit(&actions::place_entry(self.address(), entry))
            .await
            .map(single_refusal)
    }

    /// Cancel by exchange order id ([`actions::cancel_order`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_order(&self, order_id: OrderId) -> Result<Submitted> {
        self.submit(&actions::cancel_order(self.address(), order_id))
            .await
            .map(single_refusal)
    }

    /// Cancel by client order id ([`actions::cancel_order_by_client_id`]).
    ///
    /// # Errors
    ///
    /// As [`Self::submit`].
    pub async fn cancel_order_by_client_id(&self, client_order_id: u64) -> Result<Submitted> {
        self.submit(&actions::cancel_order_by_client_id(
            self.address(),
            client_order_id,
        ))
        .await
        .map(single_refusal)
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
    /// sends a reduce-only market order on the other side for its size
    /// ([`actions::close_position`]). Nothing to close is a success.
    ///
    /// # Errors
    ///
    /// A failed account read (as [`InfoClient::account`]), then as
    /// [`Self::submit`].
    pub async fn close_position(&self, market: MarketId) -> Result<Submitted> {
        let account = self.info().account(self.address()).await?;
        let held = account
            .positions
            .iter()
            .find(|p| p.market == market && p.size > 0)
            .map(|p| (p.side, p.size));
        self.submit(&close_action(self.address(), market, held))
            .await
            .map(nothing_to_close)
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

    fn committed(events: Vec<Event>) -> Submitted {
        let c = client();
        Submitted {
            tx: c
                .sign(&actions::cancel_all_orders(c.address(), None))
                .unwrap(),
            status: TxStatus::Committed(Receipt {
                hash: TxHash::of_signed_bytes(&[1]),
                height: 9,
                error: None,
                log: String::new(),
                events,
            }),
            retry_after: None,
        }
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

    fn executed(order_id: OrderId) -> PlacementOutcome {
        PlacementOutcome::Executed {
            order_id,
            requested_quantity: 5,
            filled_quantity: 5,
            unfilled: None,
        }
    }

    #[test]
    fn a_refused_market_order_is_the_error_it_always_was() {
        let no_liquidity = PlacementOutcome::Executed {
            order_id: 4,
            requested_quantity: 5,
            filled_quantity: 0,
            unfilled: Some(proof_trading_sdk::types::UnfilledReason::NoLiquidity),
        };
        // Nothing filled is still an executed order, not an error.
        assert!(single_refusal(committed(vec![placed(&[no_liquidity])])).is_success());
        let margin = EngineError::new(12, None);
        let refused = single_refusal(committed(vec![placed(&[PlacementOutcome::Rejected(
            margin,
        )])]));
        assert_eq!(refused.error(), Some(margin));
    }

    #[test]
    fn a_close_reads_the_position_and_a_flat_close_succeeds() {
        let c = client();
        for (held, side, size) in [
            (Some((Side::Buy, 7)), Side::Sell, 7),
            (Some((Side::Sell, 3)), Side::Buy, 3),
            (None, Side::Sell, 1),
        ] {
            let Action::PlaceOrders(p) = close_action(c.address(), 2, held) else {
                panic!("{held:?}")
            };
            let [e] = p.orders.as_slice() else {
                panic!("{p:?}")
            };
            assert_eq!(
                (e.market, e.side, e.quantity, e.reduce_only),
                (2, side, size, true)
            );
            assert_eq!(
                e.kind,
                proof_trading_sdk::types::OrderKind::Market { worst_price: None }
            );
        }

        let flat = PlacementOutcome::Rejected(EngineError::new(35, None));
        let closed = nothing_to_close(committed(vec![placed(&[flat])]));
        assert!(closed.is_success());
        assert_eq!(closed.receipt().unwrap().placements().len(), 1);

        let margin = EngineError::new(12, None);
        let unaffordable =
            nothing_to_close(committed(vec![placed(&[PlacementOutcome::Rejected(
                margin,
            )])]));
        assert_eq!(unaffordable.error(), Some(margin));
        assert!(nothing_to_close(committed(vec![placed(&[executed(5)])])).is_success());
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
    fn a_refused_single_is_the_error_it_always_was() {
        let margin = EngineError::new(12, None);
        let refused = single_refusal(committed(vec![placed(&[PlacementOutcome::Rejected(
            margin,
        )])]));
        assert_eq!(refused.error(), Some(margin));
        assert!(!refused.is_success());

        let not_found = EngineError::new(2, None);
        let cancel = Event::OrdersCancelled(crate::event::OrdersCancelled {
            owner: Address([1; 20]),
            reason: CancelReason::UserRequested,
            orders: vec![OrderCancellation::Refused {
                target: proof_trading_sdk::types::CancelTarget::OrderId(5),
                error: not_found,
            }],
        });
        let refused = single_refusal(committed(vec![cancel]));
        assert!(refused.error().is_some_and(EngineError::is_order_not_found));

        let rested = single_refusal(committed(vec![placed(&[executed(3)])]));
        assert!(rested.is_success());
        // A list keeps code 0 whatever its entries did.
        let list = committed(vec![placed(&[
            PlacementOutcome::Rejected(margin),
            executed(3),
        ])]);
        assert!(list.is_success());
        assert_eq!(list.receipt().unwrap().placements().len(), 2);
        assert!(single_refusal(list).is_success());
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
