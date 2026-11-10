//! Contract tests against a loopback fixture, never a real gateway.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use proof_sdk_rs::{
    Action, Address, ClientConfig, EngineError, Error, ErrorKind, Event, ExchangeClient,
    LocalSigner, RefusalReason, Side, TxHash, TxStatus,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A canned answer per request, in order. Captures each request's
/// `(method + path, body)`.
type Log = Arc<Mutex<Vec<(String, String)>>>;

async fn fixture(answers: Vec<(u16, Value)>) -> (String, Log) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let log: Log = Arc::default();
    let seen = Arc::clone(&log);
    tokio::spawn(async move {
        for (status, body) in answers {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let (head, body_in) = loop {
                let mut chunk = [0u8; 4096];
                let n = s.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..end]).to_string();
                    let len = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|v| v.parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break (head, String::from_utf8_lossy(&buf[end + 4..]).to_string());
                    }
                }
            };
            let line = head.lines().next().unwrap_or_default();
            let target = line.rsplit_once(' ').map_or(line, |(a, _)| a).to_string();
            seen.lock().unwrap().push((target, body_in));
            let body = body.to_string();
            let reply = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            s.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    (url, log)
}

fn client(url: &str) -> ExchangeClient {
    let config = ClientConfig::new(url).with_chain_id("exchange-devnet-1");
    ExchangeClient::new(&config, LocalSigner::from_bytes(&[9; 32])).unwrap()
}

fn cancel_all(c: &ExchangeClient) -> Action {
    Action::CancelAllOrders(proof_sdk_rs::core::types::CancelAllOrders {
        owner: c.address().to_bytes(),
        market: None,
    })
}

#[tokio::test]
async fn place_order_posts_the_signed_bytes_and_reads_the_committed_events() {
    let c = client("http://127.0.0.1:1");
    let order = c.limit_order(1, Side::Buy, 66_000_000_000, 2);
    let tx = c.sign(&Action::PlaceOrder(order)).unwrap();
    let (url, log) = fixture(vec![(
        200,
        // As devnet answers a resting order.
        json!({"status":"ok","txHash":tx.hash.to_string(),"code":0,"height":42,"log":"",
               "events":[{"type":"order_placed","attributes":[
                   {"index":false,"key":"order_id","value":"33514"},{"key":"market","value":"1"},
                   {"key":"side","value":"buy"},{"key":"price","value":"66000000000"},
                   {"key":"quantity","value":"2"},{"key":"client_order_id","value":"0"},
                   {"key":"post_only","value":"false"},{"key":"time_in_force","value":"gtc"}]},
                   {"type":"fees_collected","attributes":[]}]}),
    )])
    .await;
    let c = client(&url);
    let submitted = c.send(&tx).await.unwrap();
    assert!(submitted.is_success());
    assert_eq!(submitted.error(), None);
    let receipt = submitted.receipt().unwrap();
    let Event::OrderPlaced(o) = &receipt.events[0] else {
        panic!("{:?}", receipt.events)
    };
    assert_eq!(
        (o.order_id, o.price, o.client_order_id),
        (33514, 66_000_000_000, None)
    );
    assert!(matches!(&receipt.events[1], Event::Other(raw) if raw.kind == "fees_collected"));

    let (target, body) = log.lock().unwrap()[0].clone();
    assert_eq!(target, "POST /exchange");
    let sent: Value = serde_json::from_str(&body).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(sent["action"].as_str().unwrap())
        .unwrap();
    assert_eq!(bytes, tx.bytes, "the exact signed bytes go on the wire");
}

#[tokio::test]
async fn a_checktx_rejection_surfaces_a_typed_engine_error() {
    let c = client("http://127.0.0.1:1");
    let tx = c.sign(&cancel_all(&c)).unwrap();
    let (url, _) = fixture(vec![(
        200,
        json!({"status":"error","txHash":tx.hash.to_string(),"code":12}),
    )])
    .await;
    let s = client(&url).send(&tx).await.unwrap();
    assert!(!s.is_success());
    assert_eq!(
        s.error(),
        Some(EngineError::Known(ErrorKind::InsufficientMargin))
    );
    assert_eq!(
        s.status,
        TxStatus::Rejected(EngineError::Known(ErrorKind::InsufficientMargin))
    );
}

