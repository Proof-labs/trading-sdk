//! Bound market-inventory reads, not an oracle-health or light-client API.
//!
//! The bracket checks chain id, height ordering, clock monotonicity and the
//! witness app hash against a committed header. Node IDs are recorded but not
//! compared, so the three reads may come from different full nodes behind a
//! load balancer. The legacy app hash is not a state-root commitment to the
//! market registry, so the bracket proves consistency, not authenticity: every
//! backend that can answer the snapshot read must run a qualified image.

use super::MarketsSnapshot;
use super::{chain, decode_snapshot, values, AppHash, BlockHeight, ChainIdentity};
use super::{MarketsSnapshotClient, NodeId};
use super::{SnapshotError, MAX_SNAPSHOT_BYTES};
use serde::Deserialize;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotWitness {
    pub node_id: NodeId,
    pub height: BlockHeight,
    pub finalized_block_time_ms: u64,
    /// Engine state after `height`. Header `height + 1` commits this value.
    pub app_hash: AppHash,
}

/// A decoded snapshot and its witness, built only by [`decode_bound_snapshot`].
///
/// ```compile_fail
/// # use proof_trading_sdk::market_snapshot::{BoundMarketsSnapshot, MarketsSnapshot, SnapshotWitness};
/// fn forge(snapshot: MarketsSnapshot, witness: SnapshotWitness) -> BoundMarketsSnapshot {
///     BoundMarketsSnapshot { snapshot, witness }
/// }
/// ```
#[derive(Debug)]
pub struct BoundMarketsSnapshot {
    snapshot: MarketsSnapshot,
    witness: SnapshotWitness,
}

impl BoundMarketsSnapshot {
    pub fn snapshot(&self) -> &MarketsSnapshot {
        &self.snapshot
    }

    pub fn witness(&self) -> &SnapshotWitness {
        &self.witness
    }
}

/// A decoded status read with its node identity and app hash, built only by
/// [`decode_bound_identity`].
///
/// ```compile_fail
/// # use proof_trading_sdk::market_snapshot::{AppHash, BoundChainIdentity, ChainIdentity, NodeId};
/// fn forge(identity: ChainIdentity, node_id: NodeId, app_hash: AppHash) -> BoundChainIdentity {
///     BoundChainIdentity { identity, node_id, app_hash, app_hash_height: 1 }
/// }
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundChainIdentity {
    identity: ChainIdentity,
    node_id: NodeId,
    app_hash: AppHash,
    app_hash_height: u64,
}

impl BoundChainIdentity {
    pub fn identity(&self) -> &ChainIdentity {
        &self.identity
    }

    pub fn node_id(&self) -> NodeId {
        self.node_id
    }

    pub fn app_hash(&self) -> AppHash {
        self.app_hash
    }

    /// `/status.latest_app_hash` comes from the latest block HEADER and is
    /// therefore post-(latest_height - 1), not post-latest_height. Zero is a
    /// real value here: it is the state before the first block.
    pub fn app_hash_height(&self) -> u64 {
        self.app_hash_height
    }
}

/// A snapshot whose witness passed [`validate_bound_inventory`] against the
/// status reads before and after it. Only that validator builds one, and its
/// parts are read-only.
///
/// ```
/// # use proof_trading_sdk::market_snapshot::{BlockHeight, BoundInventorySnapshot};
/// fn witnessed_height(bound: &BoundInventorySnapshot) -> BlockHeight {
///     bound.witness().height
/// }
/// ```
///
/// ```compile_fail
/// # use proof_trading_sdk::market_snapshot::BoundInventorySnapshot;
/// fn forge(bound: &mut BoundInventorySnapshot) {
///     bound.witness.node_id = [0; 20];
/// }
/// ```
#[derive(Debug)]
pub struct BoundInventorySnapshot {
    snapshot: MarketsSnapshot,
    witness: SnapshotWitness,
    before: BoundChainIdentity,
    after: BoundChainIdentity,
}

impl BoundInventorySnapshot {
    pub fn snapshot(&self) -> &MarketsSnapshot {
        &self.snapshot
    }

    pub fn witness(&self) -> &SnapshotWitness {
        &self.witness
    }

