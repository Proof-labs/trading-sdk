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

    let config = WsConfig {
        max_backoff: Duration::from_millis(50),
        ..WsConfig::new(url)
    };
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
    let WsMessage::OrderbookSnapshot { bids, .. } = next(&mut rx).await else {
        panic!("expected a fresh snapshot after reconnect")
    };
    assert_eq!(bids[0].price, 10);

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
