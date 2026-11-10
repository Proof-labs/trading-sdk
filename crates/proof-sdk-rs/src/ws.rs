//! The gateway's multiplexed WebSocket feed (`/ws`), feature `ws`.
//!
//! One socket carries every subscription. [`WsClient::connect`] returns a
//! cloneable [`WsClient`] handle for subscribing, plus a [`WsReceiver`] that
//! yields typed [`WsMessage`]s. A background task owns the socket. It sends an
//! app-level ping on an interval and reconnects (with backoff) when a pong is
//! missed or the socket drops, then re-sends every subscription. After a
//! reconnect it yields [`WsMessage::Reconnected`]. Each order book then
//! re-sends its full snapshot, but account events missed while disconnected
//! are not replayed.

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::{SinkExt, Stream, StreamExt};
use proof_trading_sdk::query::AccountInfo;
use proof_trading_sdk::reads;
use proof_trading_sdk::types::{MarketId, Side};
use proof_trading_sdk::Signer;
use serde::{Deserialize, Deserializer};
use serde_json::json;
use tokio::sync::mpsc;
use tokio::time::{sleep, sleep_until, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::account_event::{kind_of, AccountEvent};
use crate::address::Address;
use crate::error::{Error, Result};
use crate::info::{ClientConfig, Level};
use crate::nonce::now_ms;

type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

/// Domain prefix of the gateway's account-stream auth message.
const ACCOUNT_AUTH_DOMAIN: &[u8] = b"ProofExchange-account-events-v1";

// -- configuration -------------------------------------------------------------

/// Signs `accountEvents` subscriptions. Gateways running with an API key (the
/// public devnet among them) refuse an unsigned account subscription.
///
/// Build it with [`crate::ExchangeClient::account_auth`], or from any
/// [`Signer`] and the network name.
#[derive(Clone)]
pub struct AccountAuth {
    signer: Arc<dyn Signer>,
    chain_id: [u8; 32],
}

impl AccountAuth {
    /// Sign for `network` (e.g. `exchange-devnet-1`).
    pub fn new(signer: Arc<dyn Signer>, network: &str) -> Self {
        Self {
            signer,
            chain_id: proof_trading_sdk::crypto::chain_id_from_string(network),
        }
    }

    /// The subscribe params proving control of `owner`, signed now:
    /// `domain || chain_id || owner_hex || after_id (i64 BE) || timestamp_ms (u64 BE)`.
    fn params(&self, owner: Address) -> Result<serde_json::Value> {
        let timestamp_ms = now_ms();
        let owner_hex = owner.to_string();
        let mut msg = Vec::with_capacity(ACCOUNT_AUTH_DOMAIN.len() + 32 + 40 + 16);
        msg.extend_from_slice(ACCOUNT_AUTH_DOMAIN);
        msg.extend_from_slice(&self.chain_id);
        msg.extend_from_slice(owner_hex.as_bytes());
        msg.extend_from_slice(&0_i64.to_be_bytes()); // after_id: no backfill
        msg.extend_from_slice(&timestamp_ms.to_be_bytes());
        let signature = self.signer.try_sign(&msg)?;
        Ok(json!({
            "public_key": hex(&self.signer.public_key()),
            "signature": hex(&signature),
            "timestamp_ms": timestamp_ms,
        }))
    }
}

impl std::fmt::Debug for AccountAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountAuth")
            .field("public_key", &hex(&self.signer.public_key()))
            .finish_non_exhaustive()
    }
}

/// WebSocket feed settings. Build with [`WsConfig::new`] or
/// [`WsConfig::from_client_config`] and the `with_*` setters.
#[derive(Clone)]
pub struct WsConfig {
    url: String,
    api_key: Option<String>,
    account_auth: Option<AccountAuth>,
    ping_interval: Duration,
    pong_timeout: Duration,
    reconnect: bool,
    max_backoff: Duration,
    buffer: usize,
}

