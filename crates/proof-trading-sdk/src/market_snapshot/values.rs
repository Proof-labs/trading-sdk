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

#[cfg(test)]
mod tests {
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
}
