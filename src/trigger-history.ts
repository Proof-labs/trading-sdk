import type {
  PositionTriggerHistoryEvent,
  PositionTriggerHistoryEventType,
  PositionTriggerHistoryFilters,
  PositionTriggerHistoryPage,
  TriggerHistoryEventType,
  TriggerHistoryPayloadBase,
  TriggerHistoryTime,
  TriggerMarketHistoryEvent,
  TriggerMarketHistoryEventType,
  TriggerMarketHistoryFilters,
  TriggerMarketHistoryPage,
} from "./types.js";

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = (1n << 32n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const I32_MAX = 0x7fff_ffff;

const OWNER_EVENT_TYPES = new Set<PositionTriggerHistoryEventType>([
  "position_triggers_set",
  "position_triggers_cancelled",
  "position_triggers_invalidated",
  "position_trigger_activated",
  "position_trigger_executed",
  "position_trigger_deferred",
]);

const MARKET_EVENT_TYPES = new Set<TriggerMarketHistoryEventType>([
  "trigger_market_deferred",
  "trigger_market_resumed",
]);

const TRIGGER_REASONS = new Set([
  "position_closed",
  "position_epoch_changed",
  "position_side_changed",
  "below_maintenance",
  "indeterminate_account",
  "market_disabled",
  "mark_unavailable",
  "mark_stale",
  "mark_future_dated",
  "no_eligible_liquidity",
  "self_trade_prevention",
  "work_limit_reached",
  "execution_rejected",
]);

const EXECUTION_RESULTS = new Set([
  "filled",
  "partial",
  "no_fill",
  "rejected",
  "invalidated",
]);

const EXECUTION_STOP_REASONS = new Set([
  "no_eligible_liquidity",
  "self_trade_prevention",
  "work_limit_reached",
]);
const POSITION_INVALIDATION_REASONS = new Set([
  "position_closed",
  "position_epoch_changed",
  "position_side_changed",
]);
const ACCOUNT_DEFERRED_REASONS = new Set([
  "below_maintenance",
  "indeterminate_account",
]);
const MARKET_DEFERRED_REASONS = new Set([
  "market_disabled",
  "mark_unavailable",
  "mark_stale",
  "mark_future_dated",
]);

const EVENT_KEYS = [
  "event_key",
  "block_height",
  "execution_ordinal",
  "event_ordinal",
  "block_time",
  "event_type",
  "owner",
  "market",
  "payload",
] as const;

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`trigger history decode: ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(
      `trigger history decode: ${name} has unexpected or missing fields`,
    );
  }
}

function string(value: unknown, name: string, nonempty = true): string {
  if (typeof value !== "string" || (nonempty && value.length === 0)) {
    throw new Error(`trigger history decode: ${name} must be a string`);
  }
  return value;
}

function unsigned(
  value: unknown,
  name: string,
  maximum = U64_MAX,
  nonzero = false,
): string {
  const text = string(value, name);
  if (!/^(?:0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(
      `trigger history decode: ${name} is not canonical unsigned decimal`,
    );
  }
  const parsed = BigInt(text);
  if (parsed > maximum || (nonzero && parsed === 0n)) {
    throw new Error(`trigger history decode: ${name} is out of range`);
  }
  return text;
}

function signedI64(value: unknown, name: string): string {
  const text = string(value, name);
  if (!/^(?:0|-?[1-9][0-9]*)$/.test(text)) {
    throw new Error(
      `trigger history decode: ${name} is not canonical signed decimal`,
    );
  }
  const parsed = BigInt(text);
  if (parsed < I64_MIN || parsed > I64_MAX) {
    throw new Error(`trigger history decode: ${name} is outside i64`);
  }
  return text;
}

function owner(value: unknown, name: string): string {
  const text = string(value, name);
  if (!/^[0-9a-f]{40}$/.test(text)) {
    throw new Error(`trigger history decode: ${name} is not a canonical owner`);
  }
  return text;
}

function rfc3339(value: unknown, name: string): string {
  const text = string(value, name);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      text,
    ) ||
    Number.isNaN(Date.parse(text))
  ) {
    throw new Error(`trigger history decode: ${name} is not RFC3339`);
  }
  return text;
}

function enumString<T extends string>(
  value: unknown,
  allowed: Set<T>,
  name: string,
): T {
  const text = string(value, name);
  if (!allowed.has(text as T)) {
    throw new Error(`trigger history decode: unknown ${name} ${text}`);
  }
  return text as T;
}

function payloadRecord(value: unknown): Record<string, string> {
  const row = object(value, "payload");
  for (const [key, item] of Object.entries(row)) {
    if (typeof item !== "string") {
      throw new Error(
        `trigger history decode: payload.${key} must remain a string`,
      );
    }
  }
  return row as Record<string, string>;
}

function requireUnsignedPayload(
  payload: Record<string, string>,
  keys: readonly string[],
): void {
  for (const key of keys) unsigned(payload[key], `payload.${key}`);
}

function requireNonemptyPayload(
  payload: Record<string, string>,
  key: string,
): string {
  return string(payload[key], `payload.${key}`);
}

function validatePayload(
  payload: Record<string, string>,
  eventType: TriggerHistoryEventType,
  eventKey: string,
  blockHeight: string,
  executionOrdinal: string,
  eventOrdinal: string,
  market: string,
  eventOwner: string | null,
): TriggerHistoryPayloadBase {
  unsigned(payload.block_height, "payload.block_height", U64_MAX, true);
  unsigned(payload.execution_ordinal, "payload.execution_ordinal");
  unsigned(payload.event_ordinal, "payload.event_ordinal", U32_MAX);
  unsigned(payload.market, "payload.market", BigInt(I32_MAX));
  if (
    payload.event_key !== eventKey ||
    payload.block_height !== blockHeight ||
    payload.execution_ordinal !== executionOrdinal ||
    payload.event_ordinal !== eventOrdinal ||
    payload.market !== market
  ) {
    throw new Error(
      "trigger history decode: payload identity disagrees with event",
    );
  }

  if (OWNER_EVENT_TYPES.has(eventType as PositionTriggerHistoryEventType)) {
    if (
      eventOwner === null ||
      owner(payload.owner, "payload.owner") !== eventOwner
    ) {
      throw new Error(
        "trigger history decode: payload owner disagrees with event",
      );
    }
    requireUnsignedPayload(payload, ["position_epoch", "group_id"]);
  } else if ("owner" in payload) {
    throw new Error(
      "trigger history decode: shared market payload carries owner",
    );
  }

  switch (eventType) {
    case "position_triggers_set": {
      requireUnsignedPayload(payload, [
        "client_group_id",
        "stop_limb_id",
        "stop_client_trigger_id",
        "take_profit_limb_id",
        "take_profit_client_trigger_id",
        "accepted_height",
        "active_from_height",
        "replaced_group_id",
      ]);
      if (
        BigInt(payload.active_from_height) !==
        BigInt(payload.accepted_height) + 1n
      ) {
        throw new Error("trigger history decode: invalid active_from_height");
      }
      if (payload.stop_limb_id === "0" && payload.take_profit_limb_id === "0") {
        throw new Error(
          "trigger history decode: set event has no trigger limbs",
        );
      }
      break;
    }
    case "position_triggers_cancelled":
    case "position_triggers_invalidated":
      break;
    case "position_trigger_activated":
      requireUnsignedPayload(payload, [
        "limb_id",
        "client_group_id",
        "client_trigger_id",
        "trigger_price",
        "frozen_mark",
        "limit_price",
        "requested_quantity",
        "execution_order_id",
      ]);
      enumString(
        payload.limb_kind,
        new Set(["stop_loss", "take_profit"] as const),
        "payload.limb_kind",
      );
      break;
    case "position_trigger_executed":
      requireUnsignedPayload(payload, [
        "limb_id",
        "client_group_id",
        "client_trigger_id",
        "trigger_price",
        "frozen_mark",
        "limit_price",
        "requested_quantity",
        "filled_quantity",
        "residual_quantity",
        "execution_order_id",
      ]);
      enumString(
        payload.limb_kind,
        new Set(["stop_loss", "take_profit"] as const),
        "payload.limb_kind",
      );
      enumString(payload.result, EXECUTION_RESULTS, "payload.result");
      signedI64(payload.total_fee, "payload.total_fee");
      string(payload.reason, "payload.reason", false);
      if (payload.reason !== "" && !TRIGGER_REASONS.has(payload.reason)) {
        throw new Error(
          `trigger history decode: unknown payload.reason ${payload.reason}`,
        );
      }
      if (
        BigInt(payload.filled_quantity) + BigInt(payload.residual_quantity) !==
        BigInt(payload.requested_quantity)
      ) {
        throw new Error(
          "trigger history decode: executed quantities do not conserve",
        );
      }
      {
        const requested = BigInt(payload.requested_quantity);
        const filled = BigInt(payload.filled_quantity);
        const residual = BigInt(payload.residual_quantity);
        const reason = payload.reason;
        const valid =
          (payload.result === "filled" &&
            filled === requested &&
            residual === 0n &&
            reason === "") ||
          (payload.result === "partial" &&
            filled > 0n &&
            residual > 0n &&
            EXECUTION_STOP_REASONS.has(reason)) ||
          (payload.result === "no_fill" &&
            filled === 0n &&
            residual > 0n &&
            EXECUTION_STOP_REASONS.has(reason)) ||
          (payload.result === "rejected" &&
            filled === 0n &&
            residual > 0n &&
            reason === "execution_rejected") ||
          (payload.result === "invalidated" &&
            filled === 0n &&
            residual > 0n &&
            POSITION_INVALIDATION_REASONS.has(reason));
        if (!valid) {
          throw new Error(
            "trigger history decode: result, quantities, and reason disagree",
          );
        }
      }
      break;
    case "position_trigger_deferred":
      requireUnsignedPayload(payload, [
        "limb_id",
        "client_group_id",
        "client_trigger_id",
        "trigger_price",
        "frozen_mark",
        "requested_quantity",
      ]);
      enumString(
        payload.limb_kind,
        new Set(["stop_loss", "take_profit"] as const),
        "payload.limb_kind",
      );
      enumString(payload.reason, ACCOUNT_DEFERRED_REASONS, "payload.reason");
      break;
    case "trigger_market_deferred":
      enumString(payload.reason, MARKET_DEFERRED_REASONS, "payload.reason");
      break;
    case "trigger_market_resumed":
      enumString(
        payload.previous_reason,
        MARKET_DEFERRED_REASONS,
        "payload.previous_reason",
      );
      break;
  }

  // Preserve every string-valued engine attribute, including additive fields
  // this SDK version does not interpret yet.
  return payload as unknown as TriggerHistoryPayloadBase;
}

function decodeEvent(
  value: unknown,
  expectedOwner: string | null,
  expectedMarket: string | null,
  scope: "owner" | "market",
): PositionTriggerHistoryEvent | TriggerMarketHistoryEvent {
  const row = object(value, "event");
  exactKeys(row, EVENT_KEYS, "event");
  const eventKey = string(row.event_key, "event_key");
  const blockHeight = unsigned(row.block_height, "block_height", U64_MAX, true);
  const executionOrdinal = unsigned(row.execution_ordinal, "execution_ordinal");
  const eventOrdinal = unsigned(row.event_ordinal, "event_ordinal", U32_MAX);
  if (eventKey !== `${blockHeight}:${executionOrdinal}:${eventOrdinal}`) {
    throw new Error("trigger history decode: event_key is not canonical");
  }
  const blockTime = rfc3339(row.block_time, "block_time");
  const eventType = string(
    row.event_type,
    "event_type",
  ) as TriggerHistoryEventType;
  if (
    (scope === "owner" &&
      !OWNER_EVENT_TYPES.has(eventType as PositionTriggerHistoryEventType)) ||
    (scope === "market" &&
      !MARKET_EVENT_TYPES.has(eventType as TriggerMarketHistoryEventType))
  ) {
    throw new Error(
      `trigger history decode: ${eventType} is invalid for ${scope} history`,
    );
  }
  const eventOwner = row.owner === null ? null : owner(row.owner, "owner");
  if (
    (scope === "owner" &&
      (eventOwner === null || eventOwner !== expectedOwner)) ||
    (scope === "market" && eventOwner !== null)
  ) {
    throw new Error("trigger history decode: owner does not match route scope");
  }
  const market = unsigned(row.market, "market", BigInt(I32_MAX));
  if (expectedMarket !== null && market !== expectedMarket) {
    throw new Error(
      "trigger history decode: market does not match route scope",
    );
  }
  const payload = validatePayload(
    payloadRecord(row.payload),
    eventType,
    eventKey,
    blockHeight,
    executionOrdinal,
    eventOrdinal,
    market,
    eventOwner,
  );
  const decoded = {
    eventKey,
    blockHeight,
    executionOrdinal,
    eventOrdinal,
    blockTime,
    eventType,
    owner: eventOwner,
    market,
    payload,
  };
  return decoded as PositionTriggerHistoryEvent | TriggerMarketHistoryEvent;
}

function assertNewestFirst(
  events: Array<PositionTriggerHistoryEvent | TriggerMarketHistoryEvent>,
): void {
  const coordinate = (
    event: PositionTriggerHistoryEvent | TriggerMarketHistoryEvent,
  ) =>
    [
      BigInt(event.blockHeight),
      BigInt(event.executionOrdinal),
      BigInt(event.eventOrdinal),
    ] as const;
  for (let i = 1; i < events.length; i += 1) {
    const previous = coordinate(events[i - 1]);
    const current = coordinate(events[i]);
    const descending =
      previous[0] > current[0] ||
      (previous[0] === current[0] && previous[1] > current[1]) ||
      (previous[0] === current[0] &&
        previous[1] === current[1] &&
        previous[2] > current[2]);
    if (!descending) {
      throw new Error(
        "trigger history decode: page is not strictly newest-first by chain coordinate",
      );
    }
  }
}

/** Decode the exact owner-history envelope and preserve every u64 as a string. */
export function decodePositionTriggerHistoryPage(
  value: unknown,
  expectedOwner: string,
  expectedMarket?: number,
): PositionTriggerHistoryPage {
  const canonicalOwner = owner(expectedOwner.toLowerCase(), "expected owner");
  const market =
    expectedMarket === undefined
      ? null
      : validateTriggerHistoryMarket(expectedMarket).toString();
  const row = object(value, "owner page");
  exactKeys(row, ["trigger_events", "next_cursor"], "owner page");
  if (!Array.isArray(row.trigger_events)) {
    throw new Error("trigger history decode: trigger_events must be an array");
  }
  const events = row.trigger_events.map((event) =>
    decodeEvent(event, canonicalOwner, market, "owner"),
  ) as PositionTriggerHistoryEvent[];
  assertNewestFirst(events);
  return {
    triggerEvents: events,
    nextCursor: string(row.next_cursor, "next_cursor", false),
  };
}

/** Decode the exact shared-market envelope; owner-bearing rows are refused. */
export function decodeTriggerMarketHistoryPage(
  value: unknown,
  expectedMarket: number,
): TriggerMarketHistoryPage {
  const market = validateTriggerHistoryMarket(expectedMarket).toString();
  const row = object(value, "market page");
  exactKeys(row, ["trigger_market_events", "next_cursor"], "market page");
  if (!Array.isArray(row.trigger_market_events)) {
    throw new Error(
      "trigger history decode: trigger_market_events must be an array",
    );
  }
  const events = row.trigger_market_events.map((event) =>
    decodeEvent(event, null, market, "market"),
  ) as TriggerMarketHistoryEvent[];
  assertNewestFirst(events);
  return {
    triggerMarketEvents: events,
    nextCursor: string(row.next_cursor, "next_cursor", false),
  };
}

export function validateTriggerHistoryMarket(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > I32_MAX) {
    throw new Error(
      `trigger history: market must be an integer in 0..=${I32_MAX}`,
    );
  }
  return value;
}

function filterTime(value: TriggerHistoryTime, name: string): string {
  if (typeof value === "bigint") {
    if (value < I64_MIN || value > I64_MAX) {
      throw new Error(
        `trigger history: ${name} epoch milliseconds are outside i64`,
      );
    }
    return value.toString();
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `trigger history: ${name} must be a safe epoch-millisecond integer`,
      );
    }
    return value.toString();
  }
  const text = string(value, name);
  if (/^-?(?:0|[1-9][0-9]*)$/.test(text)) {
    const parsed = BigInt(text);
    if (parsed < I64_MIN || parsed > I64_MAX) {
      throw new Error(
        `trigger history: ${name} epoch milliseconds are outside i64`,
      );
    }
    return text;
  }
  return rfc3339(text, name);
}

function commonParams(filters: TriggerMarketHistoryFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from !== undefined)
    params.set("from", filterTime(filters.from, "from"));
  if (filters.to !== undefined) params.set("to", filterTime(filters.to, "to"));
  if (filters.limit !== undefined) {
    if (
      !Number.isInteger(filters.limit) ||
      filters.limit < 1 ||
      filters.limit > 1_000
    ) {
      throw new Error("trigger history: limit must be an integer in 1..=1000");
    }
    params.set("limit", String(filters.limit));
  }
  if (filters.cursor !== undefined) {
    if (typeof filters.cursor !== "string" || filters.cursor.length === 0) {
      throw new Error(
        "trigger history: cursor must be a non-empty opaque string",
      );
    }
    params.set("cursor", filters.cursor);
  }
  return params;
}

export function positionTriggerHistorySearchParams(
  filters: PositionTriggerHistoryFilters = {},
): URLSearchParams {
  const params = commonParams(filters);
  if (filters.market !== undefined) {
    params.set("market", String(validateTriggerHistoryMarket(filters.market)));
  }
  return params;
}

export function triggerMarketHistorySearchParams(
  filters: TriggerMarketHistoryFilters = {},
): URLSearchParams {
  return commonParams(filters);
}