    pub fn before(&self) -> &BoundChainIdentity {
        &self.before
    }

    pub fn after(&self) -> &BoundChainIdentity {
        &self.after
    }

    pub fn into_snapshot(self) -> MarketsSnapshot {
        self.snapshot
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum WitnessError {
    /// The snapshot, status or block read itself failed.
    Snapshot(SnapshotError),
    /// The snapshot response carries no `witness` object.
    MissingWitness,
    /// The witness object announces a version this SDK does not decode.
    UnsupportedWitnessVersion { version: u8 },
    /// A witness or status field is not the hexadecimal or decimal shape its
    /// contract requires, or is the empty value that names nothing.
    MalformedWitness,
    /// Never returned: the bracket does not compare node ids.
    #[deprecated = "never returned; the bracket does not compare node ids"]
    BackendMismatch,
    /// The witness names a different height than the snapshot it accompanies.
    WitnessHeightMismatch,
    /// The status reads do not bracket the snapshot's height.
    BracketOutOfOrder,
    /// A status read's app hash does not sit exactly one height below its own
    /// latest height, so the two cannot describe the same node.
    AnchorHeightInconsistent,
    /// `/v1/block` answered for a height other than the requested `H + 1`.
    HeaderHeightMismatch,
    /// `H + 1` does not fit a `u64`.
    HeightOverflow,
    /// The snapshot's finalized clock sits outside its bracket, or a same-height
    /// read reports a different clock.
    ClockMismatch,
    /// Two reads of the same state height report different app hashes, or the
    /// committing header does not carry the witness's app hash.
    AppHashMismatch,
    /// The bracket needs the `/v1/block?height=H+1` body and the caller passed
    /// none.
    MissingBlockBody,
    /// Height `H + 1` is not committed yet, so nothing commits the witness's
    /// app hash. The read is unfinished, not refused.
    NotYetCommitted,
}

impl From<SnapshotError> for WitnessError {
    fn from(error: SnapshotError) -> Self {
        Self::Snapshot(error)
    }
}
impl fmt::Display for WitnessError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "bound market snapshot refused: {self:?}")
    }
}
impl std::error::Error for WitnessError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireWitness {
    version: u8,
    node_id: String,
    height: String,
    finalized_block_time_ms: String,
    app_hash: String,
}
#[derive(Deserialize)]
struct WireEnvelope {
    witness: Option<WireWitness>,
}
#[derive(Deserialize)]
struct BoundStatus {
    node_info: NodeInfo,
    sync_info: SyncInfo,
}
#[derive(Deserialize)]
struct NodeInfo {
    id: String,
}
#[derive(Deserialize)]
struct SyncInfo {
    latest_app_hash: String,
}
#[derive(Deserialize)]
struct BlockResult {
    block: Block,
}
#[derive(Deserialize)]
struct Block {
    header: BlockHeader,
}
#[derive(Deserialize)]
struct BlockHeader {
    chain_id: String,
    height: String,
    app_hash: String,
}

fn positive_decimal(text: &str) -> Result<u64, WitnessError> {
    values::positive_decimal(text).ok_or(WitnessError::MalformedWitness)
}

fn node_id(text: &str) -> Result<NodeId, WitnessError> {
    values::hex_array(text)
        .and_then(NodeId::new)
        .ok_or(WitnessError::MalformedWitness)
}

fn app_hash(text: &str) -> Result<AppHash, WitnessError> {
    values::hex_array(text)
        .and_then(AppHash::new)
        .ok_or(WitnessError::MalformedWitness)
}

fn block_height(text: &str) -> Result<BlockHeight, WitnessError> {
    values::positive_decimal(text)
        .and_then(BlockHeight::new)
        .ok_or(WitnessError::MalformedWitness)
}

