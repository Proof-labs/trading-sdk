//! Typed gateway reads a trading loop needs.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use proof_trading_sdk::gateway::{GatewayClient, GatewayOptions};
use proof_trading_sdk::query::{AccountInfo, AccountStateInfo};
use proof_trading_sdk::reads::{self, Shape};
use proof_trading_sdk::types::{EventId, EventInfo, MarketConfig, MarketId, Order, Position, Side};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use url::Url;

use crate::address::Address;
use crate::error::{Error, Result};

/// Devnet gateway.
pub const DEVNET_GATEWAY_URL: &str = "https://api.dev.proof.trade";
/// Devnet chain id.
pub const DEVNET_CHAIN_ID: &str = "exchange-devnet-1";

/// Where and how to reach the gateway. Every read and every submission goes
/// through this one URL; the client never talks to a node directly.
///
/// Build with [`ClientConfig::new`] or [`ClientConfig::devnet`] and the
/// `with_*` setters. Fields are private so new settings can be added without
/// a breaking change.
#[derive(Clone)]
pub struct ClientConfig {
    gateway_url: String,
    chain_id: Option<String>,
    api_key: Option<String>,
    timeout: Duration,
    max_read_bytes: usize,
}

impl ClientConfig {
    /// Config for `gateway_url` with defaults: no pinned chain, no API key,
    /// 10s timeout, 8 MiB read cap.
    ///
    /// The URL must be HTTPS, or HTTP on a loopback IP literal
    /// (`http://127.0.0.1:9080`, not `localhost`), with no path.
    #[must_use]
    pub fn new(gateway_url: impl Into<String>) -> Self {
        Self {
            gateway_url: gateway_url.into(),
            chain_id: None,
            api_key: None,
            timeout: Duration::from_secs(10),
            max_read_bytes: 8 * 1024 * 1024,
        }
    }

    /// The public devnet gateway, pinned to `exchange-devnet-1`.
    #[must_use]
    pub fn devnet() -> Self {
        Self::new(DEVNET_GATEWAY_URL).with_chain_id(DEVNET_CHAIN_ID)
    }

    /// The chain to sign for. [`crate::ExchangeClient::connect`] checks it
    /// against the gateway; without it, `connect` trusts the gateway's chain.
    #[must_use]
    pub fn with_chain_id(mut self, chain_id: impl Into<String>) -> Self {
        self.chain_id = Some(chain_id.into());
        self
    }

    /// Sent as `X-Api-Key` on every request. Never logged.
    #[must_use]
    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    /// Per-request deadline, 1ms..=60s.
    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Response size cap for reads.
    #[must_use]
    pub fn with_max_read_bytes(mut self, bytes: usize) -> Self {
        self.max_read_bytes = bytes;
        self
    }

    #[must_use]
    pub fn gateway_url(&self) -> &str {
        &self.gateway_url
    }

    #[must_use]
    pub fn chain_id(&self) -> Option<&str> {
        self.chain_id.as_deref()
    }

    #[must_use]
    pub fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    #[must_use]
    pub fn timeout(&self) -> Duration {
        self.timeout
    }
}

impl std::fmt::Debug for ClientConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientConfig")
            .field("gateway_url", &self.gateway_url)
            .field("chain_id", &self.chain_id)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("timeout", &self.timeout)
            .field("max_read_bytes", &self.max_read_bytes)
            .finish()
    }
}

/// The chain the gateway serves, from `GET /v1/status`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainStatus {
    /// The network name, e.g. `exchange-devnet-1`. Signatures bind to it.
    pub network: String,
    /// Latest committed height.
    pub height: u64,
    /// That block's time, ms since the epoch.
    pub block_time_ms: u64,
}

/// One aggregated price level. `price` in micro-USDC, `quantity` in contracts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Level {
    pub price: u64,
    pub quantity: u64,
    pub order_count: u32,
}

/// A market's aggregated book: bids best (highest) first, asks best (lowest)
/// first.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Orderbook {
    pub bids: Vec<Level>,
    pub asks: Vec<Level>,
}

