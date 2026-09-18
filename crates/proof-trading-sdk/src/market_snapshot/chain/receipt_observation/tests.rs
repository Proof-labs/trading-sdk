#![allow(clippy::unwrap_used, clippy::arithmetic_side_effects)]
use super::*;
use crate::market_snapshot::BlockHeight;
use serde_json::json;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const RAW_HASH: [u8; 32] = [0xab; 32];

fn hash() -> TxHash {
    TxHash::from_bytes(RAW_HASH)
}
fn height(height: u64) -> BlockHeight {
    BlockHeight::new(height).expect("heights in these fixtures are positive")
}
fn market(market: u32) -> MarketId {
    MarketId::new(market).expect("market ids in these fixtures are positive")
}

fn not_found() -> Vec<u8> {
    serde_json::to_vec(&json!({"jsonrpc":"2.0","error":{
        "code":-32603,"message":"Internal error",
        "data":format!("tx ({}) not found", "AB".repeat(32))}}))
    .unwrap()
}

fn accepted_body() -> serde_json::Value {
    json!({"result":{"hash":"AB".repeat(32),"height":"42","tx_result":{"code":0,
    "events":[{"type":"price_updated","attributes":[
        {"key":"market","value":"15","index":false},
        {"key":"price","value":"120","index":false},
        {"key":"signer","value":"cd".repeat(20),"index":false}
    ]}]}}})
}

#[test]
fn positive_plaintext_event_preserves_effect_metadata_not_primary_action_identity() {
    let body = serde_json::to_vec(&accepted_body()).unwrap();
    assert_eq!(
        classify(200, &body, hash()).unwrap(),
        ReceiptObservation::CommittedPriceUpdate(CommittedPriceUpdate {
            receipt: CommittedReceipt {
                hash: hash(),
                height: height(42),
                code: 0
            },
            market: market(15),
            price: MicroUsdc::new(120),
            signer: [0xcd; 20],
        })
    );
    assert_eq!(
        super::super::decode_receipt(&body, hash()).unwrap(),
        CommittedReceipt {
            hash: hash(),
            height: height(42),
            code: 0
        }
    );
    // The accepted price can be clamped; no equality with a submitted price is
    // inferred by this transport. A consumer supplies its signed tag3 binding.
    let mut wrong_hash = accepted_body();
    wrong_hash["result"]["hash"] = json!("CD".repeat(32));
    assert_eq!(
        classify(200, &serde_json::to_vec(&wrong_hash).unwrap(), hash()),
        Err(SnapshotError::HashMismatch)
    );
}

