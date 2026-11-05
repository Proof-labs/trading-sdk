import {
  I64_MAX,
  MAX_DATE_MS,
  hexAddress,
  invalidRead,
  marketId,
  rfc3339,
  type HexAddress,
  type MarketId,
} from "./read-values.js";
import type { BoundedReadOptions } from "./bounded-read.js";
import type { GatewayReadError } from "./errors.js";

/** Defaults and caps of the indexer history server. It clamps a limit outside
 * its range; the SDK refuses one, so a page is never silently shorter. */
const DEFAULT_FUNDING_PAYMENTS_LIMIT = 200;
const MAX_FUNDING_PAYMENTS_LIMIT = 1000;
const DEFAULT_ACCOUNT_EVENTS_LIMIT = 500;
const MAX_ACCOUNT_EVENTS_LIMIT = 5000;
const MAX_CURSOR_LENGTH = 4096;
/** The indexer stores markets as signed i32. */
const INDEXER_MAX_MARKET = 0x7fff_ffff;

/** Half-open block-time window, epoch ms: `fromMs` inclusive, `toMs`
 * exclusive. Keep every filter fixed when passing a cursor back. */
interface HistoryPageOptions {
  fromMs?: number;
  toMs?: number;
  limit?: number;
  /** Opaque indexer cursor from the previous page's `nextCursor`. */
  cursor?: string;
}

export interface FundingPaymentsOptions
  extends HistoryPageOptions, BoundedReadOptions {
  market?: number;
  /** 1–1000; defaults to 200. */
  limit?: number;
}
/** One `funding_settled` account event: funding paid or received on one
 * market at one funding settlement. */
export interface FundingPayment {
  owner: HexAddress;
  market: MarketId;
  /** Signed micro-USDC (6 dp), exactly as the engine emitted it. */
  payment: bigint;
  blockHeight: bigint;
  /** RFC3339 with up to nanosecond precision, as indexed. */
  blockTime: string;
}
export interface FundingPaymentsPage {
  /** Newest first. */
  payments: FundingPayment[];
  /** Absent on the last page. */
  nextCursor?: string;
}

export interface AccountEventsOptions extends HistoryPageOptions {
  /** Required by the indexer, which has no default direction. */
  order: "asc" | "desc";
  /** One indexed event type, e.g. `binary_issued_from_mtm`. */
  eventType?: string;
  /** 1–5000; defaults to 500. */
  limit?: number;
  signal?: AbortSignal;
}
/** One indexed account event. The payload is the engine event's attributes,
 * verbatim; its fields depend on `eventType`. */
export interface AccountEvent {
  eventId: bigint;
  owner: HexAddress;
  blockHeight: bigint;
  blockTime: string;
  /** Uppercase hex transaction hash; empty for an event a block emits
   * outside any transaction. */
  txHash: string;
  eventIndex: number;
  /** The transaction's position in its block, present only when the block
   * carries the same transaction hash more than once. */
  txPosition?: number;
  eventType: string;
  payload: Record<string, unknown>;
}
export interface AccountEventsPage {
  /** In the requested order of (blockTime, eventId). */
  events: AccountEvent[];
  /** Absent on the last page. */
  nextCursor?: string;
}

function invalid(
  read: string,
  field: string,
  kind: GatewayReadError["kind"] = "malformed",
): never {
  return invalidRead(`${read}.${field}`, kind);
}
function object(value: unknown, read: string, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(read, field);
  return value as Record<string, unknown>;
}
function count(value: unknown, read: string, field: string): bigint {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    invalid(read, field);
  return BigInt(value as number);
}
function cursor(value: unknown, read: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_CURSOR_LENGTH ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    )
  )
    invalid(read, "cursor");
  return value;
}

