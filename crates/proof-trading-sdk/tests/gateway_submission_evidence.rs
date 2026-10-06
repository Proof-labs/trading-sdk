#![cfg(feature = "gateway")]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use proof_trading_sdk::gateway::*;
use proof_trading_sdk::market_snapshot::BlockHeight;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
};

// Source-qualified refusal fixtures, not a live-gateway qualification receipt:
// Proof-labs/api-gateway@3c711c2a3c29ca8f37d2d986fe817d21a9eeebc3
// src/server.rs (auth, maintenance, reject_rate_limited), src/exchange.rs
// (handle_exchange), src/types/exchange_response.rs (err/rate_limited).
const BYTES: &[u8] = b"unit-test retained bytes, not a signed real transaction";
const KEY: &str = "unit-test-api-key-not-a-real-secret";

fn response(status: u16, body: &str, headers: &str) -> String {
    format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}", body.len())
}

// Counts every POST observed after answering the first request. A hidden retry
// gets its own answer and fails the request-count assertion, not a timeout.
async fn fixture(
    raw: String,
    timeout: Duration,
    cap: usize,
    body_delay: Duration,
) -> (GatewayClient, JoinHandle<Vec<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        loop {
            let wait = if requests.is_empty() {
                Duration::from_secs(2)
            } else {
                Duration::from_millis(25)
            };
            let Ok(Ok((mut stream, _))) = tokio::time::timeout(wait, listener.accept()).await
            else {
                break;
            };
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0u8; 2048];
                let count = stream.read(&mut chunk).await.unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&chunk[..count]);
                assert!(bytes.len() <= 16_384);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
                    let len = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(|n| n.parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            requests.push(bytes);
            let boundary = raw.find("\r\n\r\n").unwrap() + 4;
            let _ = stream.write_all(&raw.as_bytes()[..boundary]).await;
            tokio::time::sleep(body_delay).await;
            let _ = stream.write_all(&raw.as_bytes()[boundary..]).await;
            if requests.len() > 1 {
                break;
            }
        }
        requests
    });
    let options = GatewayOptions {
        timeout,
        max_response_bytes: cap,
        api_key: Some(KEY.into()),
    };
    assert!(!format!("{options:?}").contains(KEY));
    let client = GatewayClient::new(&url, options).unwrap();
    assert!(!format!("{client:?}").contains(KEY));
    (client, task)
}

async fn json_fixture(
    status: u16,
    body: Value,
    headers: &str,
) -> (GatewayClient, JoinHandle<Vec<Vec<u8>>>) {
    fixture(
        response(status, &body.to_string(), headers),
        Duration::from_secs(1),
        4096,
        Duration::ZERO,
    )
    .await
}

async fn assert_one_exact_post(task: JoinHandle<Vec<Vec<u8>>>) {
    let requests = task.await.unwrap();
    assert_eq!(requests.len(), 1, "transport must not retry");
    let request = String::from_utf8(requests[0].clone()).unwrap();
    assert!(request.starts_with("POST /exchange HTTP/1.1"));
    assert!(request.contains(&format!("x-api-key: {KEY}")));
    let body: Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(body.as_object().unwrap().len(), 1);
    assert_eq!(
        STANDARD.decode(body["action"].as_str().unwrap()).unwrap(),
        BYTES
    );
}

