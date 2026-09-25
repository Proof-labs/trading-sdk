#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::arithmetic_side_effects
)]

use super::*;
use crate::market_snapshot::ConfirmationPolling;

fn node(id: u8) -> NodeId {
    NodeId::new([id; 20]).expect("fixture node ids are non-zero")
}
fn hash(byte: u8) -> AppHash {
    AppHash::new([byte; 32]).expect("fixture app hashes are non-zero")
}
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const NOW: u64 = 1_789_128_000_000;

fn chain_id() -> [u8; 32] {
    crate::crypto::chain_id_from_string("proof-test")
}
fn snapshot_body(height: u64, time: u64, node: u8, hash: u8) -> Value {
    let data = rmp_serde::to_vec(&json!([chain_id(), height, [], []])).unwrap();
    json!({"data":STANDARD.encode(data),"witness":{
        "version":1,"nodeId":hex::encode([node;20]),"height":height.to_string(),
        "finalizedBlockTimeMs":time.to_string(),"appHash":hex::encode([hash;32])}})
}
fn status_body(height: u64, time: u64, node: u8, hash: u8) -> Value {
    let time = chrono::DateTime::from_timestamp_millis(time as i64)
        .unwrap()
        .to_rfc3339();
    json!({"result":{"node_info":{"network":"proof-test","id":hex::encode([node;20])},
        "sync_info":{"latest_block_height":height.to_string(),"latest_block_time":time,
        "latest_app_hash":hex::encode([hash;32]),"catching_up":false}}})
}
fn block_body(height: u64, hash: u8) -> Value {
    json!({"result":{"block":{"header":{"chain_id":"proof-test","height":height.to_string(),
        "app_hash":hex::encode([hash;32])}}}})
}
fn bytes(body: &Value) -> Vec<u8> {
    serde_json::to_vec(body).unwrap()
}
fn snapshot(node: u8) -> BoundMarketsSnapshot {
    decode_bound_snapshot(&bytes(&snapshot_body(100, NOW, node, 2)), chain_id()).unwrap()
}
fn before() -> BoundChainIdentity {
    decode_bound_identity(&bytes(&status_body(100, NOW, 1, 1)), chain_id()).unwrap()
}
fn after() -> BoundChainIdentity {
    decode_bound_identity(&bytes(&status_body(101, NOW + 100, 1, 2)), chain_id()).unwrap()
}
/// A status read past `H + 1`, so only the exact header can commit the witness.
fn advanced_on(node: u8) -> BoundChainIdentity {
    decode_bound_identity(&bytes(&status_body(105, NOW + 500, node, 8)), chain_id())
        .expect("fixture status decodes")
}

#[test]
fn legacy_snapshot_decode_is_unchanged_but_bound_method_requires_witness() {
    let full = snapshot_body(100, NOW, 1, 2);
    let mut old = full.clone();
    old.as_object_mut().unwrap().remove("witness");
    assert_eq!(
        decode_snapshot(&bytes(&old), chain_id()).unwrap().height,
        100
    );
    assert_eq!(
        decode_snapshot(&bytes(&full), chain_id()).unwrap().height,
        100
    );
    assert_eq!(
        decode_bound_snapshot(&bytes(&old), chain_id()).unwrap_err(),
        WitnessError::MissingWitness
    );
    for (field, value) in [
        ("version", json!(2)),
        ("nodeId", json!("")),
        ("nodeId", json!("00".repeat(20))),
        ("nodeId", json!("zz".repeat(20))),
        ("height", json!("0100")),
        ("height", json!("0")),
        ("height", json!(100)),
        ("finalizedBlockTimeMs", json!("0")),
        ("appHash", json!("ab".repeat(31))),
        ("appHash", json!("00".repeat(32))),
    ] {
        let mut bad = full.clone();
        bad["witness"][field] = value;
        assert!(
            decode_bound_snapshot(&bytes(&bad), chain_id()).is_err(),
            "{field}"
        );
    }
    let mut unsupported = full.clone();
    unsupported["witness"]["version"] = json!(2);
    assert_eq!(
        decode_bound_snapshot(&bytes(&unsupported), chain_id()).unwrap_err(),
        WitnessError::UnsupportedWitnessVersion { version: 2 }
    );
    let mut bad = full;
    bad["witness"]["height"] = json!("101");
    assert_eq!(
        decode_bound_snapshot(&bytes(&bad), chain_id()).unwrap_err(),
        WitnessError::WitnessHeightMismatch
    );
}

