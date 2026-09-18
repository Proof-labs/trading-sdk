import type {
  AccountFrame,
  FeedChannel,
  FeedErrorFrame,
  FeedFrame,
  FeedState,
  OrderbookFrame,
  TradeFrame,
} from "./feed-types.js";

/**
 * Minimal structural view of a WebSocket the feed needs. Both the browser
 * `WebSocket` and Node's `ws` package satisfy this via the `onmessage`
 * setter API.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Constructs a {@link WebSocketLike}. `options` is passed as the second
 *  argument when present (Node `ws` accepts `{ headers }`); browsers ignore
 *  it because we only forward options to an injected implementation. */
export type WebSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocketLike;

/** Existing signed account-subscription wire fields. */
export interface AccountFeedAuth {
  public_key: string;
  signature: string;
  timestamp_ms: number;
  after_id?: number;
}
/** An empty result explicitly selects an unsigned subscription on open gateways. */
export type AccountAuthProvider = (
  owner: string,
) => Promise<AccountFeedAuth | Record<string, never>>;

export interface GatewayFeedOptions {
  /** Called on every account subscribe/reconnect; stale async completions are discarded. */
  accountAuth?: AccountAuthProvider;
  /** Feed URL, e.g. `wss://api.dev.proof.trade/ws`. */
  url: string;
  /** Upgrade headers (e.g. `{ "X-Api-Key": key }`). Only applied when a
   *  custom `webSocketFactory`/`WebSocketImpl` is supplied — the global
   *  browser `WebSocket` has no header support and is constructed bare. */
  headers?: Record<string, string>;
  /** App-level ping cadence in ms; 0 disables the heartbeat. Default 15000. */
  pingIntervalMs?: number;
  /** Reconnect if no `pong` arrives within this many ms of a ping. Default 10000. */
  pongTimeoutMs?: number;
  /** First reconnect backoff in ms, doubled each attempt up to `maxBackoffMs`. */
  minBackoffMs?: number;
  /** Backoff ceiling in ms. Default 10000. */
  maxBackoffMs?: number;
  /** Inject a WebSocket implementation (Node `ws`, or a fake in tests). */
  WebSocketImpl?: new (url: string, options?: unknown) => WebSocketLike;
  /** Full control over socket construction; takes precedence over `WebSocketImpl`. */
  webSocketFactory?: WebSocketFactory;
  /** Schedule a timer; injectable for deterministic tests. Defaults to `setTimeout`. */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  /** Errors not tied to a single subscription (transport, unparseable frames,
   *  errors whose `id` matched no live subscription). */
  onError?: (err: FeedErrorFrame | Error) => void;
  /** Connection lifecycle transitions. */
  onStateChange?: (state: FeedState) => void;
}

/** Handler for a channel's data frames; narrowed per `subscribe*` helper. */
type FrameHandler = (frame: FeedFrame) => void;

interface SubRecord {
  channel: FeedChannel;
  /** Wire params (already snake_cased), spread into the subscribe message. */
  params: Record<string, unknown>;
  listeners: Set<FrameHandler>;
  /** `id` of the most recent subscribe message — correlates error frames. */
  lastId: number;
  auth?: AccountAuthProvider;
  generation: number;
}

const CONTROL_TYPES = new Set(["subscribed", "unsubscribed", "pong", "error"]);

/**
 * Lifecycle manager for the gateway's multiplexed `/ws` feed.
 *
 * One socket carries every channel. The class owns the full lifecycle so
 * callers only deal with subscriptions:
 *
 *   - **lazy connect** — the socket opens on the first `subscribe` and closes
 *     when the last subscription is disposed.
 *   - **auto-reconnect** — on an unexpected close it reconnects with
 *     exponential backoff and **replays every active subscription**, so a
 *     fresh snapshot arrives. Missed live events are not replayed.
 *   - **heartbeat** — an app-level `ping` runs on an interval; a missing
 *     `pong` forces a reconnect, catching half-open sockets the OS hasn't
 *     torn down.
 *
 * `subscribe` returns a disposer; the socket is reference-counted across all
 * subscriptions. Construct via {@link ExchangeClient.feed} rather than
 * directly so URL/auth derive from the client.
 */
