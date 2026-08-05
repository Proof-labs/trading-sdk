// Governance reads (W30-11): `queryAdminSignerRegistry` + `queryProposals`
// against the gateway proxies (api-gateway#97). Kept out of client.test.ts —
// that file is large; governance read coverage lives here.
//
// Same strategy as the routing tests there: stub global fetch, answer with
// base64(msgpack) bodies, assert the URL and the decoded shape.

import { describe, it, expect, afterEach, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";

describe("ExchangeClient governance reads (W30-11)", () => {
  const originalFetch = globalThis.fetch;
  const encoder = new Encoder({ useBigInt64: true });
  let calls: string[] = [];

  function toB64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function stubFetch(data: string | undefined): void {
    calls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify(data === undefined ? {} : { data }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  }

  function makeClient(): ExchangeClient {
    return new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("queryAdminSignerRegistry routes through the gateway and decodes a present registry", async () => {
    // Proxy shape: msgpack `[registry|nil]`. serde encodes `[u8; 20]` as a
    // msgpack ARRAY of integers, so members arrive as number[][] and the
    // decoder rebuilds them into Uint8Array (governance-query.ts, pinned to
    // engine golden bytes in governance-query.test.ts).
    const member = Array.from({ length: 20 }, (_, i) => i + 1);
    stubFetch(toB64(encoder.encode([[3n, 2, [member]]]) as Uint8Array));

    const got = await makeClient().queryAdminSignerRegistry();
    expect(calls).toEqual(["http://test-gateway/v1/admin/signer-registry"]);
    expect(got).toEqual({
      version: 3n,
      threshold: 2,
      members: [Uint8Array.from(member)],
    });
  });

  it("queryAdminSignerRegistry returns null for a nil registry (governance inactive)", async () => {
    // `[nil]` means no registry seeded — multisig INACTIVE (fail-closed),
    // deliberately distinct from an empty roster.
    stubFetch(toB64(encoder.encode([null]) as Uint8Array));
    expect(await makeClient().queryAdminSignerRegistry()).toBeNull();
  });

  it("queryAdminSignerRegistry rejects a successful response without encoded data", async () => {
    stubFetch(undefined);
    await expect(makeClient().queryAdminSignerRegistry()).rejects.toThrow(
      /response is missing encoded data/,
    );
  });

  it("queryProposals forwards status/cursor/limit and decodes the page", async () => {
    // A realistic `ProposalDisplayInfo` — 15 positional fields, byte fields
    // as integer arrays, the action as an externally-tagged map. The exact
    // layout is pinned against engine bytes in governance-query.test.ts;
    // here it only has to be well-formed enough to prove the client wires
    // the decoder in.
    const addr = (fill: number) => new Array(20).fill(fill);
    const proposal = [
      42n,
      "Pending",
      "Pending",
      7n,
      2,
      addr(0xaa),
      [addr(0xaa)],
      [],
      1_000_777n,
      1_700_000_000_000n,
      1_700_086_400_000n,
      1,
      {
        CreateMarket: [
          4242,
          1000,
          500,
          7,
          3,
          new Array(20).fill(0),
          3_600_000n,
          800,
          9,
          4,
          "GOLD",
          123_456_789n,
        ],
      },
      [0xde, 0xad],
      new Array(32).fill(0x5a),
    ];
    // Cursor 99 encodes as a msgpack fixint — the decoder yields a `number`,
    // which the client must normalize to honor the declared bigint type.
    stubFetch(toB64(encoder.encode([[proposal], 99]) as Uint8Array));

    const page = await makeClient().queryProposals({
      status: "open",
      cursor: 7n,
      limit: 10,
    });
    expect(calls).toEqual([
      "http://test-gateway/v1/proposals?status=open&cursor=7&limit=10",
    ]);
    expect(page.proposals).toHaveLength(1);
    const got = page.proposals[0]!;
    expect(got.proposalId).toBe(42n);
    expect(got.statusEffective).toEqual({ kind: "Pending" });
    expect(got.proposer).toEqual(Uint8Array.from(addr(0xaa)));
    expect(got.action.kind).toBe("CreateMarket");
    expect(page.nextCursor).toBe(99n);
  });

  it("queryProposals fails closed on a proposal it cannot decode", async () => {
    // A page carrying an operation this build does not know must throw
    // rather than hand back a half-rendered proposal: an approval is a
    // commitment to specific bytes, so "mostly decoded" is not a safe state.
    const proposal = [
      1n,
      "Pending",
      "Pending",
      1n,
      2,
      new Array(20).fill(1),
      [],
      [],
      1n,
      1n,
      2n,
      9,
      { DelistMarket: [7] },
      [],
      new Array(32).fill(0),
    ];
    stubFetch(toB64(encoder.encode([[proposal], null]) as Uint8Array));
    await expect(makeClient().queryProposals()).rejects.toThrow(
      /unknown AdminAction variant "DelistMarket"/,
    );
  });

  it("queryProposals decodes a nil cursor as null and omits empty query params", async () => {
    stubFetch(toB64(encoder.encode([[], null]) as Uint8Array));
    const page = await makeClient().queryProposals();
    expect(calls).toEqual(["http://test-gateway/v1/proposals"]);
    expect(page).toEqual({ proposals: [], nextCursor: null });
  });

  it("queryProposals rejects a successful response without encoded data", async () => {
    stubFetch(undefined);
    await expect(makeClient().queryProposals()).rejects.toThrow(
      /response is missing encoded data/,
    );
  });

  it("queryImpactMarkets routes through the gateway and decodes an engine row", async () => {
    // The engine-golden 15-slot row (see governance-query.test.ts for the
    // full vector provenance), re-encoded here through the same msgpack
    // encoder the stub uses elsewhere in this file.
    const row = [
      91,
      15,
      9_100,
      9_101,
      9_102,
      9_103,
      "does it land?",
      1_000_000n,
      1_000n,
      { Resolved: "Yes" },
      555n,
      777n,
      { MarketOracle: [3, 65_000_000_000n, "GreaterThanOrEqual"] },
      "body",
      "criteria",
    ];
    stubFetch(toB64(encoder.encode([row]) as Uint8Array));
    const got = await makeClient().queryImpactMarkets();
    expect(calls).toEqual(["http://test-gateway/v1/impact_markets"]);
    expect(got).toHaveLength(1);
    expect(got[0]!.impactMarketId).toBe(91);
    expect(got[0]!.status).toEqual({ kind: "Resolved", outcome: 1 });
    expect(got[0]!.oracleSource).toEqual({
      kind: "MarketOracle",
      market: 3,
      strikePrice: 65_000_000_000n,
      comparison: "GreaterThanOrEqual",
    });
    expect(got[0]!.rules).toBe("criteria");
  });

  it("queryImpactMarkets rejects a response without the encoded-data envelope", async () => {
    stubFetch(undefined);
    await expect(makeClient().queryImpactMarkets()).rejects.toThrow(
      /no encoded-data envelope/,
    );
  });

  it("queryImpactMarkets rejects a payload that is not a list", async () => {
    stubFetch(toB64(encoder.encode({ rows: [] }) as Uint8Array));
    await expect(makeClient().queryImpactMarkets()).rejects.toThrow(
      /impactMarkets is not an array/,
    );
  });

  it("queryImpactMarkets refuses the whole list when one row is malformed", async () => {
    // Fail-closed, not filter: a partially-rendered market list would hide
    // exactly the row an operator needed to see.
    const good = [
      91,
      15,
      9_100,
      9_101,
      9_102,
      9_103,
      "q",
      1n,
      1n,
      "Trading",
      0n,
      0n,
    ];
    const bad = [...good.slice(0, 11)];
    stubFetch(toB64(encoder.encode([good, bad]) as Uint8Array));
    await expect(makeClient().queryImpactMarkets()).rejects.toThrow(
      /impactMarket\[1\] has 11 fields, expected 12-15/,
    );
  });
});