impl WsConfig {
    /// Settings for the feed at `url` (e.g. `wss://api.dev.proof.trade/ws`)
    /// with defaults: ping every 15s, reconnect after a 10s pong timeout with
    /// backoff up to 10s, 4096-message buffer, no API key, no account auth.
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            api_key: None,
            account_auth: None,
            ping_interval: Duration::from_secs(15),
            pong_timeout: Duration::from_secs(10),
            reconnect: true,
            max_backoff: Duration::from_secs(10),
            buffer: 4096,
        }
    }

    /// The `/ws` feed of `config`'s gateway (`https` becomes `wss`), with its
    /// API key.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] if the gateway URL is not `http(s)`.
    pub fn from_client_config(config: &ClientConfig) -> Result<Self> {
        let base = config.gateway_url().trim_end_matches('/');
        let url = if let Some(rest) = base.strip_prefix("https://") {
            format!("wss://{rest}/ws")
        } else if let Some(rest) = base.strip_prefix("http://") {
            format!("ws://{rest}/ws")
        } else {
            return Err(Error::Config("gateway url needs an http(s) scheme".into()));
        };
        let mut ws = Self::new(url);
        ws.api_key = config.api_key().map(str::to_owned);
        Ok(ws)
    }

    /// Sign `accountEvents` subscriptions; see [`AccountAuth`].
    #[must_use]
    pub fn with_account_auth(mut self, auth: AccountAuth) -> Self {
        self.account_auth = Some(auth);
        self
    }

    /// Sent as `X-Api-Key` on the handshake.
    #[must_use]
    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    /// App-level ping cadence.
    #[must_use]
    pub fn with_ping_interval(mut self, every: Duration) -> Self {
        self.ping_interval = every;
        self
    }

    /// Reconnect if no pong arrives this long after a ping.
    #[must_use]
    pub fn with_pong_timeout(mut self, timeout: Duration) -> Self {
        self.pong_timeout = timeout;
        self
    }

    /// Reconnect after a drop (default). With `false` the receiver ends on
    /// the first disconnect.
    #[must_use]
    pub fn with_reconnect(mut self, reconnect: bool) -> Self {
        self.reconnect = reconnect;
        self
    }

    /// Upper bound of the reconnect backoff, which starts at 250ms and
    /// doubles.
    #[must_use]
    pub fn with_max_backoff(mut self, max: Duration) -> Self {
        self.max_backoff = max;
        self
    }

    /// Messages buffered for a slow consumer. While the buffer is full the
    /// socket is not read (and no pings go out).
    #[must_use]
    pub fn with_buffer(mut self, messages: usize) -> Self {
        self.buffer = messages;
        self
    }

    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }
}

impl std::fmt::Debug for WsConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WsConfig")
            .field("url", &self.url)
            .field("api_key", &self.api_key.as_ref().map(|_| "[REDACTED]"))
            .field("account_auth", &self.account_auth)
            .field("ping_interval", &self.ping_interval)
            .field("pong_timeout", &self.pong_timeout)
            .field("reconnect", &self.reconnect)
            .finish_non_exhaustive()
    }
}

// -- public messages -----------------------------------------------------------

/// A feed channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[non_exhaustive]
pub enum Subscription {
    /// Aggregated book: a snapshot, then one update per changed level.
    Orderbook(MarketId),
    /// Public fills.
    Trades(MarketId),
    /// An account's snapshot, then its live engine events (orders, fills,
    /// positions, funding). Needs [`WsConfig::with_account_auth`] on gateways
    /// that require auth, the public devnet among them.
    AccountEvents(Address),
}

/// A public fill on the `trades` channel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct WsTrade {
    pub market: MarketId,
    pub fill_id: u64,
    /// The resting order's side; the taker traded the other way.
    pub maker_side: Side,
    pub price: u64,
    pub quantity: u64,
}

/// An account snapshot from the feed: the engine's [`AccountInfo`], which
/// derefs to it. (`AccountInfo` itself has no `Debug`; this prints the
/// headline fields.)
// TODO: derive `Debug` and `Clone` on `AccountInfo` (and `OrderbookSnapshot`,
// `LevelSummary`) in proof-wire (exchange `exchange-wire/src/query.rs`), then
// drop this wrapper for `AccountInfo` and make `WsMessage` `Clone`.
pub struct WsAccount(pub AccountInfo);

impl std::ops::Deref for WsAccount {
    type Target = AccountInfo;
    fn deref(&self) -> &AccountInfo {
        &self.0
    }
}