function pageParams(
  read: string,
  options: HistoryPageOptions,
  defaultLimit: number,
  maxLimit: number,
): { params: URLSearchParams; limit: number } {
  const params = new URLSearchParams();
  for (const [key, name] of [
    ["fromMs", "from"],
    ["toMs", "to"],
  ] as const) {
    const ms = options[key];
    if (ms === undefined) continue;
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_DATE_MS)
      invalid(read, "window");
    params.set(name, String(ms));
  }
  if (
    options.fromMs !== undefined &&
    options.toMs !== undefined &&
    options.toMs <= options.fromMs
  )
    invalid(read, "window");
  const limit = options.limit ?? defaultLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit)
    invalid(read, "limit");
  params.set("limit", String(limit));
  if (options.cursor !== undefined && options.cursor !== "")
    params.set("cursor", cursor(options.cursor, read));
  return { params, limit };
}

/** Rows ≤ limit, and a next cursor only after a full page that moved on. */
function pageCursor(
  read: string,
  rows: unknown,
  next: unknown,
  limit: number,
  options: HistoryPageOptions,
): { rows: unknown[]; nextCursor: string } {
  if (!Array.isArray(rows) || rows.length > limit) invalid(read, "page size");
  const nextCursor = cursor(next, read);
  if (nextCursor && (rows.length !== limit || nextCursor === options.cursor))
    invalid(read, "non-progressing or truncated page");
  return { rows, nextCursor };
}

function blockTime(
  value: unknown,
  read: string,
  options: HistoryPageOptions,
): { raw: string; nanos: bigint } {
  const time = rfc3339(value, `${read}.block time`);
  if (
    (options.fromMs !== undefined &&
      time.nanos < BigInt(options.fromMs) * 1_000_000n) ||
    (options.toMs !== undefined &&
      time.nanos >= BigInt(options.toMs) * 1_000_000n)
  )
    invalid(read, "row outside window");
  return time;
}

const FUNDING = "funding payments";

export function fundingPaymentsSearchParams(
  owner: string,
  options: FundingPaymentsOptions,
): URLSearchParams {
  hexAddress(owner, `${FUNDING}.owner`);
  const { params } = pageParams(
    FUNDING,
    options,
    DEFAULT_FUNDING_PAYMENTS_LIMIT,
    MAX_FUNDING_PAYMENTS_LIMIT,
  );
  if (options.market !== undefined) {
    marketId(options.market);
    if (options.market > INDEXER_MAX_MARKET) invalid(FUNDING, "market");
    params.set("market", String(options.market));
  }
  return params;
}

/** One newest-first indexed page; not proof the indexer has caught up. */
export function decodeFundingPaymentsPage(
  value: unknown,
  owner: string,
  options: FundingPaymentsOptions,
): FundingPaymentsPage {
  const limit = Number(
    fundingPaymentsSearchParams(owner, options).get("limit"),
  );
  const page = object(value, FUNDING, "page");
  const { rows, nextCursor } = pageCursor(
    FUNDING,
    page.funding_payments,
    page.next_cursor,
    limit,
    options,
  );
  let previous: bigint | undefined;
  const payments = rows.map((raw): FundingPayment => {
    const row = object(raw, FUNDING, "payment");
    if (row.owner !== owner) invalid(FUNDING, "owner mismatch", "binding");
    if (options.market !== undefined && row.market !== options.market)
      invalid(FUNDING, "market mismatch", "binding");
    const time = blockTime(row.block_time, FUNDING, options);
    if (previous !== undefined && time.nanos > previous)
      invalid(FUNDING, "unordered payment");
    previous = time.nanos;
    if (
      typeof row.payment !== "string" ||
      row.payment.length > 20 ||
      !/^(0|-?[1-9][0-9]*)$/.test(row.payment)
    )
      invalid(FUNDING, "payment");
    const payment = BigInt(row.payment);
    if (payment < -I64_MAX - 1n || payment > I64_MAX)
      invalid(FUNDING, "payment");
    return {
      owner: owner as HexAddress,
      market: marketId(row.market),
      payment,
      blockHeight: count(row.block_height, FUNDING, "block height"),
      blockTime: time.raw,
    };
  });
  return { payments, ...(nextCursor ? { nextCursor } : {}) };
}

