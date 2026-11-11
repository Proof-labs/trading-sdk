import { encode } from "@msgpack/msgpack";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExchangeClient, ready } from "./index.js";
import {
  decodeFinalizedInsuranceFund,
  decodeFinalizedInsuranceFunds,
} from "./insurance-funds.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

const height = 9_007_199_254_740_993n;
const time = 123_000n;
const owner = (pool: number) =>
  keccak_256(
    new Uint8Array([
      ...new TextEncoder().encode("ProofExchange-vault-v1"),
      0,
      pool,
    ]),
  ).slice(0, 20);
const fund = (pool = 7) => ({
  pool_id: pool,
  owner: owner(pool),
  registered: false,
  stored_ledger: true,
  cash: 23n,
  debt: 29n,
  net_cash: -6n,
});
const base = () => ({ finalized_height: height, finalized_time_ms: time });
const position = () => ({
  market: 1,
  side: "sell",
  size: 7n,
  sz_decimals: 1,
  notional: {
    status: "priced",
    reference_price: 13n,
    notional_micro_usdc: "9",
  },
});
const state = () => ({
  ...base(),
  fund: fund(),
  positions: [position()],
  positions_complete: true,
});
const envelope = (value: unknown) => ({
  data: Buffer.from(encode(value, { useBigInt64: true })).toString("base64"),
  witness: {
    version: 1,
    nodeId: "ab".repeat(20),
    height: height.toString(),
    finalizedBlockTimeMs: time.toString(),
    appHash: "cd".repeat(32),
  },
});
beforeAll(ready);

