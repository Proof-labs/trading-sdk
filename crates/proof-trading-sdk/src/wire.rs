//! Wire-level newtypes for the byte fields of exchange action payloads.
//!
//! Every action payload struct (`PlaceOrder`, `Deposit`, …) wraps its
//! byte-array fields in one of these newtypes instead of using a bare
//! `[u8; N]` / `Vec<u8>`. Two goals:
//!
//! 1. **Type safety on the Rust side.** A 32-byte [`Pubkey`] cannot be
//!    passed where a 20-byte [`Address`] is expected, and the length is
//!    validated at *decode* time — a wrong-length input is a hard error,
//!    not a silently-truncated or panicking `copy_from_slice`.
//! 2. **Bridge robustness.** The [`Deserialize`] impls accept *both*
//!    representations the codec sees:
//!      * the msgpack **sequence-of-u8** that `rmp-serde` emits on the wire
//!        (a bare `[u8; N]` serializes as a msgpack array — see the golden
//!        vectors), and
//!      * the **bytes** form that `pythonize` produces from a Python
//!        `bytes`/`bytearray` object in the PyO3 codec path.
//!
//! This removes the ambiguity that made feeding Python byte fields through
//! `pythonize` fragile.
//!
//! **Wire compatibility is preserved.** For binary formats (rmp-serde — the
//! wire) [`Serialize`] forwards to the inner array/vec, so the encoded bytes
//! — and the checked-in conformance vectors — are byte-for-byte identical to
//! the pre-newtype encoding. Human-readable serializers (`pythonize`) instead
//! get a byte scalar, so a decoded address surfaces in Python as `bytes`
//! rather than a list of ints. The split keys off `Serializer::is_human_readable()`
//! (`false` for rmp-serde).

use core::fmt;

use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Defines a fixed-length byte newtype with a length-checked, dual-form
/// (`bytes` or seq-of-u8) `Deserialize` and a wire-identical `Serialize`.
macro_rules! fixed_byte_newtype {
    ($(#[$meta:meta])* $name:ident, $len:expr) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $name(pub [u8; $len]);

        impl $name {
            /// Length of the wrapped byte array.
            pub const LEN: usize = $len;

            /// Borrow the underlying bytes.
            pub fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }
        }

        impl Default for $name {
            fn default() -> Self {
                $name([0u8; $len])
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                // Hex, not the raw array, so logs stay compact. Byte fields
                // here are public identities (addresses, pubkeys), never
                // secret key material, so hex display is safe.
                write!(f, concat!(stringify!($name), "(0x"))?;
                for b in &self.0 {
                    write!(f, "{b:02x}")?;
                }
                f.write_str(")")
            }
        }

        impl From<[u8; $len]> for $name {
            fn from(bytes: [u8; $len]) -> Self {
                $name(bytes)
            }
        }

        impl From<$name> for [u8; $len] {
            fn from(v: $name) -> Self {
                v.0
            }
        }

        impl AsRef<[u8]> for $name {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                if s.is_human_readable() {
                    // Human-readable consumers — `pythonize` (→ a Python
                    // `bytes`), serde_json, etc. — get a byte scalar so a
                    // decoded address round-trips back to `bytes`, not a
                    // list of ints.
                    s.serialize_bytes(&self.0)
                } else {
                    // Binary formats (rmp-serde — the wire) get the inner
                    // array verbatim: a msgpack seq-of-u8 identical to a
                    // bare `[u8; $len]`. The conformance vectors depend on
                    // this; `is_human_readable()` is `false` for rmp-serde.
                    self.0.serialize(s)
                }
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct V;
                impl<'de> Visitor<'de> for V {
                    type Value = $name;

                    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                        write!(f, concat!($len, "-byte ", stringify!($name)))
                    }

                    fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<$name, E> {
                        if v.len() != $len {
                            return Err(E::invalid_length(v.len(), &self));
                        }
                        let mut arr = [0u8; $len];
                        arr.copy_from_slice(v);
                        Ok($name(arr))
                    }

                    fn visit_byte_buf<E: de::Error>(self, v: Vec<u8>) -> Result<$name, E> {
                        self.visit_bytes(&v)
                    }

                    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<$name, A::Error> {
                        let mut arr = [0u8; $len];
                        for (idx, slot) in arr.iter_mut().enumerate() {
                            *slot = seq
                                .next_element()?
                                .ok_or_else(|| de::Error::invalid_length(idx, &self))?;
                        }
                        if seq.next_element::<u8>()?.is_some() {
                            return Err(de::Error::custom(concat!(
                                "expected exactly ",
                                stringify!($len),
                                " bytes, found more"
                            )));
                        }
                        Ok($name(arr))
                    }
                }
                // Self-describing on the wire (rmp-serde) and over pythonize,
                // so `deserialize_any` routes arrays -> visit_seq and Python
                // bytes -> visit_bytes.
                d.deserialize_any(V)
            }
        }
    };
}

fixed_byte_newtype! {
    /// 20-byte internal account address — `keccak256(pubkey)[12..]`.
    /// Owners, relayer signers, fee-override accounts.
    Address, 20
}

fixed_byte_newtype! {
    /// 32-byte Ed25519 public key — agent wallets, Solana destinations.
    Pubkey, 32
}

