/**
 * An account's holdings at fixed steps, from the gateway's bucketed position
 * read `GET /v1/history/positions/{owner}?interval=…`: for each owner and
 * market, the last snapshot in each step of `[fromMs, toMs)`, plus the exact
 * snapshot where a market went from flat to held (`open`) and back (`close`),
 * so a holding shorter than one step still appears with its start and end.
 * Rows are newest first and paged by an opaque cursor.
 */

import {
  historyInterval,
  historyOwner,
  historySearchParams,
} from "./history.js";

/** The most owners one read may name: an account and its sub-accounts. */
export const HOLDING_STEPS_MAX_OWNERS = 16;

/** Query parameters. Keep every one fixed while following `cursor`. */
export interface HoldingStepFilters {
  /** Market ids to read; omit for every market. */
  markets?: readonly number[];
  /** Inclusive lower bound, Unix epoch milliseconds. */
  fromMs: number;
  /** Exclusive upper bound, Unix epoch milliseconds. */
  toMs: number;
  /** Step width in milliseconds: whole seconds, at most 365 days. Steps are
   *  epoch-aligned by the indexer. */
  stepMs: number;
  /** Page size, 1 to 5000. */
  limit?: number;
  /** A previous page's non-empty `nextCursor`. */
  cursor?: string;
}

/** Why a row is in the result. */
export type HoldingStepKind = "step" | "open" | "close";

/** One position snapshot. */
export interface HoldingStep {
  /** 20-byte owner address, lowercase hex without `0x`. */
  owner: string;
  market: number;
  /** `step`: the market's last snapshot in a step. `open`: the first
   *  snapshot after the market was flat. `close`: the snapshot where it went
   *  flat (`size` "0", `side` null). A step that is also an open or close is
   *  one row with the open/close kind. */
  kind: HoldingStepKind;
  /** `null` when flat. */
  side: "buy" | "sell" | null;
  /** Integer contracts as decimal text; "0" when flat. */
  size: string;
  /** Micro-USDC decimal text as served (may carry a fraction); `null` when
   *  the closed position has no entry price. */
  entryPrice: string | null;
  blockHeight: number;
  /** RFC 3339 block time as served, with its fractional seconds. */
  blockTime: string;
  /** `blockTime` in Unix epoch milliseconds. */
  timestamp: number;
}

export interface HoldingStepPage {
  steps: HoldingStep[];
  /** Pass back as `cursor` for the next page; empty on the last page. */
  nextCursor: string;
}

function fail(problem: string): never {
  throw new Error(`holding steps decode: ${problem}`);
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") fail(`${name} must be a string`);
  return value;
}

function count(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${name} must be a non-negative safe integer`);
  }
  return value as number;
}

function validMarket(market: number): boolean {
  return Number.isInteger(market) && market >= 0 && market <= 0x7fffffff;
}

/** Owners sorted and deduplicated, lowercase hex without `0x`. */
export function holdingStepOwners(owners: readonly string[]): string[] {
  const list = [...new Set(owners.map(historyOwner))].sort();
  if (list.length === 0 || list.length > HOLDING_STEPS_MAX_OWNERS) {
    throw new Error("Invalid holding step owners");
  }
  return list;
}

/** Query string for the route. The first owner (after sorting) goes in the
 *  path; the others go in `owner` as a comma list. */
export function holdingStepSearchParams(
  owners: readonly string[],
  filters: HoldingStepFilters,
): URLSearchParams {
  const others = holdingStepOwners(owners).slice(1);
  if (filters.fromMs === undefined || filters.toMs === undefined) {
    throw new Error("Invalid history range");
  }
  const params = historySearchParams(filters);
  const { stepMs } = filters;
  if (!Number.isSafeInteger(stepMs) || stepMs <= 0 || stepMs % 1000 !== 0) {
    throw new Error("Invalid holding step width");
  }
  params.set("interval", historyInterval(`${stepMs / 1000}s`));
  if (filters.markets !== undefined) {
    const markets = [...new Set(filters.markets)].sort((a, b) => a - b);
    if (markets.length === 0 || !markets.every(validMarket)) {
      throw new Error("Invalid holding step markets");
    }
    params.set("markets", markets.join(","));
  }
  if (others.length > 0) params.set("owner", others.join(","));
  return params;
}

/** Decode one page, checking each row against the requested owners and
 *  markets. A malformed row throws rather than being skipped. */
export function decodeHoldingStepPage(
  value: unknown,
  owners: readonly string[],
  markets?: readonly number[],
): HoldingStepPage {
  const ownerSet = new Set(holdingStepOwners(owners));
  const marketSet = markets === undefined ? undefined : new Set(markets);
  const page = object(value, "page");
  if (!Array.isArray(page.positions)) fail("positions must be an array");
  const nextCursor = text(page.next_cursor, "next_cursor");
  const steps = page.positions.map((value, index): HoldingStep => {
    const at = `positions[${index}]`;
    const row = object(value, at);
    const owner = text(row.owner, `${at}.owner`);
    const market = count(row.market, `${at}.market`);
    if (!ownerSet.has(owner) || (marketSet && !marketSet.has(market))) {
      fail(`${at} is outside the requested owners or markets`);
    }
    const kind = text(row.kind, `${at}.kind`);
    if (kind !== "step" && kind !== "open" && kind !== "close") {
      fail(`${at}.kind must be "step", "open" or "close"`);
    }
    const rawSide = row.side === null ? null : text(row.side, `${at}.side`);
    const side = rawSide === null ? null : rawSide.toLowerCase();
    if (side !== null && side !== "buy" && side !== "sell") {
      fail(`${at}.side must be "buy", "sell" or null`);
    }
    const size = text(row.size, `${at}.size`);
    if (!/^(0|[1-9][0-9]*)$/.test(size)) {
      fail(`${at}.size must be an integer string`);
    }
    const entryPrice =
      row.entry_px === null ? null : text(row.entry_px, `${at}.entry_px`);
    if (entryPrice !== null && !/^\d+(?:\.\d+)?$/.test(entryPrice)) {
      fail(`${at}.entry_px must be a decimal string`);
    }
    const flat = size === "0";
    if (!flat && (side === null || entryPrice === null)) {
      fail(`${at} is an open position without side or entry price`);
    }
    if (kind === "close" && (!flat || side !== null)) {
      fail(`${at} is a close with a size or side`);
    }
    if (kind === "open" && flat) fail(`${at} is an open with no size`);
    const blockTime = text(row.block_time, `${at}.block_time`);
    const timestamp = Date.parse(blockTime);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(blockTime) ||
      !Number.isFinite(timestamp)
    ) {
      fail(`${at}.block_time must be an RFC3339 UTC timestamp`);
    }
    return {
      owner,
      market,
      kind,
      side,
      size,
      entryPrice,
      blockHeight: count(row.block_height, `${at}.block_height`),
      blockTime,
      timestamp,
    };
  });
  return { steps, nextCursor };
}
