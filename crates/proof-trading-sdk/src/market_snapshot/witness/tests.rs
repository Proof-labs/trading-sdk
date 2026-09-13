#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]

use super::*;
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
    let mut bad = full;
    bad["witness"]["height"] = json!("101");
    assert_eq!(
        decode_bound_snapshot(&bytes(&bad), chain_id()).unwrap_err(),
        WitnessError::HeightMismatch
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
    // The old time-only method remains backward compatible.
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
    assert_eq!(verified.witness.app_hash, [2; 32]);
    assert_eq!(verified.after.app_hash_height, 100);
    // Status H exposes the previous state. It cannot commit snapshot post-H.
    assert_eq!(
        validate_bound_inventory(snapshot(1), before(), before(), None).unwrap_err(),
        WitnessError::Uncommitted
    );
}

#[test]
fn cross_replica_aba_and_wrong_matching_hash_are_rejected() {
    assert_eq!(
        validate_bound_inventory(snapshot(2), before(), after(), None).unwrap_err(),
        WitnessError::BackendMismatch
    );
    let mut other = after();
    other.node_id = [3; 20];
    assert_eq!(
        validate_bound_inventory(snapshot(1), before(), other, None).unwrap_err(),
        WitnessError::BackendMismatch
    );
    let mut wrong = after();
    wrong.app_hash = [3; 32];
    assert_eq!(
        validate_bound_inventory(snapshot(1), before(), wrong, None).unwrap_err(),
        WitnessError::HashMismatch
    );
}

#[test]
fn snapshot_clock_cannot_be_replaced_with_fresh_status_clock() {
    let mut stale = snapshot(1);
    stale.witness.finalized_block_time_ms = NOW - 10_000;
    assert_eq!(
        validate_bound_inventory(stale, before(), after(), None).unwrap_err(),
        WitnessError::TimeMismatch
    );
    let mut future = snapshot(1);
    future.witness.finalized_block_time_ms = NOW + 100;
    assert_eq!(
        validate_bound_inventory(future, before(), after(), None).unwrap_err(),
        WitnessError::TimeMismatch
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
        WitnessError::Uncommitted
    );
    for body in [
        block_body(100, 2),
        block_body(101, 3),
        json!({"error":{"code":-32603}}),
    ] {
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
    assert_eq!(verified.witness.node_id, [1; 20]);
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
    assert_eq!(verified.after.identity.latest_height, 101);
    task.await.unwrap();
}

#[tokio::test]
async fn backend_change_while_waiting_is_refused() {
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
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::BackendMismatch
    );
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
        WitnessError::HashMismatch
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
    for _ in 0..MAX_CONFIRMATION_POLLS {
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
    for _ in 0..MAX_CONFIRMATION_POLLS {
        responses.push(("/v1/status", status_body(100, NOW, 1, 1), Duration::ZERO));
    }
    let (url, task) = server(responses).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(5)).unwrap();
    assert_eq!(
        client.read_bound_inventory(chain_id()).await.unwrap_err(),
        WitnessError::Uncommitted
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
