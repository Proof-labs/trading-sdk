import { afterEach, expect, it, vi } from "vitest";
import {
  ExchangeClient,
  type AccountFrame,
  type AccountRecoveryStatus,
  type WebSocketLike,
} from "./index.js";

const OWNER = "bd0e11d003efc8a53e4286b41d70abfb65e5f186";

afterEach(() => {
  vi.useRealTimers();
});

class Socket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  send(s: string) {
    this.sent.push(s);
  }
  close() {}
  open() {
    this.onopen?.({});
  }
  drop() {
    this.onclose?.({});
  }
  push(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

interface Ev {
  height: number;
  tx: string;
  index: number;
  type: string;
}

const live = (e: Ev, keyed = true, txIndex: number | null = 0) => ({
  channel: "accountEvents",
  type: "account_event",
  owner: OWNER,
  eventType: e.type,
  height: e.height,
  ...(keyed ? { txHash: e.tx, txIndex, eventIndex: e.index } : {}),
  payload: { tag: `${e.height}-${e.index}` },
});

const row = (e: Ev, id: number, txPosition?: number) => ({
  event_id: id,
  owner: OWNER,
  block_height: e.height,
  block_time: "2026-10-22T00:00:00Z",
  tx_hash: e.tx,
  event_index: e.index,
  event_type: e.type,
  ...(txPosition === undefined ? {} : { tx_position: txPosition }),
  payload: { tag: `${e.height}-${e.index}` },
});

/** Newest-first history page of `events` (given oldest first). */
const page = (...events: Ev[]) => ({
  account_events: events.map((e, i) => row(e, i + 1)).reverse(),
  next_cursor: "",
});

/** Newest-first history page of ready-made rows (given oldest first). */
const pageRows = (...rows: object[]) => ({
  account_events: [...rows].reverse(),
  next_cursor: "",
});
const indexed = (height: number) => ({ ingest: { newest_height: height } });

const snap = (height?: number, marker?: "initial" | "resent") => ({
  channel: "accountEvents",
  type: "snapshot",
  owner: OWNER,
  account: {},
  ...(marker ? { snapshot: marker } : {}),
  ...(height === undefined ? {} : { height }),
});

// Same transaction hash at two heights: only the full key tells them apart.
const A: Ev = { height: 10, tx: "AA", index: 0, type: "trade_executed" };
const B: Ev = { height: 10, tx: "AA", index: 1, type: "position_updated" };
const C: Ev = { height: 11, tx: "AA", index: 0, type: "trade_executed" };
const D: Ev = { height: 12, tx: "DD", index: 3, type: "fees_collected" };
const E: Ev = { height: 13, tx: "EE", index: 0, type: "trade_executed" };
const at = (height: number): Ev => ({
  height,
  tx: `T${height}`,
  index: 0,
  type: "trade_executed",
});

interface Pending {
  url: string;
  signal?: AbortSignal | null;
  resolve: (body: object, status?: number) => void;
}

function setup() {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  const pending: Pending[] = [];
  const requests: string[] = [];
  const c = new ExchangeClient({
    gatewayUrl: "http://gateway",
    chainId: "exchange-devnet-1",
    httpTransport: (url, init) =>
      new Promise<Response>((resolve) => {
        requests.push(url);
        pending.push({
          url,
          signal: init?.signal,
          resolve: (body, status = 200) =>
            resolve(new Response(JSON.stringify(body), { status })),
        });
      }),
  });
  c.feed({
    pingIntervalMs: 0,
    minBackoffMs: 1,
    webSocketFactory: () => {
      const s = new Socket();
      sockets.push(s);
      return s;
    },
  });
  const frames: AccountFrame[] = [];
  const statuses: AccountRecoveryStatus[] = [];
  c.subscribeAccount((f) => frames.push(f), {
    owner: OWNER,
    onRecovery: (s) => statuses.push(s),
  });
  /** Answer the oldest pending read of `path`, then let it settle. */
  const answer = async (path: string, body: object, status?: number) => {
    await vi.advanceTimersByTimeAsync(0);
    const i = pending.findIndex((p) => p.url.includes(path));
    expect(i, `a pending ${path} read`).toBeGreaterThanOrEqual(0);
    pending.splice(i, 1)[0].resolve(body, status);
    await vi.advanceTimersByTimeAsync(0);
  };
  const reconnect = async (n: number, snapshot: object) => {
    sockets[n - 1].drop();
    await vi.advanceTimersByTimeAsync(10);
    sockets[n].open();
    await vi.advanceTimersByTimeAsync(0);
    sockets[n].push(snapshot);
  };
  const start = async (snapshot: object) => {
    sockets[0].open();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].push(snapshot);
  };
  return {
    c,
    sockets,
    frames,
    statuses,
    pending,
    requests,
    answer,
    reconnect,
    start,
  };
}

