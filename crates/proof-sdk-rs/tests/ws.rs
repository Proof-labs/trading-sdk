//! Feed lifecycle against a loopback WebSocket server.
#![cfg(feature = "ws")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::format_collect
)]

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use proof_sdk_rs::{
    AccountAuth, Address, LocalSigner, Signer, Subscription, WsClient, WsConfig, WsMessage,
};
use serde_json::Value;
use tokio::net::TcpListener;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

const SNAPSHOT: &str = r#"{"asks":[[11,1,1]],"bids":[[10,2,1]],"channel":"orderbook","market":1,"snapshot":"initial","type":"snapshot"}"#;

async fn next(rx: &mut proof_sdk_rs::WsReceiver) -> WsMessage {
    timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("feed stalled")
        .expect("feed ended")
}

/// Read one client text frame as JSON.
async fn read_json(ws: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Value {
    loop {
        if let Message::Text(t) = ws.next().await.unwrap().unwrap() {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

#[tokio::test]
async fn reconnects_and_resubscribes_after_a_drop() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());

    let server = tokio::spawn(async move {
        let mut seen = Vec::new();
        for round in 0..2 {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let sub = read_json(&mut ws).await;
            seen.push(sub);
            ws.send(Message::Text(SNAPSHOT.into())).await.unwrap();
            if round == 0 {
                ws.close(None).await.unwrap(); // drop the first connection
            } else {
                // Keep the second open until the client closes.
                while let Some(Ok(m)) = ws.next().await {
                    if m.is_close() {
                        break;
                    }
                }
            }
        }
        seen
    });

    let config = WsConfig::new(url).with_max_backoff(Duration::from_millis(50));
    let (client, mut rx) = WsClient::connect(config).await.unwrap();
    client.subscribe(Subscription::Orderbook(1)).unwrap();

    assert!(matches!(
        next(&mut rx).await,
        WsMessage::OrderbookSnapshot { market: 1, .. }
    ));
    assert!(matches!(
        next(&mut rx).await,
        WsMessage::Disconnected { .. }
    ));
    assert!(matches!(next(&mut rx).await, WsMessage::Reconnected));
    let WsMessage::OrderbookSnapshot { book, .. } = next(&mut rx).await else {
        panic!("expected a fresh snapshot after reconnect")
    };
    assert_eq!(book.bids[0].price, 10);

    client.close();
    assert!(timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .is_none());

    let seen = server.await.unwrap();
    for sub in &seen {
        assert_eq!(sub["method"], "subscribe");
        assert_eq!(sub["params"]["channel"], "orderbook");
        assert_eq!(sub["params"]["market"], 1);
    }
    assert_ne!(
        seen[0]["id"], seen[1]["id"],
        "each subscribe gets a fresh id"
    );
}

#[tokio::test]
async fn a_401_at_reconnect_ends_the_feed() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());

    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        ws.close(None).await.unwrap();
        // Every later handshake is refused; count them.
        let mut refused = 0;
        while let Ok(Ok((mut tcp, _))) =
            timeout(Duration::from_millis(500), listener.accept()).await
        {
            let mut buf = [0u8; 1024];
            let _ = tcp.read(&mut buf).await;
            tcp.write_all(b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n")
                .await
                .unwrap();
            refused += 1;
        }
        refused
    });

    let config = WsConfig::new(url).with_max_backoff(Duration::from_millis(20));
    let (_client, mut rx) = WsClient::connect(config).await.unwrap();

    assert!(matches!(next(&mut rx).await, WsMessage::Disconnected { .. }));
    let WsMessage::Disconnected { reason } = next(&mut rx).await else {
        panic!("expected the refused reconnect")
    };
    assert!(reason.contains("401"), "{reason}");
    assert!(timeout(Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .is_none());
    assert_eq!(server.await.unwrap(), 1, "no retry after a 401");
}