#[tokio::test]
async fn a_failure_in_the_block_is_typed_from_its_code_and_log() {
    let c = client("http://127.0.0.1:1");
    let tx = c.sign(&cancel_all(&c)).unwrap();
    let (url, _) = fixture(vec![
        (
            200,
            json!({"status":"error","txHash":tx.hash.to_string(),"code":44,"height":9,"log":"client order id not found","events":[]}),
        ),
        (
            200,
            json!({"status":"error","txHash":tx.hash.to_string(),"code":50,"height":9,
                   "log":"atomic basket aggregate slippage exceeded","events":[]}),
        ),
        (
            200,
            json!({"status":"error","txHash":tx.hash.to_string(),"code":60_000,"height":9,"events":[]}),
        ),
    ])
    .await;
    let c = client(&url);
    let gone = c.send(&tx).await.unwrap().error().unwrap();
    assert!(gone.is_order_not_found());
    assert_eq!(gone.code(), 44);
    assert_eq!(
        c.send(&tx).await.unwrap().error(),
        Some(EngineError::Known(ErrorKind::SlippageExceeded)),
        "code 50 reads from its log"
    );
    assert_eq!(
        c.send(&tx).await.unwrap().error(),
        Some(EngineError::Unknown(60_000)),
        "a code newer than the SDK keeps its number"
    );
}

#[tokio::test]
async fn a_pending_submission_reconciles_through_its_receipt() {
    let c = client("http://127.0.0.1:1");
    let tx = c.sign(&cancel_all(&c)).unwrap();
    let hash = tx.hash;
    let (url, log) = fixture(vec![
        (200, json!({"status":"pending","txHash":hash.to_string()})),
        (404, json!({"error":"not found"})),
        (
            200,
            json!({"result":{"hash":hash.to_string(),"height":"7","tx_result":{"code":0,"log":"",
                "events":[{"type":"order_cancelled","attributes":[{"key":"order_id","value":"5"},
                    {"key":"market","value":"1"},{"key":"reason","value":"user_requested"}]}]}}}),
        ),
    ])
    .await;
    let c2 = client(&url);
    let s = c2.send(&tx).await.unwrap();
    assert!(s.is_pending());
    let receipt = c2
        .wait_for_receipt(hash, Duration::from_secs(5))
        .await
        .unwrap();
    assert!(receipt.is_success());
    assert_eq!(receipt.height, 7);
    assert!(matches!(&receipt.events[0], Event::OrderCancelled(c) if c.order_id == 5));
    let targets: Vec<String> = log.lock().unwrap().iter().map(|r| r.0.clone()).collect();
    assert_eq!(targets[1], format!("GET /v1/tx/{hash}"));
}

#[tokio::test]
async fn a_5xx_on_submit_is_a_plain_http_error() {
    let c = client("http://127.0.0.1:1");
    let tx = c.sign(&cancel_all(&c)).unwrap();
    let (url, _) = fixture(vec![(502, json!({"oops": true}))]).await;
    match client(&url).send(&tx).await {
        Err(Error::Http { status: 502, .. }) => {}
        other => panic!("expected Http 502, got {other:?}"),
    }
}

#[tokio::test]
async fn an_unreachable_gateway_is_a_transport_error() {
    let c = client("http://127.0.0.1:1");
    let tx = c.sign(&cancel_all(&c)).unwrap();
    match c.send(&tx).await {
        Err(Error::Transport(_)) => {}
        other => panic!("expected Transport, got {other:?}"),
    }
}

