import { describe, expect, it } from "vitest";
import {
  PENDING_F7_ADMIN_TAGS,
  decodePendingF7AdminAction,
  encodePendingF7AdminAction,
  validateFundInsuranceFund,
  validateSetLiquidationConfig,
  validateUpdateTreasurySources,
  type PendingF7AdminAction,
} from "./index.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const unhex = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, "hex"));
const addr = (byte: number): Uint8Array => new Uint8Array(20).fill(byte);

// The engine's frozen inner admin-action bytes, copied verbatim from the
// exchange draft branches (the bytes a proposal's content hash commits):
// - `set_liquidation_config_wire_vectors_frozen`, exchange-wire/src/codec.rs
//   on #796 feat/liquidation-config-record;
// - `insurance_funding_wire_vectors_frozen`, exchange-wire/src/codec.rs on
//   #798 feat/en-11-if-funding-action.
// Rows 1, 3 and 5 are the engine's frozen bytes verbatim. Rows 2 and 4 are
// in-bound variants of engine rows that the engine's own validator refuses
// (see the next test); their bytes were produced by the same branch's
// `canonical_admin_action_bytes` (#796 @ e0f0168d, #798 @ 5e6560cd). Pending
// engine merge: when a proof-wire release carries these arms, the SDK's
// crates/spec generator takes over and emits conformance rows.
const FROZEN: [string, PendingF7AdminAction, string][] = [
  [
    "SetLiquidationConfig decided defaults (100 bps, 5000/5000)",
    {
      kind: "SetLiquidationConfig",
      value: { penaltyBps: 100, insuranceShareBps: 5000, plpShareBps: 5000 },
    },
    "81b45365744c69717569646174696f6e436f6e6669679364cd1388cd1388",
  ],
  [
    "SetLiquidationConfig all-insurance split",
    {
      kind: "SetLiquidationConfig",
      // Derived from the engine's second frozen row (250 bps, 10000/0),
      // whose penalty DEC-216's 1..=100 bound now refuses; same split, an
      // in-bound penalty.
      value: { penaltyBps: 100, insuranceShareBps: 10_000, plpShareBps: 0 },
    },
    "81b45365744c69717569646174696f6e436f6e6669679364cd271000",
  ],
  [
    "FundInsuranceFund, one allocation",
    {
      kind: "FundInsuranceFund",
      value: {
        fundingId: 7n,
        source: addr(0xab),
        allocations: [{ poolId: 0, amount: 1_000_000n }],
      },
    },
    "81b146756e64496e737572616e636546756e649307dc0014ccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccab919200ce000f4240",
  ],
  [
    "FundInsuranceFund, u64::MAX id and an i64::MAX total",
    {
      kind: "FundInsuranceFund",
      value: {
        fundingId: (1n << 64n) - 1n,
        source: addr(0xab),
        allocations: [
          { poolId: 0, amount: 3n },
          { poolId: 2, amount: (1n << 63n) - 1n - 3n },
        ],
      },
    },
    "81b146756e64496e737572616e636546756e6493cfffffffffffffffffdc0014ccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccab929200039202cf7ffffffffffffffc",
  ],
  [
    "UpdateTreasurySources",
    {
      kind: "UpdateTreasurySources",
      value: { add: [addr(0xab)], remove: [addr(0xcd)] },
    },
    "81b55570646174655472656173757279536f75726365739291dc0014ccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccab91dc0014cccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccdcccd",
  ],
];

