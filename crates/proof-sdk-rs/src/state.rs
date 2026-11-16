//! Typed current-state reads a trading bot checks besides the book: funding
//! and mark, position triggers, sub-accounts, withdrawals and agents.

use std::collections::HashSet;

use proof_trading_sdk::query::{
    AuthorizedAgents as WireAgents, FundingInfo, AUTHORIZED_AGENTS_LIMIT,
};
use proof_trading_sdk::reads::Shape;
use proof_trading_sdk::types::{
    ClientTriggerGroupId, ClientTriggerId, FundingRate, MarketId, OwnerAddress, PositionEpoch,
    Side, SubAccount as WireSubAccount, TriggerSlippageBps, WithdrawalRecord, WithdrawalStatus,
};
use serde::de::IgnoredAny;
use serde::Deserialize;

use crate::address::Address;
use crate::error::{Error, Result};
use crate::info::{de_u64, decode, unbase64, DataEnvelope, InfoClient};

/// A market's funding state and mark, from `GET /v1/funding/{market}`.
///
/// The engine answers an unknown market as one that never funded: every
/// value zero or `None`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Funding {
    pub market: MarketId,
    /// The current rate per interval, exact (1 bps = 10 000). Zero before the
    /// first funding, and from an engine that predates the exact rate.
    pub funding_rate: FundingRate,
    /// The current rate in whole basis points, truncated toward zero.
    pub funding_rate_bps: i64,
    /// The cumulative funding index.
    pub cumulative_funding: i64,
    /// When funding last ran, ms since the epoch; `None` if it never has.
    pub last_funding_ms: Option<u64>,
    /// The mark (an EWMA), micro-USDC. The engine serves the oracle price
    /// until the first trade seeds it; `None` when it has neither.
    pub mark_price: Option<u64>,
    /// The oracle price, micro-USDC; `None` while unset.
    pub oracle_price: Option<u64>,
    pub funding_interval_ms: u64,
    pub max_funding_rate_bps: u32,
}

/// `query::FundingInfo`, with the exact rate appended.
const FUNDING_INFO: Shape = Shape::Record {
    width: 9,
    nested: &[],
};

fn funding(bytes: &[u8], market: MarketId) -> Result<Funding> {
    let f: FundingInfo = decode(bytes, &FUNDING_INFO, "funding")?;
    if f.market != market {
        return Err(Error::Decode(format!(
            "funding is for market {}, asked for {market}",
            f.market
        )));
    }
    let set = |v: u64| (v != 0).then_some(v);
    Ok(Funding {
        market: f.market,
        funding_rate: f.funding_rate,
        funding_rate_bps: f.funding_rate_bps,
        cumulative_funding: f.cumulative_funding,
        last_funding_ms: set(f.last_funding_time_ms),
        mark_price: set(f.mark_price_ewma),
        oracle_price: set(f.oracle_price),
        funding_interval_ms: f.funding_interval_ms,
        max_funding_rate_bps: f.max_funding_rate_bps,
    })
}

// -- position triggers --------------------------------------------------------

/// A position's stop-loss/take-profit bracket, from `GET /v1/triggers/{owner}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PositionTriggers {
    /// The engine's id for this bracket.
    pub group_id: u64,
    pub market: MarketId,
    /// The position generation the bracket protects. Pass it to
    /// [`crate::actions::set_position_triggers`] and
    /// [`crate::actions::cancel_position_triggers`].
    pub position_epoch: PositionEpoch,
    pub position_side: Side,
    /// The block that accepted it; it is live from the next one.
    pub accepted_height: u64,
    pub client_group_id: Option<ClientTriggerGroupId>,
    pub stop_loss: Option<TriggerLimbStatus>,
    pub take_profit: Option<TriggerLimbStatus>,
    /// Whether the bracket can fire at the finalized height.
    pub availability: TriggerAvailability,
}

/// One limb of a [`PositionTriggers`] bracket, as the engine holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TriggerLimbStatus {
    pub limb_id: u64,
    /// micro-USDC.
    pub trigger_price: u64,
    pub max_slippage_bps: TriggerSlippageBps,
    pub client_trigger_id: Option<ClientTriggerId>,
    pub state: TriggerLimbState,
    /// The last time the limb was evaluated, if it has been.
    pub last_evaluation: Option<TriggerEvaluation>,
}

