//! Contract tests for the typed reads against a loopback gateway, with
//! answers captured from devnet (or the TS/Python fixtures where devnet has
//! no rows). Each asserts the request the client sent and what it decoded.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use proof_sdk_rs::{
    AccountEventsQuery, Address, CandleQuery, CandleResolution, ClientConfig, ClientTriggerId,
    Conversion, Error, Event, EventId, HistoryQuery, InfoClient, OrderHistoryQuery, PositionEpoch,
    ResolutionOutcome, ResolutionsQuery, Side, SnapshotPosition, SortOrder, TriggerAvailability,
    TriggerLimbState, TriggerOutcomeReason, TriggerSlippageBps, WithdrawalStatus,
};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Captures each request's `(method + target, body)`.
type Log = Arc<Mutex<Vec<(String, String)>>>;

/// A loopback gateway answering each request with the next canned answer.
async fn fixture(answers: Vec<(u16, Value)>) -> (InfoClient, Log) {
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
    (InfoClient::new(&ClientConfig::new(url)).unwrap(), log)
}

fn requests(log: &Log) -> Vec<(String, String)> {
    log.lock().unwrap().clone()
}

/// The devnet market maker whose history these captures come from.
const MM: &str = "dc9bbe8b8f03b084c2a60a528c7f01e1b79582f0";

fn mm() -> Address {
    MM.parse().unwrap()
}

/// `{"data": base64(msgpack(value))}`, as the gateway wraps a node read.
fn data(value: &Value) -> Value {
    json!({ "data": base64::engine::general_purpose::STANDARD.encode(rmp_serde::to_vec(value).unwrap()) })
}

// -- current state ------------------------------------------------------------

#[tokio::test]
async fn funding_reads_the_mark_and_rate_of_the_asked_market() {
    let (info, log) = fixture(vec![
        // Captured from https://api.dev.proof.trade/v1/funding/1 (2026-11-16).
        (
            200,
            json!({"data":"mQEO0//ICPxTdD2jzwAAAaHiTBeAzwAAAA9S4sOnzwAAAA8jPhKgzgA27oDNAZDOAAI6Ag=="}),
        ),
        // `/v1/funding/99999`: an unknown market answers zeros under its id.
        (200, json!({"data":"mc4AAYafAAAAAAAAAAA="})),
    ])
    .await;
    let f = info.funding(1).await.unwrap();
    assert_eq!((f.market, f.funding_rate_bps), (1, 14));
    assert_eq!(f.funding_rate.0, 145_922);
    assert_eq!(f.mark_price, Some(65_815_102_375));
    assert_eq!(f.oracle_price, Some(65_015_780_000));
    assert_eq!(f.funding_interval_ms, 3_600_000);

    let err = info.funding(1).await.unwrap_err();
    assert!(matches!(err, Error::Decode(m) if m.contains("market 99999")));
    let targets: Vec<String> = requests(&log).into_iter().map(|r| r.0).collect();
    assert_eq!(targets, ["GET /v1/funding/1", "GET /v1/funding/1"]);
}

/// The owner view `GET /v1/triggers/{owner}` answers, shaped as the TS
/// trigger fixtures (devnet holds no live brackets).
fn bracket(owner: &Address, state: &str, availability: &Value) -> Value {
    json!([
        [
            9_007_199_254_740_993_u64,
            owner.to_bytes(),
            7,
            3,
            "Buy",
            100,
            101,
            9,
            [
                11,
                "StopLoss",
                95_000,
                75,
                11,
                state,
                [102, 94_000, null, 4, 0, 4, "NoTwoSidedQuote"]
            ],
            [12, "TakeProfit", 110_000, 50, null, "Armed", null]
        ],
        null,
        availability
    ])
}

