import type {
  AccountEventFrame,
  AccountFrame,
  AccountSnapshotFrame,
} from "./feed-types.js";

/**
 * The position of one account event, shared by live `/ws` frames (gateway
 * 7.9.0 and later) and `/v1/history/account-events` rows. A transaction hash
 * can recur at different heights, and twice in one block, so all the fields
 * together identify an event. A `txIndex` of `null` is a wildcard: history
 * rows omit `tx_position` for normal blocks, where live frames still carry
 * the real index.
 */
export interface AccountEventKey {
  height: number;
  txHash: string;
  eventIndex: number;
  eventType: string;
  txIndex: number | null;
}

/** Whether two keys denote the same event: the four identifying fields are
 *  equal and the positions agree, where `null` agrees with anything. */
function sameEvent(a: AccountEventKey, b: AccountEventKey): boolean {
  return (
    a.height === b.height &&
    a.txHash === b.txHash &&
    a.eventIndex === b.eventIndex &&
    a.eventType === b.eventType &&
    (a.txIndex === null || b.txIndex === null || a.txIndex === b.txIndex)
  );
}

/** Bucket `key` into the map keyed by its four identifying fields, so
 *  `sameEvent` only has to be tried against keys they already match. */
function addEvent(
  keys: Map<string, AccountEventKey[]>,
  key: AccountEventKey,
): void {
  const id = keyId(key);
  const bucket = keys.get(id);
  if (bucket) bucket.push(key);
  else keys.set(id, [key]);
}

/** Whether `keys` holds an event `sameEvent` to `key`. */
function hasEvent(
  keys: Map<string, AccountEventKey[]>,
  key: AccountEventKey,
): boolean {
  return keys.get(keyId(key))?.some((k) => sameEvent(k, key)) ?? false;
}

/**
 * What reconnect recovery did, reported once per reconnect.
 *
 * - `backfilled`: every history row after the last delivered event (or, when
 *   none was delivered, after the previous snapshot's height) was delivered,
 *   in history order, before live delivery resumed, and history had indexed
 *   up to the reconnect snapshot's height, so nothing in between is missing.
 * - `unverified`: rows were backfilled as for `backfilled`, but the snapshot
 *   carries no `height` (an older gateway or node), so whether history had
 *   caught up cannot be checked. Events may be missing. When nothing was
 *   delivered before the outage and the previous snapshot had no height
 *   either, there is no boundary and nothing is backfilled.
 * - `unsupported`: the live frames carry no history key (`txHash` /
 *   `eventIndex`), which means a gateway older than 7.9.0. Nothing was
 *   backfilled; events during the outage are not recovered.
 * - `boundaryNotFound`: the last delivered event is not in the history
 *   window that was read. Only rows at a later height were delivered; events
 *   at the same height as the last delivered one may be missing.
 * - `historyBehind`: history had not indexed up to the snapshot's height,
 *   even after waiting `maxAttempts` status reads. Events between the newest
 *   history row and the snapshot may be missing.
 * - `failed`: a history read failed, or the gap held more rows than
 *   `maxPages` pages, so the boundary was never reached. Nothing was
 *   backfilled.
 */
export type AccountRecoveryStatus =
  | { kind: "backfilled"; delivered: number }
  | { kind: "unverified"; delivered: number }
  | { kind: "unsupported" }
  | { kind: "boundaryNotFound"; delivered: number }
  | { kind: "historyBehind"; delivered: number }
  | { kind: "failed"; error: Error };

/** One `/v1/history/account-events` row, as the gateway returns it. */
export interface AccountHistoryRow {
  event_id: number | string;
  owner: string;
  block_height: number;
  tx_hash: string;
  event_index: number;
  event_type: string;
  /** The transaction's position in its block. History serves it only when
   *  one block carries the same transaction hash more than once; it is
   *  absent otherwise. */
  tx_position?: number;
  payload: Record<string, unknown>;
}

/** One newest-first history page (`order=desc`). */
export interface AccountHistoryPage {
  rows: AccountHistoryRow[];
  nextCursor: string | null;
}