/// The last evaluation of a trigger limb.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TriggerEvaluation {
    pub height: u64,
    /// The mark the evaluation used, micro-USDC.
    pub frozen_mark: u64,
    /// The collar's limit price, if one applied.
    pub limit_price: Option<u64>,
    pub requested_quantity: u64,
    pub filled_quantity: u64,
    /// Why it did not fully fill, if it did not.
    pub reason: Option<TriggerOutcomeReason>,
}

/// Where a trigger limb is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[non_exhaustive]
pub enum TriggerLimbState {
    Armed,
    Filled,
    Partial,
    NoFill,
    Rejected,
    Cancelled,
    Invalidated,
}

/// Why a trigger did not (fully) execute or is deferred.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[non_exhaustive]
pub enum TriggerOutcomeReason {
    PositionClosed,
    PositionEpochChanged,
    PositionSideChanged,
    BelowMaintenance,
    IndeterminateAccount,
    MarketDisabled,
    MarkUnavailable,
    MarkStale,
    MarkFutureDated,
    NoEligibleLiquidity,
    SelfTradePrevention,
    WorkLimitReached,
    ExecutionRejected,
    OracleSessionClosed,
    OracleDisagreement,
    OracleExpiredSource,
    OraclePolicyMissing,
    NoTwoSidedQuote,
    InsufficientMargin,
    InsufficientBalance,
    ReduceOnlyWouldIncrease,
    PositionLimitExceeded,
    OpenInterestLimitExceeded,
    MarketClosed,
    EngineFault,
    MarketHalted,
}

/// Whether a bracket can fire at the finalized height.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize)]
#[non_exhaustive]
pub enum TriggerAvailability {
    Available,
    TriggerActionsInactive,
    PendingActivation,
    MigrationIncomplete,
    ConfigurationMissing,
    MarketDisabled,
    /// Held back for now, for this reason.
    Deferred(TriggerOutcomeReason),
}

#[derive(Deserialize, PartialEq, Eq)]
enum LimbKind {
    StopLoss,
    TakeProfit,
}

/// `PositionTriggerInfo`: bracket, retired market policy, availability.
#[derive(Deserialize)]
struct RawTriggerInfo(RawBracket, Option<IgnoredAny>, TriggerAvailability);

#[derive(Deserialize)]
struct RawBracket(
    u64,
    OwnerAddress,
    MarketId,
    PositionEpoch,
    Side,
    u64,
    u64,
    Option<ClientTriggerGroupId>,
    Option<RawLimb>,
    Option<RawLimb>,
);

#[derive(Deserialize)]
struct RawLimb(
    u64,
    LimbKind,
    u64,
    TriggerSlippageBps,
    Option<ClientTriggerId>,
    TriggerLimbState,
    Option<RawEvaluation>,
);

#[derive(Deserialize)]
struct RawEvaluation(
    u64,
    u64,
    Option<u64>,
    u64,
    u64,
    u64,
    Option<TriggerOutcomeReason>,
);

const TRIGGER_EVALUATION: Shape = Shape::Record {
    width: 7,
    nested: &[],
};
const TRIGGER_LIMB: Shape = Shape::Record {
    width: 7,
    nested: &[(6, Shape::Optional(&TRIGGER_EVALUATION))],
};
const TRIGGER_BRACKET: Shape = Shape::Record {
    width: 10,
    nested: &[
        (8, Shape::Optional(&TRIGGER_LIMB)),
        (9, Shape::Optional(&TRIGGER_LIMB)),
    ],
};
const POSITION_TRIGGER_INFO: Shape = Shape::Record {
    width: 3,
    nested: &[(0, TRIGGER_BRACKET)],
};

