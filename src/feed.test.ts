import { beforeEach, describe, expect, it } from "vitest";
import { GatewayFeed, type WebSocketLike } from "./feed.js";

/** In-memory WebSocket double: records sent frames, exposes hooks to drive
 *  open/message/close from the "server" side. */
class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  static last(): FakeWS {
    const ws = FakeWS.instances.at(-1);
    if (!ws) throw new Error("no FakeWS constructed");
    return ws;
  }

  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(
    public url: string,
    public options?: unknown,
  ) {
    FakeWS.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  // -- server-side drivers --
  open(): void {
    this.onopen?.({});
  }
  emit(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  /** Unexpected drop (handlers still attached). */
  drop(): void {
    this.onclose?.({});
  }

  sentMsgs(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

/** Deterministic timer queue — FIFO, flushed manually by the test. */
class FakeClock {
  private timers = new Map<number, () => void>();
  private id = 1;

  set = (fn: () => void): unknown => {
    const handle = this.id++;
    this.timers.set(handle, fn);
    return handle;
  };
  clear = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
  /** Run the earliest-scheduled pending timer. */
  runNext(): void {
    const next = [...this.timers.entries()][0];
    if (!next) throw new Error("no pending timer");
    this.timers.delete(next[0]);
    next[1]();
  }
  get pending(): number {
    return this.timers.size;
  }
}

function makeFeed(over: Record<string, unknown> = {}) {
  const clock = new FakeClock();
  const feed = new GatewayFeed({
    url: "wss://gw.test/ws",
    WebSocketImpl: FakeWS as unknown as new (u: string) => WebSocketLike,
    setTimeoutImpl: clock.set,
    clearTimeoutImpl: clock.clear,
    pingIntervalMs: 0, // heartbeat off unless a test opts in
    ...over,
  });
  return { feed, clock };
}

beforeEach(() => {
  FakeWS.instances = [];
});

describe("GatewayFeed", () => {
  it("connects lazily and sends a well-formed subscribe", () => {
    const { feed } = makeFeed();
    const frames: unknown[] = [];
    feed.subscribeOrderbook(1, (f) => frames.push(f));

    const ws = FakeWS.last();
    expect(ws.url).toBe("wss://gw.test/ws");
    ws.open();

    expect(ws.sentMsgs()[0]).toEqual({
      method: "subscribe",
      id: 1,
      params: { channel: "orderbook", market: 1 },
    });
    expect(feed.connectionState).toBe("open");
  });

  it("routes data frames to the owning subscription only", () => {
    const { feed } = makeFeed();
    const m1: unknown[] = [];
    const m2: unknown[] = [];
    feed.subscribeOrderbook(1, (f) => m1.push(f));
    feed.subscribeOrderbook(2, (f) => m2.push(f));
    FakeWS.last().open();

    FakeWS.last().emit({
      channel: "orderbook",
      type: "snapshot",
      market: 1,
      bids: [],
      asks: [],
    });
    FakeWS.last().emit({
      channel: "orderbook",
      type: "update",
      market: 2,
      side: "buy",
      price: 100,
      totalQuantity: 1,
      orderCount: 1,
    });

    expect(m1).toHaveLength(1);
    expect(m2).toHaveLength(1);
    expect((m1[0] as { market: number }).market).toBe(1);
  });

  it("unsubscribes the last listener and closes the idle socket", () => {
    const { feed } = makeFeed();
    const dispose = feed.subscribeTrades(7, () => {});
    const ws = FakeWS.last();
    ws.open();

    dispose();

    expect(ws.sentMsgs().some((m) => m.method === "unsubscribe")).toBe(true);
    expect(ws.closed).toBe(true);
    expect(feed.connectionState).toBe("closed");
    expect(feed.subscriptionCount).toBe(0);
  });

  it("unsubscribes a channel by key, dropping all its listeners", () => {
    const { feed } = makeFeed();
    feed.subscribeOrderbook(1, () => {});
    feed.subscribeOrderbook(1, () => {}); // two listeners, one channel
    const ws = FakeWS.last();
    ws.open();

    expect(feed.subscriptionCount).toBe(1);
    const removed = feed.unsubscribeOrderbook(1);

    expect(removed).toBe(true);
    expect(ws.sentMsgs().some((m) => m.method === "unsubscribe")).toBe(true);
    expect(feed.subscriptionCount).toBe(0);
    expect(feed.connectionState).toBe("closed"); // last sub gone → socket closed
  });

  it("unsubscribe returns false when nothing matches", () => {
    const { feed } = makeFeed();
    feed.subscribeOrderbook(1, () => {});
    FakeWS.last().open();
    expect(feed.unsubscribeTrades(1)).toBe(false);
    expect(feed.unsubscribeOrderbook(2)).toBe(false);
    expect(feed.subscriptionCount).toBe(1);
  });

  it("reconnects on an unexpected drop and replays subscriptions", () => {
    const { feed, clock } = makeFeed();
    feed.subscribeOrderbook(1, () => {});
    const ws1 = FakeWS.last();
    ws1.open();
    expect(FakeWS.instances).toHaveLength(1);

    ws1.drop(); // server-side close
    expect(feed.connectionState).toBe("reconnecting");

    clock.runNext(); // backoff elapses → reconnect
    expect(FakeWS.instances).toHaveLength(2);
    const ws2 = FakeWS.last();
    ws2.open();

    // Subscription replayed on the fresh socket.
    expect(ws2.sentMsgs()[0]).toMatchObject({
      method: "subscribe",
      params: { channel: "orderbook", market: 1 },
    });
    expect(feed.connectionState).toBe("open");
  });

  it("heartbeat: a missing pong forces a reconnect", () => {
    const { feed, clock } = makeFeed({
      pingIntervalMs: 1000,
      pongTimeoutMs: 500,
    });
    feed.subscribeOrderbook(1, () => {});
    const ws = FakeWS.last();
    ws.open(); // schedules first ping

    clock.runNext(); // ping fires
    expect(ws.sentMsgs().some((m) => m.method === "ping")).toBe(true);

    clock.runNext(); // pong-timeout fires (no pong arrived)
    expect(ws.closed).toBe(true);
    expect(feed.connectionState).toBe("reconnecting");
  });

  it("heartbeat: a pong clears the timeout and keeps the socket open", () => {
    const { feed, clock } = makeFeed({
      pingIntervalMs: 1000,
      pongTimeoutMs: 500,
    });
    feed.subscribeOrderbook(1, () => {});
    const ws = FakeWS.last();
    ws.open();

    clock.runNext(); // ping fires
    const ping = ws.sentMsgs().find((m) => m.method === "ping")!;
    ws.emit({ type: "pong", id: ping.id });

    expect(feed.connectionState).toBe("open");
    expect(ws.closed).toBe(false);
  });

  it("delivers an error frame to the subscription it was rejected for", () => {
    const { feed } = makeFeed();
    const got: unknown[] = [];
    feed.subscribeAccount("AABBCCDDEEFF00112233445566778899AABBCCDD", (f) =>
      got.push(f),
    );
    const ws = FakeWS.last();
    ws.open();

    const subId = ws.sentMsgs()[0].id;
    ws.emit({
      type: "error",
      id: subId,
      channel: "accountEvents",
      code: 401,
      error: "unauthorized",
    });

    expect(got).toHaveLength(1);
    expect((got[0] as { error: string }).error).toBe("unauthorized");
  });

  it("normalises account owner to lower-hex in the subscribe params", () => {
    const { feed } = makeFeed();
    feed.subscribeAccount("AABBCCDDEEFF00112233445566778899AABBCCDD", () => {});
    const ws = FakeWS.last();
    ws.open();
    expect((ws.sentMsgs()[0].params as { owner: string }).owner).toBe(
      "aabbccddeeff00112233445566778899aabbccdd",
    );
  });
});

describe("feed ownership and cleanup", () => {
  it("keeps identical callback references independently subscribed", () => {
    const { feed } = makeFeed();
    const frames: unknown[] = [];
    const onFrame = (frame: unknown) => frames.push(frame);
    const first = feed.subscribeTrades(1, onFrame);
    const second = feed.subscribeTrades(1, onFrame);
    const ws = FakeWS.last();
    ws.open();
    first();
    first();
    expect(feed.subscriptionCount).toBe(1);
    ws.emit({ channel: "trades", market: 1, type: "trade", fillId: "a" });
    expect(frames).toHaveLength(1);
    second();
    expect(ws.closed).toBe(true);
  });
  it("an obsolete disposer cannot tear down a replacement subscription", () => {
    const { feed } = makeFeed();
    const old = feed.subscribeTrades(1, () => {});
    feed.unsubscribeTrades(1);
    feed.subscribeTrades(1, () => {});
    old();
    expect(feed.subscriptionCount).toBe(1);
    feed.close();
  });
  it("isolates accounts and prevents auth params from replacing owner", () => {
    const { feed, clock } = makeFeed();
    const a: unknown[] = [],
      b: unknown[] = [];
    const unsub = feed.subscribeAccount("AA", (f) => a.push(f), {
      owner: "BB",
    });
    feed.subscribeAccount("BB", (f) => b.push(f));
    const ws = FakeWS.last();
    ws.open();
    ws.emit({
      channel: "accountEvents",
      type: "snapshot",
      owner: "aa",
      account: {},
    });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
    unsub();
    ws.drop();
    clock.runNext();
    const replacement = FakeWS.last();
    replacement.open();
    const params = replacement.sent.map((s) => JSON.parse(s).params);
    expect(params).toEqual([{ channel: "accountEvents", owner: "bb" }]);
    ws.emit({ channel: "accountEvents", type: "fill", owner: "bb" });
    expect(b).toHaveLength(0);
    replacement.emit({ channel: "accountEvents", type: "fill", owner: "bb" });
    expect(b).toHaveLength(1);
    feed.close();
    expect(clock.pending).toBe(0);
  });
  it("cleans pending reconnect and heartbeat timers on close", () => {
    const { feed, clock } = makeFeed({ pingIntervalMs: 10, pongTimeoutMs: 30 });
    feed.subscribeTrades(1, () => {});
    const ws = FakeWS.last();
    ws.open();
    clock.runNext(); // ping
    feed.close();
    expect(clock.pending).toBe(0);
    expect(ws.onmessage).toBeNull();
    feed.subscribeTrades(1, () => {});
    FakeWS.last().drop();
    expect(clock.pending).toBe(1);
    feed.close();
    expect(clock.pending).toBe(0);
  });
  it("ignores non-object frames and keeps channel payloads untouched", () => {
    const { feed } = makeFeed();
    const frames: unknown[] = [];
    feed.subscribeOrderbook(1, (f) => frames.push(f));
    const ws = FakeWS.last();
    ws.open();
    ws.emit(null);
    ws.emit([]);
    const delta = {
      channel: "orderbook",
      type: "update",
      market: 1,
      side: "buy",
      price: 50123456,
      totalQuantity: 0,
      orderCount: 0,
    };
    ws.emit(delta);
    expect(frames).toEqual([delta]);
    feed.close();
  });
});
