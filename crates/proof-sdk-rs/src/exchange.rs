//! Signing, submission and order helpers.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use proof_trading_sdk::gateway::{
    CommittedReceipt, ErrorKind, RetryAfter, SubmissionOutcome, TxHash,
};
use proof_trading_sdk::types::{
    Action, AmendOrder, CancelAllOrders, CancelClientOrder, CancelOrder, CancelReplaceOrder,
    ClosePosition, MarketId, MarketOrder, OrderId, PlaceOrder, Side,
};
use proof_trading_sdk::{codec, crypto, Signer};

use crate::address::Address;
use crate::error::{Error, Result};
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

/// What the gateway said about one submission.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Submitted {
    pub tx: SignedTx,
    pub outcome: SubmissionOutcome,
    /// The gateway's `Retry-After` hint (rate limiting), if any.
    pub retry_after: Option<RetryAfter>,
}

impl Submitted {
    /// Executed in a block with code 0.
    #[must_use]
    pub fn is_success(&self) -> bool {
        matches!(&self.outcome, SubmissionOutcome::Committed(r) if r.code == 0)
    }

    /// Admitted, but no verdict yet. Reconcile with
    /// [`ExchangeClient::wait_for_receipt`]; never re-sign.
    #[must_use]
    pub fn is_pending(&self) -> bool {
        matches!(self.outcome, SubmissionOutcome::Pending { .. })
    }

    /// The engine error code, when the engine refused the transaction
    /// (at `CheckTx`, or in the block). Decode it with
    /// [`proof_trading_sdk::decode_exec_error_kind`]. For example, 12 is
    /// insufficient margin and 21 is an invalid nonce.
    #[must_use]
    pub fn error_code(&self) -> Option<u32> {
        match &self.outcome {
            SubmissionOutcome::Committed(r) if r.code != 0 => Some(r.code),
            SubmissionOutcome::CheckTxRejected { code, .. } => Some(code.get()),
            _ => None,
        }
    }
}

/// Signs and submits actions for one account through the gateway.
///
/// Cheap to clone. Clones share the connection pool *and* the nonce
/// allocator, so hand a clone to every task that trades with this key.
///
/// Each submit is one `POST /exchange` with no hidden retry. The order helpers
/// fill `owner` with this client's address. To trade as a delegated agent for
/// another owner, build the action yourself and call [`Self::submit`].
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

/// First receipt poll delay; each poll adds [`RECEIPT_POLL_STEP`] up to
/// [`RECEIPT_POLL_MAX`]. Matches the TypeScript SDK.
const RECEIPT_POLL_START: Duration = Duration::from_millis(200);
const RECEIPT_POLL_STEP: Duration = Duration::from_millis(100);
const RECEIPT_POLL_MAX: Duration = Duration::from_millis(600);

impl ExchangeClient {
    /// Connect: read the gateway's chain identity and bind signatures to it.
    /// If `config.chain_id` is set, the gateway must serve that chain.
    pub async fn connect(config: &ClientConfig, signer: impl Signer + 'static) -> Result<Self> {
        let info = InfoClient::new(config)?;
        let identity = info.chain_identity().await?;
        if let Some(expected) = &config.chain_id {
            if *expected != identity.network {
                return Err(Error::ChainMismatch {
                    expected: expected.clone(),
                    actual: identity.network,
                });
            }
        }
        Ok(Self::build(info, Arc::new(signer), identity.network))
    }

    /// Build without a network round trip, signing for `config.chain_id`.
    /// Use when the chain is known and start-up latency matters.
    pub fn offline(config: &ClientConfig, signer: impl Signer + 'static) -> Result<Self> {
        let network = config
            .chain_id
            .clone()
            .ok_or_else(|| Error::Config("offline construction needs config.chain_id".into()))?;
        Ok(Self::build(
            InfoClient::new(config)?,
            Arc::new(signer),
            network,
        ))
    }