fn position_triggers(bytes: &[u8], owner: Address) -> Result<Vec<PositionTriggers>> {
    let rows: Vec<RawTriggerInfo> = decode(
        bytes,
        &Shape::List(&POSITION_TRIGGER_INFO),
        "position triggers",
    )?;
    rows.into_iter()
        .map(|RawTriggerInfo(b, _retired_policy, availability)| {
            let bad = |what: &str| Error::Decode(format!("position triggers: {what}"));
            let RawBracket(group_id, got, market, epoch, side, accepted, active_from, cgid, sl, tp) =
                b;
            if Address::from(got.into_bytes()) != owner {
                return Err(bad("a bracket for another owner"));
            }
            if group_id == 0 || epoch.0 == 0 || accepted == 0 || cgid.is_some_and(|g| g.0 == 0) {
                return Err(bad("a zero id or height"));
            }
            if accepted.checked_add(1) != Some(active_from) {
                return Err(bad("active_from_height is not accepted_height + 1"));
            }
            if sl.is_none() && tp.is_none() {
                return Err(bad("a bracket with no limbs"));
            }
            let stop_loss = sl.map(|l| limb(l, &LimbKind::StopLoss)).transpose()?;
            let take_profit = tp.map(|l| limb(l, &LimbKind::TakeProfit)).transpose()?;
            if let (Some(s), Some(t)) = (stop_loss, take_profit) {
                let same_client_id = s.client_trigger_id.is_some()
                    && s.client_trigger_id == t.client_trigger_id;
                if s.limb_id == t.limb_id || same_client_id {
                    return Err(bad("both limbs share an id"));
                }
            }
            Ok(PositionTriggers {
                group_id,
                market,
                position_epoch: epoch,
                position_side: side,
                accepted_height: accepted,
                client_group_id: cgid,
                stop_loss,
                take_profit,
                availability,
            })
        })
        .collect()
}

fn limb(l: RawLimb, slot: &LimbKind) -> Result<TriggerLimbStatus> {
    let bad = |what: &str| Error::Decode(format!("position triggers: {what}"));
    let RawLimb(limb_id, kind, trigger_price, slippage, client_id, state, evaluation) = l;
    if kind != *slot {
        return Err(bad("a limb in the other limb's slot"));
    }
    if limb_id == 0 || trigger_price == 0 || client_id.is_some_and(|c| c.0 == 0) {
        return Err(bad("a zero limb id, trigger price or client trigger id"));
    }
    if !(1..=9_999).contains(&slippage.0) {
        return Err(bad("limb slippage outside 1..=9999"));
    }
    let last_evaluation = evaluation
        .map(
            |RawEvaluation(
                height,
                frozen_mark,
                limit_price,
                requested,
                filled,
                residual,
                reason,
            )| {
                if filled.checked_add(residual) != Some(requested) {
                    return Err(bad("evaluation quantities do not add up"));
                }
                Ok(TriggerEvaluation {
                    height,
                    frozen_mark,
                    limit_price,
                    requested_quantity: requested,
                    filled_quantity: filled,
                    reason,
                })
            },
        )
        .transpose()?;
    Ok(TriggerLimbStatus {
        limb_id,
        trigger_price,
        max_slippage_bps: slippage,
        client_trigger_id: client_id,
        state,
        last_evaluation,
    })
}

// -- sub-accounts -------------------------------------------------------------

/// One sub-account under a master, from `POST /info {subAccountList}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubAccount {
    /// The id the master created it under.
    pub id: u32,
    pub address: Address,
    /// Its label, without the zero padding.
    pub name: String,
    pub created_height: u64,
}

const SUB_ACCOUNT: Shape = Shape::Record {
    width: 5,
    nested: &[],
};

fn sub_accounts(bytes: &[u8], master: Address) -> Result<Vec<SubAccount>> {
    let rows: Vec<WireSubAccount> = decode(bytes, &Shape::List(&SUB_ACCOUNT), "sub-account list")?;
    let bad = |what: &str| Error::Decode(format!("sub-account list: {what}"));
    let (mut ids, mut addresses) = (HashSet::new(), HashSet::new());
    rows.into_iter()
        .map(|row| {
            if Address::from(row.master.into_bytes()) != master {
                return Err(bad("a row for another master"));
            }
            let address = Address::from(row.address.into_bytes());
            if row.sub_account_id == 0
                || !ids.insert(row.sub_account_id)
                || !addresses.insert(address)
            {
                return Err(bad("a zero or repeated id or address"));
            }
            let end = row
                .name
                .iter()
                .rposition(|&b| b != 0)
                .map_or(0, |i| i.saturating_add(1));
            let name = std::str::from_utf8(&row.name[..end])
                .map_err(|_| bad("a name that is not UTF-8"))?
                .to_owned();
            Ok(SubAccount {
                id: row.sub_account_id,
                address,
                name,
                created_height: row.created_height,
            })
        })
        .collect()
}

