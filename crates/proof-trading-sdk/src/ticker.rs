//! The market ticker rule, checked before a binding signs a market creation.
//!
//! Source of truth: `proof_wire::ticker::validate_ticker` in the shared
//! `proof-wire` crate (Proof-labs/exchange#1351). This crate pins an older
//! proof-wire, so this module is a copy of the same rule with the same refusal
//! messages; replace it with the proof-wire function at the next proof-wire
//! upgrade. The TypeScript SDK carries the same copy in `src/ticker.ts`.
//!
//! A ticker is 1 to [`MAX_TICKER_LEN`] bytes of capital letters A-Z, digits
//! 0-9 and hyphens, starting with a capital letter (`^[A-Z][A-Z0-9-]{0,23}$`).
//! A market cannot be renamed, so a bad ticker is refused before signing
//! rather than discovered on chain. Decoding never checks it: markets created
//! before the rule still decode.

use std::fmt;

use crate::codec::ActionType;
use crate::types::{
    AdminAction, AdminBatchItem, ApproveAdminAction, CreateMarket, ProposeAdminAction,
};

/// Longest ticker the engine accepts, in UTF-8 bytes.
pub const MAX_TICKER_LEN: usize = 24;

/// Why a ticker was refused. `Display` is the engine's text, word for word.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TickerError {
    /// The ticker has no characters.
    Empty,
    /// The ticker is longer than [`MAX_TICKER_LEN`] bytes.
    TooLong(usize),
    /// The first character is not A-Z.
    BadStart(char),
    /// A later character is not A-Z, 0-9 or '-'; the index counts characters.
    BadChar(char, usize),
}

impl fmt::Display for TickerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "ticker is empty"),
            Self::TooLong(len) => {
                write!(
                    f,
                    "ticker is {len} bytes, over the {MAX_TICKER_LEN}-byte limit"
                )
            }
            Self::BadStart(c) => {
                write!(f, "ticker must start with a capital letter A-Z, not {c:?}")
            }
            Self::BadChar(c, index) => write!(
                f,
                "ticker may hold only A-Z, 0-9 and '-', found {c:?} at character {index}"
            ),
        }
    }
}

impl std::error::Error for TickerError {}

/// Check `ticker` against the rule, in the engine's order: length, empty,
/// first character, then the rest.
pub fn validate_ticker(ticker: &str) -> Result<(), TickerError> {
    if ticker.len() > MAX_TICKER_LEN {
        return Err(TickerError::TooLong(ticker.len()));
    }
    let first = ticker.chars().next().ok_or(TickerError::Empty)?;
    if !first.is_ascii_uppercase() {
        return Err(TickerError::BadStart(first));
    }
    for (i, c) in ticker.chars().enumerate().skip(1) {
        if !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-') {
            return Err(TickerError::BadChar(c, i));
        }
    }
    Ok(())
}

/// Why [`check_payload_tickers`] refused a payload.
#[derive(Debug)]
pub enum PayloadTickerError {
    /// A market creation in the payload carries a bad ticker.
    Ticker(TickerError),
    /// The payload did not decode as its action type.
    Decode(String),
}

impl fmt::Display for PayloadTickerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ticker(e) => e.fmt(f),
            Self::Decode(e) => write!(f, "payload does not decode: {e}"),
        }
    }
}

impl std::error::Error for PayloadTickerError {}