#[tokio::test]
async fn position_triggers_decode_strictly_for_the_asked_owner() {
    let owner = mm();
    let other: Address = "4f19b63a2067a0164c658858b981312aedb00c77".parse().unwrap();
    let (info, log) = fixture(vec![
        (
            200,
            data(&json!([bracket(
                &owner,
                "NoFill",
                &json!({"Deferred": "MarkStale"})
            )])),
        ),
        // As devnet answers an owner with no brackets.
        (200, json!({"data":"kA=="})),
        (
            200,
            data(&json!([bracket(&other, "Armed", &json!("Available"))])),
        ),
        (
            200,
            data(&json!([bracket(
                &owner,
                "SomeNewState",
                &json!("Available")
            )])),
        ),
    ])
    .await;
    let rows = info.position_triggers(owner).await.unwrap();
    let t = &rows[0];
    assert_eq!(
        (t.group_id, t.market, t.position_epoch, t.position_side),
        (
            proof_sdk_rs::TriggerGroupId(9_007_199_254_740_993),
            7,
            PositionEpoch(3),
            Side::Buy
        )
    );
    assert_eq!(
        t.availability,
        TriggerAvailability::Deferred(TriggerOutcomeReason::MarkStale)
    );
    let sl = t.stop_loss.unwrap();
    assert_eq!(
        (
            sl.trigger_price,
            sl.max_slippage_bps,
            sl.client_trigger_id,
            sl.state
        ),
        (
            95_000,
            TriggerSlippageBps(75),
            Some(ClientTriggerId(11)),
            TriggerLimbState::NoFill
        )
    );
    let eval = sl.last_evaluation.unwrap();
    assert_eq!(
        (eval.requested_quantity, eval.filled_quantity, eval.reason),
        (4, 0, Some(TriggerOutcomeReason::NoTwoSidedQuote))
    );
    assert_eq!(t.take_profit.unwrap().trigger_price, 110_000);

    assert!(info.position_triggers(owner).await.unwrap().is_empty());
    for _ in 0..2 {
        let err = info.position_triggers(owner).await.unwrap_err();
        assert!(matches!(err, Error::Decode(_)), "{err:?}");
    }
    assert_eq!(requests(&log)[0].0, format!("GET /v1/triggers/{MM}"));
}

#[tokio::test]
async fn sub_accounts_post_the_master_and_decode_its_rows() {
    let master: Address = "aa".repeat(20).parse().unwrap();
    let id = proof_sdk_rs::SubAccountId::new(1).unwrap();
    let child = proof_sdk_rs::actions::sub_account_address(master, id);
    let mut name = [0u8; 32];
    name[..4].copy_from_slice(b"grid");
    let row = |m: Address, a: Address| json!([m.to_bytes(), 1, a.to_bytes(), name, 4_242]);
    let underived: Address = "11".repeat(20).parse().unwrap();
    let (info, log) = fixture(vec![
        (200, data(&json!([row(master, child)]))),
        (200, json!({"data":"kA=="})),
        (200, data(&json!([row(child, child)]))),
        (200, data(&json!([row(master, underived)]))),
        (501, json!({"status":"error","error":"not implemented"})),
    ])
    .await;
    let subs = info.sub_accounts(master).await.unwrap();
    assert_eq!(subs.len(), 1);
    assert_eq!(
        (
            subs[0].id,
            subs[0].address,
            subs[0].name.as_str(),
            subs[0].created_height
        ),
        (id, child, "grid", 4_242)
    );
    assert!(info.sub_accounts(master).await.unwrap().is_empty());
    assert!(matches!(
        info.sub_accounts(master).await,
        Err(Error::Decode(_))
    ));
    let err = info.sub_accounts(master).await.unwrap_err();
    assert!(
        matches!(&err, Error::Decode(m) if m.contains("derived")),
        "{err:?}"
    );
    assert!(matches!(
        info.sub_accounts(master).await,
        Err(Error::Http { status: 501, .. })
    ));

    let (target, body) = requests(&log)[0].clone();
    assert_eq!(target, "POST /info");
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(
        body,
        json!({"type":"subAccountList","user":master.to_string()})
    );
}