impl std::fmt::Debug for WsAccount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountInfo")
            .field("balance", &self.balance)
            .field("equity", &self.equity)
            .field("margin_ratio_bps", &self.margin_ratio_bps)
            .field("positions", &self.positions.len())
            .finish_non_exhaustive()
    }
}

/// Something the feed delivered.
#[derive(Debug)]
#[non_exhaustive]
pub enum WsMessage {
    /// A market's full book. Replace local state with it.
    OrderbookSnapshot {
        market: MarketId,
        bids: Vec<Level>,
        asks: Vec<Level>,
    },
    /// One level changed. A `quantity` of 0 removes the level.
    OrderbookUpdate {
        market: MarketId,
        side: Side,
        level: Level,
    },
    /// A public fill.
    Trade(WsTrade),
    /// An account's state at subscribe time.
    AccountSnapshot {
        owner: Address,
        /// The height it was read at, when the gateway reports it.
        height: Option<u64>,
        account: Box<WsAccount>,
    },
    /// A live account event.
    AccountEvent(AccountEvent),
    /// The gateway refused a subscription or control message (`id` names the
    /// request). A `code` of 401 on `accountEvents` means it needs auth.
    Refused {
        id: Option<u64>,
        channel: Option<String>,
        code: Option<u16>,
        message: String,
    },
    /// The socket dropped and was re-opened, and every subscription was
    /// re-sent. Books will re-snapshot. Account events from the gap are
    /// not replayed; reconcile through `InfoClient` if they matter.
    Reconnected,
    /// The socket dropped. With `reconnect` on, a reconnect is under way.
    Disconnected { reason: String },
    /// A frame this client could not read. The connection carries on.
    Malformed { reason: String },
}

// -- client / receiver ---------------------------------------------------------------

enum Command {
    Subscribe(Subscription),
    Unsubscribe(Subscription),
    Close,
}

/// Handle to the feed. Cheap to clone. Dropping every handle closes the feed.
#[derive(Clone, Debug)]
pub struct WsClient {
    commands: mpsc::UnboundedSender<Command>,
}

/// The stream of [`WsMessage`]s. Ends (`None`) after [`WsClient::close`],
/// when every [`WsClient`] is dropped, or on a disconnect with `reconnect`
/// off.
#[derive(Debug)]
pub struct WsReceiver {
    messages: mpsc::Receiver<WsMessage>,
}

impl WsReceiver {
    /// The next message.
    pub async fn recv(&mut self) -> Option<WsMessage> {
        self.messages.recv().await
    }
}

impl Stream for WsReceiver {
    type Item = WsMessage;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<WsMessage>> {
        self.messages.poll_recv(cx)
    }
}

impl WsClient {
    /// Open the feed. The first connection is made before this returns, so a
    /// bad URL or an unreachable gateway is an error here and not a silent retry.
    ///
    /// Spawns the connection task with `tokio::spawn`, so it must be called
    /// inside a tokio runtime. The task ends when the feed closes.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] for a bad URL or API key, [`Error::WsConnect`] if the
    /// handshake fails or times out.
    pub async fn connect(config: WsConfig) -> Result<(Self, WsReceiver)> {
        let socket = open(&config).await?;
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (message_tx, messages) = mpsc::channel(config.buffer.max(1));
        tokio::spawn(run(config, socket, command_rx, message_tx));
        Ok((Self { commands }, WsReceiver { messages }))
    }

    /// Subscribe. Idempotent; kept across reconnects.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once the feed has ended.
    pub fn subscribe(&self, subscription: Subscription) -> Result<()> {
        self.send(Command::Subscribe(subscription))
    }

    /// Unsubscribe. Idempotent.
    ///
    /// # Errors
    ///
    /// [`Error::Closed`] once the feed has ended.
    pub fn unsubscribe(&self, subscription: Subscription) -> Result<()> {
        self.send(Command::Unsubscribe(subscription))
    }

    /// Close the socket and end the receiver.
    pub fn close(&self) {
        let _ = self.commands.send(Command::Close);
    }

    fn send(&self, command: Command) -> Result<()> {
        self.commands.send(command).map_err(|_| Error::Closed)
    }
}