#[test]
fn duplicate_fields_and_missing_node_identity_fail_closed() {
    let full = String::from_utf8(bytes(&snapshot_body(100, NOW, 1, 2))).unwrap();
    let duplicate = full.replace("\"version\":1", "\"version\":1,\"version\":1");
    assert!(decode_bound_snapshot(duplicate.as_bytes(), chain_id()).is_err());
    let duplicate_data = full.replacen("\"data\":", "\"data\":\"\",\"data\":", 1);
    assert!(decode_bound_snapshot(duplicate_data.as_bytes(), chain_id()).is_err());
    let mut status = status_body(100, NOW, 1, 1);
    status["result"]["node_info"]
        .as_object_mut()
        .unwrap()
        .remove("id");
    assert!(decode_bound_identity(&bytes(&status), chain_id()).is_err());
    // decode_identity reads the same body without the node identity.
    assert!(chain::decode_identity(&bytes(&status), chain_id()).is_ok());
    let status = String::from_utf8(bytes(&status_body(100, NOW, 1, 1))).unwrap();
    let duplicate = status.replace(
        "\"id\":",
        &format!("\"id\":\"{}\",\"id\":", "ab".repeat(20)),
    );
    assert!(decode_bound_identity(duplicate.as_bytes(), chain_id()).is_err());
    for key in ["result", "node_info", "sync_info", "latest_app_hash"] {
        let pattern = format!("\"{key}\":");
        let duplicate = status.replacen(&pattern, &format!("\"{key}\":null,{pattern}"), 1);
        assert!(
            decode_bound_identity(duplicate.as_bytes(), chain_id()).is_err(),
            "duplicate {key}"
        );
    }
    let duplicate = full.replacen("\"witness\":", "\"witness\":null,\"witness\":", 1);
    assert!(decode_bound_snapshot(duplicate.as_bytes(), chain_id()).is_err());
}

#[test]
fn hashes_are_compared_at_state_height_not_reported_header_height() {
    let pre = before();
    assert_eq!(pre.app_hash_height, 99);
    assert_ne!(pre.app_hash, snapshot(1).witness.app_hash);
    let verified = validate_bound_inventory(snapshot(1), pre, after(), None).unwrap();
    assert_eq!(verified.witness.app_hash, hash(2));
    assert_eq!(verified.after.app_hash_height, 100);
    // Status H exposes the previous state. It cannot commit snapshot post-H.
    assert_eq!(
        validate_bound_inventory(snapshot(1), before(), before(), None).unwrap_err(),
        WitnessError::NotYetCommitted
    );
}

#[test]
fn mixed_backends_with_consistent_state_are_accepted() {
    let verified = validate_bound_inventory(snapshot(2), before(), after(), None)
        .expect("a status anchor from another node commits the witness app hash");
    assert_eq!(verified.witness().node_id, node(2));
    assert_eq!(verified.before().node_id(), node(1));

    let mut other = after();
    other.node_id = node(3);
    let verified = validate_bound_inventory(snapshot(1), before(), other, None)
        .expect("the after status may come from a third node");
    assert_eq!(verified.after().node_id(), node(3));

    let verified = validate_bound_inventory(
        snapshot(2),
        before(),
        advanced_on(3),
        Some(&bytes(&block_body(101, 2))),
    )
    .expect("the exact H + 1 header commits the witness whichever node served each read");
    assert_eq!(verified.after().node_id(), node(3));
}

#[test]
fn wrong_app_hash_is_rejected_regardless_of_backend() {
    let mut wrong = after();
    wrong.node_id = node(3);
    wrong.app_hash = hash(3);
    assert_eq!(
        validate_bound_inventory(snapshot(2), before(), wrong, None)
            .expect_err("a status anchor with another app hash at H refuses the witness"),
        WitnessError::AppHashMismatch
    );
    assert_eq!(
        validate_bound_inventory(
            snapshot(2),
            before(),
            advanced_on(3),
            Some(&bytes(&block_body(101, 3)))
        )
        .expect_err("a header that does not commit the witness app hash refuses it"),
        WitnessError::AppHashMismatch
    );
}

