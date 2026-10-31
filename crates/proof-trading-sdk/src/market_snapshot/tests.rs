#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::arithmetic_side_effects
)]

use super::*;
use crate::types::{AttachedConditional, EventId, MarkSourceMode, MarketKind};

fn chain(byte: u8) -> ChainBinding {
    ChainBinding::new([byte; 32]).expect("fixture chain bindings are non-zero")
}

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
        events: vec![],
        open_interest: None,
    })
    .unwrap()
}

#[test]
fn engine_snapshot_with_an_attached_event_decodes() {
    // Bytes produced by exchange-core::query::query_markets_snapshot on the
    // one-book wire (one binary book per event): two perps, event 700 with
    // its book 70_000 and one conditional attached on perp 2. The chain id
    // is set to the test chain.
    let bytes = hex::decode(include_str!("engine-c3253d0c.hex").trim()).unwrap();
    let snapshot = decode_snapshot(&envelope(&bytes), chain(7)).unwrap();
    assert_eq!(snapshot.height, 9_007_199_254_740_993);
    assert_eq!(
        snapshot
            .markets
            .iter()
            .map(|m| m.market)
            .collect::<Vec<_>>(),
        vec![1, 2, 70_000, 70_100, 70_101]
    );
    let event = &snapshot.events[0];
    assert_eq!(event.event_id, EventId(700));
    assert_eq!(event.eby_market, 70_000);
    assert_eq!(
        event.attached_conditionals,
        vec![AttachedConditional {
            underlying_market: 2,
            cpy_market: 70_100,
            cpn_market: 70_101,
        }]
    );
}

#[test]
fn a_two_book_event_row_is_refused() {
    let mut value = rmpv::decode::read_value(&mut Cursor::new(
        hex::decode(include_str!("engine-c3253d0c.hex").trim()).unwrap(),
    ))
    .unwrap();
    let Value::Array(top) = &mut value else {
        panic!("snapshot must be a tuple")
    };
    let Value::Array(events) = &mut top[3] else {
        panic!("events must be a list")
    };
    let Value::Array(row) = &mut events[0] else {
        panic!("event must be a tuple")
    };
    row.insert(2, Value::from(70_001));
    let mut bytes = Vec::new();
    rmpv::encode::write_value(&mut bytes, &value).unwrap();
    assert_eq!(
        decode_snapshot(&envelope(&bytes), chain(7)).unwrap_err(),
        SnapshotError::Malformed
    );
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
    let snapshot = decode_snapshot(&envelope(&fixture()), chain(7)).unwrap();
    assert_eq!(snapshot.height, u64::MAX);
    assert_eq!(snapshot.markets[0].max_open_interest, u64::MAX);
    assert_eq!(snapshot.markets[0].kind, MarketKind::Perp);
    assert!(snapshot.events.is_empty());
    assert_eq!(snapshot.open_interest, None);
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
        top.push(Value::Array(vec![Value::Array(vec![
            Value::from(1),
            Value::from(3),
            Value::from(3),
            Value::from("future open-interest field"),
        ])]));
        top.push(Value::from("future snapshot field"));
    });
    assert_eq!(
        decode_snapshot(&bytes, chain(7)).unwrap().open_interest,
        Some(vec![MarketOpenInterest {
            market: 1,
            long: 3,
            short: 3,
        }])
    );
}

#[test]
fn current_engine_snapshot_serves_open_interest() {
    // rmp_serde::to_vec of an exchange-core::query::MarketsSnapshot struct
    // literal at exchange 66d50df7 (docs/market-snapshot.md): two perps, open interest 2^53 + 1 a side on market 1 and zero on
    // market 2, which has had positions that all closed.
    let bytes = hex::decode(include_str!("engine-66d50df7.hex").trim()).unwrap();
    let snapshot = decode_snapshot(&envelope(&bytes), chain(7)).unwrap();
    assert_eq!(
        snapshot.open_interest,
        Some(vec![
            MarketOpenInterest {
                market: 1,
                long: 9_007_199_254_740_993,
                short: 9_007_199_254_740_993,
            },
            MarketOpenInterest {
                market: 2,
                long: 0,
                short: 0,
            },
        ])
    );
}