const EVENTS = "account events";

/** Query parameters for `GET /v1/history/account-events`, as the raw
 * `reads().accountEvents` takes them. */
export function accountEventsParams(
  owner: string,
  options: AccountEventsOptions,
): {
  owner: string;
  order: "asc" | "desc";
  event_type?: string;
  limit: number;
  cursor?: string;
  from?: string;
  to?: string;
} {
  hexAddress(owner, `${EVENTS}.owner`);
  if (options.order !== "asc" && options.order !== "desc")
    invalid(EVENTS, "order");
  if (
    options.eventType !== undefined &&
    !/^[a-z0-9_]{1,64}$/.test(options.eventType)
  )
    invalid(EVENTS, "event type");
  const { params, limit } = pageParams(
    EVENTS,
    options,
    DEFAULT_ACCOUNT_EVENTS_LIMIT,
    MAX_ACCOUNT_EVENTS_LIMIT,
  );
  const from = params.get("from");
  const to = params.get("to");
  const next = params.get("cursor");
  return {
    owner,
    order: options.order,
    ...(options.eventType !== undefined
      ? { event_type: options.eventType }
      : {}),
    limit,
    ...(next !== null ? { cursor: next } : {}),
    ...(from !== null ? { from } : {}),
    ...(to !== null ? { to } : {}),
  };
}

/** One indexed page in the requested order; not proof the indexer has caught
 * up. Payloads are returned verbatim and not validated per event type. */
export function decodeAccountEventsPage(
  value: unknown,
  owner: string,
  options: AccountEventsOptions,
): AccountEventsPage {
  const { limit } = accountEventsParams(owner, options);
  const page = object(value, EVENTS, "page");
  const { rows, nextCursor } = pageCursor(
    EVENTS,
    page.account_events,
    page.next_cursor,
    limit,
    options,
  );
  let previous: { nanos: bigint; id: bigint } | undefined;
  const events = rows.map((raw): AccountEvent => {
    const row = object(raw, EVENTS, "event");
    if (row.owner !== owner) invalid(EVENTS, "owner mismatch", "binding");
    if (typeof row.event_type !== "string" || row.event_type === "")
      invalid(EVENTS, "event type");
    if (options.eventType !== undefined && row.event_type !== options.eventType)
      invalid(EVENTS, "event type mismatch", "binding");
    const eventId = count(row.event_id, EVENTS, "event id");
    const time = blockTime(row.block_time, EVENTS, options);
    if (previous) {
      const ascending =
        time.nanos > previous.nanos ||
        (time.nanos === previous.nanos && eventId > previous.id);
      const descending =
        time.nanos < previous.nanos ||
        (time.nanos === previous.nanos && eventId < previous.id);
      if (options.order === "asc" ? !ascending : !descending)
        invalid(EVENTS, "duplicate or unordered event");
    }
    previous = { nanos: time.nanos, id: eventId };
    if (
      typeof row.tx_hash !== "string" ||
      !/^([0-9A-Fa-f]{64})?$/.test(row.tx_hash)
    )
      invalid(EVENTS, "tx hash");
    const eventIndex = count(row.event_index, EVENTS, "event index");
    const txPosition =
      row.tx_position === undefined
        ? undefined
        : Number(count(row.tx_position, EVENTS, "tx position"));
    return {
      eventId,
      owner: owner as HexAddress,
      blockHeight: count(row.block_height, EVENTS, "block height"),
      blockTime: time.raw,
      txHash: row.tx_hash.toUpperCase(),
      eventIndex: Number(eventIndex),
      ...(txPosition !== undefined ? { txPosition } : {}),
      eventType: row.event_type,
      payload: object(row.payload, EVENTS, "payload"),
    };
  });
  return { events, ...(nextCursor ? { nextCursor } : {}) };
}
