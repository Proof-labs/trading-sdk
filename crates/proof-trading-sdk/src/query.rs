//! Node read-model (response) DTOs — re-exported from the shared `exchange-wire`
//! crate so the SDK and the engine share one definition (no positional-wire
//! drift). Client representation that needs it wraps these.

pub use proof_wire::query::{AccountInfo, BindingScenario, PositionBrief};
pub use proof_wire::query_v2::{AuthorizedAgents, AUTHORIZED_AGENTS_LIMIT};

pub const MAX_AUTHORIZED_AGENTS_BYTES: usize = 16 * 1024;

/// Decode the canonical DTO without accepting text or integer arrays as addresses.
pub fn decode_authorized_agents(bytes: &[u8]) -> Result<AuthorizedAgents, String> {
    if bytes.len() > MAX_AUTHORIZED_AGENTS_BYTES {
        return Err("authorized agents payload exceeds 16 KiB".into());
    }
    crate::msgpack::reject_floats(bytes).map_err(|e| e.to_string())?;
    let value =
        rmpv::decode::read_value(&mut std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let fields = value
        .as_map()
        .ok_or("authorized agents must be a MessagePack map")?;
    let address = |v: &rmpv::Value| matches!(v, rmpv::Value::Binary(b) if b.len() == 20);
    for (key, value) in fields {
        match key.as_str() {
            Some("owner") if !address(value) => return Err("owner must be 20-byte binary".into()),
            Some("agents") => {
                let agents = value.as_array().ok_or("agents must be an array")?;
                if !agents.iter().all(address) {
                    return Err("agents must contain 20-byte binary addresses".into());
                }
            }
            _ => {}
        }
    }
    rmp_serde::from_slice(bytes).map_err(|e| e.to_string())
}
