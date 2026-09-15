#![cfg(feature = "gateway")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use proof_trading_sdk::gateway::*;
use serde_json::{json, Value};
use std::{num::NonZeroU32, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

// Contract fixture only: a task-owned one-shot loopback server, never a real
// gateway/node. Captures exactly one request; no signing or exchange mutations.
async fn server(response: String, delay: Duration) -> (String, JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0u8; 2048];
            let n = stream.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
            assert!(bytes.len() <= 16_384);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
                let length = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(|n| n.parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        tokio::time::sleep(delay).await;
        let _ = stream.write_all(response.as_bytes()).await;
        bytes
    });
    (format!("http://{addr}"), task)
}
fn response(status: u16, body: &str, headers: &str) -> String {
    format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len())
}
async fn fixture(value: Value) -> (GatewayClient, JoinHandle<Vec<u8>>) {
    let (url, task) = server(response(200, &value.to_string(), ""), Duration::ZERO).await;
    (
        GatewayClient::new(&url, GatewayOptions::default()).unwrap(),
        task,
    )
}
fn market() -> NonZeroU32 {
    NonZeroU32::new(1).unwrap()
}
fn policy(version: u64) -> Value {
    json!([
        version,
        ([1u8; 32]),
        ([2u8; 32]),
        ([3u8; 32]),
        0,
        100_000,
        100_000,
        [
            [1, ([4u8; 32]), ([6u8; 32]), 6],
            [2, ([5u8; 32]), ([6u8; 32]), 6]
        ]
    ])
}
fn committed() -> Value {
    json!([
        1,
        15,
        10,
        true,
        "Committed",
        "Satisfied",
        policy(1),
        null,
        [15, 1_000, "Fresh", "Fresh", [123, 990], 999]
    ])
}
fn encoded(value: Value) -> Value {
    json!({"data": STANDARD.encode(rmp_serde::to_vec(&value).unwrap())})
}

#[tokio::test]
async fn exact_signed_request_and_committed_execution_are_distinct_from_permission() {
    let bytes = b"synthetic signed envelope retained exactly";
    let hash = TxHash::of_signed_bytes(bytes);
    let (url, task) = server(
        response(
            200,
            &json!({"status":"error","txHash":hash.to_string(),"code":21,"height":17}).to_string(),
            "",
        ),
        Duration::ZERO,
    )
    .await;
    let options = GatewayOptions {
        api_key: Some("test-only-not-a-real-key".into()),
        ..GatewayOptions::default()
    };
    assert!(!format!("{options:?}").contains("test-only-not-a-real-key"));
    let client = GatewayClient::new(&url, options).unwrap();
    let result = client.submit_signed_bytes(bytes).await.unwrap();
    assert_eq!(
        result.outcome,
        SubmissionOutcome::Committed(CommittedReceipt {
            hash,
            height: 17.try_into().unwrap(),
            code: 21
        })
    );
    let request = String::from_utf8(task.await.unwrap()).unwrap();
    assert!(request.starts_with("POST /exchange HTTP/1.1"));
    assert!(request.contains("x-api-key: test-only-not-a-real-key"));
    let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body.as_object().unwrap().len(), 1);
    assert_eq!(
        STANDARD.decode(body["action"].as_str().unwrap()).unwrap(),
        bytes
    );
}

