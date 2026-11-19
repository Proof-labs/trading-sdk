import { asReadError, boundedGatewayJson } from "./bounded-read.js";
import type { BoundedReadOptions } from "./bounded-read.js";
import { marketsSnapshotViewFromWasm } from "./codec-adapter.js";
import { GatewayReadError } from "./errors.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import { MARKETS_SNAPSHOT_TIMEOUT_MS } from "./market-snapshot.js";
import { chainPin } from "./read-values.js";
import type {
  FeeTier,
  MarketOpenInterest,
  MarketStatus,
  MarkSourceMode,
  PriceComparison,
} from "./types.js";
import { getWasm, ready } from "./wasm-loader.js";

/** A market's governed status as a read reports it: the engine's
 *  `MarketStatus`, or `"Unknown"` for a status this SDK does not name. Never
 *  read `"Unknown"` as trading. */
export type MarketStatusReading = MarketStatus | "Unknown";

/** A market as the node's version 2 markets snapshot lists it (proof-wire
 *  `query_v2::Market`). `null` is a value the market does not have. */
export interface MarketView {
  market: number;
  ticker: string | null;
  kind:
    | { type: "Perpetual" }
    | {
        type: "Conditional" | "PredictionBinary";
        eventId: number;
        branch: "Yes" | "No" | "Unknown";
      }
    | { type: "Unknown" };
  szDecimals: number;
  tickSize: bigint | null;
  lotSize: bigint | null;
  imBps: number;
  mmBps: number;
  takerFeeBps: number;
  makerFeeBps: number;
  feeTiers: FeeTier[];
  /** `null` when the market pays no funding. */
  fundingIntervalMs: bigint | null;
  maxFundingRateBps: number;
  maxPositionSize: bigint | null;
  maxOpenInterest: bigint | null;
  /** Resting orders older than this are cancelled; `null` when they rest
   *  until cancelled. */
  defaultTtlMs: bigint | null;
  /** How a perpetual's mark price is derived; `null` for event books, which
   *  mark off their own book. */
  mark: {
    source: MarkSourceMode | "Unknown";
    /** `null` when the guard is unset: no mark until governance sets it. */
    maxOracleAgeMs: bigint | null;
    /** Top-of-book spread above which the book mid leaves the median. */
    maxSpreadBps: number;
    /** Oldest composite exchange price the median accepts. */
    cexCompositeMaxAgeMs: bigint;
  } | null;
  status: MarketStatusReading;
  /** Effective funding dead-band half-width in bps; `null` when the market
   *  pays no funding. */
  fundingDeadBandBps: number | null;
  /** Effective funding interest leg per 8 hours, in units of 1e-8; `null`
   *  when the market pays no funding. */
  fundingInterestRate: number | null;
}

/** An event as the node's version 2 markets snapshot lists it (proof-wire
 *  `query_v2::Event`). */
export interface EventView {
  eventId: number;
  binaryMarket: number;
  question: string;
  settlementMs: bigint;
  resolutionWindowMs: bigint;
  status: "Trading" | "PreResolution" | "Resolved" | "Unknown";
  /** `null` until the event resolves. */
  outcome: "Yes" | "No" | "Void" | "Unknown" | null;
  createdMs: bigint;
  resolvedMs: bigint | null;
  resolutionSource:
    | {
        type: "MarketOracle";
        /** Yes when this market's oracle price compares to `strikePrice` as
         *  `comparison` says. */
        market: number;
        strikePrice: bigint;
        comparison: PriceComparison | "Unknown";
      }
    | { type: "RelayerAttested" }
    | { type: "Unknown" };
  attachedConditionals: {
    underlyingMarket: number;
    yesMarket: number;
    noMarket: number;
  }[];
}

/** The node's version 2 markets snapshot (`GET /v2/markets-snapshot`): every
 *  market with its status, every event and each market's open interest, from
 *  one read at `height` of the pinned chain. It carries no witness. */
export interface MarketsSnapshotView {
  chainId: Uint8Array;
  height: bigint;
  markets: MarketView[];
  events: EventView[];
  /** Long and short open interest per market that has had positions, in
   *  ascending market order; a market missing from the list has none. */
  openInterest: MarketOpenInterest[];
}

/** Decode a complete `GET /v2/markets-snapshot` body bound to
 *  `expectedChain`, in the Rust core. */
export function decodeMarketsSnapshotView(
  body: Uint8Array,
  expectedChain: Uint8Array,
): MarketsSnapshotView {
  return marketsSnapshotViewFromWasm(
    getWasm().decode_markets_snapshot_view(body, expectedChain),
  );
}

/** Gateway-only, bounded one-shot read of `GET /v2/markets-snapshot`, bound
 *  to `expectedChain`. No retry, node fallback or witness. */
export async function readMarketsSnapshotView(
  gatewayUrl: string,
  expectedChain: Uint8Array,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<MarketsSnapshotView> {
  const chain = chainPin(expectedChain);
  const response = await boundedGatewayJson(
    `${gatewayUrl.replace(/\/+$/, "")}/v2/markets-snapshot`,
    transport,
    { ...options, timeoutMs: options.timeoutMs ?? MARKETS_SNAPSHOT_TIMEOUT_MS },
    { prepare: ready },
  );
  try {
    return asReadError("market snapshot", () =>
      decodeMarketsSnapshotView(
        new TextEncoder().encode(JSON.stringify(response)),
        chain,
      ),
    );
  } catch (error) {
    // A snapshot of another chain or an uncommitted height is well formed
    // data bound to the wrong state.
    if (
      error instanceof GatewayReadError &&
      (error.message === "market snapshot: wrong chain" ||
        error.message === "market snapshot: uncommitted height")
    )
      throw new GatewayReadError("binding", "market snapshot", error.message, {
        cause: error,
      });
    throw error;
  }
}