#[test]
fn absent_duplicate_rejected_mixed_or_malformed_events_are_never_effect_proof() {
    let good_event = accepted_body()["result"]["tx_result"]["events"][0].clone();
    let committed = ReceiptObservation::Committed(CommittedReceipt {
        hash: hash(),
        height: height(42),
        code: 0,
    });
    let refused = |rejection| ReceiptObservation::RejectedPriceEvidence {
        receipt: CommittedReceipt {
            hash: hash(),
            height: height(42),
            code: 0,
        },
        rejection,
    };
    // No price_updated event to read: nothing was refused, so nothing is named.
    let mut cases = vec![
        (json!(null), committed.clone()),
        (json!([]), committed.clone()),
        (json!({}), committed.clone()),
        (
            json!([{"type":"oracle_update_rejected","attributes":[]}]),
            committed.clone(),
        ),
        (
            json!([good_event.clone(), good_event.clone()]),
            refused(PriceEvidenceRejection::MultipleEvents),
        ),
        (
            json!([good_event.clone(), {"type":"oracle_update_rejected","attributes":[]}]),
            refused(PriceEvidenceRejection::MultipleEvents),
        ),
        (
            json!([good_event.clone(), {"type":"future_event","attributes":null}]),
            refused(PriceEvidenceRejection::MultipleEvents),
        ),
    ];
    for (field, value, expected) in [
        ("type", json!("cHJpY2VfdXBkYXRlZA=="), committed.clone()),
        ("type", json!("future_event"), committed.clone()),
        (
            "attributes",
            json!(null),
            refused(PriceEvidenceRejection::MalformedPriceEvent),
        ),
    ] {
        let mut event = good_event.clone();
        event[field] = value;
        cases.push((json!([event]), expected));
    }
    for (index, key, value, expected) in [
        (
            0,
            "value",
            json!("0"),
            refused(PriceEvidenceRejection::InvalidMarket),
        ),
        (
            0,
            "value",
            json!("015"),
            refused(PriceEvidenceRejection::InvalidMarket),
        ),
        (
            0,
            "value",
            json!("4294967296"),
            refused(PriceEvidenceRejection::InvalidMarket),
        ),
        (
            0,
            "value",
            json!(15),
            refused(PriceEvidenceRejection::MalformedPriceEvent),
        ),
        (
            0,
            "key",
            json!("bWFya2V0"),
            refused(PriceEvidenceRejection::UnknownAttribute),
        ),
        (
            1,
            "value",
            json!("0"),
            refused(PriceEvidenceRejection::InvalidPrice),
        ),
        (
            1,
            "value",
            json!("-1"),
            refused(PriceEvidenceRejection::InvalidPrice),
        ),
        (
            1,
            "value",
            json!("18446744073709551616"),
            refused(PriceEvidenceRejection::InvalidPrice),
        ),
        (
            1,
            "key",
            json!("market"),
            refused(PriceEvidenceRejection::DuplicateAttribute),
        ),
        (
            2,
            "value",
            json!(""),
            refused(PriceEvidenceRejection::InvalidSigner),
        ),
        (
            2,
            "value",
            json!("CD".repeat(20)),
            refused(PriceEvidenceRejection::InvalidSigner),
        ),
        (
            2,
            "value",
            json!(format!("0x{}", "cd".repeat(20))),
            refused(PriceEvidenceRejection::InvalidSigner),
        ),
        (
            2,
            "value",
            json!("cd".repeat(19)),
            refused(PriceEvidenceRejection::InvalidSigner),
        ),
        (
            2,
            "value",
            json!("z".repeat(40)),
            refused(PriceEvidenceRejection::InvalidSigner),
        ),
    ] {
        let mut event = good_event.clone();
        event["attributes"][index][key] = value;
        cases.push((json!([event]), expected));
    }
    let mut extra_attribute = good_event.clone();
    extra_attribute["attributes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key":"market","value":"15"}));
    cases.push((
        json!([extra_attribute]),
        refused(PriceEvidenceRejection::UnexpectedAttributeCount),
    ));
    for (events, expected) in cases {
        let mut body = accepted_body();
        body["result"]["tx_result"]["events"] = events.clone();
        assert_eq!(
            classify(200, &serde_json::to_vec(&body).unwrap(), hash()).unwrap(),
            expected,
            "{events}"
        );
    }
    // A non-zero code is an execution verdict, not refused price evidence.
    let mut rejected = accepted_body();
    rejected["result"]["tx_result"]["code"] = json!(21);
    assert_eq!(
        classify(200, &serde_json::to_vec(&rejected).unwrap(), hash()).unwrap(),
        ReceiptObservation::Committed(CommittedReceipt {
            hash: hash(),
            height: height(42),
            code: 21
        })
    );
    // Duplicate JSON keys must never become accepted evidence after a
    // permissive parse identifies the event kind.
    let duplicate_key = serde_json::to_string(&accepted_body())
        .unwrap()
        .replace("\"key\":\"market\"", "\"key\":\"other\",\"key\":\"market\"");
    assert_eq!(
        classify(200, duplicate_key.as_bytes(), hash()).unwrap(),
        refused(PriceEvidenceRejection::MalformedPriceEvent)
    );
}

#[test]
fn malformed_price_event_attributes_preserve_the_committed_receipt() {
    let good_event = accepted_body()["result"]["tx_result"]["events"][0].clone();
    let mut events = vec![
        json!({"type":"price_updated"}),
        json!({"type":"price_updated","attributes":{}}),
        json!({"type":"price_updated","attributes":[null]}),
    ];
    for field in ["key", "value"] {
        let mut missing = good_event.clone();
        missing["attributes"][1]
            .as_object_mut()
            .unwrap()
            .remove(field);
        events.push(missing);
        for value in [json!(null), json!(120), json!(false), json!({}), json!([])] {
            let mut event = good_event.clone();
            event["attributes"][1][field] = value;
            events.push(event);
        }
    }
    for event in events {
        let mut body = accepted_body();
        body["result"]["tx_result"]["events"] = json!([event]);
        assert_eq!(
            classify(200, &serde_json::to_vec(&body).unwrap(), hash()).unwrap(),
            ReceiptObservation::RejectedPriceEvidence {
                receipt: CommittedReceipt {
                    hash: hash(),
                    height: height(42),
                    code: 0
                },
                rejection: PriceEvidenceRejection::MalformedPriceEvent,
            },
            "{body}"
        );
        body["result"]["tx_result"]["code"] = json!(21);
        assert_eq!(
            classify(200, &serde_json::to_vec(&body).unwrap(), hash()).unwrap(),
            ReceiptObservation::Committed(CommittedReceipt {
                hash: hash(),
                height: height(42),
                code: 21
            }),
        );
    }
}