#[test]
fn snapshot_clock_cannot_be_replaced_with_fresh_status_clock() {
    let mut stale = snapshot(1);
    stale.witness.finalized_block_time_ms = NOW - 10_000;
    assert_eq!(
        validate_bound_inventory(stale, before(), after(), None).unwrap_err(),
        WitnessError::ClockMismatch
    );
    let mut future = snapshot(1);
    future.witness.finalized_block_time_ms = NOW + 100;
    assert_eq!(
        validate_bound_inventory(future, before(), after(), None).unwrap_err(),
        WitnessError::ClockMismatch
    );
    let verified = validate_bound_inventory(snapshot(1), before(), after(), None).unwrap();
    assert_eq!(verified.witness.finalized_block_time_ms, NOW);
    assert_ne!(
        verified.witness.finalized_block_time_ms,
        verified.after.identity.latest_block_time_ms
    );
}

#[test]
fn fast_chain_uses_exact_next_header_and_rejects_wrong_height_chain_or_hash() {
    let advanced =
        || decode_bound_identity(&bytes(&status_body(105, NOW + 500, 1, 8)), chain_id()).unwrap();
    assert!(validate_bound_inventory(
        snapshot(1),
        before(),
        advanced(),
        Some(&bytes(&block_body(101, 2)))
    )
    .is_ok());
    assert_eq!(
        validate_bound_inventory(snapshot(1), before(), advanced(), None).unwrap_err(),
        WitnessError::MissingBlockBody
    );
    for height in [100, 102] {
        assert_eq!(
            validate_bound_inventory(
                snapshot(1),
                before(),
                advanced(),
                Some(&bytes(&block_body(height, 2)))
            )
            .unwrap_err(),
            WitnessError::HeaderHeightMismatch,
            "header height {height} must not satisfy the requested height 101"
        );
    }
    for body in [block_body(101, 3), json!({"error":{"code":-32603}})] {
        assert!(
            validate_bound_inventory(snapshot(1), before(), advanced(), Some(&bytes(&body)))
                .is_err()
        );
    }
    let mut foreign = block_body(101, 2);
    foreign["result"]["block"]["header"]["chain_id"] = json!("another-chain");
    assert_eq!(
        validate_bound_inventory(snapshot(1), before(), advanced(), Some(&bytes(&foreign)))
            .unwrap_err(),
        WitnessError::Snapshot(SnapshotError::WrongChain)
    );
}

#[test]
fn maximum_snapshot_height_reports_height_overflow() {
    let bound =
        decode_bound_snapshot(&bytes(&snapshot_body(u64::MAX, NOW, 1, 2)), chain_id()).unwrap();
    let anchor =
        decode_bound_identity(&bytes(&status_body(u64::MAX, NOW, 1, 1)), chain_id()).unwrap();
    assert_eq!(
        validate_bound_inventory(bound, anchor.clone(), anchor, None).unwrap_err(),
        WitnessError::HeightOverflow
    );
}

async fn server(
    responses: Vec<(&'static str, Value, Duration)>,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        for (path, body, delay) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut input = Vec::new();
            while !input.windows(4).any(|w| w == b"\r\n\r\n") {
                let mut buf = [0; 1024];
                let n = socket.read(&mut buf).await.unwrap();
                assert!(n > 0);
                input.extend_from_slice(&buf[..n]);
            }
            assert!(
                String::from_utf8_lossy(&input).starts_with(&format!("GET {path} HTTP/1.1\r\n"))
            );
            tokio::time::sleep(delay).await;
            let body = bytes(&body);
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            if socket.write_all(header.as_bytes()).await.is_err() {
                return;
            }
            if socket.write_all(&body).await.is_err() {
                return;
            }
        }
    });
    (url, task)
}

