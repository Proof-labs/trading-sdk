import type {
  AccountFrame,
  FeedChannel,
  FeedErrorFrame,
  FeedFrame,
  FeedOrderbookLevel,
  FeedState,
  OrderbookFrame,
  OrderbookSnapshotFrame,
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
  /** Orderbook only: the book this socket's snapshot and updates have built,
   *  or null until the first snapshot after (re)connecting. */
  book: LocalBook | null;
  /** Listeners that joined an active orderbook or accountEvents channel and
   *  have not had a snapshot yet. They receive no update or event before one. */
  awaitingSnapshot: Set<FrameHandler>;
  /** Events that arrived for an awaiting accountEvents listener before its
   *  snapshot: delivered if its release brings no snapshot, dropped if it
   *  does (the snapshot covers them). */
  pendingEvents: Map<FrameHandler, FeedFrame[]>;
  /** accountEvents only: a subscribe that brings a snapshot is in flight, so
   *  further late listeners wait for it instead of sending another. */
  resendPending: boolean;
  /** The gateway acknowledged or served this subscription on the current
   *  socket, so it exists there. */
  confirmed: boolean;
  /** accountEvents only: a snapshot has arrived on the current socket, so a
   *  later one is a resend for the listeners waiting on it. */
  snapshotOnSocket: boolean;
  /** Pending retry of a first subscribe whose authentication failed. */
  retryTimer: unknown;
  /** Consecutive failed authentications, for the retry backoff and its
   *  `MAX_AUTH_RETRIES` cap. Reset on confirmation and on socket replacement. */
  retryAttempts: number;
}

/** Price → `[totalQuantity, orderCount]`, per side. */
interface LocalBook {
  market: number;
  bids: Map<number, [number, number]>;
  asks: Map<number, [number, number]>;
}

const CONTROL_TYPES = new Set(["subscribed", "unsubscribed", "pong", "error"]);

/** Gateway refusal codes of an account subscribe that a retry can pass. */
const RETRYABLE_REFUSALS = new Set([401, 429, 503]);

/** Consecutive failed authentications after which a first subscribe stops
 *  being retried: a deterministic failure (the signer's key is not the
 *  account's key) would otherwise retry for ever. */