#[tokio::test]
async fn receipt_wait_times_out_without_claiming_failure() {
    let (url, _) = fixture(vec![(404, json!({})), (404, json!({})), (404, json!({}))]).await;
    let hash = TxHash::from_bytes([1; 32]);
    let err = client(&url)
        .wait_for_receipt(hash, Duration::from_millis(250))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::ReceiptTimeout { hash: h } if h == hash));
}

#[tokio::test]
async fn open_orders_and_nonces_decode_and_post_the_owner() {
    let owner: Address = "bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9".parse().unwrap();
    let order = rmp_order(owner);
    let data = base64::engine::general_purpose::STANDARD.encode(order);
    let (url, log) = fixture(vec![
        (200, json!({"data": data})),
        (
            200,
            json!({"recent": ["1762000000001", 1_762_000_000_002_u64]}),
        ),
    ])
    .await;
    let c = client(&url);
    let orders = c.info().open_orders(owner).await.unwrap();
    assert_eq!(orders.len(), 1);
    assert_eq!(orders[0].owner, owner.to_bytes());
    assert_eq!(orders[0].side, Side::Sell);
    assert_eq!(orders[0].price, 75_000_000_000);

    let nonces = c.info().recent_nonces(owner).await.unwrap();
    assert_eq!(nonces, vec![1_762_000_000_001, 1_762_000_000_002]);

    let log = log.lock().unwrap();
    assert_eq!(log[0].0, "POST /info");
    let body: Value = serde_json::from_str(&log[0].1).unwrap();
    assert_eq!(body, json!({"type":"openOrders","user":owner.to_string()}));
    assert_eq!(log[1].0, format!("GET /v1/account/{owner}/recent-nonces"));
}

#[tokio::test]
async fn a_missing_event_reads_as_none() {
    let (url, _) = fixture(vec![(404, json!({"error":"event 9 not found"}))]).await;
    assert!(client(&url)
        .info()
        .event(proof_sdk_rs::EventId(9))
        .await
        .unwrap()
        .is_none());
}

/// `[[Order]]` as the engine encodes it: a msgpack array of one 14-field record.
fn rmp_order(owner: Address) -> Vec<u8> {
    let order = proof_sdk_rs::core::types::Order {
        id: 5,
        market: 1,
        owner: owner.to_bytes(),
        side: Side::Sell,
        price: 75_000_000_000,
        quantity: 3,
        client_order_id: Some(11),
        original_quantity: 3,
        filled_quantity: 0,
        created_at_ms: 1,
        queue_priority: 1,
        time_in_force: proof_sdk_rs::TimeInForce::Gtc,
        post_only: true,
        reduce_only: false,
    };
    rmp_serde::to_vec(&vec![order]).unwrap()
}

#[tokio::test]
async fn a_gateway_refusal_is_typed_with_its_retry_hint() {
    let c = client("http://127.0.0.1:1");
    let tx = c.sign(&cancel_all(&c)).unwrap();
    let (url, _) = fixture(vec![(
        429,
        json!({"status":"refused","error":"rate limited","errorCode":"RateLimited","retryAfterMs":1501}),
    )])
    .await;
    let s = client(&url).send(&tx).await.unwrap();
    assert_eq!(s.status, TxStatus::Refused(RefusalReason::RateLimited));
    assert!(!s.is_success() && !s.is_pending());
    assert_eq!(s.error(), None, "a gateway refusal is not an engine error");
    // 1501 ms rounds up to whole seconds, never down.
    assert_eq!(s.retry_after, Some(Duration::from_secs(2)));
}

#[tokio::test]
async fn receipt_wait_reports_a_rate_limit_instead_of_timing_out() {
    let (url, _) = fixture(vec![(404, json!({})), (429, json!({}))]).await;
    let hash = TxHash::from_bytes([1; 32]);
    let err = client(&url)
        .wait_for_receipt(hash, Duration::from_secs(5))
        .await
        .unwrap_err();
    assert!(matches!(err, Error::Http { status: 429, .. }), "{err:?}");
}
