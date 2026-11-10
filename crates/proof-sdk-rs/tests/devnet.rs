//! End-to-end tests against the public devnet. Ignored by default (they need
//! the network):
//!
//! ```sh
//! cargo test -p proof-sdk-rs --test devnet -- --ignored
//! PROOF_FAUCET_TOKEN=<token> cargo test -p proof-sdk-rs --test devnet -- --ignored
//! ```
//!
//! The first test is read-only. The second funds a throwaway key with devnet
//! play money and rests orders far from the touch, so nothing fills.
#![cfg(feature = "ws")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::too_many_lines
)]

use std::time::Duration;

use proof_sdk_rs::{
    actions, AccountEvent, CancelReason, ClientConfig, Event, EventId, ExchangeClient, LocalSigner,
    Orderbook, Receipt, Side, Subscription, TxStatus, WsClient, WsMessage, WsReceiver,
};

async fn next(rx: &mut WsReceiver) -> WsMessage {
    let msg = tokio::time::timeout(Duration::from_secs(30), rx.recv())
        .await
        .expect("no feed message within 30s")
        .expect("feed ended");
    if let WsMessage::Refused { .. } | WsMessage::Malformed { .. } = msg {
        panic!("{msg:?}");
    }
    msg
}

async fn next_event(rx: &mut WsReceiver) -> AccountEvent {
    loop {
        if let WsMessage::AccountEvent(e) = next(rx).await {
            return e;
        }
    }
}

fn assert_sorted(book: &Orderbook) {
    assert!(
        book.bids.windows(2).all(|w| w[0].price > w[1].price),
        "bids best first"
    );
    assert!(
        book.asks.windows(2).all(|w| w[0].price < w[1].price),
        "asks best first"
    );
    if let (Some(b), Some(a)) = (book.best_bid(), book.best_ask()) {
        assert!(b.price < a.price, "book crossed: {b:?} / {a:?}");
    }
}

fn order_ids(r: &Receipt) -> Vec<(u64, Option<u64>)> {
    r.events
        .iter()
        .filter_map(|e| match e {
            Event::OrderPlaced(p) => Some((p.order_id, p.client_order_id)),
            _ => None,
        })
        .collect()
}

async fn throwaway() -> ExchangeClient {
    let signer = LocalSigner::from_bytes(&proof_sdk_rs::random_seed());
    ExchangeClient::connect(&ClientConfig::devnet(), signer)
        .await
        .unwrap()
}

/// Every read decodes, and a book kept from the feed with `Orderbook::apply`
/// matches the snapshot a resubscribe returns.
#[tokio::test]
#[ignore = "hits the public devnet gateway"]
async fn a_read_only_client_sees_devnet() {
    let client = throwaway().await;
    let info = client.info();
    assert_eq!(
        info.chain_status().await.unwrap().network,
        "exchange-devnet-1"
    );
    assert!(!info.markets().await.unwrap().is_empty());
    if let Some(e) = info.events().await.unwrap().first() {
        assert!(info.event(e.event_id).await.unwrap().is_some());
    }
    assert!(info.event(EventId(u32::MAX)).await.unwrap().is_none());
    assert_sorted(&info.orderbook(1).await.unwrap());

    // An active maker exercises the owner reads.
    let trades = info.recent_trades(1, 5).await.unwrap();
    let maker = trades
        .first()
        .expect("no recent trades on market 1")
        .maker_owner;
    info.open_orders(maker).await.unwrap();
    info.account(maker).await.unwrap();
    info.recent_nonces(maker).await.unwrap();
    let state = info.account_state(maker).await.unwrap();
    assert_eq!(state.owner, maker);
    assert!(state.height > 0);
    assert!(state.positions.iter().all(|p| p.owner == maker.to_bytes()));

    // The feed: a signed account subscription, and a live book.
    let (ws, mut rx) = WsClient::connect(client.ws_config()).await.unwrap();
    ws.subscribe(Subscription::AccountEvents(client.address()))
        .unwrap();
    ws.subscribe(Subscription::Orderbook(1)).unwrap();
    let (mut book, mut account, mut updates) = (None, false, 0);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline || book.is_none() || !account {
        match next(&mut rx).await {
            WsMessage::AccountSnapshot { owner, .. } => {
                assert_eq!(owner, client.address());
                account = true;
            }
            WsMessage::OrderbookSnapshot { market: 1, book: b } => book = Some(b),
            WsMessage::OrderbookUpdate {
                market: 1,
                side,
                level,
            } => {
                book.as_mut()
                    .expect("update before snapshot")
                    .apply(side, level);
                updates += 1;
            }
            _ => {}
        }
    }
    let mut book = book.unwrap();
    assert_sorted(&book);

    // Frames on one socket are ordered, so a resubscribe's snapshot is the
    // book after every update queued ahead of it.
    ws.unsubscribe(Subscription::Orderbook(1)).unwrap();
    ws.subscribe(Subscription::Orderbook(1)).unwrap();
    let fresh = loop {
        match next(&mut rx).await {
            WsMessage::OrderbookSnapshot { market: 1, book } => break book,
            WsMessage::OrderbookUpdate {
                market: 1,
                side,
                level,
            } => book.apply(side, level),
            _ => {}
        }
    };
    assert_eq!(book, fresh, "local book drifted after {updates} updates");
    ws.close();
}