/// Decodes a snapshot together with the `witness` envelope that binds it to a
/// node and a state hash. A response carrying no witness is refused here;
/// [`decode_snapshot`] reads the same body without one.
pub fn decode_bound_snapshot(
    body: &[u8],
    expected_chain: [u8; 32],
) -> Result<BoundMarketsSnapshot, WitnessError> {
    let snapshot = decode_snapshot(body, expected_chain)?;
    let raw: WireEnvelope =
        serde_json::from_slice(body).map_err(|_| WitnessError::MalformedWitness)?;
    let raw = raw.witness.ok_or(WitnessError::MissingWitness)?;
    if raw.version != 1 {
        return Err(WitnessError::UnsupportedWitnessVersion {
            version: raw.version,
        });
    }
    let witness = SnapshotWitness {
        node_id: node_id(&raw.node_id)?,
        height: block_height(&raw.height)?,
        finalized_block_time_ms: positive_decimal(&raw.finalized_block_time_ms)?,
        app_hash: app_hash(&raw.app_hash)?,
    };
    if witness.height.get() != snapshot.height {
        return Err(WitnessError::WitnessHeightMismatch);
    }
    Ok(BoundMarketsSnapshot { snapshot, witness })
}

pub fn decode_bound_identity(
    body: &[u8],
    expected_chain: [u8; 32],
) -> Result<BoundChainIdentity, WitnessError> {
    if body.len() > MAX_SNAPSHOT_BYTES {
        return Err(SnapshotError::TooLarge.into());
    }
    let identity = chain::decode_identity(body, expected_chain)?;
    let raw: BoundStatus = chain::rpc(body)?;
    let app_hash_height = identity
        .latest_height
        .get()
        .checked_sub(1)
        .ok_or(WitnessError::NotYetCommitted)?;
    Ok(BoundChainIdentity {
        identity,
        node_id: node_id(&raw.node_info.id)?,
        app_hash: app_hash(&raw.sync_info.latest_app_hash)?,
        app_hash_height,
    })
}

fn validate_bracket(
    bound: &BoundMarketsSnapshot,
    before: &BoundChainIdentity,
    after: &BoundChainIdentity,
) -> Result<(), WitnessError> {
    validate_anchor_progress(before, after)?;
    let snapshot = &bound.snapshot;
    let witness = &bound.witness;
    if before.identity.chain_binding != snapshot.chain_id
        || after.identity.chain_binding != snapshot.chain_id
    {
        return Err(SnapshotError::WrongChain.into());
    }
    if witness.height.get() != snapshot.height {
        return Err(WitnessError::WitnessHeightMismatch);
    }
    if before.identity.latest_height.get() > snapshot.height
        || snapshot.height > after.identity.latest_height.get()
    {
        return Err(WitnessError::BracketOutOfOrder);
    }
    if before.app_hash_height.checked_add(1) != Some(before.identity.latest_height.get())
        || after.app_hash_height.checked_add(1) != Some(after.identity.latest_height.get())
    {
        return Err(WitnessError::AnchorHeightInconsistent);
    }
    let time = witness.finalized_block_time_ms;
    if before.identity.latest_block_time_ms > time
        || time > after.identity.latest_block_time_ms
        || (before.identity.latest_height.get() == snapshot.height
            && before.identity.latest_block_time_ms != time)
        || (after.identity.latest_height.get() == snapshot.height
            && after.identity.latest_block_time_ms != time)
    {
        return Err(WitnessError::ClockMismatch);
    }
    Ok(())
}

fn validate_anchor_progress(
    previous: &BoundChainIdentity,
    next: &BoundChainIdentity,
) -> Result<(), WitnessError> {
    if next.identity.latest_height < previous.identity.latest_height {
        return Err(WitnessError::BracketOutOfOrder);
    }
    if next.identity.latest_block_time_ms < previous.identity.latest_block_time_ms
        || (next.identity.latest_height == previous.identity.latest_height
            && next.identity.latest_block_time_ms != previous.identity.latest_block_time_ms)
    {
        return Err(WitnessError::ClockMismatch);
    }
    if next.app_hash_height == previous.app_hash_height && next.app_hash != previous.app_hash {
        return Err(WitnessError::AppHashMismatch);
    }
    Ok(())
}