export class GatewayFeed {
  private readonly accountAuth?: AccountAuthProvider;
  private readonly url: string;
  private readonly headers?: Record<string, string>;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly factory: WebSocketFactory;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onError?: (err: FeedErrorFrame | Error) => void;
  private readonly onStateChange?: (state: FeedState) => void;

  private ws: WebSocketLike | null = null;
  private state: FeedState = "closed";
  private nextId = 1;
  private readonly subs = new Map<string, SubRecord>();

  /** True between `close()` and the next `subscribe` — suppresses reconnect. */
  private closedByUser = false;
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  private awaitingPong = false;

  constructor(opts: GatewayFeedOptions) {
    this.accountAuth = opts.accountAuth;
    this.url = opts.url;
    this.headers = opts.headers;
    this.pingIntervalMs = opts.pingIntervalMs ?? 15_000;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
    this.minBackoffMs = opts.minBackoffMs ?? 500;
    this.maxBackoffMs = opts.maxBackoffMs ?? 10_000;
    this.setTimer = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimeoutImpl ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onError = opts.onError;
    this.onStateChange = opts.onStateChange;
    this.factory = opts.webSocketFactory ?? defaultFactory(opts.WebSocketImpl);
  }

  /** Current connection state. */
  get connectionState(): FeedState {
    return this.state;
  }

  /** Number of distinct active channel subscriptions. */
  get subscriptionCount(): number {
    return this.subs.size;
  }

  // -- public channel helpers ------------------------------------------------

  subscribeOrderbook(
    market: number,
    onFrame: (frame: OrderbookFrame) => void,
  ): () => void {
    return this.subscribe("orderbook", { market }, onFrame as FrameHandler);
  }

  subscribeTrades(
    market: number,
    onFrame: (frame: TradeFrame) => void,
  ): () => void {
    return this.subscribe("trades", { market }, onFrame as FrameHandler);
  }

  /** Subscribe to `accountEvents` for `owner` (lower-hex, 20 bytes). `params`
   *  carries any signed-auth fields already serialised to wire (snake_case). */
  subscribeAccount(
    owner: string,
    onFrame: (frame: AccountFrame) => void,
    authParams: Record<string, unknown> | AccountAuthProvider = {},
  ): () => void {
    return this.subscribe(
      "accountEvents",
      {
        ...(typeof authParams === "function" ? {} : authParams),
        owner: owner.replace(/^0x/i, "").toLowerCase(),
      },
      onFrame as FrameHandler,
      typeof authParams === "function" ? authParams : undefined,
    );
  }

  /**
   * Unsubscribe a whole channel by key, dropping **all** of its listeners —
   * the by-key counterpart to the per-listener disposer returned by
   * `subscribe*`. Returns true if a subscription was present. Sends the wire
   * `unsubscribe` and closes the socket if no subscriptions remain.
   */
  unsubscribeOrderbook(market: number): boolean {
    return this.unsubscribe("orderbook", { market });
  }

  unsubscribeTrades(market: number): boolean {
    return this.unsubscribe("trades", { market });
  }

  unsubscribeAccount(owner: string): boolean {
    return this.unsubscribe("accountEvents", { owner: owner.toLowerCase() });
  }

  /** Low-level unsubscribe by channel + key params (`market` / `owner`). */
  unsubscribe(channel: FeedChannel, params: Record<string, unknown>): boolean {
    const key = subKey(channel, params);
    const record = this.subs.get(key);
    if (!record) return false;
    this.dropRecord(key, record);
    return true;
  }

  /**
   * Low-level subscribe. `params` must use the gateway's wire keys
   * (`market`, `owner`, `public_key`, …). Returns a disposer
   * that drops this listener and unsubscribes the channel when its last
   * listener goes away.
   */
  subscribe(
    channel: FeedChannel,
    params: Record<string, unknown>,
    onFrame: FrameHandler,
    auth?: AccountAuthProvider,
  ): () => void {
    // Each subscription call owns a separate reference, even for the same callback.
    const listener: FrameHandler = (frame) => onFrame(frame);
    const key = subKey(channel, params);
    this.closedByUser = false;

    let record = this.subs.get(key);
    if (record) {
      record.listeners.add(listener);
    } else {
      record = {
        channel,
        params,
        listeners: new Set([listener]),
        lastId: 0,
        auth,
        generation: 0,
      };
      this.subs.set(key, record);
      this.ensureConnected();
      if (this.state === "open") this.sendSubscribe(record);
    }

    return () => {
      const r = this.subs.get(key);
      if (!r || r !== record) return;
      r.listeners.delete(listener);
      if (r.listeners.size === 0) this.dropRecord(key, r);
    };
  }