#[test]
fn missing_or_unrecognized_price_events_do_not_report_a_rejection() {
    let expected = ReceiptObservation::Committed(CommittedReceipt {
        hash: hash(),
        height: height(42),
        code: 0,
    });
    let mut missing = accepted_body();
    missing["result"]["tx_result"]
        .as_object_mut()
        .unwrap()
        .remove("events");
    assert_eq!(
        classify(200, &serde_json::to_vec(&missing).unwrap(), hash()).unwrap(),
        expected
    );
    for events in [
        json!(null),
        json!([]),
        json!({}),
        json!([null]),
        json!([{"attributes":null}]),
        json!([{"type":123,"attributes":null}]),
        json!([{"type":"future_event","attributes":null}]),
        json!([{"type":"future_event","attributes":[{"key":"note","value":"price_updated"}]}]),
    ] {
        let mut body = accepted_body();
        body["result"]["tx_result"]["events"] = events;
        assert_eq!(
            classify(200, &serde_json::to_vec(&body).unwrap(), hash()).unwrap(),
            expected,
            "{body}"
        );
    }
}

#[test]
fn exact_not_found_is_observation_not_a_committed_receipt() {
    for status in [404, 500] {
        assert_eq!(
            classify(status, &not_found(), hash()).unwrap(),
            ReceiptObservation::ExactNotFound { tx_hash: hash() }
        );
        let flat = serde_json::to_vec(&json!({"status":"error",
            "error":format!("tx ({}) not found", "ab".repeat(32))}))
        .unwrap();
        assert_eq!(
            classify(status, &flat, hash()).unwrap(),
            ReceiptObservation::ExactNotFound { tx_hash: hash() }
        );
    }
}

#[test]
fn committed_receipts_still_require_exact_hash_height_and_code() {
    for code in [0, 21, 42] {
        let body = serde_json::to_vec(&json!({"result":{
            "hash":"AB".repeat(32),"height":"42","tx_result":{"code":code}}}))
        .unwrap();
        assert_eq!(
            classify(200, &body, hash()).unwrap(),
            ReceiptObservation::Committed(CommittedReceipt {
                hash: hash(),
                height: height(42),
                code
            })
        );
        for status in [404, 500, 503] {
            assert!(classify(status, &body, hash()).is_err());
        }
    }
    for result in [
        json!({"hash":"CD".repeat(32),"height":"42","tx_result":{"code":0}}),
        json!({"hash":"AB".repeat(32),"height":"0","tx_result":{"code":0}}),
        json!({"hash":"AB".repeat(32),"height":"42","tx_result":{}}),
        json!({"height":"42","tx_result":{"code":0}}),
    ] {
        assert!(classify(
            200,
            &serde_json::to_vec(&json!({"result":result})).unwrap(),
            hash()
        )
        .is_err());
    }
}

#[test]
fn wrong_missing_foreign_hashes_and_noncanonical_failures_never_count() {
    for status in [200, 201, 301, 400, 401, 429, 502, 503, 504] {
        assert!(
            classify(status, &not_found(), hash()).is_err(),
            "status {status}"
        );
    }
    let bodies = [
        json!({"error":"not found"}),
        json!({"error":{"data":format!("tx ({}) not found", "CD".repeat(32))}}),
        json!({"error":format!("tx ({}) not found; other ({})", "AB".repeat(32), "CD".repeat(32))}),
        json!({"error":format!("tx (0{}) not found", "AB".repeat(32))}),
        json!({"error":{"data":"tx not found"}}),
        json!({"message":format!("tx ({}) not found", "AB".repeat(32))}),
        json!({"result":{},"error":format!("tx ({}) not found", "AB".repeat(32))}),
        json!({"error":{"data":format!("tx ({}) internal failure", "AB".repeat(32))}}),
        json!({"error":{"data":42}}),
    ];
    for status in [404, 500] {
        for body in &bodies {
            assert!(classify(status, &serde_json::to_vec(body).unwrap(), hash()).is_err());
        }
        for body in [
            b"<html>not found</html>".as_slice(),
            b"{\"error\":",
            b"null",
        ] {
            assert!(classify(status, body, hash()).is_err());
        }
        let duplicate = format!(
            r#"{{"error":"unrelated","error":"tx ({}) not found"}}"#,
            "AB".repeat(32)
        );
        assert!(classify(status, duplicate.as_bytes(), hash()).is_err());
        let nested_duplicate = format!(
            r#"{{"error":{{"code":-32603,"message":"Internal error","data":"tx ({}) not found","data":"tx ({}) not found"}}}}"#,
            "CD".repeat(32),
            "AB".repeat(32)
        );
        assert!(classify(status, nested_duplicate.as_bytes(), hash()).is_err());
        for (field, value) in [
            ("code", json!(0)),
            ("code", json!("-32603")),
            ("message", json!("OK")),
            ("message", json!(null)),
        ] {
            let mut body: serde_json::Value = serde_json::from_slice(&not_found()).unwrap();
            body["error"][field] = value;
            assert!(classify(status, &serde_json::to_vec(&body).unwrap(), hash()).is_err());
        }
        for text in [
            format!("backend not found while looking up tx {}", "AB".repeat(32)),
            format!("tx ({}) not found; retry later", "AB".repeat(32)),
            format!("prefix tx ({}) not found", "AB".repeat(32)),
        ] {
            assert!(classify(
                status,
                &serde_json::to_vec(&json!({"error":text})).unwrap(),
                hash()
            )
            .is_err());
        }
        assert!(classify(
            status,
            &serde_json::to_vec(&json!({"status":"ok",
            "error":format!("tx ({}) not found", "AB".repeat(32))}))
            .unwrap(),
            hash()
        )
        .is_err());
    }
    assert_eq!(
        classify(500, &vec![b'x'; MAX_SNAPSHOT_BYTES + 1], hash()),
        Err(SnapshotError::TooLarge)
    );
}

