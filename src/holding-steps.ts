/**
 * An account's holdings at fixed steps, from the gateway's bucketed position
 * read `GET /v1/history/positions/{owner}?interval=…`: for each owner and
 * market, the last snapshot in each step of `[fromMs, toMs)`, plus each
 * flat→held (`open`) and held→flat (`close`) change (`transitions=true`), so
 * a holding shorter than one step still appears. Rows are newest first and
 * paged by an opaque cursor.
 */

import {
  decodeHistoryPositionsPage,
  historyInterval,
  historyOwner,
  historySearchParams,
} from "./history.js";

// Server limits, checked before fetching. Internal: the server owns them.
export const HOLDING_STEPS_MAX_OWNERS = 16;
export const HOLDING_STEPS_MAX_MARKETS = 200;
/** Also the default page size; keeps a page under the gateway's 1 MiB cap. */
export const HOLDING_STEPS_MAX_LIMIT = 3000;
export const HOLDING_STEPS_MAX_STEPS = 5000;

/** Query parameters. Keep every one fixed while following `cursor`. */
export interface HoldingStepFilters {
  /** Market ids to read; omit for every market. */
  markets?: readonly number[];
  /** Inclusive lower bound, Unix epoch milliseconds. */
  fromMs: number;
  /** Exclusive upper bound, Unix epoch milliseconds. */
  toMs: number;
  /** Step width in milliseconds, whole seconds. Steps are epoch-aligned by
   *  the indexer. */
  stepMs: number;
  /** Page size; defaults to the largest the SDK sends. */
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
  /** `step`: the market's last snapshot in a step. `close`: the exact
   *  snapshot where it went flat (`size` "0", `side` null). `open`: the first
   *  sampled snapshot after the market was flat, so up to one sample interval
   *  after the real open. A step that is also an open or close is one row
   *  with the open/close kind.
   *
   *  A `close` with no held row before it (older, so later in the result) is
   *  either a holding opened and closed between two samples, or one opened
   *  before `fromMs` that closed within one sample of it. Rows come newest
   *  first, so judge this only after reading every page. */
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
  const limit = filters.limit ?? HOLDING_STEPS_MAX_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > HOLDING_STEPS_MAX_LIMIT
  ) {
    throw new Error("Invalid history limit");
  }
  const params = historySearchParams({ ...filters, limit });
  const { stepMs } = filters;
  if (!Number.isSafeInteger(stepMs) || stepMs <= 0 || stepMs % 1000 !== 0) {
    throw new Error("Invalid holding step width");
  }
  params.set("interval", historyInterval(`${stepMs / 1000}s`));
  // As the indexer counts steps: whole seconds of the window (truncated),
  // integer-divided by the step in seconds.
  const spanSeconds = Math.trunc((filters.toMs - filters.fromMs) / 1000);
  if (Math.trunc(spanSeconds / (stepMs / 1000)) > HOLDING_STEPS_MAX_STEPS) {
    throw new Error("Too many holding steps");
  }
  if (filters.markets !== undefined) {
    const markets = [...new Set(filters.markets)].sort((a, b) => a - b);
    if (
      markets.length === 0 ||
      markets.length > HOLDING_STEPS_MAX_MARKETS ||
      !markets.every(validMarket)
    ) {
      throw new Error("Invalid holding step markets");
    }
    params.set("markets", markets.join(","));
  }
  if (others.length > 0) params.set("owner", others.join(","));
  params.set("transitions", "true");
  return params;
}

/** Decode one page, checking each row against the requested owners and
 *  markets. A malformed row throws rather than being skipped. Rows decode
 *  as in `queryHistoryPositionsPage`, plus `kind` and `timestamp`. */
export function decodeHoldingStepPage(
  value: unknown,
  owners: readonly string[],
  markets?: readonly number[],
): HoldingStepPage {
  const page = decodeHistoryPositionsPage(
    value,
    holdingStepOwners(owners),
    markets,
  );
  const raw = (value as { positions: Record<string, unknown>[] }).positions;
  const steps = page.positions.map((position, index): HoldingStep => {
    const at = `positions[${index}]`;
    const kind = raw[index].kind;
    if (kind !== "step" && kind !== "open" && kind !== "close") {
      fail(`${at}.kind must be "step", "open" or "close"`);
    }
    const { size } = position;
    if (!/^(0|[1-9][0-9]*)$/.test(size)) {
      fail(`${at}.size must be an integer string`);
    }
    // The shared decoder admits only buy/sell in either case.
    const side = (position.side?.toLowerCase() ?? null) as HoldingStep["side"];
    const flat = size === "0";
    if (kind === "close" && (!flat || side !== null)) {
      fail(`${at} is a close with a size or side`);
    }
    if (kind === "open" && flat) fail(`${at} is an open with no size`);
    return {
      owner: position.owner,
      market: position.market,
      kind,
      side,
      size,
      entryPrice: position.entryPrice,
      blockHeight: position.blockHeight,
      blockTime: position.blockTime,
      timestamp: Date.parse(position.blockTime),
    };
  });
  return { steps, nextCursor: page.nextCursor };
}
