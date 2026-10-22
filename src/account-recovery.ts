import type { AccountEventFrame, AccountFrame } from "./feed-types.js";

/**
 * The position of one account event, shared by live `/ws` frames (gateway
 * 7.9.0 and later) and `/v1/history/account-events` rows. A transaction hash
 * can recur at different heights, so all four fields together identify an
 * event.
 */
export interface AccountEventKey {
  height: number;
  txHash: string;
  eventIndex: number;
  eventType: string;
}

/**
 * What reconnect recovery did, reported once per reconnect.
 *
 * - `backfilled`: the last delivered event was found in history and every
 *   later history row was delivered, in history order, before live delivery
 *   resumed.
 * - `unsupported`: the live frames carry no history key (`txHash` /
 *   `eventIndex`), which means a gateway older than 7.9.0. Nothing was
 *   backfilled; events during the outage are not recovered.
 * - `boundaryNotFound`: the last delivered event is not in the history
 *   window that was read. Only rows at a later height were delivered; events
 *   at the same height as the last delivered one may be missing.
 * - `historyBehind`: history had not reached the first live event after the
 *   reconnect, even after retrying. Events between the newest history row and
 *   that live event may be missing.
 * - `failed`: the history read failed. Nothing was backfilled.
 */
export type AccountRecoveryStatus =
  | { kind: "backfilled"; delivered: number }
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
  fetchPage: (cursor: string | null) => Promise<AccountHistoryPage>;
  /** Newest-first pages read per attempt before giving up on the boundary. */
  maxPages?: number;
  /** History reads per reconnect while history lags the live feed. */
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Live event family for a history row; mirrors api-gateway
 *  `account_ws_message_type`. */
function familyOf(eventType: string): string {
  switch (eventType) {
    case "trade_executed":
      return "fill";
    case "order_placed":
    case "order_cancelled":
    case "order_amended":
    case "market_order_processed":
      return "order_update";
    case "position_updated":
    case "position_closed":
      return "position_update";
    case "funding_settled":
      return "funding";
    case "position_triggers_set":
    case "position_triggers_cancelled":
    case "position_triggers_invalidated":
    case "position_trigger_activated":
    case "position_trigger_executed":
    case "position_trigger_deferred":
      return "trigger_update";
    case "margin_warning":
      return "margin_update";
    default:
      return "account_event";
  }
}

/** Settlement event names before the canonical vocabulary, mapped to the
 *  names history rows carry. A gateway that already sends the canonical
 *  names passes through unchanged. */
const LEGACY_EVENT_TYPES: Record<string, string> = {
  conditional_settled: "condition_met",
  conditional_voided: "condition_not_met",
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
  };
}

function rowKey(row: AccountHistoryRow): AccountEventKey {
  return {
    height: Number(row.block_height),
    txHash: row.tx_hash,
    eventIndex: Number(row.event_index),
    eventType: canonicalEventType(row.event_type),
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
    txIndex: null,
    eventIndex: Number(row.event_index),
    payload: row.payload,
    backfilled: true,
  };
}

/**
 * Wrap an account listener so a reconnect backfills the events missed while
 * disconnected.
 *
 * Every snapshot after the first marks a re-subscription. From then until
 * the backfill finishes, live events are buffered. The backfill reads history
 * newest-first down to the last delivered event, delivers the newer rows in
 * history order, then flushes the buffer, dropping any live frame whose key a
 * delivered row already had. Live delivery then resumes. The snapshot itself
 * is passed through at once: it is current state, not part of the event log.
 */