#[tokio::test]
async fn fast_chain_whole_flow_uses_gateway_exact_height_query() {
    let responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        (
            "/v1/status",
            status_body(105, NOW + 500, 1, 8),
            Duration::ZERO,
        ),
        ("/v1/block?height=101", block_body(101, 2), Duration::ZERO),
    ];
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
    let verified = client.read_bound_inventory(chain_id()).await.unwrap();
    assert_eq!(verified.snapshot.height, 100);
    assert_eq!(verified.witness.node_id, node(1));
    task.await.unwrap();
}

#[tokio::test]
async fn gateway_wrong_header_height_reports_header_height_mismatch() {
    let responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        (
            "/v1/status",
            status_body(105, NOW + 500, 1, 8),
            Duration::ZERO,
        ),
        ("/v1/block?height=101", block_body(102, 2), Duration::ZERO),
    ];
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::HeaderHeightMismatch
    );
    task.await.unwrap();
}

#[tokio::test]
async fn gateway_maximum_snapshot_height_reports_height_overflow() {
    let responses = vec![
        (
            "/v1/status",
            status_body(u64::MAX, NOW, 1, 1),
            Duration::ZERO,
        ),
        (
            "/v1/markets-snapshot",
            snapshot_body(u64::MAX, NOW, 1, 2),
            Duration::ZERO,
        ),
        (
            "/v1/status",
            status_body(u64::MAX, NOW, 1, 1),
            Duration::ZERO,
        ),
    ];
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::HeightOverflow
    );
    task.await.unwrap();
}

#[tokio::test]
async fn matching_state_height_needs_no_extra_block_request() {
    let responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        (
            "/v1/status",
            status_body(101, NOW + 100, 1, 2),
            Duration::ZERO,
        ),
    ];
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
    assert!(client.read_bound_inventory(chain_id()).await.is_ok());
    task.await.unwrap();
}

#[tokio::test]
async fn same_height_reads_wait_for_next_header_without_resnapshot_or_clock_renewal() {
    let responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/status",
            status_body(101, NOW + 100, 1, 2),
            Duration::ZERO,
        ),
    ];
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(2)).unwrap();
    let verified = client.read_bound_inventory(chain_id()).await.unwrap();
    assert_eq!(verified.snapshot.height, 100);
    assert_eq!(verified.witness.finalized_block_time_ms, NOW);
    assert_eq!(verified.after.identity.latest_height.get(), 101);
    task.await.unwrap();
}

#[tokio::test]
async fn backend_change_while_waiting_is_accepted_when_state_is_consistent() {
    let responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/status",
            status_body(101, NOW + 100, 2, 2),
            Duration::ZERO,
        ),
    ];
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
    let verified = client
        .read_bound_inventory(chain_id())
        .await
        .expect("a node change while waiting does not refuse a consistent bracket");
    assert_eq!(verified.snapshot().height, 100);
    assert_eq!(verified.before().node_id(), node(1));
    assert_eq!(verified.after().node_id(), node(2));
    task.await.unwrap();
}

#[tokio::test]
async fn confirmation_poll_cannot_erase_a_conflicting_same_height_hash() {
    // The original before witness is height99, so comparing each later read
    // only with before would miss two contradictory height100 observations.
    let responses = vec![
        (
            "/v1/status",
            status_body(99, NOW - 100, 1, 9),
            Duration::ZERO,
        ),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        ("/v1/status", status_body(100, NOW, 1, 7), Duration::ZERO),
    ];
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::AppHashMismatch
    );
    task.await.unwrap();
}

#[tokio::test]
async fn halted_chain_confirmation_wait_respects_the_original_whole_call_deadline() {
    let mut responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
    ];
    for _ in 0..ConfirmationPolling::DEFAULT_POLLS {
        responses.push(("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO));
    }
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_millis(650)).unwrap();
    let start = Instant::now();
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::Snapshot(SnapshotError::Timeout)
    );
    assert!(start.elapsed() < Duration::from_millis(900));
    task.abort();
}