#[tokio::test]
async fn withdrawal_status_reads_the_record_or_none() {
    let (info, log) = fixture(vec![
        // Captured from devnet `POST /info {withdrawalStatus, withdrawalId: 1}` (2026-11-16).
        (
            200,
            json!({"data":"lgHcABTMvQ4RzNADzO/MyMylPkLMhsy0HXDMq8z7ZczlzPHMhs8AAAACUYl2GNwAIDHMokg7NV3Ml8yozOLMgg7Ms8y0zJ4/zIwhDAtPXsyozODMoXsTE8ypzJnMj3zM5KdQZW5kaW5nzgBgr8g="}),
        ),
        // Devnet's answer for an id it does not hold.
        (200, json!({"data":"wA=="})),
    ])
    .await;
    let w = info
        .withdrawal(proof_sdk_rs::WithdrawalId::new(1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (w.id, w.amount, w.status, w.request_height),
        (
            proof_sdk_rs::WithdrawalId::new(1),
            9_957_897_752,
            WithdrawalStatus::Pending,
            6_336_456
        )
    );
    assert_eq!(
        w.owner,
        "bd0e11d003efc8a53e4286b41d70abfb65e5f186".parse().unwrap()
    );
    assert_eq!(
        info.withdrawal(proof_sdk_rs::WithdrawalId::new(999_999_999))
            .await
            .unwrap(),
        None
    );

    let log = requests(&log);
    assert_eq!(log[0].0, "POST /info");
    let body: Value = serde_json::from_str(&log[1].1).unwrap();
    assert_eq!(
        body,
        json!({"type":"withdrawalStatus","withdrawalId":999_999_999})
    );
}

#[tokio::test]
async fn authorized_agents_bind_owner_and_witness_height() {
    // Captured from devnet `GET /v2/account/{MM}/agents?witness=1` (2026-11-16).
    let captured = json!({"data":"hKVvd25lcsQU3Ju+i48DsITCpgpSjH8B4beVgvCwZmluYWxpemVkX2hlaWdodM4Au/w5pmFnZW50c5CoY29tcGxldGXD",
        "witness":{"appHash":"967106e01897749dfa19062f221308baaf2ae431681266957a929e2d1f89eb16",
            "finalizedBlockTimeMs":"1794800694523","height":"12319801",
            "nodeId":"a019bb406a4f70d29ead08a2b2b0f47241c3ab7c","version":1}});
    let mut stale = captured.clone();
    stale["witness"]["height"] = json!("12319802");
    let (info, log) = fixture(vec![(200, captured.clone()), (200, stale), (200, captured)]).await;
    let a = info.authorized_agents(mm()).await.unwrap();
    assert_eq!(
        (a.owner, a.height, a.agents.len(), a.complete),
        (mm(), 12_319_801, 0, true)
    );
    assert!(matches!(
        info.authorized_agents(mm()).await,
        Err(Error::Decode(_))
    ));
    let other: Address = "4f19b63a2067a0164c658858b981312aedb00c77".parse().unwrap();
    assert!(matches!(
        info.authorized_agents(other).await,
        Err(Error::Decode(_))
    ));
    assert_eq!(
        requests(&log)[0].0,
        format!("GET /v2/account/{MM}/agents?witness=1")
    );
}

// -- history ------------------------------------------------------------------

#[tokio::test]
async fn fill_history_sends_the_filters_and_reads_one_page() {
    // Captured from devnet `GET /v1/history/fills/{MM}?limit=2` (2026-11-16).
    let page = json!({"fills":[
        {"block_height":11676065,"block_time":"2026-11-13T11:19:31.069857Z","fill_id":418103,"maker_fee":161,
         "maker_owner":MM,"maker_side":"buy","market":3,"price":"80310000.000000","quantity":"1",
         "taker_fee":402,"taker_owner":"4f19b63a2067a0164c658858b981312aedb00c77"},
        {"block_height":11676046,"block_time":"2026-11-13T11:19:24.174802Z","fill_id":418102,"maker_fee":140,
         "maker_owner":MM,"maker_side":"sell","market":1,"price":"69552000000.000000","quantity":"1",
         "taker_fee":348,"taker_owner":"4f19b63a2067a0164c658858b981312aedb00c77"}],
        "next_cursor":"MXwxNzk0NTY4NzY0MTc0ODAyfDQxODEwMnwxNDMxNDU0ODI3Mzc2NjU4MTc3OQ"});
    let mut foreign = page.clone();
    foreign["fills"][0]["maker_owner"] = json!("4f19b63a2067a0164c658858b981312aedb00c77");
    let mut broken = page.clone();
    broken["fills"][1]["price"] = json!("not a price");
    let (info, log) = fixture(vec![
        (200, page.clone()),
        (200, page),
        (200, foreign),
        (200, broken),
    ])
    .await;
    let mut q = HistoryQuery {
        market: Some(1),
        from_ms: Some(1_794_568_000_000),
        to_ms: Some(1_794_569_000_000),
        limit: Some(2),
        cursor: None,
    };
    // The page holds a market-3 fill: not what a market-1 query asked for.
    let err = info.fill_history(mm(), &q).await.unwrap_err();
    assert!(
        matches!(&err, Error::Decode(m) if m.contains("asked for 1")),
        "{err:?}"
    );
    q.market = None;
    let p = info.fill_history(mm(), &q).await.unwrap();
    assert_eq!(p.rows.len(), 2);
    let f = p.rows[1];
    assert_eq!(
        (
            f.fill_id,
            f.market,
            f.price,
            f.quantity,
            f.maker_side,
            f.maker_fee
        ),
        (418_102, 1, 69_552_000_000, 1, Side::Sell, 140)
    );
    assert_eq!(f.block_time_ns, 1_794_568_764_174_802_000);
    assert_eq!(
        p.next_cursor.as_deref(),
        Some("MXwxNzk0NTY4NzY0MTc0ODAyfDQxODEwMnwxNDMxNDU0ODI3Mzc2NjU4MTc3OQ")
    );
    assert!(matches!(
        info.fill_history(mm(), &q).await,
        Err(Error::Decode(_))
    ));
    // A row that does not decode keeps the page's cursor.
    let Err(Error::HistoryRow { next_cursor, .. }) = info.fill_history(mm(), &q).await else {
        panic!("expected HistoryRow")
    };
    assert_eq!(
        next_cursor.as_deref(),
        Some("MXwxNzk0NTY4NzY0MTc0ODAyfDQxODEwMnwxNDMxNDU0ODI3Mzc2NjU4MTc3OQ")
    );
    assert_eq!(
        requests(&log)[0].0,
        format!("GET /v1/history/fills/{MM}?market=1&from=1794568000000&to=1794569000000&limit=2")
    );
}

/// Devnet account-event rows of the kinds a market maker sees (2026-11-16).
fn account_events() -> Value {
    json!([
        {"block_height":12312305,"block_time":"2026-11-16T03:00:00.298787Z","event_id":13066871,"event_index":26,
         "event_type":"funding_settled","owner":MM,
         "payload":{"market":"3","owner":MM,"payment":"-699016","phase":"system"},
         "tx_hash":"height-12312305-kind-block-event-26"},
        {"block_height":11675990,"block_time":"2026-11-13T11:19:03.842291Z","event_id":12532298,"event_index":0,
         "event_type":"order_placed","owner":MM,
         "payload":{"client_order_id":"0","market":"1","order_id":"3436751","owner":MM,"post_only":"true",
                    "price":"70074000000","quantity":"216","reduce_only":"false","side":"sell","time_in_force":"gtc"},
         "tx_hash":"6C901CE54048A3706A8DD062DEE5734943431060D340971E05853D85580DA354"},
        {"block_height":11676065,"block_time":"2026-11-13T11:19:31.069857Z","event_id":12532512,"event_index":0,
         "event_type":"trade_executed","owner":MM,
         "payload":{"block_height":"11676065","event_key":"11676065:1:0","event_ordinal":"0","execution_ordinal":"1",
                    "fill_id":"418103","maker_client_order_id":"0","maker_fee":"161","maker_order_id":"3436355",
                    "maker_owner":MM,"maker_side":"buy","mark_price":"80520000","market":"3",
                    "oracle_price":"80520000","price":"80310000","quantity":"1","reason":"order",
                    "taker_client_order_id":"0","taker_fee":"402","taker_order_id":"3436762",
                    "taker_owner":"4f19b63a2067a0164c658858b981312aedb00c77"},
         "tx_hash":"AFB5C948449AF60BA809D4031AD59B4CAC6F77CE35B074B0450B995D833B75AF"},
        {"block_height":11912613,"block_time":"2026-11-14T11:00:06.731464Z","event_id":12831387,"event_index":6,
         "event_type":"condition_met","owner":MM,
         "payload":{"converted_size":"3","entry_price":"77961666","event_id":"35","fallback_reason":"",
                    "market":"3503","owner":MM,"realized_pnl":"-69050","settlement_price":"75660000",
                    "side":"buy","size":"3"},
         "tx_hash":"63B747E0C9C9729664D789CA10BF80D7286FC85C5589C09DB2BF38AF92FF235D"},
        {"block_height":11676065,"block_time":"2026-11-13T11:19:31.069857Z","event_id":12532516,"event_index":4,
         "event_type":"fees_collected","owner":MM,
         "payload":{"maker_fee":"161","maker_owner":MM,"market":"3","taker_fee":"402",
                    "taker_owner":"4f19b63a2067a0164c658858b981312aedb00c77"},
         "tx_hash":"AFB5C948449AF60BA809D4031AD59B4CAC6F77CE35B074B0450B995D833B75AF"}
    ])
}

#[tokio::test]
async fn account_event_history_requires_an_order_and_types_each_event() {
    let mut broken = account_events();
    broken[2]["payload"]["price"] = json!("not a price");
    // A kind this version does not type keeps structured attributes.
    let mut future = account_events();
    future[4]["event_type"] = json!("something_new");
    future[4]["payload"] = json!({"legs": [1, 2], "owner": MM});
    let page = |rows: Value| json!({"account_events": rows, "next_cursor": ""});
    let (info, log) = fixture(vec![
        (200, page(account_events())),
        (200, page(account_events())),
        (200, page(broken)),
        (200, page(future)),
        (200, page(account_events())),
    ])
    .await;
    let mut q = AccountEventsQuery::new(SortOrder::Desc);
    q.event_type = Some("trade_executed".into());
    q.limit = Some(5);
    // The page holds other kinds than the one asked for.
    let err = info.account_event_history(mm(), &q).await.unwrap_err();
    assert!(
        matches!(&err, Error::Decode(m) if m.contains("asked for trade_executed")),
        "{err:?}"
    );
    q.event_type = None;
    let p = info.account_event_history(mm(), &q).await.unwrap();
    assert_eq!(p.next_cursor, None, "an empty cursor is the last page");
    let rows = &p.rows;
    assert_eq!(rows.len(), 5);
    assert!(matches!(&rows[0].event, Event::FundingSettled(f) if f.payment == -699_016));
    assert_eq!(rows[0].tx_hash, None, "a block event has no transaction");
    assert!(matches!(&rows[1].event, Event::OrderPlaced(o) if o.order_id == 3_436_751));
    assert!(rows[1].tx_hash.is_some());
    assert!(
        matches!(&rows[2].event, Event::Fill(f) if f.fill_id == 418_103 && f.price == 80_310_000)
    );
    assert!(matches!(&rows[3].event, Event::ConditionMet(_)));
    assert!(matches!(&rows[4].event, Event::Other(raw) if raw.kind == "fees_collected"));
    assert_eq!(
        (rows[2].event_id, rows[2].block_height),
        (proof_sdk_rs::IndexerEventId(12_532_512), 11_676_065)
    );

    let err = info.account_event_history(mm(), &q).await.unwrap_err();
    assert!(
        matches!(&err, Error::HistoryRow { message, next_cursor: None } if message.contains("trade_executed")),
        "{err:?}"
    );
    let p = info.account_event_history(mm(), &q).await.unwrap();
    assert!(matches!(&p.rows[4].event, Event::Other(raw) if raw.kind == "something_new"));
    // Every row is before this window.
    q.from_ms = Some(1_800_000_000_000);
    let err = info.account_event_history(mm(), &q).await.unwrap_err();
    assert!(
        matches!(&err, Error::Decode(m) if m.contains("window")),
        "{err:?}"
    );
    assert_eq!(
        requests(&log)[0].0,
        format!("GET /v1/history/account-events?owner={MM}&order=desc&event_type=trade_executed&limit=5")
    );
}

#[tokio::test]
async fn order_history_pages_with_the_cursor() {
    // Captured from devnet `GET /v1/history/orders/{MM}?limit=1` (2026-11-16).
    let page = json!({"next_cursor":"MXwxNzk0NTY4NzkyMTAzMDIxfDEyNTMyNjA0fDk4OTUzNzAzNzk3NTE5MjU1MzI",
        "orders":[{"block_height":11676123,"block_time":"2026-11-13T11:19:52.103021Z","event_id":12532605,
            "event_index":0,"event_type":"order_cancelled","owner":MM,
            "payload":{"client_order_id":"0","filled_quantity":"9","market":"3","order_id":"3436355",
                "original_quantity":"1249","owner":MM,"reason":"user_requested","remaining_quantity":"1240"},
            "tx_hash":"B50CA919BB882D7A540905E234158D7B8641526C62AF7667169D75EF4A44BC6A"}]});
    let (info, log) = fixture(vec![(200, page)]).await;
    let q = OrderHistoryQuery {
        limit: Some(1),
        cursor: Some("MXwx".into()),
        ..OrderHistoryQuery::default()
    };
    let p = info.order_history(mm(), &q).await.unwrap();
    assert!(matches!(&p.rows[0].event, Event::OrderCancelled(c)
        if c.order_id == 3_436_355 && c.remaining_quantity == 1_240));
    assert!(p.next_cursor.is_some());
    assert_eq!(
        requests(&log)[0].0,
        format!("GET /v1/history/orders/{MM}?limit=1&cursor=MXwx")
    );
}

#[tokio::test]
async fn position_history_reads_open_and_flat_snapshots() {
    // Devnet rows (2026-11-16); the flat one as the indexer writes a close.
    let page = json!({"next_cursor":"","positions":[
        {"balance_usdc":0,"block_height":11676600,"block_time":"2026-11-13T11:22:44.93887Z",
         "entry_px":"69161400508.000000","equity_usdc":0,"margin_ratio_bps":null,"market":1,
         "owner":MM,"side":"buy","size":"215"},
        {"balance_usdc":0,"block_height":11676700,"block_time":"2026-11-13T11:23:00Z",
         "entry_px":null,"equity_usdc":0,"margin_ratio_bps":null,"market":1,
         "owner":MM,"side":null,"size":"0"}]});
    let mut broken = page.clone();
    broken["positions"][0]["side"] = Value::Null;
    let (info, log) = fixture(vec![(200, page), (200, broken)]).await;
    let q = HistoryQuery {
        market: Some(1),
        ..HistoryQuery::default()
    };
    let p = info.position_history(mm(), &q).await.unwrap();
    assert_eq!(
        p.rows[0].position,
        SnapshotPosition::Open {
            side: Side::Buy,
            size: 215,
            entry_price: 69_161_400_508
        }
    );
    assert_eq!(p.rows[1].position, SnapshotPosition::Closed);
    assert!(matches!(
        info.position_history(mm(), &q).await,
        Err(Error::HistoryRow {
            next_cursor: None,
            ..
        })
    ));
    assert_eq!(
        requests(&log)[0].0,
        format!("GET /v1/history/positions/{MM}?market=1")
    );
}

#[tokio::test]
async fn funding_history_reads_signed_payments() {
    // Captured from devnet `GET /v1/history/funding-payments/{MM}?limit=2` (2026-11-16).
    let page = json!({"funding_payments":[
        {"block_height":12312305,"block_time":"2026-11-16T03:00:00.298787Z","market":3,"owner":MM,"payment":"-699016"},
        {"block_height":12312305,"block_time":"2026-11-16T03:00:00.298787Z","market":1,"owner":MM,"payment":"-206560"}],
        "next_cursor":"MXwxNzk0Nzk4MDAwMjk4Nzg3fDEzMDY2ODU4fDkyODg1MDY3NzE1MzM5MDg2MTU"});
    let (info, log) = fixture(vec![(200, page)]).await;
    let p = info
        .funding_history(mm(), &HistoryQuery::default())
        .await
        .unwrap();
    assert_eq!(
        p.rows
            .iter()
            .map(|r| (r.market, r.payment))
            .collect::<Vec<_>>(),
        [(3, -699_016), (1, -206_560)]
    );
    assert_eq!(
        requests(&log)[0].0,
        format!("GET /v1/history/funding-payments/{MM}")
    );
}

#[tokio::test]
async fn resolution_history_types_each_outcome() {
    // Captured from devnet `GET /v1/history/resolutions/4f19...0c77` (2026-11-16).
    let owner = "4f19b63a2067a0164c658858b981312aedb00c77";
    let rows = json!([
        {"block_height":11912613,"converted_size":"0","entry_price":"","event_id":"35","fallback_reason":"",
         "kind":"condition_not_met","market":"3502","owner":owner,"realized_pnl":"0","settlement_price":"",
         "side":"buy","size":"1","timestamp":1794654006731_u64},
        {"block_height":11912613,"converted_size":"3","entry_price":"77961666","event_id":"35","fallback_reason":"",
         "kind":"condition_met","market":"3503","owner":owner,"realized_pnl":"69050","settlement_price":"75660000",
         "side":"sell","size":"3","timestamp":1794654006731_u64},
        {"block_height":11912613,"converted_size":"0","entry_price":"","event_id":"35","fallback_reason":"",
         "kind":"prediction_settled","market":"3500","owner":owner,"realized_pnl":"-6556","settlement_price":"0",
         "side":"buy","size":"1","timestamp":1794654006731_u64}
    ]);
    let mut fallback = rows.clone();
    fallback[1]["converted_size"] = json!("0");
    fallback[1]["fallback_reason"] = json!("open_interest_cap");
    let mut unknown = rows.clone();
    unknown[0]["kind"] = json!("something_new");
    // A row written before conversion existed: "0" and no reason.
    let mut legacy = rows.clone();
    legacy[1]["converted_size"] = json!("0");
    legacy[1]["fallback_reason"] = json!("");
    let (info, log) = fixture(vec![
        (200, rows.clone()),
        (200, fallback),
        (200, unknown),
        (200, legacy),
        (200, rows.clone()),
        (200, rows),
    ])
    .await;
    let owner: Address = owner.parse().unwrap();
    let q = ResolutionsQuery {
        event_id: Some(EventId(35)),
        limit: Some(3),
        ..ResolutionsQuery::default()
    };
    let r = info.resolution_history(owner, &q).await.unwrap();
    assert_eq!(r[0].outcome, ResolutionOutcome::ConditionNotMet);
    assert_eq!(
        r[1].outcome,
        ResolutionOutcome::ConditionMet {
            entry_price: 77_961_666,
            settlement_price: 75_660_000,
            realized_pnl: 69_050,
            conversion: Conversion::Converted { size: 3 }
        }
    );
    assert_eq!(
        r[2].outcome,
        ResolutionOutcome::PredictionSettled {
            payoff_per_share: 0,
            realized_pnl: -6_556
        }
    );
    assert_eq!(
        (r[2].event_id, r[2].market, r[2].side),
        (EventId(35), 3500, Side::Buy)
    );

    let r = info.resolution_history(owner, &q).await.unwrap();
    assert!(matches!(
        r[1].outcome,
        ResolutionOutcome::ConditionMet {
            conversion: Conversion::Fallback(proof_sdk_rs::ConversionFallbackReason::Known(
                proof_sdk_rs::core::types::ConversionFallbackReason::OpenInterestCap
            )),
            ..
        }
    ));
    assert!(matches!(
        info.resolution_history(owner, &q).await,
        Err(Error::Decode(_))
    ));
    let r = info.resolution_history(owner, &q).await.unwrap();
    assert!(matches!(
        r[1].outcome,
        ResolutionOutcome::ConditionMet {
            conversion: Conversion::PreConversion,
            ..
        }
    ));
    // Rows for event 35 answer neither a query for event 36 nor a window
    // after them.
    let other_event = ResolutionsQuery {
        event_id: Some(EventId(36)),
        ..q.clone()
    };
    let err = info
        .resolution_history(owner, &other_event)
        .await
        .unwrap_err();
    assert!(
        matches!(&err, Error::Decode(m) if m.contains("another event")),
        "{err:?}"
    );
    let later = ResolutionsQuery {
        from_ms: Some(1_800_000_000_000),
        ..q.clone()
    };
    let err = info.resolution_history(owner, &later).await.unwrap_err();
    assert!(
        matches!(&err, Error::Decode(m) if m.contains("window")),
        "{err:?}"
    );
    assert_eq!(
        requests(&log)[0].0,
        format!("GET /v1/history/resolutions/{owner}?event_id=35&limit=3")
    );
}

#[tokio::test]
async fn trigger_history_reads_lifecycle_events() {
    // The TS trigger-history fixture's `position_triggers_set` row; devnet
    // answers this route with an empty page.
    let page = json!({"next_cursor":"","trigger_events":[{
        "event_key":"100:1:0","block_height":"100","execution_ordinal":"1","event_ordinal":"0",
        "block_time":"2026-04-19T20:10:00Z","event_type":"position_triggers_set","owner":MM,"market":"7",
        "payload":{"event_key":"100:1:0","block_height":"100","execution_ordinal":"1","event_ordinal":"0",
            "owner":MM,"market":"7","position_epoch":"3","group_id":"9","client_group_id":"0",
            "stop_limb_id":"10","stop_client_trigger_id":"0","take_profit_limb_id":"11",
            "take_profit_client_trigger_id":"0","accepted_height":"100","active_from_height":"101",
            "replaced_group_id":"0","source_order_id":"840"}}]});
    let (info, log) = fixture(vec![
        (200, page),
        (200, json!({"next_cursor":"","trigger_events":[]})),
    ])
    .await;
    let q = HistoryQuery {
        market: Some(7),
        ..HistoryQuery::default()
    };
    let p = info.trigger_history(mm(), &q).await.unwrap();
    let e = &p.rows[0];
    assert_eq!((e.market, e.block_height, e.execution_ordinal), (7, 100, 1));
    assert!(matches!(&e.event, Event::Other(raw)
        if raw.kind == "position_triggers_set" && raw.attribute("group_id") == Some("9")));
    assert!(info
        .trigger_history(mm(), &q)
        .await
        .unwrap()
        .rows
        .is_empty());
    assert_eq!(
        requests(&log)[0].0,
        format!("GET /v1/history/triggers/{MM}?market=7")
    );
}

#[tokio::test]
async fn candles_and_bbo_read_bars_for_the_asked_market() {
    // Captured from devnet `/v1/history/candles` and `/v1/history/bbo` (2026-11-16).
    let candles = json!({"candles":[
        {"c":"69517000000.000000","h":"69517000000.000000","l":"69169000000.000000","o":"69169000000.000000",
         "quote_v":"277372000000.000000","t":"2026-11-13T11:08:00Z","trades":4,"v":"4"},
        {"c":"69142000000.000000","h":"69142000000.000000","l":"69142000000.000000","o":"69142000000.000000",
         "quote_v":"69142000000.000000","t":"2026-11-13T11:09:00Z","trades":1,"v":"1"}],
        "earliest":"2026-09-26T07:03:00Z","from":"2026-11-13T11:06:40Z","has_more":true,"market":1,
        "resolution":"1m","to":"2026-11-13T11:10:00Z"});
    let bbo = json!({"candles":[
        {"ask":"68929000000","bid":"83390067338","c":"76159533669.5","h":"76159533669.5","l":"76159533669.0",
         "o":"76159533669.0","quote_v":"0","t":"2026-11-16T03:43:00Z","trades":0,"v":"0"}],
        "earliest":"2026-09-24T13:45:00Z","from":"2026-11-16T03:42:54.417809761Z","has_more":true,"market":1,
        "resolution":"1m","to":"2026-11-16T03:44:54.417809761Z"});
    let mut other_market = candles.clone();
    other_market["market"] = json!(3);
    let (info, log) = fixture(vec![(200, candles), (200, bbo), (200, other_market)]).await;
    let mut q = CandleQuery::new(1, CandleResolution::ONE_MINUTE);
    q.from_ms = Some(1_794_568_000_000);
    q.to_ms = Some(1_794_568_200_000);
    q.limit = Some(2);
    let p = info.candles(&q).await.unwrap();
    assert_eq!(p.candles.len(), 2);
    let bar = &p.candles[0];
    assert_eq!(bar.open.to_u64(), Some(69_169_000_000));
    assert_eq!((bar.trades, bar.volume.as_str()), (4, "4"));
    assert_eq!(bar.time_ns, 1_794_568_080_000_000_000);
    assert!(p.has_more && p.earliest_ns.is_some());

    let p = info.bbo_candles(&q).await.unwrap();
    let mid = &p.candles[0];
    assert_eq!((mid.bid, mid.ask), (83_390_067_338, 68_929_000_000));
    assert_eq!(
        (mid.close.as_str(), mid.close.to_u64()),
        ("76159533669.5", None)
    );
    assert_eq!(p.from_ns, 1_794_800_574_417_809_761);

    assert!(matches!(info.candles(&q).await, Err(Error::Decode(_))));
    let targets: Vec<String> = requests(&log).into_iter().map(|r| r.0).collect();
    let query = "market=1&resolution=1m&from=1794568000000&to=1794568200000&limit=2";
    assert_eq!(targets[0], format!("GET /v1/history/candles?{query}"));
    assert_eq!(targets[1], format!("GET /v1/history/bbo?{query}"));
}