// -- connection task -------------------------------------------------------------

async fn open(config: &WsConfig) -> Result<Socket> {
    let mut request = config
        .url
        .as_str()
        .into_client_request()
        .map_err(|e| Error::Config(format!("ws url: {e}")))?;
    if let Some(key) = &config.api_key {
        let mut value = HeaderValue::from_str(key)
            .map_err(|_| Error::Config("api key is not a valid header value".into()))?;
        value.set_sensitive(true);
        request.headers_mut().insert("X-Api-Key", value);
    }
    let connect = tokio_tungstenite::connect_async(request);
    match tokio::time::timeout(Duration::from_secs(10), connect).await {
        Ok(Ok((socket, _))) => Ok(socket),
        Ok(Err(e)) => Err(Error::WsConnect(e.to_string())),
        Err(_) => Err(Error::WsConnect("timed out".into())),
    }
}

/// Why a session ended.
enum End {
    /// Closed by the caller, or nobody is listening any more.
    Closed,
    /// The connection failed; reconnect if configured.
    Dropped(String),
}

async fn run(
    config: WsConfig,
    first: Socket,
    mut commands: mpsc::UnboundedReceiver<Command>,
    out: mpsc::Sender<WsMessage>,
) {
    let mut subscriptions = BTreeSet::new();
    let mut next_id: u64 = 1;
    let mut socket = Some(first);
    let mut backoff = Duration::from_millis(250);
    let mut reconnected = false;

    loop {
        let Some(mut ws) = socket.take() else { return };
        if reconnected && out.send(WsMessage::Reconnected).await.is_err() {
            return;
        }
        let end = session(
            &config,
            &mut ws,
            &mut subscriptions,
            &mut next_id,
            &mut commands,
            &out,
        )
        .await;
        let _ = ws.close(None).await;
        let End::Dropped(reason) = end else { return };
        if out.send(WsMessage::Disconnected { reason }).await.is_err() || !config.reconnect {
            return;
        }
        // Reconnect with doubling backoff; a closed handle ends the loop.
        loop {
            tokio::select! {
                () = sleep(backoff) => {}
                cmd = commands.recv() => match cmd {
                    None | Some(Command::Close) => return,
                    Some(Command::Subscribe(s)) => { subscriptions.insert(s); continue; }
                    Some(Command::Unsubscribe(s)) => { subscriptions.remove(&s); continue; }
                },
            }
            if let Ok(ws) = open(&config).await {
                socket = Some(ws);
                backoff = Duration::from_millis(250);
                reconnected = true;
                break;
            }
            backoff = (backoff * 2).min(config.max_backoff);
        }
    }
}

async fn session(
    config: &WsConfig,
    ws: &mut Socket,
    subscriptions: &mut BTreeSet<Subscription>,
    next_id: &mut u64,
    commands: &mut mpsc::UnboundedReceiver<Command>,
    out: &mpsc::Sender<WsMessage>,
) -> End {
    for &s in subscriptions.iter() {
        if let Err(e) = send_subscribe(config, ws, s, true, next_id, out).await {
            return e;
        }
    }
    let mut next_ping = Instant::now() + config.ping_interval;
    let mut pong_deadline: Option<Instant> = None;
    loop {
        tokio::select! {
            cmd = commands.recv() => match cmd {
                None | Some(Command::Close) => return End::Closed,
                Some(Command::Subscribe(s)) => {
                    if subscriptions.insert(s) {
                        if let Err(e) = send_subscribe(config, ws, s, true, next_id, out).await {
                            return e;
                        }
                    }
                }
                Some(Command::Unsubscribe(s)) => {
                    if subscriptions.remove(&s) {
                        if let Err(e) = send_subscribe(config, ws, s, false, next_id, out).await {
                            return e;
                        }
                    }
                }
            },
            frame = ws.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    match parse(&text) {
                        Parsed::Message(m) => {
                            if out.send(*m).await.is_err() {
                                return End::Closed;
                            }
                        }
                        Parsed::Pong => pong_deadline = None,
                        Parsed::Ignore => {}
                    }
                }
                Some(Ok(Message::Close(frame))) => {
                    return End::Dropped(frame.map_or_else(|| "closed by gateway".into(), |f| f.reason.to_string()));
                }
                Some(Ok(_)) => {} // binary / protocol ping-pong: tungstenite answers pings itself
                Some(Err(e)) => return End::Dropped(e.to_string()),
                None => return End::Dropped("socket ended".into()),
            },
            () = sleep_until(next_ping) => {
                let ping = json!({ "method": "ping", "id": take_id(next_id) }).to_string();
                if let Err(e) = ws.send(Message::Text(ping)).await {
                    return End::Dropped(e.to_string());
                }
                next_ping = Instant::now() + config.ping_interval;
                pong_deadline.get_or_insert(Instant::now() + config.pong_timeout);
            },
            () = sleep_until(pong_deadline.unwrap_or(next_ping)), if pong_deadline.is_some() => {
                return End::Dropped("pong timeout".into());
            },
        }
    }
}

