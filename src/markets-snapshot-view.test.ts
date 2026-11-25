// The node's version 2 markets snapshot (`GET /v2/markets-snapshot`) through
// `client.reads().marketsSnapshotView()`: every market with its status, every
// event and each market's open interest, bound to the pinned chain.

import { readFileSync } from "node:fs";
import { decode, encode } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { GatewayHttpError, GatewayReadError } from "./errors.js";
import type { MarketsSnapshotView } from "./markets-snapshot-view.js";

/** Byte-identical copy of the API gateway's frozen example (api-gateway
 *  `tests/fixtures/v2-markets-snapshot.json`): BTC trading, ETH reduce-only,
 *  TEST delisted and the prediction binary of event 7 halted, at height
 *  12816657 of this chain. ETH is at settings sequence 1, every other market
 *  at 0. */
const EXAMPLE = readFileSync(
  new URL(
    "../crates/proof-trading-sdk/src/market_snapshot/gateway-v2-markets-snapshot.json",
    import.meta.url,
  ),
  "utf8",
);
const CHAIN = "gateway-market-status-fixture";

/** A client pinned to `chain` whose gateway answers `body` with `status`. */
function clientServing(body: string, chain = CHAIN, status = 200) {
  const transport = vi.fn(async () => new Response(body, { status }));
  return {
    client: new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      chainId: chain,
      httpTransport: transport,
    }),
    transport,
  };
}

/** The example with the MessagePack string `from` replaced by `to`, a name of
 *  the same length. */
function renamed(from: string, to: string): string {
  const data = Buffer.from(JSON.parse(EXAMPLE).data, "base64");
  const at = data.indexOf(from);
  expect(at).toBeGreaterThan(0);
  expect(to.length).toBe(from.length);
  data.write(to, at);
  return JSON.stringify({ data: data.toString("base64") });
}

/** `value` with every map written as the array of its values, in order: a
 *  record written by position, as the version 1 snapshot writes them. */
function byPosition(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(byPosition);
  if (
    value === null ||
    typeof value !== "object" ||
    value instanceof Uint8Array
  )
    return value;
  return Object.values(value).map(byPosition);
}

describe("reads().marketsSnapshotView", () => {
  it("reads the gateway's example: one market in each status, its event and open interest", async () => {
    const { client, transport } = clientServing(EXAMPLE);
    const snapshot = await client.reads().marketsSnapshotView();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe(
      "https://gateway.example/v2/markets-snapshot",
    );
    expect(snapshot.height).toBe(12_816_657n);
    expect(
      snapshot.markets.map(({ market, status }) => [market, status]),
    ).toEqual([
      [1, "Trading"],
      [2, "ReduceOnly"],
      [3, "Delisted"],
      [100, "Halted"],
    ]);
    expect(snapshot.markets[0]).toEqual({
      market: 1,
      ticker: "BTC",
      kind: { type: "Perpetual" },
      szDecimals: 5,
      tickSize: 1_000_000n,
      lotSize: 1n,
      imBps: 3334,
      mmBps: 1667,
      takerFeeBps: 5,
      makerFeeBps: 2,
      feeTiers: [],
      fundingIntervalMs: 3_600_000n,
      maxFundingRateBps: 400,
      maxPositionSize: null,
      maxOpenInterest: 30_000n,
      defaultTtlMs: null,
      mark: {
        source: "OracleOnly",
        maxOracleAgeMs: 600_000n,
        maxSpreadBps: 100,
        cexCompositeMaxAgeMs: 30_000n,
      },
      status: "Trading",
      fundingDeadBandBps: 5,
      fundingInterestRate: 0,
      minOrderLots: null,
      settingsSequence: 0n,
    });
    expect(snapshot.markets[3]).toMatchObject({
      kind: { type: "PredictionBinary", eventId: 7, branch: "Yes" },
      mark: null,
      fundingIntervalMs: null,
      fundingDeadBandBps: null,
    });
    expect(snapshot.events).toEqual([
      {
        eventId: 7,
        binaryMarket: 100,
        question: "Will BTC trade above $100,000 at settlement?",
        settlementMs: 1_798_675_200_000n,
        resolutionWindowMs: 3_600_000n,
        status: "Trading",
        outcome: null,
        createdMs: 1_794_900_000_000n,
        resolvedMs: null,
        resolutionSource: {
          type: "MarketOracle",
          market: 1,
          strikePrice: 100_000_000_000n,
          comparison: "GreaterThan",
        },
        attachedConditionals: [],
      },
    ]);
    expect(snapshot.openInterest).toEqual([
      { market: 1, long: 30_000n, short: 30_000n },
      { market: 2, long: 1_200n, short: 1_150n },
      { market: 100, long: 36_900n, short: 41_600n },
    ]);
  });

  it("reads each market's settings sequence, 0 for a market served without one", async () => {
    const sequences = (snapshot: MarketsSnapshotView) =>
      snapshot.markets.map(({ market, settingsSequence }) => [
        market,
        settingsSequence,
      ]);
    const snapshot = await clientServing(EXAMPLE)
      .client.reads()
      .marketsSnapshotView();
    expect(sequences(snapshot)).toEqual([
      [1, 0n],
      [2, 1n],
      [3, 0n],
      [100, 0n],
    ]);
    // A node that does not serve the field sends no key: the market reads 0.
    const view = decode(Buffer.from(JSON.parse(EXAMPLE).data, "base64")) as {
      markets: Record<string, unknown>[];
    };
    delete view.markets[1].settings_sequence;
    const older = await clientServing(
      JSON.stringify({ data: Buffer.from(encode(view)).toString("base64") }),
    )
      .client.reads()
      .marketsSnapshotView();
    expect(sequences(older)).toEqual([
      [1, 0n],
      [2, 0n],
      [3, 0n],
      [100, 0n],
    ]);
  });

  it("reads Unknown, never Trading, for a status or kind this SDK does not name", async () => {
    const paused = await clientServing(renamed("halted", "paused"))
      .client.reads()
      .marketsSnapshotView();
    expect(paused.markets[3].status).toBe("Unknown");
    const kind = await clientServing(renamed("perpetual", "perpetuum"))
      .client.reads()
      .marketsSnapshotView();
    expect(kind.markets[0].kind).toEqual({ type: "Unknown" });
  });

  it("requires an explicit chain pin and refuses another chain as a binding fault", async () => {
    const transport = vi.fn();
    const unpinned = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    });
    await expect(unpinned.reads().marketsSnapshotView()).rejects.toMatchObject({
      kind: "configuration",
    });
    expect(transport).not.toHaveBeenCalled();
    const error = await clientServing(EXAMPLE, "another-chain")
      .client.reads()
      .marketsSnapshotView()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayReadError);
    expect(error).toMatchObject({ kind: "binding" });
  });

  it("never turns a refusal or another shape into an inventory", async () => {
    const witnessRefused = await clientServing(
      '{"error":"v2 serves no witness"}\n',
      CHAIN,
      400,
    )
      .client.reads()
      .marketsSnapshotView()
      .catch((e: unknown) => e);
    expect(witnessRefused).toBeInstanceOf(GatewayHttpError);
    // The version 1 snapshot is positional; this read needs the map. The
    // example, complete, with every record written by position: well-formed
    // MessagePack that only the map rule refuses.
    const named = Buffer.from(JSON.parse(EXAMPLE).data, "base64");
    const positional = JSON.stringify({
      data: Buffer.from(encode(byPosition(decode(named)))).toString("base64"),
    });
    await expect(
      clientServing(positional).client.reads().marketsSnapshotView(),
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});