    fn build(info: InfoClient, signer: Arc<dyn Signer>, network: String) -> Self {
        let public_key = signer.public_key();
        Self {
            inner: Arc::new(Inner {
                info,
                address: Address::from_public_key(&public_key),
                public_key,
                chain_id: crypto::chain_id_from_string(&network),
                network,
                signer,
                nonces: NonceAllocator::new(),
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

    /// The nonce allocator every [`Self::sign`] draws from.
    #[must_use]
    pub fn nonces(&self) -> &NonceAllocator {
        &self.inner.nonces
    }

    // -- sign / submit ------------------------------------------------------

    /// Sign `action` with the next nonce. Pure CPU, no I/O.
    pub fn sign(&self, action: &Action) -> Result<SignedTx> {
        let seq = self.inner.nonces.next()?;
        self.sign_with_seq(action, seq)
    }

    /// Sign `action` with a caller-chosen `seq`. The caller guarantees it is
    /// unique for this key.
    pub fn sign_with_seq(&self, action: &Action, seq: u64) -> Result<SignedTx> {
        let encode = |e: proof_trading_sdk::types::ExecError| Error::Encode(e.to_string());
        let inner = &*self.inner;
        // The typed codec only signs with an in-memory key. To sign through
        // `Signer` (HSM, KMS), take the canonical (action_type, payload) from an
        // unsigned envelope and sign the preimage ourselves.
        let unsigned =
            codec::encode_signed_tx(action, seq, &inner.public_key, &[0; 64]).map_err(encode)?;
        let raw = codec::decode_tx_raw(&unsigned).map_err(encode)?;
        let msg = crypto::signing_message(&inner.chain_id, raw.action_type, seq, &raw.payload);
        let signature = inner.signer.try_sign(&msg)?;
        let bytes = codec::encode_signed_tx_raw(
            raw.action_type,
            &raw.payload,
            seq,
            &inner.public_key,
            &signature,
        )
        .map_err(encode)?;
        Ok(SignedTx {
            hash: TxHash::of_signed_bytes(&bytes),
            bytes,
            seq,
        })
    }

    /// Submit signed bytes exactly once.
    ///
    /// Returns [`Error::Ambiguous`] carrying `tx` when the request may have
    /// reached the gateway without a verdict coming back.
    pub async fn send(&self, tx: SignedTx) -> Result<Submitted> {
        match self
            .inner
            .info
            .gateway()
            .submit_signed_bytes(&tx.bytes)
            .await
        {
            Ok(s) => Ok(Submitted {
                tx,
                outcome: s.outcome,
                retry_after: s.retry_after,
            }),
            Err(source) if source.reconcile_hash.is_some() => Err(Error::Ambiguous {
                tx: Box::new(tx),
                source,
            }),
            Err(e) => Err(e.into()),
        }
    }

    /// Sign `action` with a fresh nonce and submit it.
    pub async fn submit(&self, action: &Action) -> Result<Submitted> {
        self.send(self.sign(action)?).await
    }

    /// [`Self::submit`], then wait up to `timeout` for a pending result to
    /// commit. A refused or already-committed result returns immediately.
    pub async fn submit_and_wait(&self, action: &Action, timeout: Duration) -> Result<Submitted> {
        let mut submitted = self.submit(action).await?;
        if submitted.is_pending() {
            let receipt = self.wait_for_receipt(submitted.tx.hash, timeout).await?;
            submitted.outcome = SubmissionOutcome::Committed(receipt);
        }
        Ok(submitted)
    }

    /// Poll `GET /v1/tx/{hash}` until the transaction commits or `timeout`
    /// passes. Not found is not failure: it returns
    /// [`Error::ReceiptTimeout`], and the transaction may still land later.
    pub async fn wait_for_receipt(
        &self,
        hash: TxHash,
        timeout: Duration,
    ) -> Result<CommittedReceipt> {
        let deadline = tokio::time::Instant::now() + timeout;
        let mut delay = RECEIPT_POLL_START;
        loop {
            match self.inner.info.gateway().committed_receipt(hash).await {
                Ok(receipt) => return Ok(receipt),
                Err(e)
                    if matches!(
                        e.kind,
                        ErrorKind::InvalidInput | ErrorKind::InvalidConfiguration
                    ) =>
                {
                    return Err(e.into())
                }
                Err(_) => {} // not found / not indexed yet / transient: keep polling
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(Error::ReceiptTimeout { hash });
            }
            tokio::time::sleep(delay.min(deadline - now)).await;
            delay = (delay + RECEIPT_POLL_STEP).min(RECEIPT_POLL_MAX);
        }
    }

    // -- order helpers --------------------------------------------------------

    /// A GTC limit order for this account. Adjust the fields (`post_only`,
    /// `client_order_id`, `time_in_force`, ...) before [`Self::place_order`].
    #[must_use]
    pub fn limit_order(
        &self,
        market: MarketId,
        side: Side,
        price: u64,
        quantity: u64,
    ) -> PlaceOrder {
        PlaceOrder {
            market,
            owner: self.inner.address.to_bytes(),
            side,
            price,
            quantity,
            ..PlaceOrder::default()
        }
    }

    /// Place a limit order (`PlaceOrder`).
    pub async fn place_order(&self, order: PlaceOrder) -> Result<Submitted> {
        self.submit(&Action::PlaceOrder(order)).await
    }

    /// Immediate-or-cancel at the best available prices (`MarketOrder`).
    pub async fn market_order(
        &self,
        market: MarketId,
        side: Side,
        quantity: u64,
    ) -> Result<Submitted> {
        self.submit(&Action::MarketOrder(MarketOrder {
            market,
            owner: self.owner(),
            side,
            quantity,
            client_order_id: None,
            stop_loss: None,
            take_profit: None,
        }))
        .await
    }

    /// Cancel by exchange order id (`CancelOrder`).
    pub async fn cancel_order(&self, order_id: OrderId) -> Result<Submitted> {
        self.submit(&Action::CancelOrder(CancelOrder {
            order_id,
            owner: self.owner(),
        }))
        .await
    }

    /// Cancel by client order id (`CancelClientOrder`).
    pub async fn cancel_client_order(&self, client_order_id: u64) -> Result<Submitted> {
        self.submit(&Action::CancelClientOrder(CancelClientOrder {
            owner: self.owner(),
            client_order_id,
        }))
        .await
    }

    /// Cancel every resting order, or only those on `market`
    /// (`CancelAllOrders`).
    pub async fn cancel_all_orders(&self, market: Option<MarketId>) -> Result<Submitted> {
        self.submit(&Action::CancelAllOrders(CancelAllOrders {
            owner: self.owner(),
            market,
        }))
        .await
    }

    /// Change a resting order's price and/or total quantity in place
    /// (`AmendOrder`). A same-price size cut keeps queue priority.
    pub async fn amend_order(
        &self,
        order_id: OrderId,
        new_price: Option<u64>,
        new_quantity: Option<u64>,
    ) -> Result<Submitted> {
        self.submit(&Action::AmendOrder(AmendOrder {
            owner: self.owner(),
            order_id,
            new_price,
            new_quantity,
        }))
        .await
    }

    /// Atomically cancel one order and place another
    /// (`CancelReplaceOrder`). Set exactly one of `cancel_order_id` /
    /// `cancel_client_order_id`.
    pub async fn cancel_replace_order(&self, order: CancelReplaceOrder) -> Result<Submitted> {
        self.submit(&Action::CancelReplaceOrder(order)).await
    }

    /// Flatten this account's position on `market` (`ClosePosition`).
    pub async fn close_position(&self, market: MarketId) -> Result<Submitted> {
        self.submit(&Action::ClosePosition(ClosePosition {
            market,
            owner: self.owner(),
        }))
        .await
    }

    fn owner(&self) -> [u8; 20] {
        self.inner.address.to_bytes()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use proof_trading_sdk::LocalSigner;

    fn client() -> ExchangeClient {
        ExchangeClient::offline(&ClientConfig::devnet(), LocalSigner::from_bytes(&[7; 32])).unwrap()
    }

    #[test]
    fn signer_path_is_byte_identical_to_the_engine_codec() {
        let c = client();
        let action = Action::PlaceOrder(c.limit_order(1, Side::Buy, 66_750_000_000, 3));
        let ours = c.sign_with_seq(&action, 1_762_000_000_000).unwrap();
        let reference = codec::sign_and_encode_with_chain(
            &crypto::chain_id_from_string("exchange-devnet-1"),
            &action,
            1_762_000_000_000,
            &ed25519_dalek::SigningKey::from_bytes(&[7; 32]),
        )
        .unwrap();
        assert_eq!(ours.bytes, reference);
        assert_eq!(ours.hash, TxHash::of_signed_bytes(&reference));
    }

    #[test]
    fn signatures_verify_against_the_bound_chain_only() {
        let c = client();
        let tx = c
            .sign(&Action::CancelAllOrders(CancelAllOrders {
                owner: c.owner(),
                market: None,
            }))
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
            .sign(&Action::PlaceOrder(c.limit_order(1, Side::Buy, 1, 1)))
            .unwrap();
        let shown = format!("{tx:?}");
        assert!(shown.contains("hash") && !shown.contains("bytes"));
    }

    #[test]
    fn offline_requires_a_chain_id() {
        let err = ExchangeClient::offline(
            &ClientConfig::new("https://api.dev.proof.trade"),
            LocalSigner::from_bytes(&[1; 32]),
        )
        .unwrap_err();
        assert!(matches!(err, Error::Config(_)));
    }
}