// -- withdrawals --------------------------------------------------------------

/// A withdrawal request and where it stands, from
/// `POST /info {withdrawalStatus}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Withdrawal {
    pub id: u64,
    pub owner: Address,
    /// micro-USDC, before custody fees.
    pub amount: u64,
    /// The Solana account it pays out to.
    pub solana_destination: [u8; 32],
    pub status: WithdrawalStatus,
    /// The block that accepted the request.
    pub request_height: u64,
}

const WITHDRAWAL_RECORD: Shape = Shape::Record {
    width: 6,
    nested: &[],
};

fn withdrawal(bytes: &[u8], id: u64) -> Result<Option<Withdrawal>> {
    let record: Option<WithdrawalRecord> = decode(
        bytes,
        &Shape::Optional(&WITHDRAWAL_RECORD),
        "withdrawal status",
    )?;
    record
        .map(|r| {
            if r.id != id {
                return Err(Error::Decode(format!(
                    "withdrawal status is for {}, asked for {id}",
                    r.id
                )));
            }
            Ok(Withdrawal {
                id: r.id,
                owner: Address::from(r.owner),
                amount: r.amount,
                solana_destination: r.solana_destination,
                status: r.status,
                request_height: r.request_height,
            })
        })
        .transpose()
}

// -- agents -------------------------------------------------------------------

/// The agents `owner` has approved to trade for it, from
/// `GET /v2/account/{owner}/agents`: explicit grants only, not the owner's
/// own key or a master's authority over its sub-accounts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedAgents {
    pub owner: Address,
    /// The finalized block this list is as of.
    pub height: u64,
    /// Agent addresses ([`Address::from_public_key`] of each approved key),
    /// in ascending order.
    pub agents: Vec<Address>,
    /// False when more grants exist than the 100 the read returns.
    pub complete: bool,
}

/// `query::AuthorizedAgents` is a map; nothing to cut.
const AUTHORIZED_AGENTS: Shape = Shape::Record {
    width: 4,
    nested: &[],
};

#[derive(Deserialize)]
struct Witnessed {
    data: String,
    witness: Witness,
}

#[derive(Deserialize)]
struct Witness {
    #[serde(deserialize_with = "de_u64")]
    height: u64,
}

fn authorized_agents(body: Witnessed, owner: Address) -> Result<AuthorizedAgents> {
    let bad = |what: &str| Error::Decode(format!("authorized agents: {what}"));
    let bytes = unbase64(&body.data)?;
    if !matches!(bytes.first(), Some(0x80..=0x8f | 0xde | 0xdf)) {
        return Err(bad("not a MessagePack map"));
    }
    let view: WireAgents = decode(&bytes, &AUTHORIZED_AGENTS, "authorized agents")?;
    if Address::from(view.owner.0) != owner {
        return Err(bad("the list is for another owner"));
    }
    if view.finalized_height != body.witness.height {
        return Err(bad("the list's height is not the witness height"));
    }
    let n = view.agents.len();
    if n > AUTHORIZED_AGENTS_LIMIT || (!view.complete && n != AUTHORIZED_AGENTS_LIMIT) {
        return Err(bad("the list's length and completeness disagree"));
    }
    if view.agents.windows(2).any(|w| w[0] >= w[1]) {
        return Err(bad("agents are not in strictly ascending order"));
    }
    Ok(AuthorizedAgents {
        owner,
        height: view.finalized_height,
        agents: view
            .agents
            .into_iter()
            .map(|a| Address::from(a.0))
            .collect(),
        complete: view.complete,
    })
}

impl InfoClient {
    /// `GET /v1/funding/{market}`: the market's funding rate, index and mark.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also when the answer is for another market) or
    /// [`Error::ResponseTooLarge`].
    pub async fn funding(&self, market: MarketId) -> Result<Funding> {
        let bytes = self.get_data(&format!("/v1/funding/{market}")).await?;
        funding(&bytes, market)
    }

