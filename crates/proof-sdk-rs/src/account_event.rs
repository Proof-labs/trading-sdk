//! Account events from the `accountEvents` feed.

use proof_trading_sdk::gateway::TxHash;

use crate::address::Address;
use crate::event::Event;

/// A live engine event for a subscribed account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountEvent {
    /// The subscribed account.
    pub owner: Address,
    /// The block it happened in.
    pub height: u64,
    /// The transaction that caused it. `None` for a block event (funding,
    /// expiry, liquidation) that no transaction caused.
    pub tx_hash: Option<TxHash>,
    /// The transaction's position in the block; `None` for a block event.
    pub tx_index: Option<u32>,
    /// The event's position within its transaction (or the block's events).
    /// With `height` and `tx_index` it identifies the event, as the
    /// account-events history keys it.
    pub event_index: Option<u32>,
    /// The event, typed as on a receipt.
    pub event: Event,
}