/// Check every market creation in an encoded action payload: a direct
/// `CreateMarket`, and a `CreateMarket` proposed or approved through
/// governance, alone or as an item of an admin `Batch`. Other action types
/// pass untouched. Bindings call this on the encode path only.
pub fn check_payload_tickers(action_type: u8, payload: &[u8]) -> Result<(), PayloadTickerError> {
    let decode = |e: rmp_serde::decode::Error| PayloadTickerError::Decode(e.to_string());
    let admin = match action_type {
        t if t == ActionType::CreateMarket as u8 => {
            let m: CreateMarket = rmp_serde::from_slice(payload).map_err(decode)?;
            return validate_ticker(&m.ticker).map_err(PayloadTickerError::Ticker);
        }
        t if t == ActionType::ProposeAdminAction as u8 => {
            rmp_serde::from_slice::<ProposeAdminAction>(payload)
                .map_err(decode)?
                .action
        }
        t if t == ActionType::ApproveAdminAction as u8 => {
            rmp_serde::from_slice::<ApproveAdminAction>(payload)
                .map_err(decode)?
                .action
        }
        _ => return Ok(()),
    };
    check_admin_action_tickers(&admin).map_err(PayloadTickerError::Ticker)
}

/// Check every `CreateMarket` inside an admin action, including `Batch` items.
pub fn check_admin_action_tickers(action: &AdminAction) -> Result<(), TickerError> {
    match action {
        AdminAction::CreateMarket(m) => validate_ticker(&m.ticker),
        AdminAction::Batch(items) => items.iter().try_for_each(|item| match item {
            AdminBatchItem::CreateMarket(m) => validate_ticker(&m.ticker),
            AdminBatchItem::AttachConditional(_) => Ok(()),
        }),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_the_rule() {
        for t in [
            "A",
            "BTC",
            "TEST2",
            "BTC-1-CPY",
            "EVT-1-EBY",
            "OI-GW-PROBE",
            &"X".repeat(24),
        ] {
            assert_eq!(validate_ticker(t), Ok(()), "{t:?}");
        }
    }

    #[test]
    fn refuses_with_the_engine_reasons_and_text() {
        let cases: [(&str, TickerError, &str); 9] = [
            ("", TickerError::Empty, "ticker is empty"),
            (
                &"X".repeat(25),
                TickerError::TooLong(25),
                "ticker is 25 bytes, over the 24-byte limit",
            ),
            (
                "test3",
                TickerError::BadStart('t'),
                "ticker must start with a capital letter A-Z, not 't'",
            ),
            (
                "1BTC",
                TickerError::BadStart('1'),
                "ticker must start with a capital letter A-Z, not '1'",
            ),
            (
                "-BTC",
                TickerError::BadStart('-'),
                "ticker must start with a capital letter A-Z, not '-'",
            ),
            (
                "TEST3.",
                TickerError::BadChar('.', 5),
                "ticker may hold only A-Z, 0-9 and '-', found '.' at character 5",
            ),
            (
                "TEST 3",
                TickerError::BadChar(' ', 4),
                "ticker may hold only A-Z, 0-9 and '-', found ' ' at character 4",
            ),
            (
                "Btc",
                TickerError::BadChar('t', 1),
                "ticker may hold only A-Z, 0-9 and '-', found 't' at character 1",
            ),
            (
                "BTCÉ",
                TickerError::BadChar('É', 3),
                "ticker may hold only A-Z, 0-9 and '-', found 'É' at character 3",
            ),
        ];
        for (ticker, err, text) in cases {
            assert_eq!(validate_ticker(ticker), Err(err.clone()), "{ticker:?}");
            assert_eq!(err.to_string(), text);
        }
    }

    #[test]
    fn length_counts_bytes_and_comes_first() {
        // 13 characters, 25 bytes.
        assert_eq!(
            validate_ticker(&format!("A{}", "É".repeat(12))),
            Err(TickerError::TooLong(25))
        );
        // 12 characters, 23 bytes.
        assert_eq!(
            validate_ticker(&format!("A{}", "É".repeat(11))),
            Err(TickerError::BadChar('É', 1))
        );
    }

    #[test]
    fn quotes_the_character_as_the_engine_does() {
        // The engine writes the character with `{:?}`, which escapes quotes,
        // backslashes and invisible characters.
        let text = |t: &str| validate_ticker(t).unwrap_err().to_string();
        assert_eq!(
            text("'A"),
            r"ticker must start with a capital letter A-Z, not '\''"
        );
        assert_eq!(
            text("A\\"),
            r"ticker may hold only A-Z, 0-9 and '-', found '\\' at character 1"
        );
        assert_eq!(
            text("A\t"),
            r"ticker may hold only A-Z, 0-9 and '-', found '\t' at character 1"
        );
        assert_eq!(
            text("A\u{200b}"),
            r"ticker may hold only A-Z, 0-9 and '-', found '\u{200b}' at character 1"
        );
        assert_eq!(
            text("A\""),
            r#"ticker may hold only A-Z, 0-9 and '-', found '"' at character 1"#
        );
    }

    fn market(ticker: &str) -> serde_json::Value {
        json!({
            "market": 42, "im_bps": 1000, "mm_bps": 500, "taker_fee_bps": 5,
            "maker_fee_bps": 2, "signer": vec![0u8; 20], "funding_interval_ms": 60000u64,
            "max_funding_rate_bps": 100, "pool_id": 0, "sz_decimals": 0,
            "ticker": ticker, "max_open_interest": 0u64,
            "tick_size": 1u64, "lot_size": 1u64
        })
    }

    fn attach() -> serde_json::Value {
        json!({
            "event_id": 91, "underlying_market": 15, "child_market_base": 9100,
            "im_bps": 3334, "mm_bps": 1667, "taker_fee_bps": 5, "maker_fee_bps": 2,
            "signer": vec![0u8; 20], "max_open_interest": 0u64
        })
    }

    fn payloads(ticker: &str) -> Vec<(&'static str, u8, serde_json::Value)> {
        let single = json!({ "CreateMarket": market(ticker) });
        let batch = json!({ "Batch": [ { "AttachConditional": attach() }, { "CreateMarket": market(ticker) } ] });
        let propose = |action: &serde_json::Value| json!({ "proposer": vec![0x22u8; 20], "registry_version": 3u64, "action": action });
        let approve = |action: &serde_json::Value| {
            json!({
                "approver": vec![0x23u8; 20], "proposal_id": 7u64, "registry_version": 3u64,
                "threshold": 2, "proposer": vec![0x22u8; 20], "created_height": 1u64,
                "created_ms": 1u64, "expiry_ms": 2u64, "action": action,
                "content_hash": vec![0u8; 32]
            })
        };
        vec![
            (
                "direct CreateMarket",
                ActionType::CreateMarket as u8,
                market(ticker),
            ),
            (
                "proposed CreateMarket",
                ActionType::ProposeAdminAction as u8,
                propose(&single),
            ),
            (
                "proposed Batch item",
                ActionType::ProposeAdminAction as u8,
                propose(&batch),
            ),
            (
                "approved CreateMarket",
                ActionType::ApproveAdminAction as u8,
                approve(&single),
            ),
            (
                "approved Batch item",
                ActionType::ApproveAdminAction as u8,
                approve(&batch),
            ),
        ]
    }

    #[test]
    fn every_market_creation_payload_is_checked() {
        for (name, action_type, fields) in payloads("TEST3.") {
            let bytes = crate::codec::encode_payload_dyn(action_type, fields).expect(name);
            let err = check_payload_tickers(action_type, &bytes).expect_err(name);
            assert_eq!(
                err.to_string(),
                "ticker may hold only A-Z, 0-9 and '-', found '.' at character 5",
                "{name}"
            );
        }
        for (name, action_type, fields) in payloads("TEST3") {
            let bytes = crate::codec::encode_payload_dyn(action_type, fields).expect(name);
            check_payload_tickers(action_type, &bytes).expect(name);
        }
    }

    #[test]
    fn other_actions_pass_untouched() {
        // Not a CreateMarket payload, and never decoded.
        check_payload_tickers(ActionType::PlaceOrder as u8, &[0xc1]).unwrap();
    }
}