#[tokio::test]
async fn a_configured_schedule_replaces_the_default_poll_count() {
    let mut responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
    ];
    // Two polls, not the default eight: the third status read never happens.
    for _ in 0..2 {
        responses.push(("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO));
    }
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::with_confirmation_polling(
        &url,
        Duration::from_secs(5),
        ConfirmationPolling {
            polls: 2,
            interval: Duration::from_millis(10),
        },
    )
    .expect("two polls are inside the ceiling");
    let start = Instant::now();
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::NotYetCommitted
    );
    // Eight polls at the default interval could not finish this quickly.
    assert!(start.elapsed() < Duration::from_millis(500));
    task.abort();
}

#[test]
fn a_schedule_outside_the_safety_ceiling_is_refused() {
    for polling in [
        ConfirmationPolling {
            polls: ConfirmationPolling::MAX_POLLS + 1,
            interval: ConfirmationPolling::DEFAULT_INTERVAL,
        },
        ConfirmationPolling {
            polls: 1,
            interval: ConfirmationPolling::MAX_INTERVAL + Duration::from_millis(1),
        },
    ] {
        assert!(matches!(
            MarketsSnapshotClient::with_confirmation_polling(
                "http://127.0.0.1:9080",
                Duration::from_secs(5),
                polling,
            ),
            Err(SnapshotError::InvalidConfirmationPolling)
        ));
    }
    // A schedule longer than the deadline is a caller's choice, not an error:
    // the whole-call deadline ends the wait.
    assert!(MarketsSnapshotClient::with_confirmation_polling(
        "http://127.0.0.1:9080",
        Duration::from_millis(100),
        ConfirmationPolling::default(),
    )
    .is_ok());
}

#[tokio::test]
async fn confirmation_poll_cap_is_finite_even_when_the_call_budget_is_longer() {
    let mut responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::ZERO,
        ),
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
    ];
    for _ in 0..ConfirmationPolling::DEFAULT_POLLS {
        responses.push(("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO));
    }
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(5)).unwrap();
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::NotYetCommitted
    );
    task.await.unwrap();
}

#[tokio::test]
async fn timeout_is_one_budget_for_the_entire_bracket_not_each_read() {
    let responses = vec![
        (
            "/v1/status",
            status_body(100, NOW, 1, 1),
            Duration::from_millis(120),
        ),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 1, 2),
            Duration::from_millis(120),
        ),
    ];
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_millis(200)).unwrap();
    let start = Instant::now();
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::Snapshot(SnapshotError::Timeout)
    );
    assert!(start.elapsed() < Duration::from_millis(350));
    task.abort();
}

/// One bracket whose pre-status came from a node a block ahead of the node
/// that served the snapshot: honest, committed reads in the wrong height order.
fn out_of_order_bracket() -> Vec<(&'static str, Value, Duration)> {
    vec![
        (
            "/v1/status",
            status_body(101, NOW + 100, 1, 2),
            Duration::ZERO,
        ),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 2, 2),
            Duration::ZERO,
        ),
        (
            "/v1/status",
            status_body(101, NOW + 100, 3, 2),
            Duration::ZERO,
        ),
    ]
}

/// The same reads once every node serves height 101: an in-order bracket
/// whose post-status commits the snapshot's app hash.
fn in_order_bracket() -> Vec<(&'static str, Value, Duration)> {
    vec![
        (
            "/v1/status",
            status_body(101, NOW + 100, 1, 2),
            Duration::ZERO,
        ),
        (
            "/v1/markets-snapshot",
            snapshot_body(101, NOW + 100, 2, 3),
            Duration::ZERO,
        ),
        (
            "/v1/status",
            status_body(102, NOW + 200, 3, 3),
            Duration::ZERO,
        ),
    ]
}

/// The scripted server answers each response once, in order, then drops its
/// listener. A caller that stops early leaves the task waiting, and one that
/// asks again after the script ends is refused with a transport error, so a
/// finished task plus the expected error pins the exact number of requests.
async fn served_every_scripted_read(task: tokio::task::JoinHandle<()>) {
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("the client made every scripted request")
        .expect("every request matched its scripted path");
}