/// Validate a completed bracket. `block_body`, when required, is the response
/// to exactly `/v1/block?height=H+1`, never a generic latest-block read. Wall
/// age and policy-specific lease limits remain the inventory consumer's job.
pub fn validate_bound_inventory(
    bound: BoundMarketsSnapshot,
    before: BoundChainIdentity,
    after: BoundChainIdentity,
    block_body: Option<&[u8]>,
) -> Result<BoundInventorySnapshot, WitnessError> {
    validate_bracket(&bound, &before, &after)?;
    let mut matched = false;
    for anchor in [&before, &after] {
        if anchor.app_hash_height == bound.witness.height.get() {
            if anchor.app_hash != bound.witness.app_hash {
                return Err(WitnessError::AppHashMismatch);
            }
            matched = true;
        }
    }
    if !matched {
        let target = bound
            .witness
            .height
            .get()
            .checked_add(1)
            .ok_or(WitnessError::HeightOverflow)?;
        if after.identity.latest_height.get() < target {
            return Err(WitnessError::NotYetCommitted);
        }
        let body = block_body.ok_or(WitnessError::MissingBlockBody)?;
        if body.len() > MAX_SNAPSHOT_BYTES {
            return Err(SnapshotError::TooLarge.into());
        }
        let result: BlockResult = chain::rpc(body)?;
        let header = result.block.header;
        if positive_decimal(&header.height)? != target {
            return Err(WitnessError::HeaderHeightMismatch);
        }
        if header.chain_id != before.identity.network || header.chain_id != after.identity.network {
            return Err(SnapshotError::WrongChain.into());
        }
        if app_hash(&header.app_hash)? != bound.witness.app_hash {
            return Err(WitnessError::AppHashMismatch);
        }
    }
    Ok(BoundInventorySnapshot {
        snapshot: bound.snapshot,
        witness: bound.witness,
        before,
        after,
    })
}

impl MarketsSnapshotClient {
    pub async fn read_bound(
        &self,
        expected_chain: [u8; 32],
    ) -> Result<BoundMarketsSnapshot, WitnessError> {
        decode_bound_snapshot(&self.get("/v1/markets-snapshot").await?, expected_chain)
    }

    pub async fn chain_identity_bound(
        &self,
        expected_chain: [u8; 32],
    ) -> Result<BoundChainIdentity, WitnessError> {
        decode_bound_identity(&self.get("/v1/status").await?, expected_chain)
    }

    /// Three reads, the client's confirmation polls and one header lookup, under
    /// ONE whole-call deadline. A fast-moving chain does not require the final
    /// status response to happen to land at exactly H+1. No snapshot retry or
    /// alternate-backend fallback; the snapshot's own clock is never renewed.
    pub async fn read_bound_inventory(
        &self,
        expected_chain: [u8; 32],
    ) -> Result<BoundInventorySnapshot, WitnessError> {
        tokio::time::timeout(self.timeout, async {
            let before = self.chain_identity_bound(expected_chain).await?;
            let bound = self.read_bound(expected_chain).await?;
            let mut after = self.chain_identity_bound(expected_chain).await?;
            validate_bracket(&bound, &before, &after)?;
            let target = bound
                .witness
                .height
                .get()
                .checked_add(1)
                .ok_or(WitnessError::HeightOverflow)?;
            // Wait for the next committed header with the same snapshot and
            // its original clock. Reading a newer snapshot each round can
            // phase-lock to the head of a fast chain and verify nothing.
            for _ in 0..self.confirmation.polls {
                if after.identity.latest_height.get() >= target {
                    break;
                }
                tokio::time::sleep(self.confirmation.interval).await;
                let next = self.chain_identity_bound(expected_chain).await?;
                validate_anchor_progress(&after, &next)?;
                validate_bracket(&bound, &before, &next)?;
                after = next;
            }
            let matching_anchor = [&before, &after]
                .iter()
                .any(|anchor| anchor.app_hash_height == bound.witness.height.get());
            let block_body = if matching_anchor {
                None
            } else {
                if after.identity.latest_height.get() < target {
                    return Err(WitnessError::NotYetCommitted);
                }
                Some(
                    self.get_with_query("/v1/block", Some(&format!("height={target}")))
                        .await?,
                )
            };
            validate_bound_inventory(bound, before, after, block_body.as_deref())
        })
        .await
        .map_err(|_| WitnessError::Snapshot(SnapshotError::Timeout))?
    }
}

#[cfg(test)]
mod tests;
