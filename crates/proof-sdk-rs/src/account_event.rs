//! Account events from the `accountEvents` feed.

use crate::address::Address;
use crate::event::Event;

/// A live engine event for a subscribed account.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct AccountEvent {
    /// The subscribed account.
    pub owner: Address,
    pub height: u64,
    /// The transaction hash (or block-event key), when the gateway sends it.
    pub tx_hash: Option<String>,
    /// The event, typed as on a receipt. Untyped events stay raw in
    /// [`Event::Other`].
    pub event: Event,
}
