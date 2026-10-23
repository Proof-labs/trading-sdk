import { beforeEach, describe, expect, it } from "vitest";
import type { OrderbookFrame } from "./feed-types.js";
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

const snapshot = (
  bids: Array<[number, number, number]>,
  asks: Array<[number, number, number]>,
) => ({ channel: "orderbook", type: "snapshot", market: 1, bids, asks });
const update = (
  side: "buy" | "sell",
  price: number,
  totalQuantity: number,
  orderCount = totalQuantity === 0 ? 0 : 1,
) => ({
  channel: "orderbook",
  type: "update",
  market: 1,
  side,
  price,
  totalQuantity,
  orderCount,
});

/** The book a listener reconstructs from the frames it received, best first. */
function rebuild(frames: OrderbookFrame[]) {
  const first = frames[0];
  expect(first?.type, "a listener's first frame is a snapshot").toBe(
    "snapshot",
  );
  const bids = new Map<number, [number, number]>();
  const asks = new Map<number, [number, number]>();
  for (const frame of frames) {
    if (frame.type === "snapshot") {
      bids.clear();
      asks.clear();
      for (const [p, q, n] of frame.bids) bids.set(p, [q, n]);
      for (const [p, q, n] of frame.asks) asks.set(p, [q, n]);
    } else {
      const side = frame.side === "buy" ? bids : asks;
      if (frame.totalQuantity === 0) side.delete(frame.price);
      else side.set(frame.price, [frame.totalQuantity, frame.orderCount]);
    }
  }
  return {
    bids: [...bids].sort(([a], [b]) => b - a),
    asks: [...asks].sort(([a], [b]) => a - b),
  };
}