#[tokio::test]
async fn exact_pre_broadcast_contracts_have_typed_per_attempt_evidence() {
    for (status, body, reason) in [
        (
            401,
            json!({"status":"refused","error":"unauthorized: invalid or missing X-Api-Key","errorCode":"Unauthorized"}),
            PreAdmissionRefusal::Unauthorized,
        ),
        (
            429,
            json!({"status":"refused","error":"rate limited","errorCode":"RateLimited","retryAfterMs":1501}),
            PreAdmissionRefusal::RateLimited,
        ),
        (
            503,
            json!({"status":"refused","error":"maintenance: signed writes are not open","errorCode":"Maintenance","mode":"paused"}),
            PreAdmissionRefusal::Maintenance(MaintenanceMode::Paused),
        ),
        (
            503,
            json!({"status":"refused","error":"maintenance: signed writes are not open","errorCode":"Maintenance","mode":"cancel-only"}),
            PreAdmissionRefusal::Maintenance(MaintenanceMode::CancelOnly),
        ),
        (
            503,
            json!({"status":"refused","error":"service overloaded","errorCode":"Overloaded"}),
            PreAdmissionRefusal::Overloaded,
        ),
        (
            503,
            json!({"status":"refused","error":"service unavailable","errorCode":"Unavailable"}),
            PreAdmissionRefusal::VerifierUnavailable,
        ),
        (
            200,
            json!({"status":"refused","error":"invalid request body","errorCode":"InvalidRequest"}),
            PreAdmissionRefusal::InvalidRequest,
        ),
        (
            200,
            json!({"status":"refused","error":"invalid action parameters","errorCode":"InvalidRequest"}),
            PreAdmissionRefusal::InvalidRequest,
        ),
        (
            200,
            json!({"status":"refused","error":"invalid base64 in action field","errorCode":"InvalidRequest"}),
            PreAdmissionRefusal::InvalidRequest,
        ),
        (
            200,
            json!({"status":"refused","error":"internal encoding error","errorCode":"EncodingError"}),
            PreAdmissionRefusal::InvalidEncoding,
        ),
    ] {
        let (client, task) = json_fixture(status, body, "").await;
        let result = client
            .submit_signed_bytes_with_evidence(BYTES)
            .await
            .unwrap();
        assert_eq!(
            result.outcome,
            SubmissionOutcome::RejectedBeforeAdmission {
                hash: TxHash::of_signed_bytes(BYTES),
                refusal: reason,
            }
        );
        assert!(!format!("{result:?}").contains(KEY));
        assert_one_exact_post(task).await;
    }
}

#[tokio::test]
async fn generic_http_failures_never_prove_refusal() {
    for status in [400, 401, 403, 404, 405, 413, 415, 422, 429, 500, 503] {
        let (client, task) = json_fixture(
            status,
            json!({"status":"error","error":"unknown edge failure"}),
            "",
        )
        .await;
        let error = client
            .submit_signed_bytes_with_evidence(BYTES)
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::HttpStatus(status));
        assert_eq!(error.reconcile_hash, Some(TxHash::of_signed_bytes(BYTES)));
        assert!(!format!("{error:?} {error}").contains("unknown edge"));
        assert_one_exact_post(task).await;
    }
}

#[tokio::test]
async fn bodies_without_a_stated_refusal_remain_unresolved() {
    for (status, body) in [
        // Not one of the four statuses: not the gateway's exchange handler.
        (200, json!({"status":"error"})),
        (200, json!({"status":"error","error":"invalid signature"})),
        (503, json!({"status":"error","error":"service overloaded"})),
        (
            503,
            json!({"status":"error","error":"service overloaded","errorCode":"Overloaded"}),
        ),
        (200, json!({"status":"refunded"})),
        // A stated refusal needs a reason this SDK knows.
        (503, json!({"status":"refused"})),
        (
            429,
            json!({"status":"refused","error":"rate limited","errorCode":"RateLimited"}),
        ),
        (503, json!({"status":"refused","errorCode":"SomethingNew"})),
        (200, json!({"status":"refused","errorCode":"TimedOut"})),
        // Maintenance names one of its two modes; a container is not a mode.
        (
            503,
            json!({"status":"refused","error":"maintenance: signed writes are not open","errorCode":"Maintenance"}),
        ),
        (
            503,
            json!({"status":"refused","error":"maintenance: signed writes are not open","errorCode":"Maintenance","mode":"open"}),
        ),
        (
            503,
            json!({"status":"refused","error":"maintenance: signed writes are not open","errorCode":"Maintenance","mode":null}),
        ),
        (
            503,
            json!({"status":"refused","error":"maintenance: signed writes are not open","errorCode":"Maintenance","mode":{"paused":null}}),
        ),
        (
            503,
            json!({"status":"refused","error":"maintenance: signed writes are not open","errorCode":"Maintenance","mode":["cancel-only"]}),
        ),
        // The stated outcome and the fields must agree.
        (
            200,
            json!({"status":"refused","errorCode":"InvalidRequest","code":17}),
        ),
        (
            200,
            json!({"status":"rejected","errorCode":"InvalidRequest"}),
        ),
        (200, json!({"status":"rejected","code":0})),
        (200, json!({"status":"pending","errorCode":"TimedOut"})),
        (200, json!({"status":"ok","code":0})),
        (
            503,
            json!({"status":"rejected","error":"invalid signature","code":17}),
        ),
    ] {
        let (client, task) = json_fixture(status, body, "").await;
        let error = client
            .submit_signed_bytes_with_evidence(BYTES)
            .await
            .unwrap_err();
        assert_eq!(error.reconcile_hash, Some(TxHash::of_signed_bytes(BYTES)));
        assert_one_exact_post(task).await;
    }
}