async fn send_subscribe(
    config: &WsConfig,
    ws: &mut Socket,
    subscription: Subscription,
    subscribe: bool,
    next_id: &mut u64,
    out: &mpsc::Sender<WsMessage>,
) -> Result<(), End> {
    let id = take_id(next_id);
    let mut params = match subscription {
        Subscription::Orderbook(market) => json!({ "channel": "orderbook", "market": market }),
        Subscription::Trades(market) => json!({ "channel": "trades", "market": market }),
        Subscription::AccountEvents(owner) => {
            json!({ "channel": "accountEvents", "owner": owner.to_string() })
        }
    };
    if let (true, Subscription::AccountEvents(owner), Some(auth)) =
        (subscribe, subscription, &config.account_auth)
    {
        match auth.params(owner) {
            Ok(serde_json::Value::Object(signed)) => {
                if let Some(p) = params.as_object_mut() {
                    p.extend(signed);
                }
            }
            Ok(_) => {}
            Err(e) => {
                // Never send an unsigned account subscribe in place of a signed one.
                let refused = WsMessage::Refused {
                    id: Some(id),
                    channel: Some("accountEvents".into()),
                    code: None,
                    message: format!("signing the subscription failed: {e}"),
                };
                return out.send(refused).await.map_err(|_| End::Closed);
            }
        }
    }
    let method = if subscribe {
        "subscribe"
    } else {
        "unsubscribe"
    };
    let frame = json!({ "method": method, "id": id, "params": params }).to_string();
    ws.send(Message::Text(frame))
        .await
        .map_err(|e| End::Dropped(e.to_string()))
}

fn take_id(next: &mut u64) -> u64 {
    let id = *next;
    *next = next.wrapping_add(1);
    id
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

// -- frame parsing ---------------------------------------------------------------

impl Parsed {
    fn message(m: WsMessage) -> Self {
        Self::Message(Box::new(m))
    }
}

enum Parsed {
    Message(Box<WsMessage>),
    Pong,
    Ignore,
}

/// Every field any frame carries. Strings borrow from the frame when they can.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw<'a> {
    #[serde(borrow, rename = "type")]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow)]
    channel: Option<Cow<'a, str>>,
    id: Option<u64>,
    #[serde(default, deserialize_with = "opt_u64")]
    market: Option<u64>,
    #[serde(borrow)]
    side: Option<Cow<'a, str>>,
    #[serde(default, deserialize_with = "opt_u64")]
    price: Option<u64>,
    #[serde(default, deserialize_with = "opt_u64")]
    total_quantity: Option<u64>,
    #[serde(default, deserialize_with = "opt_u64")]
    order_count: Option<u64>,
    bids: Option<Vec<RawLevel>>,
    asks: Option<Vec<RawLevel>>,
    #[serde(default, deserialize_with = "opt_u64")]
    fill_id: Option<u64>,
    #[serde(borrow)]
    maker_side: Option<Cow<'a, str>>,
    #[serde(default, deserialize_with = "opt_u64")]
    quantity: Option<u64>,
    #[serde(borrow)]
    owner: Option<Cow<'a, str>>,
    #[serde(borrow)]
    event_type: Option<Cow<'a, str>>,
    #[serde(default, deserialize_with = "opt_u64")]
    height: Option<u64>,
    tx_hash: Option<String>,
    payload: Option<serde_json::Value>,
    account: Option<RawAccount>,
    code: Option<u16>,
    #[serde(borrow)]
    error: Option<Cow<'a, str>>,
}