/// A funded account places, cancel-replaces and cancels; the receipt, the
/// feed and the account reads agree at each step.
#[tokio::test]
#[ignore = "trades on the public devnet; needs PROOF_FAUCET_TOKEN"]
async fn a_funded_account_trades_and_reconciles() {
    let Ok(token) = std::env::var("PROOF_FAUCET_TOKEN") else {
        eprintln!("PROOF_FAUCET_TOKEN unset; skipping");
        return;
    };
    let client = throwaway().await;
    let me = client.address();
    let (ws, mut rx) = WsClient::connect(client.ws_config()).await.unwrap();
    ws.subscribe(Subscription::AccountEvents(me)).unwrap();
    // The snapshot confirms the signed subscription landed before we act.
    while !matches!(next(&mut rx).await, WsMessage::AccountSnapshot { .. }) {}

    let drip = reqwest::Client::new()
        .post("https://faucet.dev.proof.trade/drip")
        .bearer_auth(token)
        .json(&serde_json::json!({ "address": format!("0x{me}") }))
        .send()
        .await
        .unwrap();
    assert!(drip.status().is_success(), "faucet: {}", drip.status());
    assert!(matches!(next_event(&mut rx).await.event, Event::Deposited(d) if d.amount > 0));

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
    let mut order = actions::limit_order(me, 1, Side::Buy, price, btc.lot_size);
    order.post_only = true;
    order.client_order_id = Some(77);

    // Sign and send apart: an Err from send would leave tx.hash to reconcile.
    let tx = client
        .sign(&proof_sdk_rs::Action::PlaceOrder(order.clone()))
        .unwrap();
    let TxStatus::Committed(placed) = client.send(&tx).await.unwrap().status else {
        panic!("place did not commit")
    };
    assert!(placed.is_success(), "{placed:?}");
    let [(order_id, Some(77))] = order_ids(&placed)[..] else {
        panic!("{:?}", placed.events)
    };
    let e = next_event(&mut rx).await;
    assert_eq!((e.tx_hash, e.height), (Some(tx.hash), placed.height));
    assert!(matches!(e.event, Event::OrderPlaced(o) if o.order_id == order_id));
    let state = client.info().account_state(me).await.unwrap();
    assert!(state.height >= placed.height && state.balance > 0);

    // Replace it one tick lower under a new client id.
    order.price -= tick;
    order.client_order_id = Some(78);
    let replaced = client
        .submit(&actions::cancel_replace_client_order(77, order))
        .await
        .unwrap();
    let r = replaced.receipt().expect("replace did not commit");
    assert!(r.is_success(), "{r:?}");
    assert!(r.events.iter().any(|e| matches!(e,
        Event::OrderCancelled(c) if c.order_id == order_id && c.reason == CancelReason::UserRequested)));
    let [(new_id, Some(78))] = order_ids(r)[..] else {
        panic!("{:?}", r.events)
    };
    let open = client.info().open_orders(me).await.unwrap();
    assert_eq!(open.iter().map(|o| o.id).collect::<Vec<_>>(), [new_id]);

    // Cancelling the order already replaced is a typed engine error.
    let again = client.cancel_order(order_id).await.unwrap();
    assert!(
        again.error().is_some_and(|e| e.is_order_not_found()),
        "{:?}",
        again.status
    );

    let all = client.cancel_all_orders(None).await.unwrap();
    assert!(all.is_success(), "{:?}", all.status);
    assert!(client.info().open_orders(me).await.unwrap().is_empty());
    ws.close();
}