    /// `GET /v1/triggers/{owner}`: `owner`'s stop-loss/take-profit brackets.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for a bracket of another owner or a limb state, reason or
    /// availability this version does not know) or
    /// [`Error::ResponseTooLarge`].
    pub async fn position_triggers(&self, owner: Address) -> Result<Vec<PositionTriggers>> {
        let bytes = self.get_data(&format!("/v1/triggers/{owner}")).await?;
        position_triggers(&bytes, owner)
    }

    /// `POST /info {subAccountList}`: the sub-accounts `master` created.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`] (501 when the
    /// gateway does not serve the registry), [`Error::Decode`] (also for a
    /// row of another master) or [`Error::ResponseTooLarge`].
    pub async fn sub_accounts(&self, master: Address) -> Result<Vec<SubAccount>> {
        let body = serde_json::json!({ "type": "subAccountList", "user": master.to_string() });
        let env: DataEnvelope = self.post_info(&body).await?;
        sub_accounts(&unbase64(&env.data)?, master)
    }

    /// `POST /info {withdrawalStatus}`: withdrawal `id`; `None` when the
    /// engine has no such withdrawal.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for an answer about another withdrawal or a status this version
    /// does not know) or [`Error::ResponseTooLarge`].
    pub async fn withdrawal(&self, id: u64) -> Result<Option<Withdrawal>> {
        let body = serde_json::json!({ "type": "withdrawalStatus", "withdrawalId": id });
        let env: DataEnvelope = self.post_info(&body).await?;
        withdrawal(&unbase64(&env.data)?, id)
    }

    /// `GET /v2/account/{owner}/agents?witness=1`: the agents `owner` has
    /// approved ([`crate::actions::approve_agent`]).
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also for a list of another owner, or one at another height than its
    /// witness) or [`Error::ResponseTooLarge`].
    pub async fn authorized_agents(&self, owner: Address) -> Result<AuthorizedAgents> {
        let body: Witnessed = self
            .get_json(&format!("/v2/account/{owner}/agents?witness=1"))
            .await?;
        authorized_agents(body, owner)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn devnet_funding_decodes_with_zeros_as_none() {
        // Captured from https://api.dev.proof.trade/v1/funding/1 and /99999 (2026-11-16).
        let bytes =
            unbase64("mQEO0//ICPxTdD2jzwAAAaHiTBeAzwAAAA9S4sOnzwAAAA8jPhKgzgA27oDNAZDOAAI6Ag==")
                .unwrap();
        let f = funding(&bytes, 1).unwrap();
        assert_eq!(f.funding_rate_bps, 14);
        assert_eq!(f.funding_rate, FundingRate(145_922));
        assert_eq!(f.funding_interval_ms, 3_600_000);
        assert!(f.mark_price.is_some() && f.oracle_price.is_some() && f.last_funding_ms.is_some());

        let unknown = unbase64("mc4AAYafAAAAAAAAAAA=").unwrap();
        let f = funding(&unknown, 99_999).unwrap();
        assert_eq!(
            (f.mark_price, f.oracle_price, f.last_funding_ms),
            (None, None, None)
        );
        assert!(matches!(funding(&unknown, 1), Err(Error::Decode(_))));
    }

    #[test]
    fn devnet_withdrawal_decodes_and_binds_its_id() {
        // Captured from devnet `POST /info {withdrawalStatus, withdrawalId: 1}` (2026-11-16).
        let bytes = unbase64("lgHcABTMvQ4RzNADzO/MyMylPkLMhsy0HXDMq8z7ZczlzPHMhs8AAAACUYl2GNwAIDHMokg7NV3Ml8yozOLMgg7Ms8y0zJ4/zIwhDAtPXsyozODMoXsTE8ypzJnMj3zM5KdQZW5kaW5nzgBgr8g=").unwrap();
        let w = withdrawal(&bytes, 1).unwrap().unwrap();
        assert_eq!(w.status, WithdrawalStatus::Pending);
        assert_eq!(w.amount, 9_957_897_752);
        assert_eq!(w.request_height, 6_336_456);
        assert!(matches!(withdrawal(&bytes, 2), Err(Error::Decode(_))));
        assert_eq!(withdrawal(&[0xc0], 7).unwrap(), None);
    }
}