impl Orderbook {
    /// Apply one level change from the feed ([`crate::WsMessage::OrderbookUpdate`]):
    /// replace the level at `level.price`, insert it in price order, or
    /// remove it when `level.quantity` is 0.
    pub fn apply(&mut self, side: Side, level: Level) {
        let (levels, at) = match side {
            Side::Buy => {
                let at = self.bids.binary_search_by(|l| level.price.cmp(&l.price));
                (&mut self.bids, at)
            }
            Side::Sell => {
                let at = self.asks.binary_search_by(|l| l.price.cmp(&level.price));
                (&mut self.asks, at)
            }
        };
        match at {
            Ok(i) if level.quantity == 0 => {
                levels.remove(i);
            }
            Ok(i) => levels[i] = level,
            Err(i) if level.quantity > 0 => levels.insert(i, level),
            Err(_) => {}
        }
    }

    #[must_use]
    pub fn best_bid(&self) -> Option<Level> {
        self.bids.first().copied()
    }
    #[must_use]
    pub fn best_ask(&self) -> Option<Level> {
        self.asks.first().copied()
    }
}

/// One public fill from `GET /v1/trades/{market}`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Trade {
    #[serde(deserialize_with = "de_u64")]
    pub fill_id: u64,
    #[serde(deserialize_with = "de_market")]
    pub market: MarketId,
    #[serde(deserialize_with = "de_u64")]
    pub price: u64,
    #[serde(deserialize_with = "de_u64")]
    pub quantity: u64,
    pub maker_owner: Address,
    pub taker_owner: Address,
    /// The resting order's side; the taker traded the other way.
    #[serde(deserialize_with = "de_side")]
    pub maker_side: Side,
    pub block_height: u64,
    /// Block time, ms since the epoch.
    pub timestamp: u64,
}

/// An account's finalized ledger at one block, from
/// `GET /v1/account/{owner}/state`: what reconciliation needs, with no mark,
/// equity or margin (see [`InfoClient::account`] for those).
#[derive(Clone, Debug)]
pub struct AccountState {
    pub owner: Address,
    /// The finalized block this state is as of.
    pub height: u64,
    /// Collateral, micro-USDC.
    pub balance: u64,
    pub positions: Vec<Position>,
}

// -- record shapes the core does not name -----------------------------------

const LEVEL: Shape = Shape::Record {
    width: 3,
    nested: &[],
};
/// `query::OrderbookSnapshot { bids, asks }`.
const ORDERBOOK: Shape = Shape::Record {
    width: 2,
    nested: &[(0, Shape::List(&LEVEL)), (1, Shape::List(&LEVEL))],
};
/// `types::Position`.
const POSITION: Shape = Shape::Record {
    width: 7,
    nested: &[],
};
/// `query::AccountStateInfo`; field 3 is `positions`.
const ACCOUNT_STATE: Shape = Shape::Record {
    width: 4,
    nested: &[(3, Shape::List(&POSITION))],
};
/// `types::Order`, as `openOrders` returns it.
const ORDER: Shape = Shape::Record {
    width: 14,
    nested: &[],
};

/// Typed reads over the gateway. Cheap to clone: clones share one connection
/// pool.
///
/// Every record that has a `proof-wire` type decodes as that type through
/// [`proof_trading_sdk::reads::decode`], so a field the engine appends later
/// does not break the read.
#[derive(Clone)]
pub struct InfoClient {
    config: ClientConfig,
    base: Url,
    max_read_bytes: usize,
    gateway: GatewayClient,
}

impl std::fmt::Debug for InfoClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InfoClient")
            .field("base", &self.base.as_str())
            .finish_non_exhaustive()
    }
}

impl InfoClient {
    /// Build a client. Makes no request.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] for an invalid URL, API key or timeout.
    pub fn new(config: &ClientConfig) -> Result<Self> {
        let gateway = GatewayClient::new(
            &config.gateway_url,
            GatewayOptions {
                timeout: config.timeout,
                api_key: config.api_key.clone(),
                ..GatewayOptions::default()
            },
        )
        .map_err(|_| {
            Error::Config(
                "gateway_url must be https:// or http:// on a loopback IP with no path; \
                 timeout 1ms..=60s; api key non-empty"
                    .into(),
            )
        })?;
        let base = Url::parse(&config.gateway_url).map_err(|e| Error::Config(e.to_string()))?;
        Ok(Self {
            config: config.clone(),
            base,
            max_read_bytes: config.max_read_bytes,
            gateway,
        })
    }