#[tokio::test]
async fn a_refusal_contradicted_by_execution_fields_is_not_a_refusal() {
    let hash = TxHash::of_signed_bytes(BYTES);
    for (field, value) in [
        ("txHash", json!(hash.to_string())),
        ("txHash", json!(TxHash::from_bytes([7; 32]).to_string())),
        ("code", json!(21)),
        ("height", json!(10)),
    ] {
        let mut body =
            json!({"status":"refused","error":"service unavailable","errorCode":"Unavailable"});
        body[field] = value;
        let (client, task) = json_fixture(503, body, "").await;
        let error = client
            .submit_signed_bytes_with_evidence(BYTES)
            .await
            .unwrap_err();
        assert_eq!(error.reconcile_hash, Some(hash));
        assert_one_exact_post(task).await;
    }
}

#[tokio::test]
async fn exact_hash_execution_outcomes_keep_the_existing_contract() {
    let hash = TxHash::of_signed_bytes(BYTES);
    for (body, expected) in [
        (
            json!({"status":"ok","txHash":hash.to_string(),"code":0,"height":12}),
            SubmissionOutcome::Committed(CommittedReceipt {
                hash,
                height: BlockHeight::new(12).expect("a positive fixture height"),
                code: 0,
            }),
        ),
        (
            json!({"status":"rejected","txHash":hash.to_string(),"code":21,"height":12}),
            SubmissionOutcome::Committed(CommittedReceipt {
                hash,
                height: BlockHeight::new(12).expect("a positive fixture height"),
                code: 21,
            }),
        ),
        (
            json!({"status":"rejected","txHash":hash.to_string(),"code":21}),
            SubmissionOutcome::CheckTxRejected {
                hash,
                code: 21.try_into().unwrap(),
            },
        ),
        (
            json!({"status":"pending","txHash":hash.to_string()}),
            SubmissionOutcome::Pending { hash },
        ),
        // Refused before broadcast with the engine's own code: no txHash.
        (
            json!({"status":"rejected","error":"invalid signature","code":17}),
            SubmissionOutcome::CheckTxRejected {
                hash,
                code: 17.try_into().unwrap(),
            },
        ),
    ] {
        let (client, task) = json_fixture(200, body, "").await;
        let result = client
            .submit_signed_bytes_with_evidence(BYTES)
            .await
            .unwrap();
        assert_eq!(result.outcome, expected);
        assert_one_exact_post(task).await;
    }
}

#[tokio::test]
async fn retry_after_headers_win_and_body_milliseconds_round_up_without_overflow() {
    let at = httpdate::parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").unwrap();
    for (header, ms, expected) in [
        ("", 0, RetryAfter::DelaySeconds(0)),
        ("", 1, RetryAfter::DelaySeconds(1)),
        ("", 1000, RetryAfter::DelaySeconds(1)),
        ("", 1001, RetryAfter::DelaySeconds(2)),
        (
            "",
            u64::MAX,
            RetryAfter::DelaySeconds(18_446_744_073_709_552),
        ),
        ("Retry-After: 9\r\n", 1, RetryAfter::DelaySeconds(9)),
        ("Retry-After: 0\r\n", 1001, RetryAfter::DelaySeconds(0)),
        (
            "Retry-After: Wed, 21 Oct 2015 07:28:00 GMT\r\n",
            1001,
            RetryAfter::At(at),
        ),
        ("Retry-After: broken\r\n", 1001, RetryAfter::Invalid),
        (
            "Retry-After: 1\r\nRetry-After: 2\r\n",
            1001,
            RetryAfter::Invalid,
        ),
        (
            "Retry-After: 18446744073709551616\r\n",
            1001,
            RetryAfter::Invalid,
        ),
    ] {
        let (client, task) = json_fixture(
            429,
            json!({"status":"refused","error":"rate limited","errorCode":"RateLimited","retryAfterMs":ms}),
            header,
        )
        .await;
        let result = client
            .submit_signed_bytes_with_evidence(BYTES)
            .await
            .unwrap();
        assert_eq!(
            result.outcome,
            SubmissionOutcome::RejectedBeforeAdmission {
                hash: TxHash::of_signed_bytes(BYTES),
                refusal: PreAdmissionRefusal::RateLimited,
            }
        );
        assert_eq!(result.retry_after, Some(expected));
        assert_one_exact_post(task).await;
    }
}

