//! Engine result-code classification for clients (SDK representation).
//!
//! The wire *contract* (codec, action table, ExecError codes) lives in
//! `exchange-wire`; this module is the client-side decode of a numeric result
//! code into a named, human-meaningful kind. Reconciling `ERROR_KINDS` with
//! `exchange_wire::types::ExecError::code()` (single-sourcing the table) is a
//! follow-up.

macro_rules! define_error_kinds {
    ($($code:literal => $name:ident ~ $meaning:literal),+ $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum ErrorKind {
            $($name,)+
        }

        impl ErrorKind {
            pub fn code(self) -> u32 {
                match self {
                    $(Self::$name => $code,)+
                }
            }

            pub fn name(self) -> &'static str {
                match self {
                    $(Self::$name => stringify!($name),)+
                }
            }

            pub fn meaning(self) -> &'static str {
                match self {
                    $(Self::$name => $meaning,)+
                }
            }
        }

        /// The complete error-kind manifest — one entry per variant, in
        /// definition order. Used by every language binding.
        pub const ERROR_KINDS: &[ErrorKind] = &[$(ErrorKind::$name),+];
    };
}

define_error_kinds! {
    1   => DecodeError         ~ "Tx envelope or payload could not be decoded as MessagePack at the expected version. Indicates a malformed wire frame or a client/server version mismatch.",
    2   => OrderNotFound       ~ "Order ID does not exist on the requested market, or has already been filled or cancelled.",
    3   => NotOwner            ~ "Tx signer is not the owner of the referenced order; only the owner (or an approved agent) may cancel or amend it.",
    4   => UnauthorizedOracle  ~ "Oracle update was signed by a key that is not registered as an oracle signer for the market.",
    5   => Overflow            ~ "An arithmetic operation (price * quantity, fee accrual, position size) overflowed a u64. Almost always indicates a malformed input rather than legitimate volume.",
    6   => InvalidPrice        ~ "Price is zero, exceeds the per-market max, or violates tick-size quantization.",
    7   => InvalidQuantity     ~ "Quantity is zero, exceeds the per-market max, or violates lot-size quantization.",
    8   => InvalidSide         ~ "Side byte is neither Buy (0) nor Sell (1).",
    9   => UnknownMarket       ~ "Market ID is not registered. Either the market does not exist or it has been removed.",
    10  => StateCorruption     ~ "Engine read state in an unexpected shape (e.g. missing required key, malformed value). Indicates a bug or data corruption — file an issue with the surrounding context.",
    11  => InsufficientBalance ~ "Account's USDC balance cannot cover the requested debit (deposit, withdrawal, or fee).",
    12  => InsufficientMargin  ~ "Post-trade equity would fall below the initial-margin requirement for the resulting portfolio. Reduce order size, add collateral, or close offsetting positions.",
    13  => UnauthorizedRelayer ~ "Tx is a relayer-only action (oracle update, funding tick, deposit confirmation, etc.) but the signer is not registered as an authorized relayer.",
    14  => WithdrawalNotFound            ~ "Withdrawal ID does not exist or has already been claimed/refunded.",
    15  => WithdrawalAlreadyProcessed    ~ "Withdrawal was already settled (claim or refund); duplicate finalize call rejected.",
    16  => DuplicateDeposit             ~ "On-chain deposit signature has already been credited; idempotency guard rejected the replay.",
    17  => InvalidSignature             ~ "Ed25519 verification of the V2 envelope failed. Signature, pubkey, or signed bytes are wrong.",
    18  => SignatureRequired            ~ "A signed (V2) transaction envelope is required. Unsigned (V1) envelopes are not accepted.",
    19  => AgentNotAuthorized           ~ "Tx signer is neither the account owner nor on the owner's approved-agent list.",
    20  => AgentCannotWithdraw          ~ "Agent wallets may place/cancel/market orders but are forbidden from initiating withdrawals.",
    21  => InvalidNonce                 ~ "Timestamp nonce failed replay-window validation. Use a unique millisecond Unix timestamp within [block_time-2d, block_time+1d]; included failures burn their nonce.",
    22  => MarketAlreadyExists          ~ "Attempted CreateMarket for a market ID already in the registry.",
    23  => InvalidMarketConfig          ~ "MarketConfig fields fail validation (e.g. fee bps out of range, lot/tick zero, IM/MM ratio inverted).",
    24  => ImpactMarketAlreadyExists    ~ "Attempted CreateImpactMarket for an impact market ID already in the registry.",
    25  => ImpactMarketNotFound         ~ "Impact market ID does not exist; cannot resolve, cash-out, or query.",
    26  => MarketClosedForTrading       ~ "Order placement attempted on a conditional/binary book whose parent impact market is already resolved or voided.",
    27  => BinaryPriceOutOfRange        ~ "Binary-book order price is outside the [0, BINARY_PRICE_MAX] range.",
    28  => InvalidResolution            ~ "ResolveEvent called with an outcome incompatible with the current state (already resolved, outcome not in the configured set, etc.).",
    29  => PositionLimitExceeded        ~ "Fill would push absolute net position past MarketConfig.max_position_size. Engine cap enforced at placement time independent of margin.",
    30  => OracleTimestampNotMonotonic  ~ "OracleUpdate publish_time_ms is not strictly greater than the last accepted update for this market — replay protection per audit B3 (2026-04-23).",
    31  => TooManyActiveImpactMarkets   ~ "Account would touch more impact markets than the scenario margin engine can enumerate (MAX_IMPACT_MARKETS_PER_ACCOUNT). Close a leg before opening another.",
    32  => SettlementPriceMismatch      ~ "Net-delta margin grouping found legs with disagreeing settle prices (data corruption across same underlying_market_id).",
    33  => OracleNotApplicable          ~ "OracleUpdate targets an impact-family market (CPY/CPN/EBY/EBN), which marks off the book and has no oracle layer.",
    34  => PostOnlyWouldCross           ~ "PlaceOrder with post_only=true would have crossed the book. Rejected so makers retain maker-side fills.",
    35  => ReduceOnlyWouldIncrease      ~ "PlaceOrder/MarketOrder with reduce_only=true was same-side as the existing position (would increase exposure) or no position existed.",
    36  => TestActionRejected           ~ "Test/admin action rejected because the engine isn't configured to accept them, or the position the action referenced does not exist.",
    37  => StaleOracle                  ~ "Oracle price is stale for this market; refresh the oracle before placing orders, reading margin, or liquidating.",
    38  => UserLeverageBelowMarketIm    ~ "User-selected initial margin is below the market risk floor; only deleveraging above the market floor is allowed.",
    39  => TickSizeViolation            ~ "Order price is not an exact multiple of the market tick size.",
    40  => LotSizeViolation             ~ "Order quantity is not an exact multiple of the market lot size.",
    41  => OracleStaleNotElapsed        ~ "Fallback oracle signer published before the market staleness window elapsed.",
    42  => FeeBpsOutOfRange             ~ "Per-account fee override has a fee outside the legal basis-point range.",
    43  => FeeOverrideStaleSeq          ~ "Per-account fee override sequence is stale or out of order.",
    44  => ClientOrderIdNotFound        ~ "No active resting order exists for the requested client order id.",
    45  => DuplicateClientOrderId       ~ "An active resting order already uses the requested client order id.",
    46  => InvalidClientOrderId         ~ "Client order id zero is reserved and cannot be submitted.",
    47  => FillOrKillWouldNotFill       ~ "Fill-or-kill order cannot be fully filled immediately at the submitted limit price.",
    48  => InvalidCancelReplaceTarget   ~ "Cancel-replace must specify exactly one active order target: either orderId or clientOrderId.",
    49  => AmendBelowFilled             ~ "AmendOrder new quantity is below the quantity already filled while the order rested.",
    50  => SlippageExceeded             ~ "Atomic basket aggregate slippage exceeded the submitted max_slippage_bps budget.",
    51  => OpenInterestLimitExceeded    ~ "Fill would push aggregate market open interest past MarketConfig.max_open_interest.",
    52  => AdminGovernanceInactive      ~ "Admin governance action was submitted while no admin signer registry exists on this chain; multisig administration is inactive and every governance path fails closed.",
    53  => NotAdminSigner               ~ "Tx signer does not match the action's declared proposer/approver/rejecter/signer field, or is not a member of the current admin signer registry.",
    // Proposal-lifecycle family (multisig governance). Mirrored from the
    // engine's `ExecError` (exchange-core/src/types.rs, codes 54-71) and the
    // frozen exchange/sdk reference table. Decode-only on the SDK side — the
    // client never constructs these, it classifies the result codes.
    54  => ProposalNotFound                 ~ "No admin proposal exists under this id (never created, or pruned from terminal retention).",
    55  => ProposalNotPending               ~ "The admin proposal is already terminal — votes are only accepted while pending.",
    56  => ProposalExpired                  ~ "The admin proposal passed its TTL — re-propose and collect fresh approvals.",
    57  => DuplicateApproval                ~ "This signer already approved the proposal (the proposer approves at creation).",
    58  => DuplicateRejection               ~ "This signer already rejected the proposal.",
    59  => ProposalRegistryVersionMismatch  ~ "Registry version differs from the current signer registry — re-read and re-sign.",
    60  => ProposalContentMismatch          ~ "Approval context does not byte-match the stored proposal — rebuild from the proposals query.",
    61  => InvalidAdminAction               ~ "Inner admin/emergency action is invalid: unknown or not-admitted arm, non-zero inner signer, or out-of-bounds field.",
    62  => AdminActionTooLarge              ~ "Canonical inner action bytes exceed MAX_ADMIN_ACTION_BYTES.",
    63  => TooManyPendingProposals          ~ "MAX_PENDING_PROPOSALS admin proposals are already pending.",
    64  => ProposalIdExhausted              ~ "A governance id counter is exhausted; ids never wrap.",
    65  => ConflictingVote                  ~ "The opposite vote already exists — votes are immutable and disjoint.",
    66  => MarketIdOutOfRange               ~ "Market id exceeds the signed-32-bit identity bound (i32::MAX).",
    67  => EmergencyRateLimited             ~ "Per-signer emergency action bound reached within the rolling window.",
    68  => EmergencyGlobalRateLimited       ~ "Chain-wide emergency action bound reached within the rolling window.",
    69  => EmergencyActionRetired           ~ "This emergency arm was retired; new submissions fail closed.",
    70  => AdminActionRequiresProposal      ~ "The signer registry exists — this admin action is proposal-only, even for an authorized relayer.",
    71  => InvalidAdminRegistry             ~ "Proposed signer roster violates the registry invariants (threshold bounds, sorted unique members, roster size, version headroom).",
    255 => InternalError                ~ "Catch-all for unexpected runtime failures (panics caught by the FFI boundary, etc.). Treat as a server bug.",
}