#[tokio::test]
async fn account_subscriptions_carry_a_verifiable_signature() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        read_json(&mut ws).await
    });

    let signer = Arc::new(LocalSigner::from_bytes(&[4; 32]));
    let owner = Address::from_public_key(&signer.public_key());
    let config =
        WsConfig::new(url).with_account_auth(AccountAuth::new(signer.clone(), "exchange-devnet-1"));
    let (client, _rx) = WsClient::connect(config).await.unwrap();
    client
        .subscribe(Subscription::AccountEvents(owner))
        .unwrap();

    let sub = timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
    let p = &sub["params"];
    assert_eq!(p["channel"], "accountEvents");
    assert_eq!(p["owner"], owner.to_string());
    let ts = p["timestamp_ms"].as_u64().unwrap();

    let mut msg = b"ProofExchange-account-events-v1".to_vec();
    msg.extend_from_slice(&proof_sdk_rs::core::crypto::chain_id_from_string(
        "exchange-devnet-1",
    ));
    msg.extend_from_slice(owner.to_string().as_bytes());
    msg.extend_from_slice(&0_i64.to_be_bytes());
    msg.extend_from_slice(&ts.to_be_bytes());
    let sig = signer.try_sign(&msg).unwrap();
    let hex: String = sig.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(p["signature"], hex);
}

/// A refused subscription can be retried, and account events the snapshot
/// already holds are not delivered again.
#[tokio::test]
async fn a_refused_subscription_retries_and_the_snapshot_boundary_holds() {
    const OWNER: &str = "bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9";
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let first = read_json(&mut ws).await;
        let refuse = serde_json::json!({"type":"error","id":first["id"],"channel":"accountEvents","code":429,"error":"rate limited"});
        ws.send(Message::Text(refuse.to_string().into())).await.unwrap();
        let second = read_json(&mut ws).await;
        let event = |height: u64| serde_json::json!({"channel":"accountEvents","type":"fill","eventType":"deposited","owner":OWNER,"height":height,"txHash":format!("height-{height}-kind-block-event-0"),"txIndex":null,"eventIndex":0,"payload":{"owner":OWNER,"amount":"5","new_balance":"5"}}).to_string();
        for frame in [
            serde_json::json!({"type":"subscribed","id":second["id"],"channel":"accountEvents"}).to_string(),
            serde_json::json!({"channel":"accountEvents","type":"snapshot","owner":OWNER,"account":{"data":"mgCQAAAAAJAAAAA="},"height":10,"snapshot":"initial"}).to_string(),
            event(10), // already in the snapshot
            event(11),
        ] {
            ws.send(Message::Text(frame.into())).await.unwrap();
        }
        while let Some(Ok(m)) = ws.next().await {
            if m.is_close() {
                break;
            }
        }
    });

    let owner: Address = OWNER.parse().unwrap();
    let (client, mut rx) = WsClient::connect(WsConfig::new(url)).await.unwrap();
    client.subscribe(Subscription::AccountEvents(owner)).unwrap();
    let m = next(&mut rx).await;
    assert!(
        matches!(m, WsMessage::Refused { subscription: Some(Subscription::AccountEvents(o)), code: Some(429), .. } if o == owner),
        "{m:?}"
    );
    client.subscribe(Subscription::AccountEvents(owner)).unwrap();
    assert!(matches!(next(&mut rx).await, WsMessage::AccountSnapshot { height: Some(10), .. }));
    let WsMessage::AccountEvent(e) = next(&mut rx).await else {
        panic!("expected the event after the snapshot")
    };
    assert_eq!((e.height, e.tx_hash, e.tx_index, e.event_index), (11, None, None, Some(0)));
    client.close();
    server.await.unwrap();
}

/// A consumer that stops reading for longer than the pong timeout does not
/// lose a healthy socket: frames queued behind it count as proof of life.
#[tokio::test]
async fn a_slow_consumer_keeps_a_busy_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        read_json(&mut ws).await;
        // Never answers a ping; just keeps the book busy.
        for _ in 0..80 {
            ws.send(Message::Text(SNAPSHOT.into())).await.unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let config = WsConfig::new(url)
        .with_ping_interval(Duration::from_millis(50))
        .with_pong_timeout(Duration::from_millis(100))
        .with_buffer(1);
    let (client, mut rx) = WsClient::connect(config).await.unwrap();
    client.subscribe(Subscription::Orderbook(1)).unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    for i in 0..40 {
        let m = next(&mut rx).await;
        assert!(matches!(m, WsMessage::OrderbookSnapshot { .. }), "message {i}: {m:?}");
    }
    client.close();
}
