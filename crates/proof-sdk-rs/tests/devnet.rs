//! Read-only smoke test against the public devnet. Ignored by default (needs
//! the network): `cargo test -p proof-sdk-rs --test devnet -- --ignored`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

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
    let client = ExchangeClient::new(
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

/// Funds a throwaway account, rests a post-only bid far below the book, cancels
/// it, and checks each step arrives on the signed feed as a typed event.
/// Devnet play money; no fill, no position. Needs `PROOF_FAUCET_TOKEN`.
#[cfg(feature = "ws")]
#[tokio::test]
#[ignore = "trades on the public devnet; needs PROOF_FAUCET_TOKEN"]
async fn live_account_events_arrive_typed() {
    use proof_sdk_rs::{
        AccountEventKind, ExchangeClient, LocalSigner, Side, Subscription, WsClient, WsConfig,
        WsMessage, WsReceiver,
    };
    use std::time::Duration;

    async fn next_kind(rx: &mut WsReceiver) -> AccountEventKind {
        loop {
            let msg = tokio::time::timeout(Duration::from_secs(30), rx.recv())
                .await
                .expect("no account event within 30s")
                .expect("feed ended");
            match msg {
                WsMessage::AccountEvent(e) => {
                    eprintln!("{} -> {:?}", e.event_type, e.kind);
                    return e.kind;
                }
                WsMessage::Refused { message, .. } => panic!("refused: {message}"),
                _ => {}
            }
        }
    }

    let Ok(token) = std::env::var("PROOF_FAUCET_TOKEN") else {
        eprintln!("PROOF_FAUCET_TOKEN unset; skipping");
        return;
    };
    let config = ClientConfig::devnet();
    let signer = LocalSigner::from_bytes(&proof_sdk_rs::random_seed());
    let client = ExchangeClient::connect(&config, signer).await.unwrap();
    let ws_config = WsConfig::from_client_config(&config)
        .unwrap()
        .with_account_auth(client.account_auth());
    let (ws, mut rx) = WsClient::connect(ws_config).await.unwrap();
    ws.subscribe(Subscription::AccountEvents(client.address()))
        .unwrap();
    // The snapshot confirms the signed subscription landed before we act.
    while !matches!(rx.recv().await, Some(WsMessage::AccountSnapshot { .. })) {}

    let drip = reqwest::Client::new()
        .post("https://faucet.dev.proof.trade/drip")
        .bearer_auth(token)
        .json(&serde_json::json!({ "address": format!("0x{}", client.address()) }))
        .send()
        .await
        .unwrap();
    assert!(drip.status().is_success(), "faucet: {}", drip.status());
    assert!(matches!(
        next_kind(&mut rx).await,
        AccountEventKind::Deposited(d) if d.amount > 0
    ));

    let markets = client.info().markets().await.unwrap();
    let btc = markets.iter().find(|m| m.market == 1).unwrap();
    let bid = client
        .info()
        .orderbook(1)
        .await
        .unwrap()
        .best_bid()
        .unwrap();
    let tick = btc.tick_size.max(1);
    let price = (bid.price / 2) / tick * tick; // half the touch: never fills
    let mut order = client.limit_order(1, Side::Buy, price, btc.lot_size.max(1));
    order.post_only = true;
    order.client_order_id = Some(77);
    let placed = client
        .submit_and_wait(
            &proof_sdk_rs::Action::PlaceOrder(order),
            Duration::from_secs(15),
        )
        .await
        .unwrap();
    assert!(placed.is_success(), "{:?}", placed.status);
    let AccountEventKind::OrderPlaced(o) = next_kind(&mut rx).await else {
        panic!("expected OrderPlaced")
    };
    assert_eq!(
        (o.market, o.price, o.client_order_id, o.post_only),
        (1, price, Some(77), true)
    );

    let cancelled = client.cancel_client_order(77).await.unwrap();
    assert!(
        cancelled.is_success() || cancelled.is_pending(),
        "{:?}",
        cancelled.status
    );
    let AccountEventKind::OrderCancelled(c) = next_kind(&mut rx).await else {
        panic!("expected OrderCancelled")
    };
    assert_eq!((c.order_id, c.client_order_id), (o.order_id, Some(77)));
    ws.close();
}