const STATUS = "/v1/history/status";
const EVENTS = "/v1/history/account-events";

const tags = (frames: AccountFrame[]) =>
  frames.map((f) =>
    f.type === "snapshot"
      ? "snapshot"
      : (f as { type: string }).type === "error"
        ? "error"
        : `${(f.payload as { tag: string }).tag}${f.backfilled ? "*" : ""}`,
  );

it("delivers events from an outage exactly once and in order", async () => {
  const t = setup();
  await t.start(snap(10, "initial"));
  t.sockets[0].push(live(A));
  t.sockets[0].push(live(B));
  // C and D happen while the socket is down.
  await t.reconnect(1, snap(12, "initial"));
  // Live frames during the backfill: D overlaps history, E is new.
  t.sockets[1].push(live(D));
  t.sockets[1].push(live(E));
  await t.answer(STATUS, indexed(12));
  await t.answer(EVENTS, page(A, B, C, D));
  expect(t.requests.find((u) => u.includes(EVENTS))).toContain("order=desc");
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "10-1",
    "snapshot",
    "11-0*",
    "12-3*",
    "13-0",
  ]);
  expect(t.statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  t.sockets[1].push(live(at(14)));
  expect(tags(t.frames).at(-1)).toBe("14-0");
  t.c.disconnect();
});

it("retries until history has indexed the snapshot height, even with no live frame", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(13));
  // History is behind the snapshot and no live frame has arrived to show it.
  await t.answer(STATUS, indexed(10));
  expect(
    t.pending.some((p) => p.url.includes(EVENTS)),
    "no history read while history lags",
  ).toBe(false);
  expect(t.statuses, "not reported while history lags").toEqual([]);
  await vi.advanceTimersByTimeAsync(1000);
  await t.answer(STATUS, indexed(13));
  await t.answer(EVENTS, page(A, C, E));
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "snapshot",
    "11-0*",
    "13-0*",
  ]);
  expect(t.statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  t.c.disconnect();
});

it("reports historyBehind, never backfilled, when history never reaches the snapshot", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(13));
  for (let i = 0; i < 30; i++) {
    await t.answer(STATUS, indexed(10));
    await vi.advanceTimersByTimeAsync(1000);
  }
  await t.answer(EVENTS, page(A));
  expect(t.statuses).toEqual([{ kind: "historyBehind", delivered: 0 }]);
  t.c.disconnect();
});

it("reports unverified, never backfilled, when the snapshot has no height", async () => {
  const t = setup();
  await t.start(snap());
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap());
  await t.answer(EVENTS, page(A, C));
  expect(t.requests.some((u) => u.includes(STATUS))).toBe(false);
  expect(tags(t.frames)).toEqual(["snapshot", "10-0", "snapshot", "11-0*"]);
  expect(t.statuses).toEqual([{ kind: "unverified", delivered: 1 }]);
  t.c.disconnect();
});

it("backfills from the previous snapshot's height when nothing was delivered before the outage", async () => {
  const t = setup();
  await t.start(snap(10));
  await t.reconnect(1, snap(12));
  await t.answer(STATUS, indexed(12));
  await t.answer(EVENTS, page(A, C, D));
  expect(tags(t.frames)).toEqual(["snapshot", "snapshot", "11-0*", "12-3*"]);
  expect(t.statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  t.c.disconnect();
});

it("reports once per reconnect even when there is no boundary to recover from", async () => {
  const t = setup();
  await t.start(snap());
  await t.reconnect(1, snap());
  await vi.advanceTimersByTimeAsync(0);
  expect(t.requests).toEqual([]);
  expect(t.statuses).toEqual([{ kind: "unverified", delivered: 0 }]);
  t.c.disconnect();
});

it("loses nothing when the socket reconnects again during a backfill", async () => {
  // History holds 1..5. Live 1; outage; reconnect; live 3; outage, in which
  // 4 happens; reconnect; live 5.
  const t = setup();
  await t.start(snap(0));
  t.sockets[0].push(live(at(1)));
  await t.reconnect(1, snap(2));
  t.sockets[1].push(live(at(3)));
  await t.reconnect(2, snap(4));
  t.sockets[2].push(live(at(5)));
  // The first backfill only now reads history, which has reached 2.
  await t.answer(STATUS, indexed(2));
  await t.answer(EVENTS, page(at(1), at(2)));
  // The second starts from 3, the last frame before the second snapshot.
  await t.answer(STATUS, indexed(5));
  await t.answer(EVENTS, page(at(1), at(2), at(3), at(4), at(5)));
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "1-0",
    "snapshot",
    "snapshot",
    "2-0*",
    "3-0",
    "4-0*",
    "5-0*",
  ]);
  expect(t.statuses).toEqual([
    { kind: "backfilled", delivered: 1 },
    { kind: "backfilled", delivered: 2 },
  ]);
  t.c.disconnect();
});

