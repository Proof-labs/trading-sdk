//! Ids the reads and helpers pass around that have no type in the core.

use std::fmt;
use std::num::NonZeroU32;

use crate::error::{Error, Result};

/// The engine's id for a position's stop-loss/take-profit bracket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TriggerGroupId(pub u64);

/// The engine's id for one limb (stop-loss or take-profit) of a bracket.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TriggerLimbId(pub u64);

/// The indexer's id for an indexed engine event: unique and increasing in
/// commit order. Not an [`crate::EventId`], which names a prediction event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct IndexerEventId(pub u64);

/// The id a master creates a sub-account under. The engine refuses 0
/// (`SubAccountIdZero`), so this type cannot hold it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SubAccountId(NonZeroU32);

impl SubAccountId {
    /// `id`, or [`Error::InvalidInput`] for 0.
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for 0, which the engine refuses.
    pub fn new(id: u32) -> Result<Self> {
        NonZeroU32::new(id)
            .map(Self)
            .ok_or_else(|| Error::InvalidInput("a sub-account id cannot be 0".into()))
    }

    /// The id as the wire carries it.
    #[must_use]
    pub const fn get(self) -> u32 {
        self.0.get()
    }
}

impl fmt::Display for SubAccountId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

macro_rules! display_inner {
    ($($t:ty),*) => {$(
        impl fmt::Display for $t {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }
    )*};
}
display_inner!(TriggerGroupId, TriggerLimbId, IndexerEventId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sub_account_id_refuses_zero() {
        assert!(matches!(SubAccountId::new(0), Err(Error::InvalidInput(_))));
        assert_eq!(SubAccountId::new(7).map(SubAccountId::get).ok(), Some(7));
    }
}