fn open_interest_row(market: i64, long: i64, short: i64) -> Value {
    Value::Array(vec![
        Value::from(market),
        Value::from(long),
        Value::from(short),
    ])
}

#[test]
fn no_open_interest_is_served_distinct_from_none_served() {
    let bytes = changed(|top| top.push(Value::Array(vec![])));
    assert_eq!(
        decode_snapshot(&bytes, chain(7)).unwrap().open_interest,
        Some(vec![])
    );
    assert_eq!(
        decode_snapshot(&envelope(&fixture()), chain(7))
            .unwrap()
            .open_interest,
        None
    );
}

#[test]
fn malformed_or_unordered_open_interest_refuses_the_whole_snapshot() {
    let with = |rows: Value| changed(|top| top.push(rows));
    assert_eq!(
        decode_snapshot(
            &with(Value::Array(vec![
                open_interest_row(1, 3, 3),
                open_interest_row(1, 3, 3),
            ])),
            chain(7)
        )
        .unwrap_err(),
        SnapshotError::DuplicateMarket
    );
    assert_eq!(
        decode_snapshot(
            &with(Value::Array(vec![
                open_interest_row(2, 0, 0),
                open_interest_row(1, 3, 3),
            ])),
            chain(7)
        )
        .unwrap_err(),
        SnapshotError::UnorderedOpenInterest
    );
    for rows in [
        Value::Array(vec![open_interest_row(1, -1, 3)]),
        Value::Array(vec![Value::Array(vec![Value::from(1), Value::from(3)])]),
        Value::Array(vec![Value::Nil]),
        Value::Nil,
    ] {
        assert_eq!(
            decode_snapshot(&with(rows), chain(7)).unwrap_err(),
            SnapshotError::Malformed
        );
    }
}

#[test]
fn complete_empty_inventory_is_distinct_from_unavailable_or_uncommitted() {
    let bytes = changed(|top| top[2] = Value::Array(vec![]));
    assert!(decode_snapshot(&bytes, chain(7))
        .unwrap()
        .markets
        .is_empty());
    assert_eq!(
        decode_snapshot(&bytes, chain(8)).unwrap_err(),
        SnapshotError::WrongChain
    );
    let bytes = changed(|top| top[1] = Value::from(0));
    assert_eq!(
        decode_snapshot(&bytes, chain(7)).unwrap_err(),
        SnapshotError::Uncommitted
    );
    for bytes in [
        br#"{}"#.as_slice(),
        br#"{"data":null}"#,
        br#"{"data":"!"}"#,
        br#"{"data":"kA==","data":"kA=="}"#,
    ] {
        assert_eq!(
            decode_snapshot(bytes, chain(7)).unwrap_err(),
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
        decode_snapshot(&duplicate, chain(7)).unwrap_err(),
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
            decode_snapshot(&bytes, chain(7)).unwrap_err(),
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
        decode_snapshot(&short, chain(7)).unwrap_err(),
        SnapshotError::Malformed
    );
}

#[test]
fn oversized_truncated_deep_and_trailing_inputs_are_refused() {
    assert_eq!(
        decode_snapshot(&vec![b' '; MAX_SNAPSHOT_BYTES + 1], chain(7)).unwrap_err(),
        SnapshotError::TooLarge
    );
    let mut trailing = fixture();
    trailing.push(0);
    assert_eq!(
        decode_snapshot(&envelope(&trailing), chain(7)).unwrap_err(),
        SnapshotError::Malformed
    );
    assert_eq!(
        decode_snapshot(&envelope(&[0xdd, 0xff, 0xff, 0xff, 0xff]), chain(7)).unwrap_err(),
        SnapshotError::Malformed
    );
    let mut deep = vec![0x91; 64];
    deep.push(0);
    assert_eq!(
        decode_snapshot(&envelope(&deep), chain(7)).unwrap_err(),
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
            .read(chain(7))
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
                .read(chain(7))
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
                .read(chain(7))
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
