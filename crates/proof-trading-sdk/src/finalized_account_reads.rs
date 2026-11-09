//! Canonical account read payloads with finalized-route constraints.
use crate::query::AccountInfo;
use rmpv::Value;
use std::collections::HashSet;
use std::io::Cursor;

const MAX_BYTES: usize = 512 * 1024;
fn raw(bytes: &[u8]) -> Result<Value, &'static str> {
    if bytes.len() > MAX_BYTES {
        return Err("account read exceeds byte limit");
    }
    crate::msgpack::reject_floats(bytes).map_err(|_| "invalid account read MessagePack")?;
    rmpv::decode::read_value(&mut Cursor::new(bytes))
        .map_err(|_| "invalid account read MessagePack")
}
fn address(value: &Value) -> bool {
    match value {
        Value::Binary(v) => v.len() == 20,
        Value::Array(v) => v.len() == 20 && v.iter().all(|b| b.as_u64().is_some_and(|n| n <= 255)),
        _ => false,
    }
}

pub fn account(bytes: &[u8], owner: &[u8; 20]) -> Result<AccountInfo, &'static str> {
    let value = raw(bytes)?;
    let rows = value
        .as_array()
        .and_then(|v| v.get(1))
        .and_then(Value::as_array)
        .ok_or("invalid account positions")?;
    for row in rows {
        let fields = row.as_array().ok_or("invalid account position")?;
        if !fields.first().is_some_and(address) {
            return Err("invalid account position owner bytes");
        }
        // Serde also accepts an enum by index or as a map; only the wire name is valid.
        if !matches!(fields.get(2).and_then(Value::as_str), Some("Buy" | "Sell")) {
            return Err("invalid account position side");
        }
    }
    let scenarios = value
        .as_array()
        .and_then(|v| v.get(6))
        .and_then(Value::as_array);
    for scenario in scenarios.into_iter().flatten() {
        let branch = scenario
            .as_array()
            .and_then(|v| v.get(1))
            .and_then(Value::as_str);
        if !matches!(branch, Some("Yes" | "No")) {
            return Err("invalid account binding scenario branch");
        }
    }
    let account: AccountInfo = crate::reads::decode(bytes, &crate::reads::ACCOUNT_INFO)
        .map_err(|_| "invalid account fields")?;
    let mut seen = HashSet::new();
    for position in &account.positions {
        if &position.owner != owner || !seen.insert(position.market) {
            return Err("account position owner or market binding mismatch");
        }
    }
    Ok(account)
}

pub fn agent_authorization(bytes: &[u8]) -> Result<bool, &'static str> {
    raw(bytes)?;
    rmp_serde::from_slice(bytes).map_err(|_| "invalid agent authorization")
}

pub fn recent_nonces(bytes: &[u8]) -> Result<Vec<u64>, &'static str> {
    let value = raw(bytes)?;
    if value.as_array().is_none_or(|v| v.len() > 100) {
        return Err("invalid recent nonce count");
    }
    let nonces: Vec<u64> =
        rmp_serde::from_slice(bytes).map_err(|_| "invalid recent nonce fields")?;
    if nonces.windows(2).any(|v| v[0] >= v[1]) {
        return Err("recent nonces must be strictly increasing");
    }
    Ok(nonces)
}

pub fn open_orders(
    bytes: &[u8],
    owner: &[u8; 20],
    limit: usize,
) -> Result<Vec<crate::types::Order>, &'static str> {
    if !(1..=101).contains(&limit) {
        return Err("invalid finalized order limit");
    }
    let value = raw(bytes)?;
    let rows = value
        .as_array()
        .filter(|v| v.len() <= limit)
        .ok_or("finalized order limit exceeded")?;
    for row in rows {
        let fields = row
            .as_array()
            .filter(|v| v.len() == 14)
            .ok_or("finalized order must have exactly 14 fields")?;
        if fields[1].as_u64() == Some(0) {
            return Err("invalid finalized order market");
        }
        if !matches!(fields[3].as_str(), Some("Buy" | "Sell"))
            || !matches!(fields[11].as_str(), Some("Gtc" | "Ioc" | "Fok"))
        {
            return Err("invalid finalized order enum");
        }
    }
    crate::reads::decode_open_orders(bytes, owner)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bare_boolean_and_nonce_domains_are_exact() {
        assert!(!agent_authorization(&[0xc2]).expect("false decodes"));
        assert!(agent_authorization(&[0]).is_err());
        let bytes = rmp_serde::to_vec(&vec![0u64, u64::MAX]).expect("nonces encode");
        assert_eq!(
            recent_nonces(&bytes).expect("nonces decode"),
            vec![0, u64::MAX]
        );
        for values in [vec![1u64, 1], vec![2, 1], vec![0; 101]] {
            assert!(recent_nonces(&rmp_serde::to_vec(&values).expect("nonces encode")).is_err());
        }
    }
    #[test]
    fn finalized_orders_refuse_legacy_width_before_shared_decoder() {
        let bytes = rmp_serde::to_vec(&vec![(1u64, 3u32, [7u8; 20], "Buy", 1u64, 1u64)])
            .expect("legacy order encodes");
        assert!(crate::reads::decode_open_orders(&bytes, &[7; 20]).is_ok());
        assert!(open_orders(&bytes, &[7; 20], 101).is_err());
        assert!(open_orders(&[0x90], &[7; 20], 101)
            .expect("an empty list decodes")
            .is_empty());
    }
}