  /** Remove a subscription record: emit the wire `unsubscribe` when open, and
   *  close the socket once the last subscription is gone. Shared by the
   *  per-listener disposer and the by-key `unsubscribe*` methods. */
  private dropRecord(key: string, record: SubRecord): void {
    this.subs.delete(key);
    if (this.state === "open") this.sendUnsubscribe(record);
    if (this.subs.size === 0) this.close();
  }

  /** Tear down the socket and all subscriptions. Suppresses reconnect until
   *  the next `subscribe`. Idempotent. */
  close(): void {
    this.closedByUser = true;
    this.subs.clear();
    this.clearReconnect();
    this.stopHeartbeat();
    this.teardownSocket();
    this.setState("closed");
  }

  // -- connection lifecycle --------------------------------------------------

  private ensureConnected(): void {
    if (
      this.ws ||
      this.state === "connecting" ||
      this.state === "reconnecting"
    ) {
      return;
    }
    this.connect();
  }

  private connect(): void {
    this.setState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    let ws: WebSocketLike;
    try {
      ws = this.factory(
        this.url,
        this.headers ? { headers: this.headers } : undefined,
      );
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState("open");
      // Replay every active subscription — a reconnect yields fresh snapshots.
      for (const record of this.subs.values()) this.sendSubscribe(record);
      this.startHeartbeat();
    };

    ws.onmessage = (ev) => {
      const text = extractText(ev.data);
      if (text === null) return;
      this.handleMessage(text);
    };

    ws.onerror = (ev) => {
      // Browsers fire `error` then `close`; let `onclose` drive reconnect so
      // we don't double-schedule. Surface a best-effort error for visibility.
      this.onError?.(toError(ev));
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      this.ws = null;
      if (this.closedByUser || this.subs.size === 0) {
        this.setState("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private teardownSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    this.ws = null;
    try {
      ws.close();
    } catch {
      // already closing/closed
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = Math.min(
      this.maxBackoffMs,
      this.minBackoffMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.setState("reconnecting");
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (this.closedByUser || this.subs.size === 0) return;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer != null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // -- heartbeat -------------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.pingIntervalMs <= 0) return;
    this.awaitingPong = false;
    this.pingTimer = this.setTimer(() => this.sendPing(), this.pingIntervalMs);
  }

  private sendPing(): void {
    if (this.state !== "open" || !this.ws || this.awaitingPong) return;
    this.send({ method: "ping", id: this.nextId++ });
    this.awaitingPong = true;
    this.pongTimer = this.setTimer(() => {
      if (this.awaitingPong) {
        // Half-open socket: force a reconnect via teardown.
        this.stopHeartbeat();
        this.teardownSocket();
        if (!this.closedByUser && this.subs.size > 0) this.scheduleReconnect();
        else this.setState("closed");
      }
    }, this.pongTimeoutMs);
    // Re-arm the next ping.
    this.pingTimer = this.setTimer(() => this.sendPing(), this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer != null) this.clearTimer(this.pingTimer);
    if (this.pongTimer != null) this.clearTimer(this.pongTimer);
    this.pingTimer = this.pongTimer = null;
    this.awaitingPong = false;
  }

  // -- messaging -------------------------------------------------------------

  private sendSubscribe(record: SubRecord): void {
    const socket = this.ws;
    const generation = ++record.generation;
    const key = subKey(record.channel, record.params);
    const active = () =>
      this.ws === socket &&
      this.state === "open" &&
      this.subs.get(key) === record &&
      record.generation === generation;
    const send = (auth: object = {}) => {
      if (!active()) return;
      record.lastId = this.nextId++;
      this.send({
        method: "subscribe",
        id: record.lastId,
        params: {
          ...record.params,
          ...auth,
          channel: record.channel,
          ...(record.channel === "accountEvents"
            ? { owner: record.params.owner }
            : {}),
        },
      });
    };
    const provider =
      record.channel === "accountEvents"
        ? (record.auth ?? this.accountAuth)
        : undefined;
    if (!provider) {
      send();
      return;
    }
    // Never send unsigned account params while asynchronous auth is pending.
    void Promise.resolve()
      .then(() => provider(String(record.params.owner)))
      .then(send)
      .catch((err) => {
        if (!active()) return;
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
  }

  private sendUnsubscribe(record: SubRecord): void {
    this.send({
      method: "unsubscribe",
      id: this.nextId++,
      params: { channel: record.channel, ...record.params },
    });
  }

  private send(msg: unknown): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleMessage(text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.onError?.(
        new Error(`feed: unparseable frame: ${text.slice(0, 120)}`),
      );
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
    const type = msg.type as string | undefined;

    if (type === "pong") {
      this.awaitingPong = false;
      if (this.pingTimer != null) this.clearTimer(this.pingTimer);
      if (this.pingIntervalMs > 0)
        this.pingTimer = this.setTimer(
          () => this.sendPing(),
          this.pingIntervalMs,
        );
      if (this.pongTimer != null) {
        this.clearTimer(this.pongTimer);
        this.pongTimer = null;
      }
      return;
    }

    if (type === "error") {
      this.dispatchError(msg as unknown as FeedErrorFrame);
      return;
    }

    if (type && CONTROL_TYPES.has(type)) {
      // "subscribed" / "unsubscribed" acks — no listener action needed.
      return;
    }

    // Data frame: route by channel + key to the owning subscription.
    const channel = msg.channel as FeedChannel | undefined;
    if (!channel) return;
    const key = subKey(channel, msg);
    const record = this.subs.get(key);
    if (!record) return;
    for (const listener of record.listeners) {
      try {
        listener(msg as unknown as FeedFrame);
      } catch (err) {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  private dispatchError(frame: FeedErrorFrame): void {
    // Route to the subscription whose last subscribe carried this id, so a
    // rejected channel surfaces against the right caller.
    if (typeof frame.id === "number") {
      for (const record of this.subs.values()) {
        if (record.lastId === frame.id) {
          // Deliver as a frame the subscriber can pattern-match on `type`.
          for (const listener of record.listeners) {
            try {
              listener(frame as unknown as FeedFrame);
            } catch (err) {
              this.onError?.(
                err instanceof Error ? err : new Error(String(err)),
              );
            }
          }
          this.onError?.(frame);
          return;
        }
      }
    }
    this.onError?.(frame);
  }

  private setState(state: FeedState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Subscription identity. Orderbook/trades key on market; accountEvents on
 *  owner. Derives the same key from an outgoing subscribe and an incoming
 *  data frame so routing is symmetric. */
function subKey(channel: FeedChannel, src: Record<string, unknown>): string {
  if (channel === "accountEvents") {
    return `accountEvents:${String(src.owner ?? "")
      .replace(/^0x/i, "")
      .toLowerCase()}`;
  }
  return `${channel}:${src.market ?? ""}`;
}

function defaultFactory(
  Impl?: new (url: string, options?: unknown) => WebSocketLike,
): WebSocketFactory {
  return (url, options) => {
    const Ctor =
      Impl ??
      (globalThis as { WebSocket?: new (url: string) => WebSocketLike })
        .WebSocket;
    if (!Ctor) {
      throw new Error(
        "GatewayFeed: no WebSocket implementation. Pass WebSocketImpl (e.g. the 'ws' package) when running outside a browser.",
      );
    }
    // Only forward options (headers) to an injected impl; the global browser
    // WebSocket treats a second arg as subprotocols and would mishandle it.
    if (Impl && options) return new Impl(url, options);
    return new Ctor(url);
  };
}

/** Coerce a WebSocket message payload to text. Browser delivers a string;
 *  `ws` may deliver a Buffer/ArrayBuffer for the same text frame. */
function extractText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as ArrayBufferView);
  }
  if (
    data &&
    typeof (data as { toString?: () => string }).toString === "function"
  ) {
    return (data as { toString: () => string }).toString();
  }
  return null;
}

function toError(ev: unknown): Error {
  if (ev instanceof Error) return ev;
  const message =
    ev && typeof ev === "object" && "message" in ev
      ? String((ev as { message: unknown }).message)
      : "feed socket error";
  return new Error(message);
}
