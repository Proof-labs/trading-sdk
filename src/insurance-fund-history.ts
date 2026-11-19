import {
  asReadError,
  boundedGatewayJson,
  type BoundedReadOptions,
} from "./bounded-read.js";
import { GatewayReadError } from "./errors.js";
import type { GatewayFetch } from "./gateway-reads.js";

export type InsuranceHistoryStream = "balances" | "activity";
export type InsuranceHistoryPhase = "upgrade" | "tx" | "end_block";
export interface InsuranceHistoryCoordinate {
  blockHeight: bigint;
  phase: InsuranceHistoryPhase;
  txIndex: bigint;
  eventIndex: bigint;
}
export interface InsuranceHistoryEvent extends InsuranceHistoryCoordinate {
  blockTime: string;
  eventType: string;
  /** Engine attributes are strings; unknown attribute names are preserved. */
  payload: Record<string, string>;
  /** Net cash (cash minus debt), NOT equity. Present only in balances. */
  balanceMicroUsdc?: bigint;
  deltaMicroUsdc?: bigint;
}
export interface InsuranceFundHistoryPage {
  poolId: number;
  stream: InsuranceHistoryStream;
  events: InsuranceHistoryEvent[];
  nextCursor: string;
  coverage: {
    mode: "observed_events_only";
    completeFromGenesis: false;
    continuousFrontier: null;
    firstObserved: InsuranceHistoryCoordinate | null;
    lastObserved: InsuranceHistoryCoordinate | null;
  };
}
export interface InsuranceFundHistoryParams {
  poolId: number;
  stream: InsuranceHistoryStream;
  /** One page only, 1–200 observations; default 100. */
  limit?: number;
  /** Opaque pool/stream-bound continuation token. */
  cursor?: string;
}

const I64_MAX = (1n << 63n) - 1n;
function invalid(field: string): never {
  throw new GatewayReadError(
    "malformed",
    field,
    `Invalid insurance history ${field}`,
  );
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}
function decimal(value: unknown, field: string, signed = false): bigint {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !(signed ? /^(?:0|-?[1-9][0-9]*)$/ : /^(?:0|[1-9][0-9]*)$/).test(value)
  )
    invalid(field);
  const n = BigInt(value as string);
  if (n > I64_MAX || n < (signed ? -I64_MAX - 1n : 0n)) invalid(field);
  return n;
}
function coordinate(value: unknown): InsuranceHistoryCoordinate {
  const row = record(value, "coordinate");
  if (
    row.phase !== "upgrade" &&
    row.phase !== "tx" &&
    row.phase !== "end_block"
  )
    invalid("phase");
  const result = {
    blockHeight: decimal(row.block_height, "block_height"),
    phase: row.phase as InsuranceHistoryPhase,
    txIndex: decimal(row.tx_index, "tx_index"),
    eventIndex: decimal(row.event_index, "event_index"),
  };
  if (
    result.blockHeight === 0n ||
    (result.phase !== "tx" && result.txIndex !== 0n)
  )
    invalid("coordinate");
  return result;
}
function compare(
  a: InsuranceHistoryCoordinate,
  b: InsuranceHistoryCoordinate,
): number {
  const phases = { upgrade: 0n, tx: 1n, end_block: 2n };
  const left = [a.blockHeight, phases[a.phase], a.txIndex, a.eventIndex];
  const right = [b.blockHeight, phases[b.phase], b.txIndex, b.eventIndex];
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}
function cursor(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]*$/.test(value)
  )
    invalid("cursor");
  return value;
}
function parameters(
  params: InsuranceFundHistoryParams,
): Required<InsuranceFundHistoryParams> {
  const { poolId, stream, limit = 100, cursor: token = "" } = params;
  if (
    !Number.isInteger(poolId) ||
    poolId < 0 ||
    poolId > 255 ||
    (stream !== "balances" && stream !== "activity") ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    typeof token !== "string" ||
    token.length > 256 ||
    !/^[A-Za-z0-9_-]*$/.test(token)
  ) {
    throw new GatewayReadError(
      "configuration",
      "insuranceHistory",
      "Invalid insurance history request",
    );
  }
  return { poolId, stream, limit, cursor: token };
}

