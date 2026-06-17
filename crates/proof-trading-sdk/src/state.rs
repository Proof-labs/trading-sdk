use core::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    DecodeFailure {
        key: Vec<u8>,
        type_name: &'static str,
        message: String,
    },
    EncodeFailure {
        key: Vec<u8>,
        type_name: &'static str,
        message: String,
    },
    MissingRequiredKey {
        key: Vec<u8>,
        name: &'static str,
    },
    InvalidKeyLayout {
        key: Vec<u8>,
        message: String,
    },
    ArithmeticInvariantViolation {
        name: &'static str,
        message: String,
    },
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StateError::DecodeFailure {
                key,
                type_name,
                message,
            } => write!(
                f,
                "failed to decode {type_name} at key 0x{}: {message}",
                format_key(key)
            ),
            StateError::EncodeFailure {
                key,
                type_name,
                message,
            } => write!(
                f,
                "failed to encode {type_name} at key 0x{}: {message}",
                format_key(key)
            ),
            StateError::MissingRequiredKey { key, name } => write!(
                f,
                "missing required state {name} at key 0x{}",
                format_key(key)
            ),
            StateError::InvalidKeyLayout { key, message } => {
                write!(f, "invalid key layout at 0x{}: {message}", format_key(key))
            }
            StateError::ArithmeticInvariantViolation { name, message } => {
                write!(f, "arithmetic invariant violated for {name}: {message}")
            }
        }
    }
}

impl std::error::Error for StateError {}

fn format_key(key: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut out = String::with_capacity(key.len().saturating_mul(2));
    for byte in key {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