const MAX_AUTH_RETRIES = 5;

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
 *   - **late listeners** — the gateway sends one snapshot per socket
 *     subscription. A listener that joins an active `orderbook` channel
 *     receives a snapshot of the book the feed has built; one that joins an
 *     active `accountEvents` channel re-subscribes, and the gateway resends
 *     the account snapshot. Neither sees an update or event before its
 *     snapshot. A gateway too old to resend leaves the account listener on
 *     the live events, as before.
 *   - **subscribe retry** — when signing an account subscribe fails, or the
 *     gateway refuses it with 401, 429 or 503, and the channel has no
 *     subscription on the socket, listeners get an `error` frame and the
 *     subscribe is retried with the reconnect backoff. After
 *     `MAX_AUTH_RETRIES` consecutive failures it gives up with one final
 *     `error` frame; a replaced socket starts a fresh retry budget.
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
      // The gateway sends a snapshot once per socket subscription, so a late
      // orderbook listener is given one built from the local book. Delivered
      // after `subscribe` returns, never inside it.
      if (record.channel === "orderbook") {
        const joined = record;
        joined.awaitingSnapshot.add(listener);
        queueMicrotask(() => this.primeLateListener(key, joined, listener));
      } else if (record.channel === "accountEvents") {
        // Account events cannot be rebuilt locally, so a repeat subscribe
        // asks the gateway to resend the account snapshot. Closed or
        // reconnecting, the replay on open brings a snapshot anyway. One
        // resend in flight serves every listener that joins while it is
        // pending: its snapshot releases them all.
        record.awaitingSnapshot.add(listener);
        // A pending retry brings the first snapshot, which releases it.
        if (
          this.state === "open" &&
          !record.resendPending &&
          record.retryTimer == null
        )
          this.sendSubscribe(record);
      }
    } else {
      record = {
        channel,
        params,
        listeners: new Set([listener]),
        lastId: 0,
        auth,
        generation: 0,
        book: null,
        awaitingSnapshot: new Set(),
        pendingEvents: new Map(),
        resendPending: false,
        confirmed: false,
        snapshotOnSocket: false,
        retryTimer: null,
        retryAttempts: 0,
      };
      this.subs.set(key, record);
      this.ensureConnected();
      if (this.state === "open") this.sendSubscribe(record);
    }

    return () => {
      const r = this.subs.get(key);
      if (!r || r !== record) return;
      r.listeners.delete(listener);
      r.awaitingSnapshot.delete(listener);
      r.pendingEvents.delete(listener);
      if (r.listeners.size === 0) this.dropRecord(key, r);
    };
  }

  /** Remove a subscription record: emit the wire `unsubscribe` when open, and
   *  close the socket once the last subscription is gone. Shared by the
   *  per-listener disposer and the by-key `unsubscribe*` methods. */
  private dropRecord(key: string, record: SubRecord): void {
    this.cancelRetry(record);
    this.subs.delete(key);
    if (this.state === "open") this.sendUnsubscribe(record);
    if (this.subs.size === 0) this.close();
  }

  /** Tear down the socket and all subscriptions. Suppresses reconnect until
   *  the next `subscribe`. Idempotent. */
  close(): void {
    this.closedByUser = true;
    for (const record of this.subs.values()) this.cancelRetry(record);
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
      this.forgetBooks();
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
    this.forgetBooks();
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
    if (record.channel === "accountEvents") record.resendPending = true;
    const key = subKey(record.channel, record.params);
    const active = () =>
      this.ws === socket &&
      this.state === "open" &&
      this.subs.get(key) === record &&
      record.generation === generation;
    const send = (auth: object = {}) => {
      if (!active()) return;
      record.lastId = this.nextId++;
      const sent = this.send({
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
      if (!sent) this.releaseAwaiting(record);
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
        // No subscribe goes out, so no snapshot comes back on this socket.
        this.authFailed(
          record,
          err instanceof Error ? err : new Error(String(err)),
        );
      });
  }

  private sendUnsubscribe(record: SubRecord): void {
    this.send({
      method: "unsubscribe",
      id: this.nextId++,
      params: { channel: record.channel, ...record.params },
    });
  }

  /** False when there is no socket or the send threw. */
  private send(msg: unknown): boolean {
    if (!this.ws) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      return false;
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

    if (type === "subscribed") {
      this.handleSubscribed(msg);
      return;
    }

    if (type && CONTROL_TYPES.has(type)) {
      // "unsubscribed" acks — no listener action needed.
      return;
    }

    // Data frame: route by channel + key to the owning subscription.
    const channel = msg.channel as FeedChannel | undefined;
    if (!channel) return;
    const key = subKey(channel, msg);
    const record = this.subs.get(key);
    if (!record) return;
    this.confirm(record);
    if (record.channel === "orderbook") applyToBook(record, msg);
    // A second account snapshot on one socket is a resend a late listener
    // asked for: only the listeners waiting on a snapshot take it.
    const resent =
      record.channel === "accountEvents" &&
      msg.type === "snapshot" &&
      record.snapshotOnSocket;
    if (record.channel === "accountEvents" && msg.type === "snapshot")
      record.snapshotOnSocket = true;
    // A snapshot means the subscribe that brings it has landed, so a further
    // late listener sends a fresh resend.
    if (record.channel === "accountEvents" && msg.type === "snapshot")
      record.resendPending = false;
    for (const listener of record.listeners) {
      if (resent && !record.awaitingSnapshot.has(listener)) continue;
      if (record.awaitingSnapshot.has(listener)) {
        if (msg.type === "snapshot") {
          record.awaitingSnapshot.delete(listener);
          // The snapshot covers them, so the events a waiting listener held
          // are dropped with it.
          record.pendingEvents.delete(listener);
        } else {
          // An orderbook update is already in the local book, so the snapshot
          // built from it replaces the update. An account event is held until
          // the snapshot arrives; if none does, release delivers the held
          // events so the fallback loses nothing.
          if (record.channel === "orderbook") {
            this.primeFromBook(record, listener);
          } else {
            const frame = msg as unknown as FeedFrame;
            const held = record.pendingEvents.get(listener);
            if (held) held.push(frame);
            else record.pendingEvents.set(listener, [frame]);
          }
          continue;
        }
      }
      this.deliver(listener, msg as unknown as FeedFrame);
    }
  }

  /** A gateway that predates resending (its repeat ack has no
   *  `snapshot: "resent"`) sends no snapshot, so waiting account listeners
   *  are released to the live events instead of waiting for ever. */
  private handleSubscribed(msg: Record<string, unknown>): void {
    const record = this.recordForId(msg.id);
    if (record) this.confirm(record);
    if (msg.note !== "already subscribed" || msg.snapshot === "resent") return;
    if (record) this.releaseAwaiting(record);
  }

  private confirm(record: SubRecord): void {
    record.confirmed = true;
    record.retryAttempts = 0;
    this.cancelRetry(record);
  }

  /** Account listeners waiting on a snapshot that will not come take the
   *  live events instead, as before the gateway could resend one: the events
   *  held while they waited are delivered first, in order. Orderbook
   *  listeners never wait on the gateway once a local book exists. */
  private releaseAwaiting(record: SubRecord): void {
    if (record.channel !== "accountEvents") return;
    // No snapshot is coming for these listeners; the next one to join sends
    // a fresh subscribe.
    record.resendPending = false;
    for (const listener of record.awaitingSnapshot) {
      const held = record.pendingEvents.get(listener);
      if (held) for (const frame of held) this.deliver(listener, frame);
    }
    record.awaitingSnapshot.clear();
    record.pendingEvents.clear();
  }

  private recordForId(id: unknown): SubRecord | undefined {
    if (typeof id !== "number") return undefined;
    for (const record of this.subs.values()) {
      if (record.lastId === id) return record;
    }
    return undefined;
  }

  private deliver(listener: FrameHandler, frame: FeedFrame): void {
    try {
      listener(frame);
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private primeLateListener(
    key: string,
    record: SubRecord,
    listener: FrameHandler,
  ): void {
    if (this.subs.get(key) !== record) return;
    if (!record.awaitingSnapshot.has(listener)) return;
    this.primeFromBook(record, listener);
  }

  /** Give an awaiting listener a snapshot of the local book. With no book yet
   *  it keeps waiting for the gateway's own snapshot. */
  private primeFromBook(record: SubRecord, listener: FrameHandler): void {
    if (!record.book) return;
    record.awaitingSnapshot.delete(listener);
    this.deliver(listener, bookSnapshot(record.book));
  }

  /** A new socket starts from the gateway's next snapshot, never from a book
   *  the old socket built. The subscribe in flight died with the socket; the
   *  replay on open sends a fresh one. */
  private forgetBooks(): void {
    for (const record of this.subs.values()) {
      record.book = null;
      record.resendPending = false;
      record.confirmed = false;
      record.snapshotOnSocket = false;
      // The next socket's replay subscribes afresh, with a fresh retry
      // budget: the failures on the dead socket were not consecutive with
      // whatever the new socket brings.
      record.retryAttempts = 0;
      this.cancelRetry(record);
    }
  }

  private cancelRetry(record: SubRecord): void {
    if (record.retryTimer != null) {
      this.clearTimer(record.retryTimer);
      record.retryTimer = null;
    }
  }

  /**
   * The authentication for a subscribe failed. When the channel already has a
   * subscription on this socket (a repeat for a late listener), live delivery
   * goes on. Otherwise nothing is subscribed while the socket stays healthy,
   * so the failure goes to the listeners as an `error` frame and the
   * subscribe is retried with the reconnect backoff until it succeeds, the
   * subscription is dropped, the retry budget runs out, or the socket is
   * replaced.
   */
  private authFailed(record: SubRecord, err: Error): void {
    this.releaseAwaiting(record);
    this.onError?.(err);
    if (record.confirmed) return;
    if (record.retryAttempts >= MAX_AUTH_RETRIES) {
      this.giveUpRetrying(
        record,
        `${record.channel} subscription authentication failed: ${err.message}; not retrying after ${MAX_AUTH_RETRIES} failed attempts`,
      );
      return;
    }
    const delay = this.scheduleRetry(record);
    const frame: FeedErrorFrame = {
      type: "error",
      channel: record.channel,
      error: `${record.channel} subscription authentication failed: ${err.message}; retrying in ${delay}ms`,
    };
    for (const listener of record.listeners)
      this.deliver(listener, frame as unknown as FeedFrame);
  }

  /** The subscribe retry budget is spent: tell the listeners once and leave
   *  the subscription unconfirmed but quiet. A replaced socket replays it
   *  with a fresh budget. */
  private giveUpRetrying(record: SubRecord, reason: string): void {
    const frame: FeedErrorFrame = {
      type: "error",
      channel: record.channel,
      error: reason,
    };
    for (const listener of record.listeners)
      this.deliver(listener, frame as unknown as FeedFrame);
  }

  /** Subscribe again after the reconnect backoff, on this socket only, while
   *  the subscription is still unconfirmed. Returns the delay. */
  private scheduleRetry(record: SubRecord): number {
    const delay = Math.min(
      this.maxBackoffMs,
      this.minBackoffMs * 2 ** record.retryAttempts,
    );
    record.retryAttempts += 1;
    const socket = this.ws;
    const key = subKey(record.channel, record.params);
    this.cancelRetry(record);
    record.retryTimer = this.setTimer(() => {
      record.retryTimer = null;
      if (
        this.ws === socket &&
        this.state === "open" &&
        this.subs.get(key) === record &&
        !record.confirmed
      )
        this.sendSubscribe(record);
    }, delay);
    return delay;
  }

  private dispatchError(frame: FeedErrorFrame): void {
    // Route to the subscription whose last subscribe carried this id, so a
    // rejected channel surfaces against the right caller.
    const record = this.recordForId(frame.id);
    if (record) {
      // Deliver as a frame the subscriber can pattern-match on `type`.
      for (const listener of record.listeners) {
        this.deliver(listener, frame as unknown as FeedFrame);
      }
      // A refused repeat subscribe (the resent account snapshot could not be
      // read) brings no snapshot: the waiting listeners take the live events.
      this.releaseAwaiting(record);
      // A refused first account subscribe leaves nothing subscribed on a
      // healthy socket. An expired signature (401), a rate limit (429) or an
      // unreadable snapshot (503) can pass, so it is retried; the listeners
      // already have the gateway's error frame. Once the retry budget has
      // run out the refusals repeat for ever, so it stops with one final
      // error frame.
      if (
        record.channel === "accountEvents" &&
        !record.confirmed &&
        RETRYABLE_REFUSALS.has(frame.code ?? 0)
      ) {
        if (record.retryAttempts >= MAX_AUTH_RETRIES)
          this.giveUpRetrying(
            record,
            `${record.channel} subscription refused (${frame.code}): ${frame.error}; not retrying after ${MAX_AUTH_RETRIES} failed attempts`,
          );
        else this.scheduleRetry(record);
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

/** Fold an orderbook data frame into the record's local book. A snapshot
 *  replaces it; an update sets one level, and a zero quantity removes it. */
function applyToBook(record: SubRecord, msg: Record<string, unknown>): void {
  if (msg.type === "snapshot") {
    record.book = {
      market: Number(msg.market),
      bids: levelMap(msg.bids),
      asks: levelMap(msg.asks),
    };
    return;
  }
  const book = record.book;
  if (msg.type !== "update" || !book) return;
  const side =
    msg.side === "buy" ? book.bids : msg.side === "sell" ? book.asks : null;
  const { price, totalQuantity, orderCount } = msg;
  if (
    !side ||
    typeof price !== "number" ||
    typeof totalQuantity !== "number" ||
    typeof orderCount !== "number"
  ) {
    return;
  }
  if (totalQuantity === 0) side.delete(price);
  else side.set(price, [totalQuantity, orderCount]);
}

function levelMap(levels: unknown): Map<number, [number, number]> {
  const map = new Map<number, [number, number]>();
  if (!Array.isArray(levels)) return map;
  for (const level of levels) {
    if (!Array.isArray(level)) continue;
    const [price, totalQuantity, orderCount] = level as unknown[];
    if (
      typeof price === "number" &&
      typeof totalQuantity === "number" &&
      typeof orderCount === "number"
    ) {
      map.set(price, [totalQuantity, orderCount]);
    }
  }
  return map;
}

/** The local book as the gateway orders a snapshot: best price first. */
function bookSnapshot(book: LocalBook): OrderbookSnapshotFrame {
  const levels = (
    side: Map<number, [number, number]>,
    bestFirst: (a: number, b: number) => number,
  ): FeedOrderbookLevel[] =>
    [...side.entries()]
      .sort(([a], [b]) => bestFirst(a, b))
      .map(([price, [totalQuantity, orderCount]]) => [
        price,
        totalQuantity,
        orderCount,
      ]);
  return {
    channel: "orderbook",
    type: "snapshot",
    market: book.market,
    bids: levels(book.bids, (a, b) => b - a),
    asks: levels(book.asks, (a, b) => a - b),
  };
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