/// Safe classification of an engine result code plus its canonical DeliverTx
/// log. Upgraded engines use code 50 for slippage and 51 for open interest, but
/// legacy engines may emit code 50 for open interest during a rolling upgrade.
/// Callers must not infer the meaning of code 50 from the integer alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodedExecErrorKind {
    Known(ErrorKind),
    /// Preserved for source compatibility with the original log-aware
    /// code-50 decoder.
    SlippageExceeded,
    LegacyOpenInterestLimitExceeded,
    AmbiguousCode50,
}

impl DecodedExecErrorKind {
    pub fn code(self) -> u32 {
        match self {
            Self::Known(kind) => kind.code(),
            Self::SlippageExceeded
            | Self::LegacyOpenInterestLimitExceeded
            | Self::AmbiguousCode50 => 50,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Known(kind) => kind.name(),
            Self::SlippageExceeded => "SlippageExceeded",
            Self::LegacyOpenInterestLimitExceeded => "OpenInterestLimitExceeded",
            Self::AmbiguousCode50 => "AmbiguousCode50",
        }
    }

    pub fn meaning(self) -> &'static str {
        match self {
            Self::Known(kind) => kind.meaning(),
            Self::SlippageExceeded => {
                "Atomic basket aggregate slippage exceeded the submitted max_slippage_bps budget."
            }
            Self::LegacyOpenInterestLimitExceeded => {
                "A legacy engine reported that a fill would push aggregate market open interest past MarketConfig.max_open_interest."
            }
            Self::AmbiguousCode50 => {
                "During the rolling upgrade, engine code 50 may mean legacy OpenInterestLimitExceeded or current SlippageExceeded; a canonical non-empty DeliverTx log is required to classify it safely."
            }
        }
    }
}