    /// The configuration this client was built from.
    #[must_use]
    pub fn config(&self) -> &ClientConfig {
        &self.config
    }

    /// The core transport this client submits through.
    pub(crate) fn gateway(&self) -> &GatewayClient {
        &self.gateway
    }

    /// `GET /v1/status`: the network the gateway serves and its latest
    /// committed block.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`].
    pub async fn chain_status(&self) -> Result<ChainStatus> {
        let id = self.gateway.chain_identity().await?;
        Ok(ChainStatus {
            network: id.network,
            height: id.latest_height.get(),
            block_time_ms: id.latest_block_time_ms,
        })
    }

    /// `GET /v1/markets`: every market's config (tick, lot, margin, kind,
    /// ticker).
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`].
    pub async fn markets(&self) -> Result<Vec<MarketConfig>> {
        let bytes = self.get_data("/v1/markets").await?;
        decode(&bytes, &Shape::List(&reads::MARKET_CONFIG), "markets")
    }

    /// `GET /v1/events`: every event, with its binary book and attached
    /// conditionals.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`].
    pub async fn events(&self) -> Result<Vec<EventInfo>> {
        let bytes = self.get_data("/v1/events").await?;
        decode(&bytes, &Shape::List(&reads::EVENT_INFO), "events")
    }

    /// `GET /v1/event/{id}`; `None` when it does not exist.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`]. A missing event is `Ok(None)`, not an error.
    pub async fn event(&self, event_id: EventId) -> Result<Option<EventInfo>> {
        match self.get_data(&format!("/v1/event/{event_id}")).await {
            Ok(bytes) => decode(&bytes, &Shape::Optional(&reads::EVENT_INFO), "event"),
            Err(Error::Http { status: 404, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `GET /v1/orderbook/{market}`: the aggregated book.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`].
    pub async fn orderbook(&self, market: MarketId) -> Result<Orderbook> {
        let bytes = self.get_data(&format!("/v1/orderbook/{market}")).await?;
        let snap: proof_trading_sdk::query::OrderbookSnapshot =
            decode(&bytes, &ORDERBOOK, "orderbook")?;
        let level = |l: proof_trading_sdk::query::LevelSummary| Level {
            price: l.price,
            quantity: l.total_quantity,
            order_count: l.order_count,
        };
        Ok(Orderbook {
            bids: snap.bids.into_iter().map(level).collect(),
            asks: snap.asks.into_iter().map(level).collect(),
        })
    }

    /// `GET /v1/trades/{market}?limit=`: the recent public tape, newest first.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`].
    pub async fn recent_trades(&self, market: MarketId, limit: u32) -> Result<Vec<Trade>> {
        #[derive(Deserialize)]
        struct Tape {
            trades: Vec<Trade>,
        }
        let tape: Tape = self
            .get_json(&format!("/v1/trades/{market}?limit={limit}"))
            .await?;
        Ok(tape.trades)
    }

    /// `POST /info {clearinghouseState}`: balance, positions, equity and
    /// margin for `owner`. An account never credited reads as zeros.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`].
    pub async fn account(&self, owner: Address) -> Result<AccountInfo> {
        let bytes = self.post_info_data("clearinghouseState", owner).await?;
        decode(&bytes, &reads::ACCOUNT_INFO, "account")
    }

    /// `GET /v1/account/{owner}/state`: balance and positions as of a
    /// finalized height. An account never credited reads as zeros.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// (also when the answer is for another owner) or
    /// [`Error::ResponseTooLarge`].
    pub async fn account_state(&self, owner: Address) -> Result<AccountState> {
        let bytes = self.get_data(&format!("/v1/account/{owner}/state")).await?;
        account_state(&bytes, owner)
    }

    /// `POST /info {openOrders}`: `owner`'s resting orders.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`].
    pub async fn open_orders(&self, owner: Address) -> Result<Vec<Order>> {
        let bytes = self.post_info_data("openOrders", owner).await?;
        decode(&bytes, &Shape::List(&ORDER), "open orders")
    }

    /// `GET /v1/account/{owner}/recent-nonces`: the nonces the engine still
    /// remembers for `owner`. Pass the maximum to
    /// [`crate::NonceAllocator::next_after`] when a restarted process must stay
    /// ahead of its predecessor.
    ///
    /// # Errors
    ///
    /// A read failure: [`Error::Transport`], [`Error::Http`], [`Error::Decode`]
    /// or [`Error::ResponseTooLarge`].
    pub async fn recent_nonces(&self, owner: Address) -> Result<Vec<u64>> {
        #[derive(Deserialize)]
        struct Recent {
            #[serde(default)]
            recent: Vec<Dec>,
        }
        let r: Recent = self
            .get_json(&format!("/v1/account/{owner}/recent-nonces"))
            .await?;
        Ok(r.recent.into_iter().map(|d| d.0).collect())
    }

    // -- escape hatches -----------------------------------------------------

    /// GET a `{"data": "<base64 msgpack>"}` route and return the decoded
    /// `MessagePack` bytes, for routes this client does not wrap. Decode them
    /// with [`proof_trading_sdk::reads::decode`].
    ///
    /// # Errors
    ///
    /// [`Error::InvalidInput`] for a bad `path`, otherwise a read failure:
    /// [`Error::Transport`], [`Error::Http`], [`Error::Decode`] or
    /// [`Error::ResponseTooLarge`].
    pub async fn get_data(&self, path: &str) -> Result<Vec<u8>> {
        let env: DataEnvelope = self.get_json(path).await?;
        unbase64(&env.data)
    }

    /// GET a JSON route.
    ///
    /// # Errors
    ///
    /// As [`Self::get_data`].
    pub async fn get_json<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = self.url(path)?;
        let resp = self.gateway.http().get(url).send().await?;
        self.json(resp).await
    }

    /// POST a JSON body to `/info` and return the JSON answer.
    ///
    /// # Errors
    ///
    /// As [`Self::get_data`].
    pub async fn post_info<B: Serialize + ?Sized, T: DeserializeOwned>(
        &self,
        body: &B,
    ) -> Result<T> {
        let url = self.url("/info")?;
        let resp = self.gateway.http().post(url).json(body).send().await?;
        self.json(resp).await
    }

    // -- internals ----------------------------------------------------------

    async fn post_info_data(&self, kind: &str, owner: Address) -> Result<Vec<u8>> {
        let body = serde_json::json!({ "type": kind, "user": owner.to_string() });
        let env: DataEnvelope = self.post_info(&body).await?;
        unbase64(&env.data)
    }

    fn url(&self, path: &str) -> Result<Url> {
        self.base
            .join(path)
            .map_err(|e| Error::InvalidInput(format!("path {path:?}: {e}")))
    }

    async fn json<T: DeserializeOwned>(&self, mut resp: reqwest::Response) -> Result<T> {
        let status = resp.status();
        if resp
            .content_length()
            .is_some_and(|n| n > self.max_read_bytes as u64)
        {
            return Err(Error::ResponseTooLarge);
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await? {
            if chunk.len() > self.max_read_bytes.saturating_sub(body.len()) {
                return Err(Error::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        if status != StatusCode::OK {
            let text = String::from_utf8_lossy(&body);
            return Err(Error::Http {
                status: status.as_u16(),
                body: text.chars().take(256).collect(),
            });
        }
        serde_json::from_slice(&body).map_err(|e| Error::Decode(e.to_string()))
    }
}

#[derive(Deserialize)]
struct DataEnvelope {
    data: String,
}

fn unbase64(data: &str) -> Result<Vec<u8>> {
    STANDARD
        .decode(data)
        .map_err(|e| Error::Decode(format!("base64: {e}")))
}

fn decode<T: DeserializeOwned>(bytes: &[u8], shape: &Shape, what: &str) -> Result<T> {
    proof_trading_sdk::msgpack::reject_floats(bytes)
        .map_err(|e| Error::Decode(format!("{what}: {e}")))?;
    reads::decode(bytes, shape).map_err(|e| Error::Decode(format!("{what}: {e}")))
}

fn account_state(bytes: &[u8], owner: Address) -> Result<AccountState> {
    let s: AccountStateInfo = decode(bytes, &ACCOUNT_STATE, "account state")?;
    let got = Address::from(s.owner.0);
    if got != owner {
        return Err(Error::Decode(format!(
            "account state is for {got}, asked for {owner}"
        )));
    }
    Ok(AccountState {
        owner: got,
        height: s.finalized_height.0,
        balance: s.balance,
        positions: s.positions,
    })
}

/// A u64 the gateway serves as a JSON number or a decimal string.
struct Dec(u64);
impl<'de> Deserialize<'de> for Dec {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        de_u64(d).map(Dec)
    }
}

fn de_u64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        N(u64),
        S(String),
    }
    match Raw::deserialize(d)? {
        Raw::N(n) => Ok(n),
        Raw::S(s) => s.parse().map_err(serde::de::Error::custom),
    }
}

fn de_market<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<MarketId, D::Error> {
    MarketId::try_from(de_u64(d)?).map_err(serde::de::Error::custom)
}

fn de_side<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Side, D::Error> {
    match String::deserialize(d)?.as_str() {
        "buy" | "Buy" => Ok(Side::Buy),
        "sell" | "Sell" => Ok(Side::Sell),
        other => Err(serde::de::Error::custom(format!("unknown side {other:?}"))),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn orderbook_bytes_from_devnet_decode() {
        // Captured from https://api.dev.proof.trade/v1/orderbook/1 (2026-11-10).
        let bytes = unbase64(
            "kpSTzwAAABFdbwGAzQRwAZPPAAAAEV0x+IAXAZPPAAAAEVhtRIAQAZPPAAAAETxLHoDMyAGTk88AAAARZqweQM0BGgGTzwAAABFrcNJAzMoBk88AAAARc8kNQM0FOQE=",
        )
        .unwrap();
        let snap: proof_trading_sdk::query::OrderbookSnapshot =
            decode(&bytes, &ORDERBOOK, "orderbook").unwrap();
        assert_eq!(snap.bids.len(), 4);
        assert_eq!(snap.asks.len(), 3);
        assert!(snap.bids[0].price > snap.bids[1].price, "bids best first");
        assert!(snap.asks[0].price < snap.asks[1].price, "asks best first");
        assert!(snap.bids[0].price < snap.asks[0].price, "book not crossed");
    }

    #[test]
    fn a_level_with_an_appended_field_still_decodes() {
        // [[ [price, qty, count, extra] ], []]
        let bytes = [0x92, 0x91, 0x94, 0x0a, 0x02, 0x01, 0x07, 0x90];
        let snap: proof_trading_sdk::query::OrderbookSnapshot =
            decode(&bytes, &ORDERBOOK, "orderbook").unwrap();
        assert_eq!(snap.bids[0].price, 10);
        assert_eq!(snap.bids[0].total_quantity, 2);
    }

    #[test]
    fn floats_are_refused() {
        // [[ [1.5, 1, 1] ], []]
        let bytes = [
            0x92, 0x91, 0x93, 0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0, 0x01, 0x01, 0x90,
        ];
        assert!(decode::<proof_trading_sdk::query::OrderbookSnapshot>(
            &bytes,
            &ORDERBOOK,
            "orderbook"
        )
        .is_err());
    }

    #[test]
    fn trade_rows_decode_decimal_strings() {
        let t: Trade = serde_json::from_str(
            r#"{"fill_id":"375779","market":"1","price":"74737000000","quantity":"1",
               "maker_owner":"bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9",
               "taker_owner":"4f19b63a2067a0164c658858b981312aedb00c77",
               "maker_side":"sell","taker_fee":"374","maker_fee":"150",
               "block_height":10869313,"timestamp":1794278105172}"#,
        )
        .unwrap();
        assert_eq!(t.price, 74_737_000_000);
        assert_eq!(t.maker_side, Side::Sell);
    }

    #[test]
    fn config_debug_redacts_the_api_key() {
        let c = ClientConfig::devnet().with_api_key("super-secret");
        assert!(!format!("{c:?}").contains("super-secret"));
    }
}
