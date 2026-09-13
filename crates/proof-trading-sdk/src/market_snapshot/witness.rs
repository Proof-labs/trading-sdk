//! Bound market-inventory reads, not an oracle-health or light-client API.
//!
//! The public Comet node ID binds the three reads to one configured backend.
//! Qualified images and unique node keys remain deployment prerequisites: the
//! legacy app hash is not a state-root commitment to the market registry.

use super::{chain, decode_snapshot, ChainIdentity, MarketsSnapshot, MarketsSnapshotClient};
use super::{SnapshotError, MAX_SNAPSHOT_BYTES};
use serde::Deserialize;
use std::fmt;
use std::time::Duration;

const MAX_CONFIRMATION_POLLS: usize = 8;
const CONFIRMATION_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotWitness {
    pub node_id: [u8; 20],
    pub height: u64,
    pub finalized_block_time_ms: u64,
    /// Engine state after `height`. Header `height + 1` commits this value.
    pub app_hash: [u8; 32],
}

#[derive(Debug)]
pub struct BoundMarketsSnapshot {
    pub snapshot: MarketsSnapshot,
    pub witness: SnapshotWitness,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BoundChainIdentity {
    pub identity: ChainIdentity,
    pub node_id: [u8; 20],
    pub app_hash: [u8; 32],
    /// `/status.latest_app_hash` comes from the latest block HEADER and is
    /// therefore post-(latest_height - 1), not post-latest_height.
    pub app_hash_height: u64,
}

#[derive(Debug)]
pub struct BoundInventorySnapshot {
    pub snapshot: MarketsSnapshot,
    pub witness: SnapshotWitness,
    pub before: BoundChainIdentity,
    pub after: BoundChainIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum WitnessError {
    Snapshot(SnapshotError),
    MissingWitness,
    Malformed,
    BackendMismatch,
    HeightMismatch,
    TimeMismatch,
    HashMismatch,
    Uncommitted,
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
    if text.is_empty() || text.starts_with('0') || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(WitnessError::Malformed);
    }
    text.parse().map_err(|_| WitnessError::Malformed)
}

fn nonzero_hex<const N: usize>(text: &str) -> Result<[u8; N], WitnessError> {
    if text.len() != N.saturating_mul(2) || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(WitnessError::Malformed);
    }
    let mut result = [0; N];
    for (out, pair) in result.iter_mut().zip(text.as_bytes().chunks_exact(2)) {
        let pair = std::str::from_utf8(pair).map_err(|_| WitnessError::Malformed)?;
        *out = u8::from_str_radix(pair, 16).map_err(|_| WitnessError::Malformed)?;
    }
    if result == [0; N] {
        return Err(WitnessError::Malformed);
    }
    Ok(result)
}