describe("pending F7 admin actions (pending engine merge)", () => {
  it("claims inner tags 0x11..=0x13", () => {
    expect(PENDING_F7_ADMIN_TAGS).toEqual({
      SetLiquidationConfig: 0x11,
      FundInsuranceFund: 0x12,
      UpdateTreasurySources: 0x13,
    });
  });

  it.each(FROZEN)(
    "%s encodes to the engine bytes and round-trips",
    (_n, action, expected) => {
      const bytes = encodePendingF7AdminAction(action);
      expect(hex(bytes)).toBe(expected);
      expect(decodePendingF7AdminAction(bytes)).toEqual(action);
    },
  );

  it("refuses the engine's frozen rows that its own validator refuses", () => {
    // #798's two-allocation frozen row sums to i64::MAX + 3, which the
    // engine's `validate_fund_insurance_fund` refuses: the engine test pins
    // encoding only. The decoder here validates, so it refuses it.
    expect(() =>
      decodePendingF7AdminAction(
        unhex(
          "81b146756e64496e737572616e636546756e6493cfffffffffffffffffdc0014ccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccabccab929200039202cf7fffffffffffffff",
        ),
      ),
    ).toThrow("i64::MAX");
    // #796 frozen row 2 (250 bps) predates DEC-216's 1..=100 bound.
    expect(() =>
      decodePendingF7AdminAction(
        unhex("81b45365744c69717569646174696f6e436f6e66696793ccfacd271000"),
      ),
    ).toThrow("penaltyBps must be in 1..=100");
  });

  it("validates SetLiquidationConfig per DEC-216 and the 10 000 bps split", () => {
    const ok = { penaltyBps: 1, insuranceShareBps: 0, plpShareBps: 10_000 };
    expect(() => validateSetLiquidationConfig(ok)).not.toThrow();
    for (const bad of [
      { ...ok, penaltyBps: 0 },
      { ...ok, penaltyBps: 101 },
      { ...ok, penaltyBps: 1.5 },
      { ...ok, plpShareBps: 9_999 },
      { ...ok, insuranceShareBps: 0xffff_ffff },
      { ...ok, insuranceShareBps: -1, plpShareBps: 10_001 },
    ]) {
      expect(() => validateSetLiquidationConfig(bad)).toThrow();
      expect(() =>
        encodePendingF7AdminAction({
          kind: "SetLiquidationConfig",
          value: bad,
        }),
      ).toThrow();
    }
  });

  it("validates FundInsuranceFund shape and returns the total", () => {
    const base = {
      fundingId: 1n,
      source: addr(1),
      allocations: [
        { poolId: 0, amount: 5n },
        { poolId: 7, amount: 6n },
      ],
    };
    expect(validateFundInsuranceFund(base)).toBe(11n);
    for (const bad of [
      { ...base, source: addr(0) },
      { ...base, source: new Uint8Array(19) },
      { ...base, fundingId: -1n },
      { ...base, allocations: [] },
      {
        ...base,
        allocations: Array.from({ length: 9 }, (_, i) => ({
          poolId: i,
          amount: 1n,
        })),
      },
      {
        ...base,
        allocations: [
          { poolId: 7, amount: 1n },
          { poolId: 0, amount: 1n },
        ],
      },
      {
        ...base,
        allocations: [
          { poolId: 3, amount: 1n },
          { poolId: 3, amount: 1n },
        ],
      },
      { ...base, allocations: [{ poolId: 256, amount: 1n }] },
      { ...base, allocations: [{ poolId: 0, amount: 0n }] },
      { ...base, allocations: [{ poolId: 0, amount: 1n << 63n }] },
    ]) {
      expect(() => validateFundInsuranceFund(bad)).toThrow();
    }
  });

  it("validates UpdateTreasurySources shape (DEC-195 allowlist changes)", () => {
    expect(() =>
      validateUpdateTreasurySources({ add: [addr(1), addr(2)], remove: [] }),
    ).not.toThrow();
    for (const bad of [
      { add: [], remove: [] },
      { add: [addr(2), addr(1)], remove: [] },
      { add: [addr(1), addr(1)], remove: [] },
      { add: [addr(0)], remove: [] },
      { add: [], remove: [new Uint8Array(21)] },
      { add: [addr(1)], remove: [addr(1)] },
      { add: Array.from({ length: 9 }, (_, i) => addr(i + 1)), remove: [] },
    ]) {
      expect(() => validateUpdateTreasurySources(bad)).toThrow();
    }
  });

  it.each([
    ["an unknown variant", "81a3466f6f90"],
    ["a non-map", "93010203"],
    ["a two-entry map", "82a16190a16290"],
    // SetLiquidationConfig with 100 encoded as uint16 instead of fixint.
    [
      "a non-minimal integer",
      "81b45365744c69717569646174696f6e436f6e66696793cd0064cd1388cd1388",
    ],
    [
      "a short payload",
      "81b45365744c69717569646174696f6e436f6e6669669264cd1388",
    ],
    [
      "an address as a bin",
      "81b55570646174655472656173757279536f75726365739291c414" +
        "ab".repeat(20) +
        "90",
    ],
    [
      "trailing bytes",
      "81b45365744c69717569646174696f6e436f6e6669679364cd1388cd138800",
    ],
  ])("decode fails closed on %s", (_name, text) => {
    expect(() => decodePendingF7AdminAction(unhex(text))).toThrow();
  });
});