#[tokio::test]
async fn invalid_or_duplicate_json_delays_are_not_absent_and_never_prove_refusal() {
    for delay in [
        "-1",
        "0.1",
        "\"1000\"",
        "null",
        "true",
        "[]",
        "{}",
        "18446744073709551616",
        "1e100",
    ] {
        let body =
            format!("{{\"status\":\"refused\",\"error\":\"rate limited\",\"errorCode\":\"RateLimited\",\"retryAfterMs\":{delay}}}");
        for (header, expected) in [
            ("", RetryAfter::Invalid),
            ("Retry-After: 4\r\n", RetryAfter::DelaySeconds(4)),
        ] {
            let (client, task) = fixture(
                response(429, &body, header),
                Duration::from_secs(1),
                4096,
                Duration::ZERO,
            )
            .await;
            let error = client
                .submit_signed_bytes_with_evidence(BYTES)
                .await
                .unwrap_err();
            assert_eq!(error.retry_after, Some(expected));
            assert_eq!(error.reconcile_hash, Some(TxHash::of_signed_bytes(BYTES)));
            assert_one_exact_post(task).await;
        }
    }
    let (client, task) = fixture(
        response(
            429,
            r#"{"status":"refused","error":"rate limited","errorCode":"RateLimited","retryAfterMs":1,"retryAfterMs":2}"#,
            "",
        ),
        Duration::from_secs(1),
        4096,
        Duration::ZERO,
    )
    .await;
    let error = client
        .submit_signed_bytes_with_evidence(BYTES)
        .await
        .unwrap_err();
    assert_eq!(error.retry_after, Some(RetryAfter::Invalid));
    assert_one_exact_post(task).await;
}

#[tokio::test]
async fn malformed_foreign_hash_and_redirect_responses_keep_local_hash_and_redact_body() {
    for (status, body, header) in [
        (
            503,
            format!(
                r#"{{"status":"refused","error":"service unavailable","errorCode":"Unavailable","txHash":"{}"}}"#,
                TxHash::from_bytes([4; 32])
            ),
            "",
        ),
        (
            200,
            r#"{"status":"rejected","error":"invalid signature","code":17,"txHash":"broken"}"#
                .into(),
            "",
        ),
        (
            200,
            r#"{"status":"rejected","status":"rejected","error":"invalid signature","code":17}"#
                .into(),
            "",
        ),
        (503, format!("malformed response containing {KEY}"), ""),
        (
            302,
            String::new(),
            "Location: http://127.0.0.1:9/internal\r\n",
        ),
    ] {
        let (client, task) = fixture(
            response(status, &body, header),
            Duration::from_secs(1),
            4096,
            Duration::ZERO,
        )
        .await;
        let error = client
            .submit_signed_bytes_with_evidence(BYTES)
            .await
            .unwrap_err();
        assert_eq!(error.reconcile_hash, Some(TxHash::of_signed_bytes(BYTES)));
        assert!(!format!("{error:?} {error}").contains(KEY));
        assert!(!format!("{error:?} {error}").contains("retained bytes"));
        assert_one_exact_post(task).await;
    }
}

#[tokio::test]
async fn refusal_bodies_share_size_and_total_deadline_bounds_without_retry() {
    let (client, task) = fixture(
        response(
            503,
            &"sensitive-looking-body".repeat(20),
            "Retry-After: 7\r\n",
        ),
        Duration::from_secs(1),
        64,
        Duration::ZERO,
    )
    .await;
    let error = client
        .submit_signed_bytes_with_evidence(BYTES)
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::BodyTooLarge);
    assert_eq!(error.retry_after, Some(RetryAfter::DelaySeconds(7)));
    assert_eq!(error.reconcile_hash, Some(TxHash::of_signed_bytes(BYTES)));
    assert_one_exact_post(task).await;

    let (client, task) = fixture(
        response(
            503,
            r#"{"status":"refused","error":"service unavailable","errorCode":"Unavailable"}"#,
            "Retry-After: 7\r\n",
        ),
        Duration::from_millis(25),
        4096,
        Duration::from_millis(150),
    )
    .await;
    let error = client
        .submit_signed_bytes_with_evidence(BYTES)
        .await
        .unwrap_err();
    assert_eq!(error.kind, ErrorKind::Timeout);
    assert_eq!(error.retry_after, Some(RetryAfter::DelaySeconds(7)));
    assert_eq!(error.reconcile_hash, Some(TxHash::of_signed_bytes(BYTES)));
    assert_one_exact_post(task).await;
}
