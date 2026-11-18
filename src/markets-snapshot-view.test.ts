// The node's version 2 markets snapshot (`GET /v2/markets-snapshot`) through
// `client.reads().marketsSnapshotView()`: every market with its status, every
// event and each market's open interest, bound to the pinned chain.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { GatewayHttpError, GatewayReadError } from "./errors.js";

/** Byte-identical copy of the API gateway's frozen example (api-gateway
 *  `tests/fixtures/v2-markets-snapshot.json`): BTC trading, ETH reduce-only,
 *  TEST delisted and the prediction binary of event 7 halted, at height
 *  12816657 of this chain. */
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
    // The version 1 snapshot is positional; this read needs the map.
    const positional = JSON.stringify({ data: "lAEC" });
    await expect(
      clientServing(positional).client.reads().marketsSnapshotView(),
    ).rejects.toMatchObject({ kind: "malformed" });
  });
});
