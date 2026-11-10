//! Read-only smoke test against the public devnet. Ignored by default (needs
//! the network): `cargo test -p proof-sdk-rs --test devnet -- --ignored`.
#![allow(clippy::unwrap_used)]

use proof_sdk_rs::{ClientConfig, EventId, InfoClient};

#[tokio::test]
#[ignore = "hits the public devnet gateway"]
async fn every_read_decodes_against_devnet() {
    let info = InfoClient::new(&ClientConfig::devnet()).unwrap();

    let id = info.chain_status().await.unwrap();
    assert_eq!(id.network, "exchange-devnet-1");

    let markets = info.markets().await.unwrap();
    assert!(!markets.is_empty());
    let market = markets[0].market;

    let events = info.events().await.unwrap();
    if let Some(e) = events.first() {
        assert!(info.event(e.event_id).await.unwrap().is_some());
    }
    assert!(info.event(EventId(u32::MAX)).await.unwrap().is_none());

    let book = info.orderbook(market).await.unwrap();
    if let (Some(b), Some(a)) = (book.best_bid(), book.best_ask()) {
        assert!(b.price < a.price, "book crossed: {b:?} / {a:?}");
    }

    let trades = info.recent_trades(market, 5).await.unwrap();
    if let Some(t) = trades.first() {
        // An active maker: its open orders and nonces exercise the owner reads.
        info.open_orders(t.maker_owner).await.unwrap();
        info.account(t.maker_owner).await.unwrap();
        info.recent_nonces(t.maker_owner).await.unwrap();
        let state = info.account_state(t.maker_owner).await.unwrap();
        assert_eq!(state.owner, t.maker_owner);
        assert!(state.height > 0);
    }
}