export interface AccountRecoveryOptions {
  owner: string;
  onFrame: (frame: AccountFrame) => void;
  onRecovery?: (status: AccountRecoveryStatus) => void;
  /** Read one newest-first page; `cursor` is the previous page's. */
  fetchPage: (
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<AccountHistoryPage>;
  /** The newest height history has fully indexed
   *  (`/v1/history/status` → `ingest.newest_height`). */
  fetchIndexedHeight: (signal: AbortSignal) => Promise<number>;
  /** Newest-first pages read before giving up on the boundary. */
  maxPages?: number;
  /** Status reads per reconnect, `retryDelayMs` apart, while history lags
   *  the snapshot; the default 30 waits out about 30 seconds of indexer lag. */
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** Live frame type for a history row; mirrors api-gateway
 *  `account_ws_message_type`. */
function familyOf(eventType: string): string {
  switch (eventType) {
    case "trade_executed":
      return "fill";
    case "order_placed":
    case "order_cancelled":
    case "order_amended":
    case "market_order_processed":
      return "orderUpdate";
    case "position_updated":
    case "position_closed":
      return "positionUpdate";
    case "funding_settled":
      return "funding";
    case "position_triggers_set":
    case "position_triggers_cancelled":
    case "position_triggers_invalidated":
    case "position_trigger_activated":
    case "position_trigger_executed":
    case "position_trigger_deferred":
      return "triggerUpdate";
    case "margin_warning":
      return "marginUpdate";
    default:
      return "accountEvent";
  }
}

/** Settlement event names before the canonical vocabulary, mapped to the
 *  names history rows carry. A gateway that already sends the canonical
 *  names passes through unchanged. */
const LEGACY_EVENT_TYPES: Record<string, string> = {
  conditional_settled: "condition_met", // vocabulary-lint: allow
  conditional_voided: "condition_not_met", // vocabulary-lint: allow
};

function canonicalEventType(eventType: string): string {
  return LEGACY_EVENT_TYPES[eventType] ?? eventType;
}

/** The history key of a live frame, or null when the gateway sent none. */
export function liveKey(frame: AccountEventFrame): AccountEventKey | null {
  if (
    typeof frame.txHash !== "string" ||
    typeof frame.eventIndex !== "number" ||
    typeof frame.height !== "number"
  )
    return null;
  return {
    height: frame.height,
    txHash: frame.txHash,
    eventIndex: frame.eventIndex,
    eventType: canonicalEventType(frame.eventType),
    txIndex: typeof frame.txIndex === "number" ? frame.txIndex : null,
  };
}

function rowKey(row: AccountHistoryRow): AccountEventKey {
  return {
    height: Number(row.block_height),
    txHash: row.tx_hash,
    eventIndex: Number(row.event_index),
    eventType: canonicalEventType(row.event_type),
    txIndex: typeof row.tx_position === "number" ? row.tx_position : null,
  };
}

function keyId(k: AccountEventKey): string {
  return `${k.height}|${k.txHash}|${k.eventIndex}|${k.eventType}`;
}

function rowFrame(row: AccountHistoryRow): AccountEventFrame {
  return {
    channel: "accountEvents",
    type: familyOf(row.event_type),
    owner: row.owner,
    eventType: row.event_type,
    height: Number(row.block_height),
    txHash: row.tx_hash,
    txIndex: typeof row.tx_position === "number" ? row.tx_position : null,
    eventIndex: Number(row.event_index),
    payload: row.payload,
    backfilled: true,
  };
}

/** Where a backfill starts: after this event, or after this height. */
interface Boundary {
  key: AccountEventKey | null;
  height: number;
}

type Buffered =
  | { kind: "event"; frame: AccountEventFrame }
  | { kind: "snapshot"; frame: AccountSnapshotFrame };

/** A pause that ends early, rejecting, when `signal` aborts. */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("closed"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("closed"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const heightOf = (frame: AccountSnapshotFrame): number | undefined =>
  typeof frame.height === "number" ? frame.height : undefined;

/**
 * Wrap an account listener so a reconnect backfills the events missed while
 * disconnected.
 *
 * A snapshot after the first, other than one marked `snapshot: "resent"`
 * (sent because another listener joined), marks a re-subscription. The
 * snapshot is passed through at once: it is current state, not part of the
 * event log. Until the backfill finishes, live events are buffered. The
 * backfill waits while history has not indexed up to the new snapshot's
 * height, reads history newest-first down to the last delivered event (or
 * the previous snapshot's height when none was delivered), delivers the
 * newer rows in history order, then flushes the buffer, dropping any live
 * frame history already delivered. If the socket reconnects again during a
 * backfill, only the frames before that snapshot are flushed; the next
 * backfill starts from the last of them and the later frames stay buffered.
 */
export function recoveringAccountHandler(opts: AccountRecoveryOptions): {
  handle: (frame: AccountFrame) => void;
  close: () => void;
} {
  const maxPages = opts.maxPages ?? 10;
  const maxAttempts = opts.maxAttempts ?? 30;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const abort = new AbortController();
  // `undefined`: nothing delivered yet. `null`: the last delivered frame had
  // no history key, so there is no event boundary to recover from.
  let last: AccountEventKey | null | undefined;
  // Height of the latest snapshot that recovery has caught up to.
  let snapshotHeight: number | undefined;
  let seenSnapshot = false;
  let recovering = false;
  let closed = false;
  let buffer: Buffered[] = [];
  // Events a backfill delivered, kept until a live frame passes the newest
  // of their heights: a slow socket can still deliver one the indexer
  // already served.
  let recent: {
    keys: Map<string, AccountEventKey[]>;
    height: number;
    floor: number;
  } | null = null;

  const deliver = (frame: AccountEventFrame, key: AccountEventKey | null) => {
    if (closed) return;
    last = key;
    opts.onFrame(frame);
  };

  /** Deliver a live frame unless a backfill already delivered it. */
  const deliverLive = (frame: AccountEventFrame) => {
    const key = liveKey(frame);
    if (key && recent) {
      if (hasEvent(recent.keys, key) || key.height < recent.floor) return;
      if (key.height > recent.height) recent = null;
    }
    deliver(frame, key);
  };

  const scan = async (boundary: Boundary) => {
    const newerFirst: AccountHistoryRow[] = [];
    // A height boundary is exact: the snapshot holds everything up to it.
    let found = boundary.key === null;
    let reached = false;
    let cursor: string | null = null;
    for (let page = 0; page < maxPages && !reached; page++) {
      const { rows, nextCursor } = await opts.fetchPage(cursor, abort.signal);
      for (const row of rows) {
        const key = rowKey(row);
        if (boundary.key && sameEvent(key, boundary.key)) {
          found = reached = true;
          break;
        }
        if (
          boundary.key
            ? key.height < boundary.height
            : key.height <= boundary.height
        ) {
          reached = true;
          break;
        }
        newerFirst.push(row);
      }
      if (!nextCursor) break;
      cursor = nextCursor;
      if (page === maxPages - 1 && !reached)
        throw new Error(
          `account history holds more than ${maxPages} pages after the recovery boundary`,
        );
    }
    const rows = newerFirst.reverse();
    return {
      found,
      rows:
        found || !boundary.key
          ? rows
          : rows.filter((r) => Number(r.block_height) > boundary.height),
    };
  };

  const boundaryNow = (): Boundary | AccountRecoveryStatus => {
    if (last === null) return { kind: "unsupported" };
    if (last) return { key: last, height: last.height };
    if (snapshotHeight !== undefined)
      return { key: null, height: snapshotHeight };
    return { kind: "unverified", delivered: 0 };
  };

  const recover = async (snapshot: AccountSnapshotFrame) => {
    const target = heightOf(snapshot);
    const boundary = boundaryNow();
    let status: AccountRecoveryStatus;
    let delivered = new Map<string, AccountEventKey[]>();
    let floor = -1;
    if ("kind" in boundary) {
      status = boundary;
      recent = null;
    } else {
      try {
        let indexed =
          target === undefined
            ? -1
            : await opts.fetchIndexedHeight(abort.signal);
        for (
          let attempt = 1;
          target !== undefined && indexed < target && attempt < maxAttempts;
          attempt++
        ) {
          await abortableSleep(retryDelayMs, abort.signal);
          indexed = await opts.fetchIndexedHeight(abort.signal);
        }
        const result = await scan(boundary);
        if (closed) return undefined;
        if (boundary.key) addEvent(delivered, boundary.key);
        floor = boundary.key ? boundary.height : boundary.height + 1;
        let newest = -1;
        for (const row of result.rows) {
          const key = rowKey(row);
          addEvent(delivered, key);
          newest = Math.max(newest, key.height);
          deliver(rowFrame(row), key);
        }
        const count = result.rows.length;
        status = !result.found
          ? { kind: "boundaryNotFound", delivered: count }
          : target === undefined
            ? { kind: "unverified", delivered: count }
            : indexed >= target
              ? { kind: "backfilled", delivered: count }
              : { kind: "historyBehind", delivered: count };
        recent = { keys: delivered, height: newest, floor };
      } catch (err) {
        if (closed) return undefined;
        status = {
          kind: "failed",
          error: err instanceof Error ? err : new Error(String(err)),
        };
        recent = null;
      }
    }
    snapshotHeight = target;
    // Flush up to the next reconnect snapshot; it starts the next backfill,
    // from the last frame flushed here, and the frames after it stay buffered.
    const cut = buffer.findIndex((b) => b.kind === "snapshot");
    const now = cut < 0 ? buffer : buffer.slice(0, cut);
    const next =
      cut < 0 ? undefined : (buffer[cut].frame as AccountSnapshotFrame);
    buffer = cut < 0 ? [] : buffer.slice(cut + 1);
    for (const b of now) if (b.kind === "event") deliverLive(b.frame);
    if (!closed) opts.onRecovery?.(status);
    return next;
  };

  const run = async (snapshot: AccountSnapshotFrame) => {
    recovering = true;
    let current: AccountSnapshotFrame | undefined = snapshot;
    while (current && !closed) current = await recover(current);
    recovering = false;
  };

  const handle = (frame: AccountFrame) => {
    if (closed) return;
    if (frame.type === "snapshot") {
      opts.onFrame(frame);
      const snap = frame as AccountSnapshotFrame;
      if (!seenSnapshot) {
        seenSnapshot = true;
        snapshotHeight = heightOf(snap);
        return;
      }
      // A resend for another listener is not a reconnect.
      if (snap.snapshot === "resent") return;
      if (recovering) buffer.push({ kind: "snapshot", frame: snap });
      else void run(snap);
      return;
    }
    // An error frame (a refused subscribe, a failed authentication) is no
    // account event: it passes straight through and moves no boundary.
    if ((frame as { type: string }).type === "error") {
      opts.onFrame(frame);
      return;
    }
    const event = frame as AccountEventFrame;
    if (recovering) buffer.push({ kind: "event", frame: event });
    else deliverLive(event);
  };

  return {
    handle,
    close: () => {
      closed = true;
      buffer = [];
      abort.abort();
    },
  };
}