#[tokio::test]
async fn out_of_order_bracket_is_read_again_and_accepted_when_in_order() {
    let mut responses = out_of_order_bracket();
    responses.extend(in_order_bracket());
    let (url, task) = server(responses).await;
    let client =
        MarketsSnapshotClient::new(&url, Duration::from_secs(2)).expect("valid loopback client");
    let start = Instant::now();
    let verified = client
        .read_bound_inventory(chain_id())
        .await
        .expect("a fresh in-order bracket is accepted after an out-of-order one");
    assert!(start.elapsed() >= BRACKET_RETRY_DELAY);
    // Every part comes from the second attempt; nothing is carried over.
    assert_eq!(verified.snapshot().height, 101);
    assert_eq!(verified.witness().app_hash, hash(3));
    assert_eq!(verified.before().identity().latest_height.get(), 101);
    assert_eq!(verified.after().identity().latest_height.get(), 102);
    served_every_scripted_read(task).await;
}

#[tokio::test]
async fn out_of_order_on_every_attempt_refuses_after_the_attempt_limit() {
    let mut responses = Vec::new();
    for _ in 0..BRACKET_ATTEMPTS {
        responses.extend(out_of_order_bracket());
    }
    assert_eq!(responses.len(), 3 * BRACKET_ATTEMPTS);
    let (url, task) = server(responses).await;
    let client =
        MarketsSnapshotClient::new(&url, Duration::from_secs(5)).expect("valid loopback client");
    let start = Instant::now();
    assert_eq!(
        client
            .read_bound_inventory(chain_id())
            .await
            .expect_err("reads that never land in order are refused"),
        WitnessError::BracketOutOfOrder
    );
    // One pause between each pair of attempts.
    let pauses = u32::try_from(BRACKET_ATTEMPTS - 1).expect("the attempt limit fits a u32");
    assert!(start.elapsed() >= BRACKET_RETRY_DELAY * pauses);
    served_every_scripted_read(task).await;
}

#[tokio::test]
async fn confirmation_poll_behind_the_previous_status_is_read_again() {
    // The post-status sits at the snapshot height, so the client polls; the
    // poll lands on a node one block behind and the attempt is refused as out
    // of order, then a fresh bracket is accepted.
    let mut responses = vec![
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/markets-snapshot",
            snapshot_body(100, NOW, 2, 2),
            Duration::ZERO,
        ),
        ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
        (
            "/v1/status",
            status_body(99, NOW - 100, 3, 9),
            Duration::ZERO,
        ),
    ];
    responses.extend(in_order_bracket());
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::with_confirmation_polling(
        &url,
        Duration::from_secs(2),
        ConfirmationPolling {
            polls: 2,
            interval: Duration::from_millis(10),
        },
    )
    .expect("two polls are inside the ceiling");
    let verified = client
        .read_bound_inventory(chain_id())
        .await
        .expect("a fresh bracket after a lagging poll is accepted");
    assert_eq!(verified.snapshot().height, 101);
    served_every_scripted_read(task).await;
}

#[tokio::test]
async fn refusals_other_than_out_of_order_are_not_retried() {
    let mut bad_witness = snapshot_body(100, NOW, 2, 2);
    bad_witness["witness"]["nodeId"] = json!("");
    let cases = vec![
        (
            // The post-status commits another app hash at the snapshot height.
            vec![
                ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
                (
                    "/v1/markets-snapshot",
                    snapshot_body(100, NOW, 2, 2),
                    Duration::ZERO,
                ),
                (
                    "/v1/status",
                    status_body(101, NOW + 100, 3, 3),
                    Duration::ZERO,
                ),
            ],
            WitnessError::AppHashMismatch,
        ),
        (
            // The snapshot's witness names no node; the attempt ends there.
            vec![
                ("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO),
                ("/v1/markets-snapshot", bad_witness, Duration::ZERO),
            ],
            WitnessError::MalformedWitness,
        ),
    ];
    for (responses, expected) in cases {
        let (url, task) = server(responses).await;
        let client = MarketsSnapshotClient::new(&url, Duration::from_secs(2))
            .expect("valid loopback client");
        // A second attempt would find the listener gone and fail as transport.
        assert_eq!(
            client
                .read_bound_inventory(chain_id())
                .await
                .expect_err("the scripted bracket is refused"),
            expected
        );
        served_every_scripted_read(task).await;
    }
}
