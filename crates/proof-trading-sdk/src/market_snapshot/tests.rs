#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use super::*;
use crate::types::{MarkSourceMode, MarketKind};

fn market() -> MarketConfig {
    MarketConfig {
        market: 1,
        im_bps: 1000,
        mm_bps: 500,
        taker_fee_bps: 5,
        maker_fee_bps: 2,
        funding_interval_ms: 3_600_000,
        max_funding_rate_bps: 100,
        kind: MarketKind::Perp,
        max_position_size: 0,
        default_ttl_ms: 0,
        net_delta_margin: false,
        pool_id: 0,
        mark_price_max_oracle_age_ms: 30_000,
        fee_tiers: vec![],
        tick_size: 100,
        lot_size: 1,
        primary_oracle_signer: None,
        oracle_staleness_ms: 0,
        mark_source_mode: MarkSourceMode::OracleOnly,
        max_mark_spread_bps: 0,
        cex_composite_staleness_ms: 0,
        partial_liquidation_enabled: false,
        sz_decimals: 5,
        ticker: "BTC".into(),
        max_open_interest: u64::MAX,
    }
}

fn fixture() -> Vec<u8> {
    rmp_serde::to_vec(&MarketsSnapshot {
        chain_id: [7; 32],
        height: u64::MAX,
        markets: vec![market()],
        impact_markets: vec![],
    })
    .unwrap()
}

#[test]
fn current_engine_g17_snapshot_matches_the_older_shared_wire_contract() {
    // Actual exchange-core::query::MarketsSnapshot at dev 0d215eaa, encoded
    // with rmp_serde::to_vec. G17 EventId changed the Rust field name but not
    // the positional PredictionBinary payload [u32, Branch].
    let bytes = hex::decode(include_str!("engine-0d215eaa.hex").trim()).unwrap();
    let snapshot = decode_snapshot(&envelope(&bytes), [7; 32]).unwrap();
    assert_eq!(snapshot.height, 9_007_199_254_740_993);
    assert_eq!(snapshot.markets.len(), 5);
    assert_eq!(snapshot.markets[3].market, 201);
    assert!(matches!(
        snapshot.markets[3].kind,
        MarketKind::PredictionBinary {
            impact_market_id: 123,
            ..
        }
    ));
    assert_eq!(snapshot.markets[0].fee_tiers[0].maker_fee_tenth_bps, -7);
    assert_eq!(snapshot.markets[0].max_open_interest, u64::MAX);
    assert_eq!(snapshot.impact_markets[0].impact_market_id, 77);
    assert_eq!(snapshot.impact_markets[0].eby_market, 0);
}

fn envelope(bytes: &[u8]) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({"data": STANDARD.encode(bytes)})).unwrap()
}

fn changed(change: impl FnOnce(&mut Vec<Value>)) -> Vec<u8> {
    let mut value = rmpv::decode::read_value(&mut Cursor::new(fixture())).unwrap();
    let Value::Array(ref mut values) = value else {
        panic!("fixture must be tuple")
    };
    change(values);
    let mut bytes = Vec::new();
    rmpv::encode::write_value(&mut bytes, &value).unwrap();
    envelope(&bytes)
}

#[test]
fn actual_shared_wire_snapshot_round_trips_without_numeric_loss() {
    let snapshot = decode_snapshot(&envelope(&fixture()), [7; 32]).unwrap();
    assert_eq!(snapshot.height, u64::MAX);
    assert_eq!(snapshot.markets[0].max_open_interest, u64::MAX);
    assert_eq!(snapshot.markets[0].kind, MarketKind::Perp);
    assert!(snapshot.impact_markets.is_empty());
    // Rust-produced golden vector also consumed by the TypeScript decoder.
    println!("snapshot-golden={}", hex::encode(fixture()));
}

#[test]
fn additive_fields_are_ignored_without_weakening_existing_fields() {
    let bytes = changed(|top| {
        let Value::Array(rows) = &mut top[2] else {
            unreachable!()
        };
        let Value::Array(row) = &mut rows[0] else {
            unreachable!()
        };
        row.push(Value::from("future market field"));
        top.push(Value::from("future snapshot field"));
    });
    assert!(decode_snapshot(&bytes, [7; 32]).is_ok());
}

#[test]
fn complete_empty_inventory_is_distinct_from_unavailable_or_uncommitted() {
    let bytes = changed(|top| top[2] = Value::Array(vec![]));
    assert!(decode_snapshot(&bytes, [7; 32]).unwrap().markets.is_empty());
    assert_eq!(
        decode_snapshot(&bytes, [8; 32]).unwrap_err(),
        SnapshotError::WrongChain
    );
    let bytes = changed(|top| top[1] = Value::from(0));
    assert_eq!(
        decode_snapshot(&bytes, [7; 32]).unwrap_err(),
        SnapshotError::Uncommitted
    );
    for bytes in [
        br#"{}"#.as_slice(),
        br#"{"data":null}"#,
        br#"{"data":"!"}"#,
        br#"{"data":"kA==","data":"kA=="}"#,
    ] {
        assert_eq!(
            decode_snapshot(bytes, [7; 32]).unwrap_err(),
            SnapshotError::Malformed
        );
    }
}