const microtasks = () =>
  new Promise<void>((resolve) => queueMicrotask(resolve));

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

  it("gives a late orderbook listener a snapshot of the current book", async () => {
    const { feed } = makeFeed();
    const early: OrderbookFrame[] = [];
    const late: OrderbookFrame[] = [];
    feed.subscribeOrderbook(1, (f) => early.push(f));
    const ws = FakeWS.last();
    ws.open();
    ws.emit(
      snapshot(
        [
          [100, 5, 1],
          [99, 3, 2],
        ],
        [
          [101, 4, 1],
          [103, 2, 1],
        ],
      ),
    );
    ws.emit(update("buy", 98, 7));
    ws.emit(update("sell", 101, 0));
    ws.emit(update("buy", 100, 6, 2));

    feed.subscribeOrderbook(1, (f) => late.push(f));
    expect(late, "nothing is delivered inside subscribe").toEqual([]);
    await microtasks();
    expect(late).toEqual([
      snapshot(
        [
          [100, 6, 2],
          [99, 3, 2],
          [98, 7, 1],
        ],
        [[103, 2, 1]],
      ),
    ]);

    ws.emit(update("sell", 102, 9));
    ws.emit(update("buy", 99, 0));
    expect(rebuild(late)).toEqual(rebuild(early));
    expect(
      early.map((f) => f.type),
      "the early listener gets no extra snapshot",
    ).toEqual(["snapshot", "update", "update", "update", "update", "update"]);
    expect(
      ws.sentMsgs().filter((m) => m.method === "subscribe"),
      "one wire subscription serves both listeners",
    ).toHaveLength(1);
    feed.close();
  });

  it("primes a late listener before the update that arrives first", () => {
    const { feed } = makeFeed();
    const early: OrderbookFrame[] = [];
    const late: OrderbookFrame[] = [];
    feed.subscribeOrderbook(1, (f) => early.push(f));
    const ws = FakeWS.last();
    ws.open();
    ws.emit(snapshot([[100, 5, 1]], []));
    feed.subscribeOrderbook(1, (f) => late.push(f));
    // A frame lands before the microtask runs: the late listener's snapshot
    // already includes it, and it never sees the bare update.
    ws.emit(update("sell", 105, 2));
    expect(late).toEqual([snapshot([[100, 5, 1]], [[105, 2, 1]])]);
    expect(rebuild(late)).toEqual(rebuild(early));
    feed.close();
  });

  it("a listener that joins before the first snapshot waits for the gateway's", async () => {
    const { feed } = makeFeed();
    const early: OrderbookFrame[] = [];
    const late: OrderbookFrame[] = [];
    feed.subscribeOrderbook(1, (f) => early.push(f));
    feed.subscribeOrderbook(1, (f) => late.push(f));
    const ws = FakeWS.last();
    ws.open();
    await microtasks();
    expect(late, "no book yet, so no built snapshot").toEqual([]);
    const opening = snapshot([[100, 5, 1]], [[101, 4, 1]]);
    ws.emit(opening);
    ws.emit(update("buy", 100, 0));
    expect(late).toEqual([opening, update("buy", 100, 0)]);
    expect(early).toEqual(late);
    feed.close();
  });

  it("never builds a late listener's snapshot from a dropped socket's book", async () => {
    const { feed, clock } = makeFeed();
    const late: OrderbookFrame[] = [];
    feed.subscribeOrderbook(1, () => {});
    FakeWS.last().open();
    FakeWS.last().emit(snapshot([[100, 5, 1]], []));
    FakeWS.last().drop();

    feed.subscribeOrderbook(1, (f) => late.push(f));
    await microtasks();
    expect(late, "the old book is gone while reconnecting").toEqual([]);

    clock.runNext();
    const ws = FakeWS.last();
    ws.open();
    const fresh = snapshot([[99, 1, 1]], []);
    ws.emit(fresh);
    expect(late).toEqual([fresh]);
    feed.close();
  });

  it("a late listener disposed before its snapshot receives nothing", async () => {
    const { feed } = makeFeed();
    const late: OrderbookFrame[] = [];
    feed.subscribeOrderbook(1, () => {});
    const ws = FakeWS.last();
    ws.open();
    ws.emit(snapshot([[100, 5, 1]], []));
    const dispose = feed.subscribeOrderbook(1, (f) => late.push(f));
    dispose();
    await microtasks();
    ws.emit(update("buy", 100, 0));
    expect(late).toEqual([]);
    feed.close();
  });

  describe("late account listeners", () => {
    const owner = "ab".repeat(20);
    const accountSnapshot = (n: number) => ({
      channel: "accountEvents",
      type: "snapshot",
      owner,
      account: { n },
    });
    const fill = (n: number) => ({
      channel: "accountEvents",
      type: "fill",
      owner,
      payload: { n: String(n) },
    });
    const subscribes = (ws: FakeWS) =>
      ws.sentMsgs().filter((m) => m.method === "subscribe");

    function joined() {
      const { feed, clock } = makeFeed();
      const early: unknown[] = [];
      const late: unknown[] = [];
      feed.subscribeAccount(owner, (f) => early.push(f));
      const ws = FakeWS.last();
      ws.open();
      ws.emit({ type: "subscribed", id: 1, channel: "accountEvents" });
      ws.emit(accountSnapshot(1));
      ws.emit(fill(1));
      feed.subscribeAccount(owner, (f) => late.push(f));
      return { feed, clock, ws, early, late };
    }

    it("re-subscribes and starts the late listener from the resent snapshot", () => {
      const { feed, ws, early, late } = joined();
      const repeat = subscribes(ws)[1];
      expect(repeat, "a late listener asks for a snapshot").toEqual({
        method: "subscribe",
        id: 2,
        params: { channel: "accountEvents", owner },
      });
      ws.emit(fill(2)); // already in the snapshot being resent
      expect(late, "no event before the snapshot").toEqual([]);
      ws.emit({
        type: "subscribed",
        id: 2,
        channel: "accountEvents",
        note: "already subscribed",
        snapshot: "resent",
      });
      ws.emit(accountSnapshot(2));
      ws.emit(fill(3));
      expect(late).toEqual([accountSnapshot(2), fill(3)]);
      // The resend is the late listener's: the existing one keeps its stream
      // and never sees a second snapshot it could take for a reconnect.
      expect(early).toEqual([accountSnapshot(1), fill(1), fill(2), fill(3)]);
      feed.close();
    });

    it("falls back to live events when the gateway does not resend", () => {
      const { feed, ws, late } = joined();
      ws.emit({
        type: "subscribed",
        id: 2,
        channel: "accountEvents",
        note: "already subscribed",
      });
      ws.emit(fill(2));
      expect(late, "an older gateway's listener is not left waiting").toEqual([
        fill(2),
      ]);
      feed.close();
    });

    it("delivers events that landed before an older gateway's ack", () => {
      const { feed, ws, late } = joined();
      // An older gateway answers a repeat subscribe with queued events still
      // ahead of the ack, and no snapshot follows. Nothing is lost to the
      // window between the resend and the ack.
      ws.emit(fill(2));
      ws.emit({
        type: "subscribed",
        id: 2,
        channel: "accountEvents",
        note: "already subscribed",
      });
      ws.emit(fill(3));
      expect(late).toEqual([fill(2), fill(3)]);
      feed.close();
    });

    it("falls back when the ack promises nothing and the resend is refused", () => {
      const { feed, ws, late } = joined();
      const refusal = {
        type: "error",
        id: 2,
        channel: "accountEvents",
        code: 503,
        error: "snapshot unavailable",
      };
      // The gateway promises a snapshot only when one follows: a refused
      // resend is a plain ack, then the 503.
      ws.emit({
        type: "subscribed",
        id: 2,
        channel: "accountEvents",
        note: "already subscribed",
      });
      ws.emit(refusal);
      ws.emit(fill(2));
      expect(late).toEqual([refusal, fill(2)]);
      feed.close();
    });

    it("falls back when an ack promises the snapshot and the 503 retracts it", () => {
      const { feed, ws, late } = joined();
      const refusal = {
        type: "error",
        id: 2,
        channel: "accountEvents",
        code: 503,
        error: "snapshot unavailable",
      };
      // An earlier gateway announced the snapshot in the ack and reported
      // the failure only afterwards; the error itself releases the listener.
      ws.emit({
        type: "subscribed",
        id: 2,
        channel: "accountEvents",
        note: "already subscribed",
        snapshot: "resent",
      });
      ws.emit(refusal);
      ws.emit(fill(2));
      expect(late).toEqual([refusal, fill(2)]);
      feed.close();
    });

    it("one in-flight resend serves listeners that join before its snapshot", () => {
      const { feed } = makeFeed();
      const a: unknown[] = [];
      const b: unknown[] = [];
      feed.subscribeAccount(owner, () => {});
      const ws = FakeWS.last();
      ws.open();
      ws.emit({ type: "subscribed", id: 1, channel: "accountEvents" });
      ws.emit(accountSnapshot(1));
      feed.subscribeAccount(owner, (f) => a.push(f));
      // B joins while A's resend is still on the wire.
      feed.subscribeAccount(owner, (f) => b.push(f));
      expect(
        subscribes(ws),
        "the resend in flight serves both listeners",
      ).toHaveLength(2);
      ws.emit(fill(2)); // already in the snapshot being resent
      ws.emit({
        type: "subscribed",
        id: 2,
        channel: "accountEvents",
        note: "already subscribed",
        snapshot: "resent",
      });
      ws.emit(accountSnapshot(2));
      expect(a).toEqual([accountSnapshot(2)]);
      expect(b).toEqual([accountSnapshot(2)]);
      // The snapshot released everyone, so a further listener resends again.
      feed.subscribeAccount(owner, () => {});
      expect(
        subscribes(ws),
        "a listener after the snapshot resends",
      ).toHaveLength(3);
      feed.close();
    });

    it("waits for the replayed snapshot when it joins while reconnecting", () => {
      const { feed, clock } = makeFeed();
      const late: unknown[] = [];
      feed.subscribeAccount(owner, () => {});
      FakeWS.last().open();
      FakeWS.last().emit(accountSnapshot(1));
      FakeWS.last().drop();
      feed.subscribeAccount(owner, (f) => late.push(f));
      clock.runNext();
      const ws = FakeWS.last();
      ws.open();
      expect(subscribes(ws), "the replay is the only subscribe").toHaveLength(
        1,
      );
      ws.emit(fill(2));
      ws.emit(accountSnapshot(2));
      expect(late).toEqual([accountSnapshot(2)]);
      feed.close();
    });

    it("falls back to live events when signing the repeat subscribe fails", async () => {
      const errors: unknown[] = [];
      const { feed } = makeFeed({ onError: (e: unknown) => errors.push(e) });
      let calls = 0;
      const auth = async () => {
        calls += 1;
        if (calls > 1) throw new Error("signer unavailable");
        return { public_key: "pk", signature: "sig", timestamp_ms: 1 };
      };
      const early: unknown[] = [];
      const late: unknown[] = [];
      feed.subscribeAccount(owner, (f) => early.push(f), auth);
      const ws = FakeWS.last();
      ws.open();
      await microtasks();
      await microtasks();
      ws.emit(accountSnapshot(1));
      feed.subscribeAccount(owner, (f) => late.push(f), auth);
      // Let the rejected signing settle through its promise chain.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(subscribes(ws), "the rejected repeat sends nothing").toHaveLength(
        1,
      );
      ws.emit(fill(2));
      expect(late, "the late listener is not left waiting").toEqual([fill(2)]);
      expect(early).toEqual([accountSnapshot(1), fill(2)]);
      expect(errors).toEqual([new Error("signer unavailable")]);
      expect(feed.connectionState).toBe("open");
      feed.close();
    });

    it("retries a first subscribe whose signing failed, on the same socket", async () => {
      const errors: unknown[] = [];
      const { feed, clock } = makeFeed({
        onError: (e: unknown) => errors.push(e),
        minBackoffMs: 100,
      });
      let calls = 0;
      const auth = async () => {
        calls += 1;
        if (calls === 1) throw new Error("signer unavailable");
        return { public_key: "pk", signature: "sig", timestamp_ms: 1 };
      };
      const got: Array<Record<string, unknown>> = [];
      feed.subscribeAccount(
        owner,
        (f) => got.push(f as unknown as Record<string, unknown>),
        auth,
      );
      const ws = FakeWS.last();
      ws.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(subscribes(ws), "nothing subscribed yet").toHaveLength(0);
      expect(errors).toEqual([new Error("signer unavailable")]);
      expect(got).toEqual([
        {
          type: "error",
          channel: "accountEvents",
          error:
            "accountEvents subscription authentication failed: signer unavailable; retrying in 100ms",
        },
      ]);
      expect(clock.pending, "a retry is scheduled").toBe(1);
      clock.runNext();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(subscribes(ws), "the retry subscribes").toHaveLength(1);
      ws.emit(accountSnapshot(1));
      ws.emit(fill(2));
      expect(got.slice(1)).toEqual([accountSnapshot(1), fill(2)]);
      expect(FakeWS.instances, "no reconnect was needed").toHaveLength(1);
      expect(feed.connectionState).toBe("open");
      feed.close();
    });

    it("stops retrying a first subscribe whose signing keeps failing, with one final error frame", async () => {
      const errors: unknown[] = [];
      const { feed, clock } = makeFeed({
        onError: (e: unknown) => errors.push(e),
        minBackoffMs: 100,
      });
      const auth = async () => {
        throw new Error("signer unavailable");
      };
      const got: Array<Record<string, unknown>> = [];
      feed.subscribeAccount(
        owner,
        (f) => got.push(f as unknown as Record<string, unknown>),
        auth,
      );
      const ws = FakeWS.last();
      ws.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(subscribes(ws), "nothing ever gets on the wire").toHaveLength(0);
      // Drain retries while the feed still schedules them; the safety bound
      // only guards against a regression that retries for ever.
      for (let i = 0; i < 10 && clock.pending > 0; i++) {
        clock.runNext();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(clock.pending, "no retry is left scheduled").toBe(0);
      const final = got.filter((f) => /not retrying after/.test(f.error));
      expect(final, "exactly one final error frame").toHaveLength(1);
      expect(
        got.slice(0, -1).every((f) => /retrying in/.test(f.error)),
        "every earlier frame announced its retry",
      ).toBe(true);
      expect(feed.connectionState).toBe("open");
      feed.close();
    });

    it("retries a first account subscribe the gateway refused with 401", () => {
      const { feed, clock } = makeFeed({ minBackoffMs: 50 });
      const got: Array<Record<string, unknown>> = [];
      feed.subscribeAccount(owner, (f) =>
        got.push(f as unknown as Record<string, unknown>),
      );
      const ws = FakeWS.last();
      ws.open();
      const refusal = {
        type: "error",
        id: subscribes(ws)[0].id,
        channel: "accountEvents",
        code: 401,
        error: "unauthorized: provide X-Api-Key or signed account auth",
      };
      ws.emit(refusal);
      expect(got).toEqual([refusal]);
      expect(clock.pending, "a retry is scheduled").toBe(1);
      clock.runNext();
      expect(subscribes(ws)).toHaveLength(2);
      ws.emit(accountSnapshot(1));
      expect(got.at(-1)).toEqual(accountSnapshot(1));
      expect(FakeWS.instances).toHaveLength(1);
      feed.close();
    });

    it("does not retry a refusal no retry can pass", () => {
      const { feed, clock } = makeFeed();
      feed.subscribeAccount(owner, () => {});
      const ws = FakeWS.last();
      ws.open();
      ws.emit({ type: "error", id: subscribes(ws)[0].id, error: "bad owner" });
      expect(clock.pending).toBe(0);
      feed.close();
    });

    it("sends no late-listener resend while a subscribe retry is pending", async () => {
      const { feed, clock } = makeFeed({ onError: () => {} });
      let calls = 0;
      const auth = async () => {
        calls += 1;
        if (calls === 1) throw new Error("signer unavailable");
        return { public_key: "pk", signature: "sig", timestamp_ms: 1 };
      };
      feed.subscribeAccount(owner, () => {}, auth);
      const ws = FakeWS.last();
      ws.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(clock.pending).toBe(1);
      const late: unknown[] = [];
      feed.subscribeAccount(owner, (f) => late.push(f), auth);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(subscribes(ws), "the retry will serve the late listener").toEqual(
        [],
      );
      clock.runNext();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(subscribes(ws)).toHaveLength(1);
      ws.emit(accountSnapshot(1));
      expect(late).toEqual([accountSnapshot(1)]);
      feed.close();
    });

    it("cancels a pending subscribe retry on unsubscribe", async () => {
      const { feed, clock } = makeFeed({ onError: () => {} });
      const auth = async () => {
        throw new Error("chain id unavailable");
      };
      const keep = feed.subscribeOrderbook(1, () => {});
      const unsub = feed.subscribeAccount(owner, () => {}, auth);
      const ws = FakeWS.last();
      ws.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(clock.pending).toBe(1);
      unsub();
      expect(clock.pending, "the retry is cancelled").toBe(0);
      expect(
        subscribes(ws).filter(
          (m) => (m.params as { channel?: string }).channel === "accountEvents",
        ),
      ).toHaveLength(0);
      keep();
      feed.close();
    });

    it("falls back to live events when sending the repeat subscribe fails", () => {
      const errors: unknown[] = [];
      const { feed } = makeFeed({ onError: (e: unknown) => errors.push(e) });
      const late: unknown[] = [];
      feed.subscribeAccount(owner, () => {});
      const ws = FakeWS.last();
      ws.open();
      ws.emit(accountSnapshot(1));
      ws.send = () => {
        throw new Error("socket write failed");
      };
      feed.subscribeAccount(owner, (f) => late.push(f));
      ws.emit(fill(2));
      expect(late).toEqual([fill(2)]);
      expect(errors).toEqual([new Error("socket write failed")]);
      feed.close();
    });

    it("signs the repeat subscribe like the first", async () => {
      const { feed } = makeFeed();
      let signed = 0;
      const auth = async () => {
        signed += 1;
        return {
          public_key: "pk",
          signature: `sig${signed}`,
          timestamp_ms: signed,
        };
      };
      feed.subscribeAccount(owner, () => {}, auth);
      const ws = FakeWS.last();
      ws.open();
      await microtasks();
      await microtasks();
      // The first snapshot lands, so the late listener sends a fresh resend
      // rather than waiting on the one that already arrived.
      ws.emit(accountSnapshot(1));
      feed.subscribeAccount(owner, () => {}, auth);
      await microtasks();
      await microtasks();
      expect(
        subscribes(ws).map(
          (m) => (m.params as { signature?: string }).signature,
        ),
      ).toEqual(["sig1", "sig2"]);
      feed.close();
    });
  });
});