it("does not treat a snapshot resent for another listener as a reconnect", async () => {
  const t = setup();
  await t.start(snap(10, "initial"));
  t.sockets[0].push(live(A));
  // A second subscribeAccount on the shared feed asks for a resend.
  t.c.subscribeAccount(() => {}, { owner: OWNER });
  await vi.advanceTimersByTimeAsync(0);
  t.sockets[0].push(snap(10, "resent"));
  t.sockets[0].push(live(C));
  await vi.advanceTimersByTimeAsync(0);
  expect(t.requests).toEqual([]);
  expect(t.statuses).toEqual([]);
  expect(tags(t.frames)).toEqual(["snapshot", "10-0", "11-0"]);
  t.c.disconnect();
});

it("drops a live frame a backfill already delivered, even after the backfill ends", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(12));
  await t.answer(STATUS, indexed(12));
  await t.answer(EVENTS, page(A, C, D));
  // A slow socket delivers D after the indexer already served it.
  t.sockets[1].push(live(D));
  t.sockets[1].push(live(E));
  t.sockets[1].push(live(D));
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "snapshot",
    "11-0*",
    "12-3*",
    "13-0",
    "12-3",
  ]);
  t.c.disconnect();
});

it("matches history rows without a position to live frames that carry one", async () => {
  // A normal block: history omits tx_position, the live frame carries 0.
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(12));
  t.sockets[1].push(live(D));
  await t.answer(STATUS, indexed(12));
  await t.answer(EVENTS, page(A, C, D));
  // The unpositioned boundary row A still stops the scan, and the live D is
  // dropped against its unpositioned row.
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "snapshot",
    "11-0*",
    "12-3*",
  ]);
  expect(t.statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  t.c.disconnect();
});

it("separates two copies of one transaction hash in a block by position", async () => {
  // The gateway serves tx_position only when a block repeats the hash.
  const F: Ev = { height: 12, tx: "FF", index: 0, type: "trade_executed" };
  const G: Ev = { height: 12, tx: "FF", index: 1, type: "position_updated" };
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(12));
  t.sockets[1].push(live(F, true, 0));
  t.sockets[1].push(live(G, true, 1));
  await t.answer(STATUS, indexed(12));
  await t.answer(EVENTS, pageRows(row(A, 1), row(F, 2, 0), row(G, 3, 1)));
  // Each live copy matches its own row: no double delivery, no skip.
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "snapshot",
    "12-0*",
    "12-1*",
  ]);
  expect(t.statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  t.c.disconnect();
});

it("dedupes a late live duplicate of a backfilled row that carried no position", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(12));
  await t.answer(STATUS, indexed(12));
  await t.answer(EVENTS, page(A, C, D));
  t.sockets[1].push(live(D));
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "snapshot",
    "11-0*",
    "12-3*",
  ]);
  t.c.disconnect();
});

it("waits out an indexer lag of several seconds before reading history", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(13));
  // History catches up 20 seconds after the reconnect.
  for (let i = 0; i < 20; i++) {
    await t.answer(STATUS, indexed(10));
    await vi.advanceTimersByTimeAsync(1000);
  }
  await t.answer(STATUS, indexed(13));
  await t.answer(EVENTS, page(A, C, E));
  expect(t.statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  t.c.disconnect();
});

it("reports failed, never backfilled, when the gap is longer than the page budget", async () => {
  const t = setup();
  // Nothing is delivered before the outage: the boundary is the snapshot's
  // height, and 11 full pages of newer rows lie above it.
  await t.start(snap(10));
  await t.reconnect(1, snap(5511));
  await t.answer(STATUS, indexed(5511));
  for (let p = 0; p < 10; p++) {
    const top = 5511 - p * 500;
    const events = Array.from({ length: 500 }, (_, i) => at(top - 499 + i));
    await t.answer(EVENTS, { ...page(...events), next_cursor: `c${p + 1}` });
  }
  expect(t.statuses).toEqual([{ kind: "failed", error: expect.any(Error) }]);
  expect(tags(t.frames)).toEqual(["snapshot", "snapshot"]);
  t.c.disconnect();
});