/// `[price, totalQuantity, orderCount]`.
struct RawLevel(Level);

impl<'de> Deserialize<'de> for RawLevel {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let (price, quantity, order_count) = <(u64, u64, u32)>::deserialize(d)?;
        Ok(Self(Level {
            price,
            quantity,
            order_count,
        }))
    }
}

/// The account snapshot's `{"data": "<base64 msgpack AccountInfo>"}`.
#[derive(Deserialize)]
struct RawAccount {
    data: String,
}

fn opt_u64<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<u64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum N<'a> {
        U(u64),
        #[serde(borrow)]
        S(Cow<'a, str>),
    }
    match Option::<N>::deserialize(d)? {
        None => Ok(None),
        Some(N::U(n)) => Ok(Some(n)),
        Some(N::S(s)) if s.is_empty() => Ok(None),
        Some(N::S(s)) => s.parse().map(Some).map_err(serde::de::Error::custom),
    }
}

fn side(s: Option<&str>) -> Option<Side> {
    match s? {
        // The gateway's orderbook frames say bid/ask; trades say buy/sell.
        "bid" | "buy" | "Buy" => Some(Side::Buy),
        "ask" | "sell" | "Sell" => Some(Side::Sell),
        _ => None,
    }
}

fn malformed(reason: impl Into<String>) -> Parsed {
    Parsed::message(WsMessage::Malformed {
        reason: reason.into(),
    })
}

fn parse(text: &str) -> Parsed {
    let raw: Raw = match serde_json::from_str(text) {
        Ok(raw) => raw,
        Err(e) => return malformed(e.to_string()),
    };
    match raw.kind.as_deref() {
        Some("pong") => Parsed::Pong,
        Some("subscribed" | "unsubscribed") => Parsed::Ignore,
        Some("error") => Parsed::message(WsMessage::Refused {
            id: raw.id,
            channel: raw.channel.map(Cow::into_owned),
            code: raw.code,
            message: raw.error.map(Cow::into_owned).unwrap_or_default(),
        }),
        _ => match raw.channel.as_deref() {
            Some("orderbook") => orderbook(raw),
            Some("trades") => trade(&raw),
            Some("accountEvents") => account(raw),
            _ => Parsed::Ignore,
        },
    }
}

fn market(raw: &Raw<'_>) -> Option<MarketId> {
    raw.market.and_then(|m| MarketId::try_from(m).ok())
}

fn orderbook(raw: Raw<'_>) -> Parsed {
    let Some(market) = market(&raw) else {
        return malformed("orderbook frame without a market");
    };
    match raw.kind.as_deref() {
        Some("snapshot") => {
            let levels =
                |v: Option<Vec<RawLevel>>| v.unwrap_or_default().into_iter().map(|l| l.0).collect();
            Parsed::message(WsMessage::OrderbookSnapshot {
                market,
                bids: levels(raw.bids),
                asks: levels(raw.asks),
            })
        }
        Some("update") => match (side(raw.side.as_deref()), raw.price, raw.total_quantity) {
            (Some(side), Some(price), Some(quantity)) => {
                Parsed::message(WsMessage::OrderbookUpdate {
                    market,
                    side,
                    level: Level {
                        price,
                        quantity,
                        order_count: raw
                            .order_count
                            .and_then(|c| u32::try_from(c).ok())
                            .unwrap_or(0),
                    },
                })
            }
            _ => malformed("orderbook update missing side/price/totalQuantity"),
        },
        _ => Parsed::Ignore,
    }
}

fn trade(raw: &Raw<'_>) -> Parsed {
    match (
        market(raw),
        raw.fill_id,
        side(raw.maker_side.as_deref()),
        raw.price,
        raw.quantity,
    ) {
        (Some(market), Some(fill_id), Some(maker_side), Some(price), Some(quantity)) => {
            Parsed::message(WsMessage::Trade(WsTrade {
                market,
                fill_id,
                maker_side,
                price,
                quantity,
            }))
        }
        _ => malformed("trade missing market/fillId/makerSide/price/quantity"),
    }
}