/// Additive decoder. The legacy four-field MessagePack decoder is unchanged;
/// only this explicit bound API requires the node's new witness envelope.
pub fn decode_bound_snapshot(
    body: &[u8],
    expected_chain: [u8; 32],
) -> Result<BoundMarketsSnapshot, WitnessError> {
    let snapshot = decode_snapshot(body, expected_chain)?;
    let raw: WireEnvelope = serde_json::from_slice(body).map_err(|_| WitnessError::Malformed)?;
    let raw = raw.witness.ok_or(WitnessError::MissingWitness)?;
    if raw.version != 1 {
        return Err(WitnessError::Malformed);
    }
    let witness = SnapshotWitness {
        node_id: nonzero_hex(&raw.node_id)?,
        height: positive_decimal(&raw.height)?,
        finalized_block_time_ms: positive_decimal(&raw.finalized_block_time_ms)?,
        app_hash: nonzero_hex(&raw.app_hash)?,
    };
    if witness.height != snapshot.height {
        return Err(WitnessError::HeightMismatch);
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
        .checked_sub(1)
        .ok_or(WitnessError::Uncommitted)?;
    Ok(BoundChainIdentity {
        identity,
        node_id: nonzero_hex(&raw.node_info.id)?,
        app_hash: nonzero_hex(&raw.sync_info.latest_app_hash)?,
        app_hash_height,
    })
}

fn validate_bracket(
    bound: &BoundMarketsSnapshot,
    before: &BoundChainIdentity,
    after: &BoundChainIdentity,
) -> Result<(), WitnessError> {
    let snapshot = &bound.snapshot;
    let witness = &bound.witness;
    if witness.node_id != before.node_id || witness.node_id != after.node_id {
        return Err(WitnessError::BackendMismatch);
    }
    if before.identity.chain_binding != snapshot.chain_id
        || after.identity.chain_binding != snapshot.chain_id
    {
        return Err(SnapshotError::WrongChain.into());
    }
    if witness.height != snapshot.height
        || before.identity.latest_height > snapshot.height
        || snapshot.height > after.identity.latest_height
        || before.app_hash_height.checked_add(1) != Some(before.identity.latest_height)
        || after.app_hash_height.checked_add(1) != Some(after.identity.latest_height)
    {
        return Err(WitnessError::HeightMismatch);
    }
    let time = witness.finalized_block_time_ms;
    if before.identity.latest_block_time_ms > time
        || time > after.identity.latest_block_time_ms
        || (before.identity.latest_height == snapshot.height
            && before.identity.latest_block_time_ms != time)
        || (after.identity.latest_height == snapshot.height
            && after.identity.latest_block_time_ms != time)
    {
        return Err(WitnessError::TimeMismatch);
    }
    if before.app_hash_height == after.app_hash_height && before.app_hash != after.app_hash {
        return Err(WitnessError::HashMismatch);
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
        if anchor.app_hash_height == bound.witness.height {
            if anchor.app_hash != bound.witness.app_hash {
                return Err(WitnessError::HashMismatch);
            }
            matched = true;
        }
    }
    if !matched {
        let target = bound
            .witness
            .height
            .checked_add(1)
            .ok_or(WitnessError::HeightMismatch)?;
        if after.identity.latest_height < target {
            return Err(WitnessError::Uncommitted);
        }
        let body = block_body.ok_or(WitnessError::Uncommitted)?;
        if body.len() > MAX_SNAPSHOT_BYTES {
            return Err(SnapshotError::TooLarge.into());
        }
        let result: BlockResult = chain::rpc(body)?;
        let header = result.block.header;
        if positive_decimal(&header.height)? != target {
            return Err(WitnessError::HeightMismatch);
        }
        if header.chain_id != before.identity.network || header.chain_id != after.identity.network {
            return Err(SnapshotError::WrongChain.into());
        }
        if nonzero_hex::<32>(&header.app_hash)? != bound.witness.app_hash {
            return Err(WitnessError::HashMismatch);
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

    /// Three reads, at most eight confirmation polls and one header lookup, under ONE
    /// whole-call deadline. A fast-moving chain does not require the final
    /// status response to happen to land at exactly H+1. No snapshot retry or
    /// alternate-backend fallback; the candidate clock is never renewed.
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
                .checked_add(1)
                .ok_or(WitnessError::HeightMismatch)?;
            // Keep the same candidate and its original clock while waiting for
            // the next committed header. Starting over with a newer snapshot
            // can phase-lock fast reads to the head and never verify anything.
            for _ in 0..MAX_CONFIRMATION_POLLS {
                if after.identity.latest_height >= target {
                    break;
                }
                tokio::time::sleep(CONFIRMATION_POLL_INTERVAL).await;
                after = self.chain_identity_bound(expected_chain).await?;
                validate_bracket(&bound, &before, &after)?;
            }
            let matching_anchor = [&before, &after]
                .iter()
                .any(|anchor| anchor.app_hash_height == bound.witness.height);
            let block_body = if matching_anchor {
                None
            } else {
                if after.identity.latest_height < target {
                    return Err(WitnessError::Uncommitted);
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
