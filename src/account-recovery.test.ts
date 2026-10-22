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

const live = (e: Ev, keyed = true) => ({
  channel: "accountEvents",
  type: "account_event",
  owner: OWNER,
  eventType: e.type,
  height: e.height,
  ...(keyed ? { txHash: e.tx, txIndex: 0, eventIndex: e.index } : {}),
  payload: { tag: `${e.height}-${e.index}` },
});

const row = (e: Ev, id: number) => ({
  event_id: id,
  owner: OWNER,
  block_height: e.height,
  block_time: "2026-10-22T00:00:00Z",
  tx_hash: e.tx,
  event_index: e.index,
  event_type: e.type,
  payload: { tag: `${e.height}-${e.index}` },
});

const snapshot = { channel: "accountEvents", type: "snapshot", owner: OWNER };

// Same transaction hash at two heights: only the full key tells them apart.
const A: Ev = { height: 10, tx: "AA", index: 0, type: "trade_executed" };
const B: Ev = { height: 10, tx: "AA", index: 1, type: "position_updated" };
const C: Ev = { height: 11, tx: "AA", index: 0, type: "trade_executed" };
const D: Ev = { height: 12, tx: "DD", index: 3, type: "fees_collected" };
const E: Ev = { height: 13, tx: "EE", index: 0, type: "trade_executed" };

function setup() {
  vi.useFakeTimers();
  const sockets: Socket[] = [];
  let history: { resolve: (body: object) => void; url: string } | null = null;
  const c = new ExchangeClient({
    gatewayUrl: "http://gateway",
    chainId: "exchange-devnet-1",
    httpTransport: (url) =>
      new Promise<Response>((resolve) => {
        history = {
          url,
          resolve: (body) => resolve(new Response(JSON.stringify(body))),
        };
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
  return { c, sockets, frames, statuses, history: () => history };
}

const tags = (frames: AccountFrame[]) =>
  frames.map((f) =>
    f.type === "snapshot"
      ? "snapshot"
      : `${(f.payload as { tag: string }).tag}${f.backfilled ? "*" : ""}`,
  );

it("delivers events from an outage exactly once and in order", async () => {
  const { c, sockets, frames, statuses, history } = setup();
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].push(snapshot);
  sockets[0].push(live(A));
  sockets[0].push(live(B));

  // C and D happen while the socket is down.
  sockets[0].drop();
  await vi.advanceTimersByTimeAsync(10);
  sockets[1].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[1].push(snapshot);
  // Live frames during the backfill: D overlaps history, E is new.
  sockets[1].push(live(D));
  sockets[1].push(live(E));
  await vi.advanceTimersByTimeAsync(0);
  expect(history()!.url).toContain("/v1/history/account-events?");
  expect(history()!.url).toContain("order=desc");
  history()!.resolve({
    account_events: [row(D, 4), row(C, 3), row(B, 2), row(A, 1)],
    next_cursor: "",
  });
  await vi.advanceTimersByTimeAsync(0);

  expect(tags(frames)).toEqual([
    "snapshot",
    "10-0",
    "10-1",
    "snapshot",
    "11-0*",
    "12-3*",
    "13-0",
  ]);
  expect(statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);

  // Live delivery resumes after the backfill.
  sockets[1].push(live({ height: 14, tx: "FF", index: 0, type: "x" }));
  expect(tags(frames).at(-1)).toBe("14-0");
  c.disconnect();
});

it("retries while history lags the live feed", async () => {
  const { c, sockets, frames, statuses, history } = setup();
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].push(snapshot);
  sockets[0].push(live(A));
  sockets[0].drop();
  await vi.advanceTimersByTimeAsync(10);
  sockets[1].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[1].push(snapshot);
  sockets[1].push(live(E));
  await vi.advanceTimersByTimeAsync(0);
  // History has not indexed past A yet.
  history()!.resolve({ account_events: [row(A, 1)], next_cursor: "" });
  await vi.advanceTimersByTimeAsync(1000);
  history()!.resolve({
    account_events: [row(E, 3), row(C, 2), row(A, 1)],
    next_cursor: "",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(tags(frames)).toEqual([
    "snapshot",
    "10-0",
    "snapshot",
    "11-0*",
    "13-0*",
  ]);
  expect(statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  c.disconnect();
});

it("reports unsupported and keeps live delivery when frames carry no key", async () => {
  const { c, sockets, frames, statuses, history } = setup();
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].push(snapshot);
  sockets[0].push(live(A, false));
  sockets[0].drop();
  await vi.advanceTimersByTimeAsync(10);
  sockets[1].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[1].push(snapshot);
  sockets[1].push(live(E, false));
  expect(history()).toBeNull();
  expect(tags(frames)).toEqual(["snapshot", "10-0", "snapshot", "13-0"]);
  expect(statuses).toEqual([{ kind: "unsupported" }]);
  c.disconnect();
});

it("reports a failed history read and flushes the buffered live frames", async () => {
  const { c, sockets, frames, statuses, history } = setup();
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].push(snapshot);
  sockets[0].push(live(A));
  sockets[0].drop();
  await vi.advanceTimersByTimeAsync(10);
  sockets[1].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[1].push(snapshot);
  sockets[1].push(live(E));
  await vi.advanceTimersByTimeAsync(0);
  history()!.resolve({ error: "order_required" });
  await vi.advanceTimersByTimeAsync(0);
  expect(tags(frames)).toEqual(["snapshot", "10-0", "snapshot", "13-0"]);
  expect(statuses[0].kind).toBe("failed");
  c.disconnect();
});

it("matches a legacy live settlement name to the canonical history name", async () => {
  const { c, sockets, frames, statuses, history } = setup();
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
  const canonical = (e: Ev, type: string): Ev => ({ ...e, type });
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].push(snapshot);
  sockets[0].push(live(met));
  sockets[0].drop();
  await vi.advanceTimersByTimeAsync(10);
  sockets[1].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[1].push(snapshot);
  sockets[1].push(live(notMet));
  await vi.advanceTimersByTimeAsync(0);
  history()!.resolve({
    account_events: [
      row(canonical(notMet, "condition_not_met"), 3),
      row(C, 2),
      row(canonical(met, "condition_met"), 1),
    ],
    next_cursor: "",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(tags(frames)).toEqual([
    "snapshot",
    "10-2",
    "snapshot",
    "11-0*",
    "12-1*",
  ]);
  expect(statuses).toEqual([{ kind: "backfilled", delivered: 2 }]);
  c.disconnect();
});

it("passes an error frame through without losing the recovery boundary", async () => {
  const { c, sockets, frames, statuses, history } = setup();
  sockets[0].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[0].push(snapshot);
  sockets[0].push(live(A));
  const id = JSON.parse(sockets[0].sent[0]).id;
  sockets[0].push({ type: "error", id, channel: "accountEvents", error: "x" });
  sockets[0].drop();
  await vi.advanceTimersByTimeAsync(10);
  sockets[1].open();
  await vi.advanceTimersByTimeAsync(0);
  sockets[1].push(snapshot);
  await vi.advanceTimersByTimeAsync(0);
  history()!.resolve({
    account_events: [row(C, 2), row(A, 1)],
    next_cursor: "",
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(frames.map((f) => f.type)).toEqual([
    "snapshot",
    "account_event",
    "error",
    "snapshot",
    "fill",
  ]);
  expect(statuses).toEqual([{ kind: "backfilled", delivered: 1 }]);
  c.disconnect();
});
