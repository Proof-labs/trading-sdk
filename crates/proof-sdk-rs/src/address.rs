//! The 20-byte account address.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::Error;

/// An account (owner) address: `keccak256(ed25519_pubkey)[12..32]`.
///
/// Displays as 40 lowercase hex digits with no `0x`, the form gateway routes
/// take. Parses with or without `0x`, in either case. Serializes as that hex
/// string in JSON.
#[derive(Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Address(pub [u8; 20]);

impl Address {
    /// The address that owns `public_key`.
    #[must_use]
    pub fn from_public_key(public_key: &[u8; 32]) -> Self {
        Self(proof_trading_sdk::crypto::pubkey_to_owner(public_key))
    }

    /// The raw bytes, as wire payloads carry them.
    #[must_use]
    pub const fn to_bytes(self) -> [u8; 20] {
        self.0
    }
}

impl From<[u8; 20]> for Address {
    fn from(bytes: [u8; 20]) -> Self {
        Self(bytes)
    }
}

impl From<Address> for [u8; 20] {
    fn from(a: Address) -> Self {
        a.0
    }
}

impl AsRef<[u8]> for Address {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.iter().try_for_each(|b| write!(f, "{b:02x}"))
    }
}

impl fmt::Debug for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Address(0x{self})")
    }
}

impl FromStr for Address {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let hex = s
            .strip_prefix("0x")
            .or_else(|| s.strip_prefix("0X"))
            .unwrap_or(s);
        let invalid = || Error::InvalidInput(format!("address must be 40 hex digits, got {s:?}"));
        // `from_str_radix` alone would take "+f" as a byte.
        if hex.len() != 40 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(invalid());
        }
        let mut out = [0u8; 20];
        for (byte, pair) in out.iter_mut().zip(hex.as_bytes().as_chunks::<2>().0) {
            let pair = std::str::from_utf8(pair).map_err(|_| invalid())?;
            *byte = u8::from_str_radix(pair, 16).map_err(|_| invalid())?;
        }
        Ok(Self(out))
    }
}

impl Serialize for Address {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Address {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = <std::borrow::Cow<'de, str>>::deserialize(d)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn round_trips_through_hex() {
        let a: Address = "0xBDAE2DDF5BDE1E6A5BE62BCD9E008106FCA6DFD9"
            .parse()
            .unwrap();
        assert_eq!(a.to_string(), "bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9");
        assert_eq!(a.to_string().parse::<Address>().unwrap(), a);
    }

    #[test]
    fn rejects_bad_input() {
        for s in [
            "",
            "0x12",
            &"g".repeat(40),
            &"a".repeat(41),
            "éé",
            &"+f".repeat(20),
        ] {
            assert!(s.parse::<Address>().is_err(), "{s:?}");
        }
    }

    #[test]
    fn matches_the_core_owner_derivation() {
        let pk = [3u8; 32];
        assert_eq!(
            Address::from_public_key(&pk).to_bytes(),
            proof_trading_sdk::crypto::pubkey_to_owner(&pk)
        );
    }
}
