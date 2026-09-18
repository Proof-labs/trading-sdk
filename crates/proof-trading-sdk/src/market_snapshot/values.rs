//! Value types for the snapshot and receipt surfaces. Each one carries the
//! check its decoder already performed, so a caller cannot mistake a node
//! identity for a state hash, or a height for a millisecond clock.

use std::num::{NonZeroU32, NonZeroU64};

/// A Comet node's public identity, as `/status.node_info.id` reports it.
/// An all-zero identity names no node, so it is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct NodeId([u8; 20]);

impl NodeId {
    pub fn new(bytes: [u8; 20]) -> Option<Self> {
        (bytes != [0; 20]).then_some(Self(bytes))
    }

    pub fn bytes(self) -> [u8; 20] {
        self.0
    }
}

/// The application state hash a block header commits. An all-zero hash commits
/// no state, so it is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct AppHash([u8; 32]);

impl AppHash {
    pub fn new(bytes: [u8; 32]) -> Option<Self> {
        (bytes != [0; 32]).then_some(Self(bytes))
    }

    pub fn bytes(self) -> [u8; 32] {
        self.0
    }
}

/// A committed block height. Heights start at 1, so zero is not a height:
/// it is the state before the first block.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockHeight(NonZeroU64);

impl BlockHeight {
    pub fn new(height: u64) -> Option<Self> {
        NonZeroU64::new(height).map(Self)
    }

    pub fn get(self) -> u64 {
        self.0.get()
    }
}

impl std::fmt::Display for BlockHeight {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// A market's registry id. Ids start at 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MarketId(NonZeroU32);

impl MarketId {
    pub fn new(market: u32) -> Option<Self> {
        NonZeroU32::new(market).map(Self)
    }

    pub fn get(self) -> u32 {
        self.0.get()
    }
}

/// An amount in micro-USDC: six decimal places, so `1_000_000` is one dollar.
/// Whether zero is meaningful belongs to the field, not to the unit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MicroUsdc(u64);

impl MicroUsdc {
    pub fn new(micro: u64) -> Self {
        Self(micro)
    }

    pub fn micro(self) -> u64 {
        self.0
    }
}

/// A decimal with no leading zero and no sign, so one value has one spelling.
/// Zero is refused: every field read through this is positive by contract.
pub(crate) fn positive_decimal(text: &str) -> Option<u64> {
    if text.is_empty() || text.starts_with('0') || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Exactly `N` bytes of hexadecimal, either case.
pub(crate) fn hex_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    hex_array_with(text, u8::is_ascii_hexdigit)
}

/// Exactly `N` bytes of lowercase hexadecimal, for values whose source emits
/// one spelling and whose consumer compares them as text elsewhere.
pub(crate) fn lowercase_hex_array<const N: usize>(text: &str) -> Option<[u8; N]> {
    hex_array_with(text, |byte| {
        byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
    })
}

fn hex_array_with<const N: usize>(text: &str, accepted: impl Fn(&u8) -> bool) -> Option<[u8; N]> {
    if text.len() != N.checked_mul(2)? || !text.as_bytes().iter().all(accepted) {
        return None;
    }
    let mut result = [0; N];
    for (out, pair) in result.iter_mut().zip(text.as_bytes().chunks_exact(2)) {
        *out = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]
    use super::*;

    #[test]
    fn identities_and_hashes_refuse_their_empty_value() {
        assert_eq!(NodeId::new([0; 20]), None);
        assert_eq!(AppHash::new([0; 32]), None);
        assert_eq!(BlockHeight::new(0), None);
        assert_eq!(MarketId::new(0), None);
        assert_eq!(NodeId::new([1; 20]).expect("non-zero id").bytes(), [1; 20]);
        assert_eq!(
            AppHash::new([2; 32]).expect("non-zero hash").bytes(),
            [2; 32]
        );
        assert_eq!(BlockHeight::new(7).expect("positive height").get(), 7);
        assert_eq!(MarketId::new(15).expect("positive market").get(), 15);
        assert_eq!(MicroUsdc::new(0).micro(), 0);
    }

    #[test]
    fn parsers_accept_one_spelling_per_value() {
        assert_eq!(positive_decimal("42"), Some(42));
        for refused in ["", "0", "042", "-1", "4 2", "0x2a", "18446744073709551616"] {
            assert_eq!(positive_decimal(refused), None, "{refused}");
        }
        assert_eq!(hex_array::<2>("aB0f"), Some([0xab, 0x0f]));
        assert_eq!(lowercase_hex_array::<2>("ab0f"), Some([0xab, 0x0f]));
        assert_eq!(lowercase_hex_array::<2>("aB0f"), None);
        for refused in ["", "abc", "zz", "ab0f1c"] {
            assert_eq!(hex_array::<2>(refused), None, "{refused}");
        }
    }
}