/** Strict, exact-integer decoding. Coverage describes observed records, not a
 * continuous ingestion frontier or a same-state witness. */
export function decodeInsuranceFundHistory(
  value: unknown,
  params: InsuranceFundHistoryParams,
): InsuranceFundHistoryPage {
  const expected = parameters(params);
  return asReadError("insuranceHistory", () => {
    const body = record(value, "page");
    if (
      body.pool_id !== String(expected.poolId) ||
      body.stream !== expected.stream
    ) {
      throw new GatewayReadError(
        "binding",
        "insuranceHistory",
        "Insurance history pool/stream mismatch",
      );
    }
    if (!Array.isArray(body.events) || body.events.length > expected.limit)
      invalid("events");
    const events = body.events.map((value): InsuranceHistoryEvent => {
      const row = record(value, "event");
      const point = coordinate(row);
      if (
        typeof row.block_time !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          row.block_time,
        ) ||
        !Number.isFinite(Date.parse(row.block_time))
      )
        invalid("block_time");
      if (
        typeof row.event_type !== "string" ||
        !/^[a-z][a-z0-9_]{0,127}$/.test(row.event_type)
      )
        invalid("event_type");
      const attrs = record(row.payload, "payload");
      if (
        Object.keys(attrs).length > 128 ||
        Object.values(attrs).some(
          (v) => typeof v !== "string" || v.length > 65536,
        )
      )
        invalid("payload");
      const event: InsuranceHistoryEvent = {
        ...point,
        blockTime: row.block_time,
        eventType: row.event_type,
        payload: { ...attrs } as Record<string, string>,
      };
      if (expected.stream === "balances") {
        if (event.eventType !== "insurance_fund_updated") invalid("event_type");
        event.balanceMicroUsdc = decimal(
          row.balance_micro_usdc,
          "balance_micro_usdc",
          true,
        );
        event.deltaMicroUsdc = decimal(
          row.delta_micro_usdc,
          "delta_micro_usdc",
          true,
        );
      } else if ("balance_micro_usdc" in row || "delta_micro_usdc" in row)
        invalid("activity balance");
      return event;
    });
    for (let i = 1; i < events.length; i++) {
      if (compare(events[i - 1], events[i]) <= 0) invalid("event order");
    }
    const nextCursor = cursor(body.next_cursor);
    if (
      nextCursor &&
      (events.length !== expected.limit || nextCursor === expected.cursor)
    )
      invalid("cursor progress");
    const coverage = record(body.coverage, "coverage");
    if (
      coverage.mode !== "observed_events_only" ||
      coverage.complete_from_genesis !== false ||
      coverage.continuous_frontier !== null
    )
      invalid("coverage");
    const first =
      coverage.first_observed === null
        ? null
        : coordinate(coverage.first_observed);
    const last =
      coverage.last_observed === null
        ? null
        : coordinate(coverage.last_observed);
    if (
      (first === null) !== (last === null) ||
      (first && last && compare(first, last) > 0)
    )
      invalid("coverage bounds");
    // Endpoint bounds may include newer observations, but must cover this page.
    if (
      events.length &&
      (!first ||
        !last ||
        events.some((e) => compare(e, first) < 0 || compare(e, last) > 0))
    )
      invalid("coverage bounds");
    return {
      poolId: expected.poolId,
      stream: expected.stream,
      events,
      nextCursor,
      coverage: {
        mode: "observed_events_only",
        completeFromGenesis: false,
        continuousFrontier: null,
        firstObserved: first,
        lastObserved: last,
      },
    };
  });
}

/** One bounded gateway request. No direct indexer access, retry or inferred history. */
export async function readInsuranceFundHistory(
  base: string,
  transport: GatewayFetch,
  params: InsuranceFundHistoryParams,
  options: BoundedReadOptions = {},
): Promise<InsuranceFundHistoryPage> {
  const expected = parameters(params);
  const query = new URLSearchParams({
    stream: expected.stream,
    limit: String(expected.limit),
  });
  if (expected.cursor) query.set("cursor", expected.cursor);
  const body = await boundedGatewayJson(
    `${base}/v1/history/insurance-funds/${expected.poolId}?${query}`,
    transport,
    options,
  );
  return decodeInsuranceFundHistory(body, expected);
}