#[tokio::test]
async fn submit_classifies_checktx_ambiguous_and_pre_admission_without_retry() {
    let bytes = b"retained exact bytes";
    let hash = TxHash::of_signed_bytes(bytes);
    for (body, expected) in [
        (
            json!({"status":"error","txHash":hash.to_string(),"code":21}),
            SubmissionOutcome::CheckTxRejected {
                hash,
                code: 21.try_into().unwrap(),
            },
        ),
        (
            json!({"status":"error","txHash":hash.to_string()}),
            SubmissionOutcome::Pending { hash },
        ),
        (json!({"status":"ok"}), SubmissionOutcome::Pending { hash }),
        (
            json!({"status":"ok","txHash":hash.to_string(),"code":0}),
            SubmissionOutcome::Pending { hash },
        ),
        (
            json!({"status":"error","error":"validation rejected"}),
            SubmissionOutcome::RejectedBeforeAdmission { hash },
        ),
    ] {
        let (client, task) = fixture(body).await;
        assert_eq!(
            client.submit_signed_bytes(bytes).await.unwrap().outcome,
            expected
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn post_mismatch_or_malformed_result_retains_local_hash_and_hides_payload() {
    let bytes = b"signature-and-secret-looking-payload";
    let own = TxHash::of_signed_bytes(bytes);
    for (body, kind) in [
        (
            json!({"status":"ok","txHash":TxHash::from_bytes([9;32]).to_string(),"code":0,"height":1}),
            ErrorKind::HashMismatch,
        ),
        (
            json!({"status":"ok","txHash":own.to_string(),"code":0,"height":0}),
            ErrorKind::InvalidResponse,
        ),
        (
            json!({"status":"ok","code":0,"height":1}),
            ErrorKind::InvalidResponse,
        ),
        (
            json!({"status":"ok","txHash":own.to_string(),"code":21,"height":1}),
            ErrorKind::InvalidResponse,
        ),
        (
            json!({"status":"signature-and-secret-looking-payload"}),
            ErrorKind::InvalidResponse,
        ),
    ] {
        let (client, task) = fixture(body).await;
        let error = client.submit_signed_bytes(bytes).await.unwrap_err();
        assert_eq!(error.kind, kind);
        assert_eq!(error.reconcile_hash, Some(own));
        assert!(!format!("{error:?} {error}").contains("signature-and-secret-looking-payload"));
        task.await.unwrap();
    }
}

#[tokio::test]
async fn receipt_requires_hash_positive_height_and_exact_code() {
    let hash = TxHash::from_bytes([7; 32]);
    let (client, task) = fixture(json!({"result":{"hash":hash.to_string(),"height":"18446744073709551615","tx_result":{"code":0}}})).await;
    let receipt = client.committed_receipt(hash).await.unwrap();
    assert_eq!(receipt.height.get(), u64::MAX);
    assert_eq!(receipt.code, 0);
    assert!(String::from_utf8(task.await.unwrap())
        .unwrap()
        .starts_with(&format!("GET /v1/tx/{hash} HTTP/1.1")));
    for body in [
        json!({"result":{"hash":TxHash::from_bytes([8;32]).to_string(),"height":"1","tx_result":{"code":0}}}),
        json!({"result":{"hash":hash.to_string(),"height":"0","tx_result":{"code":0}}}),
        json!({"result":{"hash":hash.to_string(),"height":"01","tx_result":{"code":0}}}),
        json!({"result":{"hash":hash.to_string(),"height":"1","tx_result":{}}}),
        json!({"result":{"hash":hash.to_string(),"height":"1","tx_result":{"code":0}},"error":{"code":-1}}),
        json!({"error":{"code":-32603,"message":"not found yet"}}),
    ] {
        let (client, task) = fixture(body).await;
        assert!(client.committed_receipt(hash).await.is_err());
        task.await.unwrap();
    }
}

#[tokio::test]
async fn chain_identity_uses_gateway_status_and_real_chain_binding_and_time() {
    let value = json!({"result":{"node_info":{"network":"proof-fixture"},"sync_info":{
        "latest_block_height":"9007199254740993","latest_block_time":"2026-09-10T12:34:56.123456789Z","catching_up":false}}});
    let (client, task) = fixture(value.clone()).await;
    let chain = client.chain_identity().await.unwrap();
    assert_eq!(
        chain.chain_binding,
        proof_trading_sdk::crypto::chain_id_from_string("proof-fixture")
    );
    assert_eq!(chain.latest_height, 9_007_199_254_740_993);
    assert_eq!(chain.latest_block_time_ms, 1_789_043_696_123);
    assert!(!chain.catching_up);
    assert!(String::from_utf8(task.await.unwrap())
        .unwrap()
        .starts_with("GET /v1/status HTTP/1.1"));
    for path in ["latest_block_height", "latest_block_time"] {
        let mut bad = value.clone();
        bad["result"]["sync_info"][path] = json!("not-a-value");
        let (client, task) = fixture(bad).await;
        assert_eq!(
            client.chain_identity().await.unwrap_err().kind,
            ErrorKind::InvalidResponse
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn permissions_preserve_exact_typed_epoch_and_truthful_unavailability() {
    for wire in [
        committed(),
        json!([1, 9, 10, false, "Legacy", null, null, null, null]),
        json!([
            1,
            15,
            10,
            true,
            "Unavailable",
            "Unavailable",
            null,
            [16, policy(1)],
            null
        ]),
        json!([
            1,
            15,
            10,
            true,
            "Committed",
            "Unavailable",
            policy(1),
            null,
            [15, 1000, "Stale", "ExpiredSource", null, null]
        ]),
    ] {
        let (client, task) = fixture(encoded(wire.clone())).await;
        let read = client.oracle_permissions(market()).await.unwrap();
        assert_eq!(read.market, 1);
        assert_eq!(read.finalized_height, wire[1].as_u64().unwrap());
        if let Some(policy) = read.policy {
            assert_eq!(policy.sources[1].authority, [5u8; 32]);
        }
        assert!(String::from_utf8(task.await.unwrap())
            .unwrap()
            .starts_with("GET /v1/oracle/permissions/1 HTTP/1.1"));
    }
}

#[tokio::test]
async fn malformed_or_false_permission_evidence_never_decodes_as_healthy() {
    let mut cases = vec![
        json!({"market":1}),
        json!([1, 15]),
        json!([1, 15, 10, true, "Unknown", "Unavailable", null, null, null]),
    ];
    for (index, replacement) in [
        (0, json!(2)),
        (1, json!(-1)),
        (2, json!(16)),
        (3, json!(false)),
        (4, json!("Legacy")),
        (5, json!("Unavailable")),
        (6, Value::Null),
    ] {
        let mut bad = committed();
        bad[index] = replacement;
        cases.push(bad);
    }
    for (index, replacement) in [
        (0, json!(14)),
        (2, json!("Unpriceable")),
        (3, json!("MissingSource")),
        (4, Value::Null),
        (5, json!(1001)),
    ] {
        let mut bad = committed();
        bad[8][index] = replacement;
        cases.push(bad);
    }
    let mut same_authority = committed();
    same_authority[6][7][1][1] = json!(([4u8; 32]));
    cases.push(same_authority);
    let mut wrong_scale = committed();
    wrong_scale[6][7][1][3] = json!(8);
    cases.push(wrong_scale);
    let mut old_pending = committed();
    old_pending[7] = json!([15, policy(1)]);
    cases.push(old_pending);
    for case in cases {
        let (client, task) = fixture(encoded(case)).await;
        assert_eq!(
            client.oracle_permissions(market()).await.unwrap_err().kind,
            ErrorKind::InvalidResponse
        );
        task.await.unwrap();
    }
    let mut trailing = rmp_serde::to_vec(&committed()).unwrap();
    trailing.push(0);
    let (client, task) = fixture(json!({"data":STANDARD.encode(trailing)})).await;
    assert_eq!(
        client.oracle_permissions(market()).await.unwrap_err().kind,
        ErrorKind::InvalidResponse
    );
    task.await.unwrap();
}

#[tokio::test]
async fn enum_ordinals_maps_and_binary_strings_are_not_canonical_permission_reads() {
    let mut cases = Vec::new();
    for replacement in [json!(0), json!({"Legacy":null})] {
        let mut value = json!([1, 9, 10, false, "Legacy", null, null, null, null]);
        value[4] = replacement;
        cases.push(value);
    }
    for (index, replacement) in [
        (2, json!(0)),
        (2, json!({"Fresh":null})),
        (3, json!(15)),
        (3, json!({"Fresh":null})),
    ] {
        let mut value = committed();
        value[8][index] = replacement;
        cases.push(value);
    }
    for replacement in [json!(0), json!({"Satisfied":null})] {
        let mut value = committed();
        value[5] = replacement;
        cases.push(value);
    }
    for case in cases {
        let (client, task) = fixture(encoded(case)).await;
        assert!(
            client.oracle_permissions(market()).await.is_err(),
            "non-string enum accepted"
        );
        task.await.unwrap();
    }
    // Same bytes as the enum name, but MessagePack BIN rather than STR.
    let mut bytes =
        rmp_serde::to_vec(&json!([1, 9, 10, false, "Legacy", null, null, null, null])).unwrap();
    let position = bytes.windows(7).position(|w| w == b"\xa6Legacy").unwrap();
    bytes.splice(position..position + 1, [0xc4, 6]);
    let (client, task) = fixture(json!({"data":STANDARD.encode(bytes)})).await;
    assert!(client.oracle_permissions(market()).await.is_err());
    task.await.unwrap();
}

#[tokio::test]
async fn retry_after_retains_delay_absolute_date_invalid_and_duplicate_forms() {
    for (header, expected) in [
        ("Retry-After: 123\r\n", Some(RetryAfter::DelaySeconds(123))),
        (
            "Retry-After: Wed, 21 Oct 2015 07:28:00 GMT\r\n",
            Some(RetryAfter::At(
                httpdate::parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").unwrap(),
            )),
        ),
        (
            "Retry-After: 18446744073709551616\r\n",
            Some(RetryAfter::Invalid),
        ),
        ("Retry-After: nonsense\r\n", Some(RetryAfter::Invalid)),
        (
            "Retry-After: 1\r\nRetry-After: 2\r\n",
            Some(RetryAfter::Invalid),
        ),
        ("", None),
    ] {
        let (url, task) = server(
            response(429, "response body must not be disclosed", header),
            Duration::ZERO,
        )
        .await;
        let client = GatewayClient::new(&url, GatewayOptions::default()).unwrap();
        let error = client
            .submit_signed_bytes(b"opaque retained bytes")
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::HttpStatus(429));
        assert_eq!(error.retry_after, expected);
        assert!(error.reconcile_hash.is_some());
        assert!(!format!("{error:?}").contains("response body"));
        task.await.unwrap();
    }
}

#[tokio::test]
async fn timeout_and_lost_response_are_ambiguous_and_never_auto_resubmitted() {
    for response in [String::new(), response(200, "{}", "")] {
        let delay = if response.is_empty() {
            Duration::ZERO
        } else {
            Duration::from_millis(200)
        };
        let (url, task) = server(response, delay).await;
        let client = GatewayClient::new(
            &url,
            GatewayOptions {
                timeout: Duration::from_millis(25),
                ..GatewayOptions::default()
            },
        )
        .unwrap();
        let error = client.submit_signed_bytes(b"keep-me").await.unwrap_err();
        assert!(matches!(
            error.kind,
            ErrorKind::Transport | ErrorKind::Timeout
        ));
        assert_eq!(
            error.reconcile_hash,
            Some(TxHash::of_signed_bytes(b"keep-me"))
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn total_deadline_includes_a_stalled_response_body_and_preserves_retry_after() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 2048];
        stream.read(&mut request).await.unwrap();
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nRetry-After: 7\r\nConnection: close\r\n\r\n{").await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
    });
    let client = GatewayClient::new(
        &url,
        GatewayOptions {
            timeout: Duration::from_millis(25),
            ..GatewayOptions::default()
        },
    )
    .unwrap();
    let error = client.chain_identity().await.unwrap_err();
    assert_eq!(error.kind, ErrorKind::Timeout);
    assert_eq!(error.retry_after, Some(RetryAfter::DelaySeconds(7)));
    task.await.unwrap();
}

#[tokio::test]
async fn bounded_body_and_redirect_refusal_do_not_leak_keys_or_follow_upstreams() {
    for response in [response(200,&"x".repeat(65),""),
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n41\r\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\n0\r\n\r\n".into()] {
        let (url,task)=server(response,Duration::ZERO).await;
        let client=GatewayClient::new(&url,GatewayOptions{max_response_bytes:64,..GatewayOptions::default()}).unwrap();
        assert_eq!(client.chain_identity().await.unwrap_err().kind,ErrorKind::BodyTooLarge);
        task.await.unwrap();
    }
    let (url, task) = server(
        response(302, "", "Location: http://127.0.0.1:9/internal\r\n"),
        Duration::ZERO,
    )
    .await;
    let client = GatewayClient::new(&url, GatewayOptions::default()).unwrap();
    assert_eq!(
        client.chain_identity().await.unwrap_err().kind,
        ErrorKind::HttpStatus(302)
    );
    task.await.unwrap();
}

#[test]
fn configuration_rejects_credential_urls_non_gateway_origins_and_unbounded_options() {
    for url in [
        "https://user:secret@example.test",
        "https://example.test/?token=secret",
        "https://example.test/#secret",
        "http://example.test",
        "http://localhost:9080",
        "https://example.test/v1",
        "file:///tmp/file",
        "not-a-url",
    ] {
        let error = GatewayClient::new(url, GatewayOptions::default()).unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidConfiguration);
        assert!(!format!("{error:?}").contains("secret"));
    }
    for options in [
        GatewayOptions {
            timeout: Duration::ZERO,
            ..GatewayOptions::default()
        },
        GatewayOptions {
            timeout: Duration::from_secs(61),
            ..GatewayOptions::default()
        },
        GatewayOptions {
            max_response_bytes: 1_048_577,
            ..GatewayOptions::default()
        },
        GatewayOptions {
            api_key: Some("secret\r\ninjected: header".into()),
            ..GatewayOptions::default()
        },
    ] {
        assert!(GatewayClient::new("https://gateway.example.test", options).is_err());
    }
}

#[tokio::test]
async fn invalid_signed_input_is_rejected_before_network() {
    let client = GatewayClient::new("http://127.0.0.1:9", GatewayOptions::default()).unwrap();
    for bytes in [Vec::new(), vec![0; 4097]] {
        let error = client.submit_signed_bytes(&bytes).await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidInput);
        assert_eq!(error.reconcile_hash, None);
    }
}