#[test]
fn malformed_rows_and_duplicates_refuse_the_whole_snapshot() {
    let duplicate = changed(|top| {
        let Value::Array(rows) = &mut top[2] else {
            unreachable!()
        };
        rows.push(rows[0].clone());
    });
    assert_eq!(
        decode_snapshot(&duplicate, [7; 32]).unwrap_err(),
        SnapshotError::DuplicateMarket
    );
    for (slot, replacement) in [
        (0, Value::from(-1)),
        (1, Value::F64(1000.0)),
        (7, Value::from("UnknownKind")),
        (10, Value::from(0)),
        (16, Value::Array(vec![Value::from(1); 19])),
    ] {
        let bytes = changed(|top| {
            let Value::Array(rows) = &mut top[2] else {
                unreachable!()
            };
            let Value::Array(row) = &mut rows[0] else {
                unreachable!()
            };
            row[slot] = replacement;
        });
        assert_eq!(
            decode_snapshot(&bytes, [7; 32]).unwrap_err(),
            SnapshotError::Malformed
        );
    }
    let short = changed(|top| {
        let Value::Array(rows) = &mut top[2] else {
            unreachable!()
        };
        let Value::Array(row) = &mut rows[0] else {
            unreachable!()
        };
        row.truncate(7);
    });
    assert_eq!(
        decode_snapshot(&short, [7; 32]).unwrap_err(),
        SnapshotError::Malformed
    );
}

#[test]
fn oversized_truncated_deep_and_trailing_inputs_are_refused() {
    assert_eq!(
        decode_snapshot(&vec![b' '; MAX_SNAPSHOT_BYTES + 1], [7; 32]).unwrap_err(),
        SnapshotError::TooLarge
    );
    let mut trailing = fixture();
    trailing.push(0);
    assert_eq!(
        decode_snapshot(&envelope(&trailing), [7; 32]).unwrap_err(),
        SnapshotError::Malformed
    );
    assert_eq!(
        decode_snapshot(&envelope(&[0xdd, 0xff, 0xff, 0xff, 0xff]), [7; 32]).unwrap_err(),
        SnapshotError::Malformed
    );
    let mut deep = vec![0x91; 64];
    deep.push(0);
    assert_eq!(
        decode_snapshot(&envelope(&deep), [7; 32]).unwrap_err(),
        SnapshotError::Malformed
    );
}

#[cfg(feature = "gateway")]
mod transport {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve(
        status: u16,
        body: Vec<u8>,
        delay: Duration,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 1024];
            let n = socket.read(&mut request).await.unwrap();
            assert!(std::str::from_utf8(&request[..n])
                .unwrap()
                .starts_with("GET /v1/markets-snapshot HTTP/1.1\r\n"));
            let header = format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(header.as_bytes()).await.unwrap();
            tokio::time::sleep(delay).await;
            let _ = socket.write_all(&body).await;
        });
        (url, task)
    }

    #[tokio::test]
    async fn exact_gateway_route_and_whole_response_chain_binding() {
        let (url, task) = serve(200, envelope(&fixture()), Duration::ZERO).await;
        let snapshot = MarketsSnapshotClient::new(&url, Duration::from_secs(1))
            .unwrap()
            .read([7; 32])
            .await
            .unwrap();
        assert_eq!(snapshot.height, u64::MAX);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn errors_redirects_and_stalled_bodies_never_produce_inventory() {
        for code in [204, 206, 302, 404, 429, 503] {
            let (url, task) =
                serve(code, b"secret URL must not appear".to_vec(), Duration::ZERO).await;
            let error = MarketsSnapshotClient::new(&url, Duration::from_secs(1))
                .unwrap()
                .read([7; 32])
                .await
                .unwrap_err();
            assert_eq!(error, SnapshotError::Http(code));
            assert!(!error.to_string().contains("secret"));
            task.await.unwrap();
        }
        let (url, task) = serve(200, envelope(&fixture()), Duration::from_millis(200)).await;
        assert_eq!(
            MarketsSnapshotClient::new(&url, Duration::from_millis(25))
                .unwrap()
                .read([7; 32])
                .await
                .unwrap_err(),
            SnapshotError::Timeout
        );
        task.abort();
    }

    #[test]
    fn endpoint_and_timeout_validation_do_not_expose_input() {
        for url in [
            "https://key:secret@example.com",
            "https://example.com?token=secret",
            "ftp://example.com",
            "https://example.com/node",
            "https://example.com/#secret",
        ] {
            let err = MarketsSnapshotClient::new(url, Duration::from_secs(1))
                .err()
                .unwrap();
            assert_eq!(err, SnapshotError::InvalidEndpoint);
            assert!(!err.to_string().contains("secret"));
        }
        assert!(MarketsSnapshotClient::new("https://api.dev.proof.trade", Duration::ZERO).is_err());
    }
}