describe("witnessed insurance fund directory and positions", () => {
  it("reads marketless cash/debt through the gateway with exact evidence", async () => {
    const transport = vi.fn<ExchangeHttpTransport>(
      async () =>
        new Response(JSON.stringify(envelope({ ...base(), funds: [fund()] }))),
    );
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      useGateway: false,
      httpTransport: transport,
    });
    const result = await client.reads().finalized.insuranceFunds();
    expect(result.funds[0]).toMatchObject({
      poolId: 7,
      registered: false,
      storedLedger: true,
      cash: 23n,
      debt: 29n,
      netCash: -6n,
    });
    expect(result.finalizedHeight).toBe(height);
    expect(transport.mock.calls[0][0]).toBe(
      "https://gateway.example/v2/insurance-funds?witness=1",
    );
    expect(transport.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    transport.mockImplementation(
      async () => new Response(JSON.stringify(envelope(state()))),
    );
    const detail = await client.reads().finalized.insuranceFund(7);
    expect(detail.positions[0].notional).toEqual({
      status: "priced",
      referencePrice: 13n,
      notionalMicroUsdc: 9n,
    });
    expect(transport.mock.calls[1][0]).toBe(
      "https://gateway.example/v2/insurance-fund/7?witness=1",
    );
  });

  it("binds canonical fund owner, pool, height, time and exact net cash", () => {
    for (const value of [
      { ...state(), fund: { ...fund(), owner: owner(8) } },
      { ...state(), fund: fund(8) },
      { ...state(), fund: { ...fund(), net_cash: 0n } },
      { ...state(), finalized_height: height - 1n },
      { ...state(), finalized_time_ms: time + 1n },
      { ...state(), fund: { ...fund(), cash: -1n } },
      { ...state(), fund: { ...fund(), registered: "true" } },
      Object.values(state()),
    ])
      expect(() => decodeFinalizedInsuranceFund(envelope(value), 7)).toThrow();
    for (const value of [
      { ...envelope(state()), witness: null },
      { data: envelope(state()).data },
      { ...envelope(state()), extra: 1 },
    ])
      expect(() => decodeFinalizedInsuranceFund(value, 7)).toThrow();
  });

  it("keeps unpriced and unsupported positions distinct from an empty fund", () => {
    for (const notional of [
      // TODO: add "thin_book" once the proof-wire pin carries ThinBook; the
      // pinned decoder reads it as "unknown" until then.
      ...["stale", "guard_unset", "no_verdict", "no_mark"].map((reason) => ({
        status: "unpriced",
        reason,
      })),
      { status: "unsupported_binary" },
    ]) {
      const result = decodeFinalizedInsuranceFund(
        envelope({ ...state(), positions: [{ ...position(), notional }] }),
        7,
      );
      expect(result.positions[0].notional).toEqual(notional);
    }
    expect(
      decodeFinalizedInsuranceFund(envelope({ ...state(), positions: [] }), 7)
        .positions,
    ).toEqual([]);
  });

  it("retains balances and positions across future wire variants without inventing valuations", () => {
    const positions = [
      position(),
      {
        ...position(),
        market: 2,
        side: "future_side",
        notional: { status: "future_status" },
      },
      {
        ...position(),
        market: 3,
        notional: { status: "unpriced", reason: "future_reason" },
      },
    ];
    const result = decodeFinalizedInsuranceFund(
      envelope({ ...state(), positions }),
      7,
    );
    expect(result.fund).toMatchObject({ cash: 23n, debt: 29n, netCash: -6n });
    expect(result.positions).toHaveLength(3);
    expect(result.positions[0].notional).toEqual({
      status: "priced",
      referencePrice: 13n,
      notionalMicroUsdc: 9n,
    });
    expect(result.positions[1]).toMatchObject({
      market: 2,
      side: "unknown",
      size: 7n,
      notional: { status: "unknown" },
    });
    expect(result.positions[2].notional).toEqual({
      status: "unpriced",
      reason: "unknown",
    });
    expect(() =>
      decodeFinalizedInsuranceFund(
        envelope({
          ...state(),
          positions: [
            {
              ...position(),
              notional: { ...position().notional, notional_micro_usdc: "10" },
            },
            positions[1],
          ],
        }),
        7,
      ),
    ).toThrow();
  });

  it("preserves unsigned 128-bit display amounts and rejects rounded or malformed amounts", () => {
    const size = (1n << 64n) - 1n;
    expect(
      decodeFinalizedInsuranceFund(
        envelope({
          ...state(),
          positions: [
            {
              ...position(),
              size,
              sz_decimals: 0,
              notional: {
                status: "priced",
                reference_price: 13n,
                notional_micro_usdc: (size * 13n).toString(),
              },
            },
          ],
        }),
        7,
      ).positions[0].notional,
    ).toMatchObject({ notionalMicroUsdc: size * 13n });
    for (const amount of [
      "09",
      "-9",
      "9.0",
      "10",
      "1e1",
      (1n << 128n).toString(),
    ])
      expect(() =>
        decodeFinalizedInsuranceFund(
          envelope({
            ...state(),
            positions: [
              {
                ...position(),
                notional: {
                  ...position().notional,
                  notional_micro_usdc: amount,
                },
              },
            ],
          }),
          7,
        ),
      ).toThrow();
  });

  it("requires a sorted complete directory and explicitly bounded positions", () => {
    expect(
      decodeFinalizedInsuranceFunds(envelope({ ...base(), funds: [] })).funds,
    ).toEqual([]);
    for (const funds of [
      [fund(8), fund(7)],
      [fund(), fund()],
      [{ ...fund(), registered: false, stored_ledger: false }],
    ])
      expect(() =>
        decodeFinalizedInsuranceFunds(envelope({ ...base(), funds })),
      ).toThrow();
    const positions = Array.from({ length: 100 }, (_, index) => ({
      ...position(),
      market: index + 1,
    }));
    expect(
      decodeFinalizedInsuranceFund(
        envelope({ ...state(), positions, positions_complete: false }),
        7,
      ).positionsComplete,
    ).toBe(false);
    for (const values of [
      [],
      [position()],
      [...positions, { ...position(), market: 101 }],
    ])
      expect(() =>
        decodeFinalizedInsuranceFund(
          envelope({
            ...state(),
            positions: values,
            positions_complete: false,
          }),
          7,
        ),
      ).toThrow();
    expect(() =>
      decodeFinalizedInsuranceFund(
        envelope({ ...state(), positions: [position(), position()] }),
        7,
      ),
    ).toThrow();
  });

  it("refuses invalid input before transport and honours caller cancellation", async () => {
    const transport = vi.fn<ExchangeHttpTransport>();
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    });
    for (const pool of [-1, 256, 0.5, NaN])
      await expect(
        client.reads().finalized.insuranceFund(pool),
      ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.reads().finalized.insuranceFunds({ signal: controller.signal }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