async fn serve_once(
    status: u16,
    body: Vec<u8>,
    declared: usize,
    delay: Duration,
) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0; 1024];
        let n = socket.read(&mut request).await.unwrap();
        assert!(std::str::from_utf8(&request[..n])
            .unwrap()
            .starts_with(&format!("GET /v1/tx/{} HTTP/1.1\r\n", "AB".repeat(32))));
        socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        tokio::time::sleep(delay).await;
        let _ = socket.write_all(&body).await;
        drop(socket);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "one observation must never retry"
        );
    });
    (url, task)
}

#[tokio::test]
async fn one_shot_http_preserves_exact_not_found_and_existing_method_behavior() {
    for observation in [true, false] {
        let body = not_found();
        let (url, task) = serve_once(500, body.clone(), body.len(), Duration::ZERO).await;
        let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
        if observation {
            assert_eq!(
                client.receipt_observation(hash()).await.unwrap(),
                ReceiptObservation::ExactNotFound { tx_hash: hash() }
            );
        } else {
            assert_eq!(
                client.committed_receipt(hash()).await,
                Err(SnapshotError::Http(500))
            );
        }
        task.await.unwrap();
    }
}

#[tokio::test]
async fn positive_event_observation_uses_the_same_bounded_gateway_route() {
    let body = serde_json::to_vec(&accepted_body()).unwrap();
    let (url, task) = serve_once(200, body.clone(), body.len(), Duration::ZERO).await;
    let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
    assert!(matches!(
        client.receipt_observation(hash()).await.unwrap(),
        ReceiptObservation::CommittedPriceUpdate(update)
            if (update.market(), update.price(), update.signer())
                == (market(15), MicroUsdc::new(120), [0xcd; 20])
    ));
    task.await.unwrap();
}

#[tokio::test]
async fn malformed_price_event_is_reported_through_the_gateway_client() {
    let mut body = accepted_body();
    body["result"]["tx_result"]["events"][0]["attributes"][1]["value"] = json!(120);
    let body = serde_json::to_vec(&body).unwrap();
    let receipt = CommittedReceipt {
        hash: hash(),
        height: height(42),
        code: 0,
    };
    for observe in [true, false] {
        let (url, task) = serve_once(200, body.clone(), body.len(), Duration::ZERO).await;
        let client = MarketsSnapshotClient::new(&url, Duration::from_secs(1)).unwrap();
        if observe {
            assert_eq!(
                client.receipt_observation(hash()).await.unwrap(),
                ReceiptObservation::RejectedPriceEvidence {
                    receipt: receipt.clone(),
                    rejection: PriceEvidenceRejection::MalformedPriceEvent,
                }
            );
        } else {
            assert_eq!(client.committed_receipt(hash()).await.unwrap(), receipt);
        }
        task.await.unwrap();
    }
}

#[tokio::test]
async fn transport_truncation_size_timeout_and_shed_are_sanitized_errors() {
    let body = not_found();
    for (status, declared, delay, expected) in [
        (
            500,
            body.len() + 1,
            Duration::ZERO,
            SnapshotError::Transport,
        ),
        (
            500,
            MAX_SNAPSHOT_BYTES + 1,
            Duration::ZERO,
            SnapshotError::TooLarge,
        ),
        (
            500,
            body.len(),
            Duration::from_millis(150),
            SnapshotError::Timeout,
        ),
        (429, body.len(), Duration::ZERO, SnapshotError::Http(429)),
        (503, body.len(), Duration::ZERO, SnapshotError::Http(503)),
    ] {
        let (url, task) = serve_once(status, body.clone(), declared, delay).await;
        let client = MarketsSnapshotClient::new(&url, Duration::from_millis(80)).unwrap();
        let error = client.receipt_observation(hash()).await.unwrap_err();
        assert_eq!(error, expected);
        assert!(!error.to_string().contains(&url));
        assert!(!format!("{error:?}").contains("ABAB"));
        task.await.unwrap();
    }
}