/// A Solana transaction signature — the raw on-chain signature bytes that
/// bridge actions (`ConfirmDeposit`, `ConfirmWithdrawal`)
/// carry for idempotency / dedup. Variable length (Solana signatures are
/// 64 bytes, but the length is *not* constrained here — the engine and
/// gateway validate it downstream, and the dedup keyspace is byte-equality
/// so the SDK must not silently reshape it).
///
/// Wraps `Vec<u8>` for the same dual-form decode (msgpack seq-of-u8 *or*
/// Python `bytes`) and wire-identical encode guarantees as the fixed
/// newtypes.
/// Length of a Solana (Ed25519) signature in bytes. Used to bound the
/// untrusted-decode pre-allocation; not a hard validity check.
const SOLANA_SIG_LEN: usize = 64;

#[derive(Clone, PartialEq, Eq, Hash, Default)]
pub struct SolanaSignature(pub Vec<u8>);

impl SolanaSignature {
    /// Borrow the underlying bytes.
    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SolanaSignature {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SolanaSignature(0x")?;
        for b in &self.0 {
            write!(f, "{b:02x}")?;
        }
        f.write_str(")")
    }
}

impl From<Vec<u8>> for SolanaSignature {
    fn from(bytes: Vec<u8>) -> Self {
        SolanaSignature(bytes)
    }
}

impl From<SolanaSignature> for Vec<u8> {
    fn from(v: SolanaSignature) -> Self {
        v.0
    }
}

impl AsRef<[u8]> for SolanaSignature {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

impl Serialize for SolanaSignature {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            // Human-readable consumers (pythonize → a Python `bytes`).
            s.serialize_bytes(self.0.as_slice())
        } else {
            // Wire (rmp-serde): a msgpack array of u8, identical to the
            // pre-newtype `Vec<u8>` field encoding.
            self.0.serialize(s)
        }
    }
}

impl<'de> Deserialize<'de> for SolanaSignature {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = SolanaSignature;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a byte string or sequence of u8")
            }

            fn visit_bytes<E: de::Error>(self, v: &[u8]) -> Result<SolanaSignature, E> {
                Ok(SolanaSignature(v.to_vec()))
            }

            fn visit_byte_buf<E: de::Error>(self, v: Vec<u8>) -> Result<SolanaSignature, E> {
                Ok(SolanaSignature(v))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<SolanaSignature, A::Error> {
                // Never pre-allocate from the declared sequence length: a
                // malformed msgpack array header can claim billions of
                // elements, and `with_capacity(that)` is an OOM DoS on
                // untrusted input (caught by fuzzing). A Solana signature is
                // 64 bytes, so cap the hint; the Vec still grows to fit any
                // real elements that follow.
                let cap = seq.size_hint().unwrap_or(0).min(SOLANA_SIG_LEN);
                let mut out = Vec::with_capacity(cap);
                while let Some(b) = seq.next_element::<u8>()? {
                    out.push(b);
                }
                Ok(SolanaSignature(out))
            }
        }
        d.deserialize_any(V)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn address_wire_identical_to_bare_array() {
        let raw: [u8; 20] = [0x11; 20];
        let bare = rmp_serde::to_vec(&raw).unwrap();
        let wrapped = rmp_serde::to_vec(&Address(raw)).unwrap();
        assert_eq!(bare, wrapped, "Address must encode like a bare [u8;20]");
    }

    #[test]
    fn pubkey_wire_identical_to_bare_array() {
        let raw: [u8; 32] = [0xAB; 32];
        assert_eq!(
            rmp_serde::to_vec(&raw).unwrap(),
            rmp_serde::to_vec(&Pubkey(raw)).unwrap()
        );
    }

    #[test]
    fn solana_signature_wire_identical_to_bare_vec() {
        let raw: Vec<u8> = vec![1, 2, 3, 250, 0];
        assert_eq!(
            rmp_serde::to_vec(&raw).unwrap(),
            rmp_serde::to_vec(&SolanaSignature(raw.clone())).unwrap()
        );
    }

    #[test]
    fn address_round_trips_from_wire_seq() {
        let a = Address([0x42; 20]);
        let bytes = rmp_serde::to_vec(&a).unwrap();
        let back: Address = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(a, back);
    }

    #[test]
    fn address_rejects_wrong_length_seq() {
        // A 19-element msgpack array must fail to decode as Address.
        let short: [u8; 19] = [0; 19];
        let bytes = rmp_serde::to_vec(&short).unwrap();
        assert!(rmp_serde::from_slice::<Address>(&bytes).is_err());
    }

    #[test]
    fn debug_is_hex_not_array() {
        let a = Address([0x0a, 0x0b, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert!(format!("{a:?}").starts_with("Address(0x0a0b0c"));
    }

    #[test]
    fn solana_sig_huge_length_header_errors_without_oom() {
        // Regression (fuzz, decode_payload OOM): a msgpack `array32` marker
        // (0xdd) declaring ~3.7B elements with no real payload must error on
        // the truncated stream — NOT pre-allocate gigabytes and OOM.
        let malicious = [0xddu8, 0xdd, 0xdd, 0xdd, 0xdd];
        assert!(rmp_serde::from_slice::<SolanaSignature>(&malicious).is_err());
    }

    #[test]
    fn solana_sig_round_trips_64_bytes() {
        let sig = SolanaSignature(vec![0x7u8; 64]);
        let bytes = rmp_serde::to_vec(&sig).unwrap();
        assert_eq!(rmp_serde::from_slice::<SolanaSignature>(&bytes).unwrap(), sig);
    }
}