it("reports boundaryNotFound when history no longer holds the boundary event", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(13));
  // History was pruned past the boundary: every row is newer than A.
  await t.answer(STATUS, indexed(13));
  await t.answer(EVENTS, page(E, at(14)));
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "snapshot",
    "13-0*",
    "14-0*",
  ]);
  expect(t.statuses).toEqual([{ kind: "boundaryNotFound", delivered: 2 }]);
  t.c.disconnect();
});

it("re-delivers the rows a failed backfill skipped on the next reconnect", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(13));
  await t.answer(STATUS, indexed(13));
  await t.answer(EVENTS, { error: "order_required" }, 400);
  expect(t.statuses[0].kind).toBe("failed");
  // The reconnect after the transient failure starts over from the same
  // boundary: the scan reads newest-first down to it, so the gap rows are
  // delivered then.
  await t.reconnect(2, snap(13));
  await t.answer(STATUS, indexed(13));
  await t.answer(EVENTS, page(A, C, E));
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "snapshot",
    "snapshot",
    "11-0*",
    "13-0*",
  ]);
  expect(t.statuses).toEqual([
    { kind: "failed", error: expect.any(Error) },
    { kind: "backfilled", delivered: 2 },
  ]);
  t.c.disconnect();
});

it("stops a pending backfill when the subscription closes", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(13));
  await t.answer(STATUS, indexed(10));
  // Now waiting before the retry.
  const before = t.requests.length;
  t.c.disconnect();
  await vi.advanceTimersByTimeAsync(5000);
  expect(t.requests.length, "no read after close").toBe(before);
  expect(t.statuses).toEqual([]);
});

it("aborts an in-flight history read when the subscription closes", async () => {
  const t = setup();
  const unsub = t.c.subscribeAccount(() => {}, { owner: OWNER });
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(13));
  await vi.advanceTimersByTimeAsync(0);
  const inFlight = t.pending.filter((p) => p.url.includes(STATUS));
  expect(inFlight.length).toBeGreaterThan(0);
  unsub();
  t.c.disconnect();
  expect(inFlight.some((p) => p.signal?.aborted)).toBe(true);
});

it("reports unsupported and keeps live delivery when frames carry no key", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A, false));
  await t.reconnect(1, snap(13));
  t.sockets[1].push(live(E, false));
  expect(t.requests).toEqual([]);
  expect(tags(t.frames)).toEqual(["snapshot", "10-0", "snapshot", "13-0"]);
  expect(t.statuses).toEqual([{ kind: "unsupported" }]);
  t.c.disconnect();
});

it("reports a failed history read and flushes the buffered live frames", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  await t.reconnect(1, snap(13));
  t.sockets[1].push(live(E));
  await t.answer(STATUS, indexed(13));
  await t.answer(EVENTS, { error: "order_required" }, 400);
  expect(tags(t.frames)).toEqual(["snapshot", "10-0", "snapshot", "13-0"]);
  expect(t.statuses[0].kind).toBe("failed");
  t.c.disconnect();
});

it("matches a legacy live settlement name to the canonical history name", async () => {
  const t = setup();
  const met: Ev = {
    height: 10,
    tx: "AA",
    index: 2,
    type: "conditional_settled",
  };
  const notMet: Ev = {
    height: 12,
    tx: "DD",
    index: 1,
    type: "conditional_voided",
  };
  await t.start(snap(10));
  t.sockets[0].push(live(met));
  await t.reconnect(1, snap(12));
  t.sockets[1].push(live(notMet));
  await t.answer(STATUS, indexed(12));
  await t.answer(
    EVENTS,
    page({ ...met, type: "condition_met" }, C, {
      ...notMet,
      type: "condition_not_met",
    }),
  );
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-2",
    "snapshot",
    "11-0*",
    "12-1*",
  ]);
  expect(t.statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  t.c.disconnect();
});

it("passes an error frame through without losing the recovery boundary", async () => {
  const t = setup();
  await t.start(snap(10));
  t.sockets[0].push(live(A));
  const id = JSON.parse(t.sockets[0].sent[0]).id;
  t.sockets[0].push({
    type: "error",
    id,
    channel: "accountEvents",
    error: "x",
  });
  await t.reconnect(1, snap(11));
  await t.answer(STATUS, indexed(11));
  await t.answer(EVENTS, page(A, C));
  expect(tags(t.frames)).toEqual([
    "snapshot",
    "10-0",
    "error",
    "snapshot",
    "11-0*",
  ]);
  expect(t.statuses).toEqual([{ kind: "backfilled", delivered: 1 }]);
  t.c.disconnect();
});