/// Decode an engine error without guessing the transitional meaning of code 50.
pub fn decode_exec_error_kind(code: u32, log: Option<&str>) -> Option<DecodedExecErrorKind> {
    if code == 0 {
        return None;
    }
    if code == 50 {
        return Some(match log {
            Some(log) if log.starts_with("open interest limit exceeded on market ") => {
                DecodedExecErrorKind::LegacyOpenInterestLimitExceeded
            }
            Some(log) if log.starts_with("atomic basket aggregate slippage ") => {
                DecodedExecErrorKind::SlippageExceeded
            }
            _ => DecodedExecErrorKind::AmbiguousCode50,
        });
    }
    ERROR_KINDS
        .iter()
        .copied()
        .find(|kind| kind.code() == code)
        .map(DecodedExecErrorKind::Known)
}

// Backward-compat alias for any callers still using `error_code_manifest()`.
pub fn error_code_manifest() -> &'static [ErrorKind] {
    ERROR_KINDS
}

#[cfg(test)]
mod exec_error_meaning_tests {
    use super::*;
    use exchange_wire::types::ExecError;

    #[test]
    #[allow(clippy::unwrap_used)]
    fn current_code_51_decodes_without_a_log() {
        let oi = decode_exec_error_kind(51, None).unwrap();
        assert_eq!(oi.name(), "OpenInterestLimitExceeded");
        assert_eq!(oi.code(), 51);
        assert_eq!(
            decode_exec_error_kind(51, Some("unrecognized")),
            Some(DecodedExecErrorKind::Known(
                ErrorKind::OpenInterestLimitExceeded
            ))
        );
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn governance_codes_52_53_decode_without_a_log() {
        let inactive = decode_exec_error_kind(52, None).unwrap();
        assert_eq!(inactive.name(), "AdminGovernanceInactive");
        assert_eq!(inactive.code(), 52);
        let not_signer = decode_exec_error_kind(53, None).unwrap();
        assert_eq!(not_signer.name(), "NotAdminSigner");
        assert_eq!(not_signer.code(), 53);
        assert_eq!(ExecError::AdminGovernanceInactive.code(), 52);
        assert_eq!(ExecError::NotAdminSigner.code(), 53);
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn transitional_code_50_requires_the_canonical_log() {
        let oi = decode_exec_error_kind(
            50,
            Some("open interest limit exceeded on market 7: would be 4, cap 3"),
        )
        .unwrap();
        assert_eq!(oi.name(), "OpenInterestLimitExceeded");
        assert_eq!(oi.code(), 50);

        let slippage = decode_exec_error_kind(
            50,
            Some("atomic basket aggregate slippage 51 bps exceeds budget 50 bps"),
        )
        .unwrap();
        assert_eq!(slippage, DecodedExecErrorKind::SlippageExceeded);
        assert_eq!(slippage.name(), "SlippageExceeded");

        for log in [None, Some(""), Some("unknown code 50 diagnostic")] {
            assert_eq!(
                decode_exec_error_kind(50, log).unwrap().name(),
                "AmbiguousCode50"
            );
        }
        assert_eq!(decode_exec_error_kind(0, None), None);
        assert_eq!(
            decode_exec_error_kind(12, None).unwrap().name(),
            "InsufficientMargin"
        );
    }

    /// Sample one constructed value per variant. New variants added to
    /// `ExecError` must be added here, otherwise the test below fails
    /// (which is the point — it forces docs to keep up with the wire).
    fn one_of_each() -> Vec<ExecError> {
        vec![
            ExecError::DecodeError("e".into()),
            ExecError::OrderNotFound(0),
            ExecError::NotOwner(0),
            ExecError::UnauthorizedOracle,
            ExecError::Overflow,
            ExecError::InvalidPrice,
            ExecError::InvalidQuantity,
            ExecError::InvalidSide,
            ExecError::UnknownMarket(0),
            ExecError::InsufficientBalance,
            ExecError::InsufficientMargin,
            ExecError::StateCorruption("e".into()),
            ExecError::InternalError("e".into()),
            ExecError::UnauthorizedRelayer,
            ExecError::WithdrawalNotFound(0),
            ExecError::WithdrawalAlreadyProcessed(0),
            ExecError::DuplicateDeposit,
            ExecError::InvalidSignature,
            ExecError::SignatureRequired,
            ExecError::AgentNotAuthorized,
            ExecError::AgentCannotWithdraw,
            ExecError::NonceTooOld {
                min_accepted: 0,
                got: 0,
            },
            ExecError::NonceTooFarFuture {
                max_accepted: 0,
                got: 0,
            },
            ExecError::NonceReplay { nonce: 0 },
            ExecError::NonceBelowOldest { oldest: 0, got: 0 },
            ExecError::MarketAlreadyExists(0),
            ExecError::InvalidMarketConfig("e".into()),
            ExecError::ImpactMarketAlreadyExists(0),
            ExecError::ImpactMarketNotFound(0),
            ExecError::MarketClosedForTrading(0),
            ExecError::BinaryPriceOutOfRange,
            ExecError::InvalidResolution("e".into()),
            ExecError::PositionLimitExceeded {
                market: 0,
                limit: 0,
                would_be: 0,
            },
            ExecError::OracleTimestampNotMonotonic {
                market: 0,
                stored: 0,
                submitted: 0,
            },
            ExecError::TooManyActiveImpactMarkets { current: 0, max: 0 },
            ExecError::SettlementPriceMismatch {
                market: 0,
                expected: 0,
                got: 0,
            },
            ExecError::OracleNotApplicable { market: 0 },
            ExecError::PostOnlyWouldCross,
            ExecError::ReduceOnlyWouldIncrease,
            ExecError::TestActionRejected("e".into()),
            ExecError::FeeBpsOutOfRange { bps: 0 },
            ExecError::FeeOverrideStaleSeq {
                cmd_seq: 0,
                stored_seq: 0,
            },
            ExecError::TickSizeViolation {
                market: 0,
                tick_size: 1,
                price: 0,
            },
            ExecError::LotSizeViolation {
                market: 0,
                lot_size: 1,
                quantity: 0,
            },
            ExecError::OracleStaleNotElapsed {
                market: 0,
                last_publish_ms: 0,
                block_time_ms: 0,
                staleness_ms: 1,
            },
            ExecError::StaleOracle {
                market: 0,
                publish_time_ms: 0,
                block_time_ms: 0,
                max_staleness_ms: 1,
            },
            ExecError::UserLeverageBelowMarketIm {
                market: 0,
                user_im_bps: 0,
                market_im_bps: 1,
            },
            ExecError::ClientOrderIdNotFound { client_order_id: 0 },
            ExecError::DuplicateClientOrderId { client_order_id: 0 },
            ExecError::InvalidClientOrderId { client_order_id: 0 },
            ExecError::FillOrKillWouldNotFill {
                requested: 1,
                available: 0,
            },
            ExecError::InvalidCancelReplaceTarget,
            ExecError::AmendBelowFilled {
                order_id: 0,
                filled_quantity: 1,
                requested_quantity: 0,
            },
            ExecError::SlippageExceeded {
                aggregate_bps: 51,
                max_slippage_bps: 50,
            },
            ExecError::OpenInterestLimitExceeded {
                market: 0,
                limit: 1,
                would_be: 2,
            },
        ]
    }

    /// Every code returned by `code()` must have a non-empty `meaning()`.
    /// This is the integration contract for the openapi-yaml `ExecErrorCode`
    /// table — clients (Auros, etc.) read these to map raw codes to
    /// actionable client-side errors.
    #[test]
    fn every_variant_has_non_empty_meaning() {
        for e in one_of_each() {
            let m = e.meaning();
            assert!(
                !m.is_empty(),
                "ExecError code={} ({:?}) has empty meaning()",
                e.code(),
                e
            );
            // Heuristic: meanings should be at least one full sentence,
            // not just the variant name. Catches future placeholder
            // additions like `_ => "TODO"`.
            assert!(
                m.len() > 20,
                "ExecError code={} ({:?}) meaning is too short to be useful: {:?}",
                e.code(),
                e,
                m
            );
        }
    }

    /// Codes 1..=71 + 255 must all be covered by the public error manifest.
    /// Catches the case where a code is reserved by the mirrored engine error
    /// enum but no SDK classification maps to it.
    #[test]
    fn no_code_holes_in_documented_range() {
        let mut codes: Vec<u32> = ERROR_KINDS.iter().map(|kind| kind.code()).collect();
        codes.sort();
        codes.dedup();
        let expected: Vec<u32> = (1u32..=71).chain(std::iter::once(255)).collect();
        assert_eq!(
            codes, expected,
            "ExecError codes covered by variants: {:?}; expected: {:?}. \
             A new variant was added without bumping the codes table, \
             OR a code was reserved without a corresponding variant.",
            codes, expected
        );
    }
}

// ---------------------------------------------------------------------------
// Prelude — commonly used types for internal imports
// ---------------------------------------------------------------------------

pub mod prelude {
    pub use crate::types::{
        AccountFeeOverride, Action, AmendOrder, ApproveAgent, Branch, CancelAllOrders,
        CancelClientOrder, CancelOrder, CancelReason, CancelReplaceOrder, ClosePosition,
        ConfirmDeposit, ConfirmWithdrawal, CreateImpactMarket, CreateMarket, Deposit, Event,
        EventOracleSource, ExecError, FailDepositReason, FailWithdrawal, FillId, ImpactMarketId,
        ImpactMarketInfo, ImpactMarketStatus, MarkSourceMode, MarketConfig, MarketId, MarketKind,
        MarketOrder, OracleUpdate, Order, OrderId, Outcome, PlaceOrder, Position, ResolveEvent,
        RevokeAgent, SetUserMarketLeverage, Side, TimeInForce, UpdateMarketFees, Withdraw,
        WithdrawRequest, WithdrawalStatus, BINARY_PRICE_MAX, DEFAULT_CEX_COMPOSITE_STALENESS_MS,
        DEFAULT_MAX_MARK_SPREAD_BPS,
    };
}