export function recoveringAccountHandler(opts: AccountRecoveryOptions): {
  handle: (frame: AccountFrame) => void;
  close: () => void;
} {
  const maxPages = opts.maxPages ?? 10;
  const maxAttempts = opts.maxAttempts ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 1000;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // `undefined`: nothing delivered yet. `null`: the last delivered frame had
  // no history key, so there is no boundary to recover from.
  let last: AccountEventKey | null | undefined;
  let seenSnapshot = false;
  let recovering = false;
  let rerun = false;
  let closed = false;
  let buffer: AccountEventFrame[] = [];

  const deliver = (frame: AccountEventFrame, key: AccountEventKey | null) => {
    if (closed) return;
    last = key;
    opts.onFrame(frame);
  };

  const scan = async (boundary: AccountEventKey) => {
    const newerFirst: AccountHistoryRow[] = [];
    let found = false;
    let cursor: string | null = null;
    for (let page = 0; page < maxPages && !found; page++) {
      const { rows, nextCursor } = await opts.fetchPage(cursor);
      for (const row of rows) {
        const key = rowKey(row);
        if (keyId(key) === keyId(boundary)) {
          found = true;
          break;
        }
        if (key.height < boundary.height) break;
        newerFirst.push(row);
      }
      if (
        !found &&
        rows.length > 0 &&
        rowKey(rows[rows.length - 1]).height < boundary.height
      )
        break;
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    const rows = newerFirst.reverse();
    return {
      found,
      rows: found ? rows : rows.filter((r) => r.block_height > boundary.height),
    };
  };

  /** True when history has reached the first live event buffered so far. */
  const covers = (rows: AccountHistoryRow[]) => {
    const first = buffer.length > 0 ? liveKey(buffer[0]) : null;
    if (!first) return true;
    if (rows.some((r) => keyId(rowKey(r)) === keyId(first))) return true;
    const newest = rows.length > 0 ? rowKey(rows[rows.length - 1]).height : -1;
    return newest >= first.height;
  };

  const recover = async (boundary: AccountEventKey) => {
    recovering = true;
    let status: AccountRecoveryStatus;
    try {
      let result = await scan(boundary);
      let attempt = 1;
      while (!covers(result.rows) && attempt < maxAttempts && !closed) {
        await sleep(retryDelayMs);
        result = await scan(boundary);
        attempt++;
      }
      const delivered = new Set<string>([keyId(boundary)]);
      for (const row of result.rows) {
        const key = rowKey(row);
        delivered.add(keyId(key));
        deliver(rowFrame(row), key);
      }
      const count = result.rows.length;
      status = !result.found
        ? { kind: "boundaryNotFound", delivered: count }
        : covers(result.rows)
          ? { kind: "backfilled", delivered: count }
          : { kind: "historyBehind", delivered: count };
      flush(delivered, boundary.height);
    } catch (err) {
      status = {
        kind: "failed",
        error: err instanceof Error ? err : new Error(String(err)),
      };
      flush(new Set(), -1);
    }
    recovering = false;
    if (!closed) opts.onRecovery?.(status);
    if (rerun && !closed) {
      rerun = false;
      start();
    }
  };

  const flush = (delivered: Set<string>, boundaryHeight: number) => {
    const pending = buffer;
    buffer = [];
    for (const frame of pending) {
      const key = liveKey(frame);
      if (key && (delivered.has(keyId(key)) || key.height < boundaryHeight))
        continue;
      deliver(frame, key);
    }
  };

  const start = () => {
    if (last === undefined) return;
    if (last === null) {
      opts.onRecovery?.({ kind: "unsupported" });
      return;
    }
    void recover(last);
  };

  const handle = (frame: AccountFrame) => {
    if (closed) return;
    if (frame.type === "snapshot") {
      opts.onFrame(frame);
      if (!seenSnapshot) {
        seenSnapshot = true;
        return;
      }
      if (recovering) rerun = true;
      else start();
      return;
    }
    // An error frame (a refused subscribe, a failed authentication) is no
    // account event: it passes straight through and moves no boundary.
    if ((frame as { type: string }).type === "error") {
      opts.onFrame(frame);
      return;
    }
    const event = frame as AccountEventFrame;
    if (recovering) buffer.push(event);
    else deliver(event, liveKey(event));
  };

  return {
    handle,
    close: () => {
      closed = true;
      buffer = [];
    },
  };
}