fn account(raw: Raw<'_>) -> Parsed {
    let Some(owner) = raw.owner.as_deref().and_then(|o| o.parse().ok()) else {
        return malformed("account frame without an owner");
    };
    match raw.kind.as_deref() {
        Some("snapshot") => {
            let Some(account) = raw.account else {
                return malformed("account snapshot without an account");
            };
            match decode_account(&account.data) {
                Ok(account) => Parsed::message(WsMessage::AccountSnapshot {
                    owner,
                    height: raw.height,
                    account: Box::new(WsAccount(account)),
                }),
                Err(reason) => malformed(reason),
            }
        }
        Some(_) => {
            let Some(event_type) = raw.event_type else {
                return malformed("account event without an eventType");
            };
            let payload = raw.payload.unwrap_or(serde_json::Value::Null);
            Parsed::message(WsMessage::AccountEvent(AccountEvent {
                owner,
                kind: kind_of(&event_type, &payload),
                event_type: event_type.into_owned(),
                height: raw.height.unwrap_or(0),
                tx_hash: raw.tx_hash,
                payload,
            }))
        }
        None => Parsed::Ignore,
    }
}

fn decode_account(data: &str) -> std::result::Result<AccountInfo, String> {
    let bytes = STANDARD
        .decode(data)
        .map_err(|e| format!("account snapshot base64: {e}"))?;
    proof_trading_sdk::msgpack::reject_floats(&bytes)
        .map_err(|e| format!("account snapshot: {e}"))?;
    reads::decode(&bytes, &reads::ACCOUNT_INFO).map_err(|e| format!("account snapshot: {e}"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::panic)]
    use super::*;

    fn message(text: &str) -> WsMessage {
        match parse(text) {
            Parsed::Message(m) => *m,
            Parsed::Pong => panic!("pong"),
            Parsed::Ignore => panic!("ignored"),
        }
    }

    // Frames below are verbatim from wss://api.dev.proof.trade/ws (2026-11-10).

    #[test]
    fn orderbook_snapshot() {
        let m = message(
            r#"{"asks":[[74737000000,274,1],[74817000000,202,1]],"bids":[[74595000000,1137,1]],"channel":"orderbook","market":1,"snapshot":"initial","type":"snapshot"}"#,
        );
        let WsMessage::OrderbookSnapshot { market, bids, asks } = m else {
            panic!("{m:?}")
        };
        assert_eq!(market, 1);
        assert_eq!(bids[0].price, 74_595_000_000);
        assert_eq!(asks.len(), 2);
    }

    #[test]
    fn orderbook_update_uses_bid_ask() {
        let m = message(
            r#"{"channel":"orderbook","market":1,"orderCount":0,"price":74595000000,"side":"bid","totalQuantity":0,"type":"update"}"#,
        );
        let WsMessage::OrderbookUpdate { side, level, .. } = m else {
            panic!("{m:?}")
        };
        assert_eq!(side, Side::Buy);
        assert_eq!(level.quantity, 0, "zero quantity removes the level");
        let m = message(
            r#"{"channel":"orderbook","market":1,"orderCount":1,"price":74992000000,"side":"ask","totalQuantity":1336,"type":"update"}"#,
        );
        assert!(matches!(
            m,
            WsMessage::OrderbookUpdate {
                side: Side::Sell,
                ..
            }
        ));
    }

    #[test]
    fn control_frames() {
        assert!(matches!(parse(r#"{"id":5,"type":"pong"}"#), Parsed::Pong));
        assert!(matches!(
            parse(r#"{"channel":"orderbook","id":1,"type":"subscribed"}"#),
            Parsed::Ignore
        ));
        let m = message(
            r#"{"channel":"accountEvents","code":401,"error":"unauthorized: provide X-Api-Key or signed account auth","id":3,"type":"error"}"#,
        );
        assert!(matches!(
            m,
            WsMessage::Refused {
                code: Some(401),
                id: Some(3),
                ..
            }
        ));
    }

    #[test]
    fn trade_with_decimal_strings() {
        let m = message(
            r#"{"channel":"trades","type":"trade","market":1,"fillId":"375779","makerSide":"sell","price":"74737000000","quantity":"1","payload":{}}"#,
        );
        let WsMessage::Trade(t) = m else {
            panic!("{m:?}")
        };
        assert_eq!(t.fill_id, 375_779);
        assert_eq!(t.maker_side, Side::Sell);
        assert_eq!(t.price, 74_737_000_000);
    }

    #[test]
    fn account_snapshot_decodes_the_wire_account() {
        // An account never credited: AccountInfo all zero / empty.
        let m = message(
            r#"{"channel":"accountEvents","type":"snapshot","owner":"bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9","account":{"data":"mgCQAAAAAJAAAAA="},"height":10869421,"snapshot":"initial"}"#,
        );
        let WsMessage::AccountSnapshot {
            account, height, ..
        } = m
        else {
            panic!("{m:?}")
        };
        assert_eq!(account.balance, 0);
        assert_eq!(height, Some(10_869_421));
    }

    #[test]
    fn account_events_arrive_typed_with_the_raw_payload_kept() {
        let m = message(
            r#"{"channel":"accountEvents","type":"orderUpdate","eventType":"order_cancelled","owner":"bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9","height":7,"txHash":"AB","payload":{"client_order_id":"9","filled_quantity":"1","market":"1","order_id":"3211376","original_quantity":"260","owner":"bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9","reason":"user_requested","remaining_quantity":"259"}}"#,
        );
        let WsMessage::AccountEvent(e) = m else {
            panic!("{m:?}")
        };
        assert_eq!((e.event_type.as_str(), e.height), ("order_cancelled", 7));
        let crate::AccountEventKind::OrderCancelled(c) = &e.kind else {
            panic!("{:?}", e.kind)
        };
        assert_eq!((c.order_id, c.client_order_id), (3_211_376, Some(9)));
        assert_eq!(e.payload["reason"], "user_requested");

        // A payload that does not match its event stays raw rather than mistyped.
        let m = message(
            r#"{"channel":"accountEvents","type":"fill","eventType":"trade_executed","owner":"bdae2ddf5bde1e6a5be62bcd9e008106fca6dfd9","height":8,"payload":{"price":"1"}}"#,
        );
        let WsMessage::AccountEvent(e) = m else {
            panic!("{m:?}")
        };
        assert_eq!(e.kind, crate::AccountEventKind::Other);
    }

    #[test]
    fn garbage_is_reported_not_dropped() {
        assert!(matches!(message("{"), WsMessage::Malformed { .. }));
        assert!(matches!(
            message(r#"{"channel":"orderbook","type":"update","market":1}"#),
            WsMessage::Malformed { .. }
        ));
    }

    #[test]
    fn account_auth_signs_the_gateway_layout() {
        let signer = Arc::new(proof_trading_sdk::LocalSigner::from_bytes(&[5; 32]));
        let auth = AccountAuth::new(signer.clone(), "exchange-devnet-1");
        let owner = Address::from_public_key(&signer.public_key());
        let p = auth.params(owner).unwrap();
        let ts = p["timestamp_ms"].as_u64().unwrap();

        let mut msg = b"ProofExchange-account-events-v1".to_vec();
        msg.extend_from_slice(&proof_trading_sdk::crypto::chain_id_from_string(
            "exchange-devnet-1",
        ));
        msg.extend_from_slice(owner.to_string().as_bytes());
        msg.extend_from_slice(&0_i64.to_be_bytes());
        msg.extend_from_slice(&ts.to_be_bytes());
        let expected = signer.try_sign(&msg).unwrap();
        assert_eq!(p["signature"], hex(&expected));
        assert_eq!(p["public_key"], hex(&signer.public_key()));
    }

    #[test]
    fn ws_url_follows_the_gateway() {
        let c = WsConfig::from_client_config(&ClientConfig::devnet()).unwrap();
        assert_eq!(c.url, "wss://api.dev.proof.trade/ws");
        let c = WsConfig::from_client_config(&ClientConfig::new("http://127.0.0.1:9080/")).unwrap();
        assert_eq!(c.url, "ws://127.0.0.1:9080/ws");
    }
}
