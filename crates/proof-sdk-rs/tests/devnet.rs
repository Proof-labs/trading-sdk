//! Read-only smoke test against the public devnet. Ignored by default (needs
//! the network): `cargo test -p proof-sdk-rs --test devnet -- --ignored`.
#![allow(clippy::unwrap_used, clippy::panic)]

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
    }
}

#[cfg(feature = "ws")]
#[tokio::test]
#[ignore = "hits the public devnet gateway"]
async fn the_feed_snapshots_a_book_and_accepts_a_signed_account_subscription() {
    use proof_sdk_rs::{ExchangeClient, LocalSigner, Subscription, WsClient, WsConfig, WsMessage};
    use std::time::Duration;

    let config = ClientConfig::devnet();
    let client = ExchangeClient::offline(
        &config,
        LocalSigner::from_bytes(&proof_sdk_rs::random_seed()),
    )
    .unwrap();
    let ws_config = WsConfig::from_client_config(&config)
        .unwrap()
        .with_account_auth(client.account_auth());
    let (ws, mut rx) = WsClient::connect(ws_config).await.unwrap();
    ws.subscribe(Subscription::Orderbook(1)).unwrap();
    ws.subscribe(Subscription::AccountEvents(client.address()))
        .unwrap();

    let (mut book, mut account) = (false, false);
    while !(book && account) {
        let msg = tokio::time::timeout(Duration::from_secs(15), rx.recv())
            .await
            .unwrap()
            .unwrap();
        match msg {
            WsMessage::OrderbookSnapshot { market: 1, .. } => book = true,
            WsMessage::AccountSnapshot { owner, .. } => {
                assert_eq!(owner, client.address());
                account = true;
            }
            WsMessage::Refused { .. } | WsMessage::Malformed { .. } => panic!("{msg:?}"),
            _ => {}
        }
    }
    ws.close();
}
