import { beforeAll, describe, expect, it } from "vitest";
import { Decoder } from "@msgpack/msgpack";
import {
  adminProposalContentHash,
  bytesToHex,
  decodeHlpConfigUpdatedEvent,
  decodeTx,
  encodePayloadBytes,
  encodeSignedTx,
  hexToBytes,
  HLP_CONFIG_UPDATED_EVENT_TYPE,
  ready,
  validateSetHlpConfig,
  type Action,
  type SetHlpConfig,
  type TxEvent,
} from "./index.js";
import { decodeAdminAction } from "./governance-query.js";

// Independent authority: proof-wire 2.3.0 codec.rs
// set_hlp_config_wire_vectors_frozen (exchange#748, consumed by the engine).
const ADDRESS = new Uint8Array(20).fill(0xaa);
const vectors: Array<[SetHlpConfig, string]> = [
  [
    {
      address: ADDRESS,
      bootstrapBalance: 12_500_000_000n,
      minBalanceFloor: 5_000_000_000n,
      enabled: true,
    },
    "81ac536574486c70436f6e66696794dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaacf00000002e90edd00cf000000012a05f200c3",
  ],
  [
    {
      address: ADDRESS,
      bootstrapBalance: 0n,
      minBalanceFloor: 0n,
      enabled: false,
    },
    "81ac536574486c70436f6e66696794dc0014ccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaaccaa0000c2",
  ],
];

const propose = (value: SetHlpConfig): Action => ({
  type: "ProposeAdminAction",
  data: {
    proposer: new Uint8Array(20).fill(0xa1),
    registryVersion: 1n,
    action: { kind: "SetHlpConfig", value },
  },
});

const U64_MAX = (1n << 64n) - 1n;

describe("SetHlpConfig (inner admin tag 16)", () => {
  beforeAll(ready);

  it.each(vectors)(
    "matches the engine's frozen inner bytes and read shape: %#",
    (value, hex) => {
      const action = propose(value);
      // The inner AdminAction is the final field of ProposeAdminAction.
      expect(bytesToHex(encodePayloadBytes(action)).endsWith(hex)).toBe(true);
      const decoded = decodeTx(
        encodeSignedTx(action, 1n, new Uint8Array(32), new Uint8Array(64)),
      );
      expect(decoded.action).toEqual(action);
      expect(
        decodeAdminAction(
          new Decoder({ useBigInt64: true }).decode(hexToBytes(hex)),
        ),
      ).toEqual({ kind: "SetHlpConfig", value });
    },
  );

  it("round-trips full u64 width and the floor == bootstrap bound", () => {
    const value: SetHlpConfig = {
      address: new Uint8Array(20).fill(0xa7),
      bootstrapBalance: U64_MAX,
      minBalanceFloor: U64_MAX,
      enabled: true,
    };
    expect(
      decodeTx(
        encodeSignedTx(
          propose(value),
          1n,
          new Uint8Array(32),
          new Uint8Array(64),
        ),
      ).action,
    ).toEqual(propose(value));
  });

  const valid: SetHlpConfig = vectors[0][0];
  it.each([
    { ...valid, address: new Uint8Array(20) },
    { ...valid, address: new Uint8Array(19).fill(1) },
    { ...valid, address: new Uint8Array(21).fill(1) },
    { ...valid, address: Array(20).fill(1) },
    { ...valid, enabled: true, bootstrapBalance: 0n, minBalanceFloor: 0n },
    { ...valid, minBalanceFloor: valid.bootstrapBalance + 1n },
    { ...valid, enabled: false, bootstrapBalance: 0n, minBalanceFloor: 1n },
    { ...valid, bootstrapBalance: -1n },
    { ...valid, bootstrapBalance: U64_MAX + 1n },
    { ...valid, bootstrapBalance: 12_500_000_000 },
    { ...valid, minBalanceFloor: -1n },
    { ...valid, minBalanceFloor: 5_000_000_000 },
    { ...valid, enabled: "true" },
    { ...valid, enabled: undefined },
  ])("rejects malformed configs before signing or hashing: %#", (input) => {
    const value = input as unknown as SetHlpConfig;
    expect(() => validateSetHlpConfig(value)).toThrow();
    expect(() => encodePayloadBytes(propose(value))).toThrow();
    expect(() =>
      adminProposalContentHash({
        chainId: new Uint8Array(32),
        proposalId: 1n,
        registryVersion: 1n,
        threshold: 2,
        proposer: new Uint8Array(20),
        createdHeight: 1n,
        createdMs: 1n,
        expiryMs: 10n,
        action: { kind: "SetHlpConfig", value },
      }),
    ).toThrow();
  });

  it("accepts a disabled config with a zero bootstrap and floor", () => {
    expect(() => validateSetHlpConfig(vectors[1][0])).not.toThrow();
  });

  it("rejects malformed read payloads and forbids nesting it in Batch", () => {
    const addr = Array(20).fill(0xaa);
    for (const raw of [
      [Array(20).fill(0), 1, 0, true], // zero address
      [addr, 0, 0, true], // enabled with zero bootstrap
      [addr, 1, 2, false], // floor above bootstrap
      [addr.slice(1), 1, 0, true], // 19-byte address
      [addr, -1, 0, false], // negative balance
      [addr, 1, 0, 1], // non-boolean flag
      [addr, 1, 0], // missing field
      [addr, 1, 0, true, 7], // extra field
    ]) {
      expect(() => decodeAdminAction({ SetHlpConfig: raw })).toThrow(
        /governance decode/,
      );
    }
    expect(() =>
      decodeAdminAction({ Batch: [{ SetHlpConfig: [addr, 1, 0, true] }] }),
    ).toThrow(/unknown AdminBatchItem/);
  });
});

describe("decodeHlpConfigUpdatedEvent", () => {
  const attrs = (overrides: Record<string, string> = {}) =>
    Object.entries({
      address: "aa".repeat(20),
      bootstrap_balance: "12500000000",
      min_balance_floor: "5000000000",
      enabled: "true",
      proposal_id: "42",
      ...overrides,
    }).map(([key, value]) => ({ key, value }));
  const event = (overrides?: Record<string, string>): TxEvent => ({
    type: HLP_CONFIG_UPDATED_EVENT_TYPE,
    attributes: attrs(overrides),
  });

  it("decodes the engine's hlp_config_updated attributes", () => {
    expect(HLP_CONFIG_UPDATED_EVENT_TYPE).toBe("hlp_config_updated");
    expect(decodeHlpConfigUpdatedEvent(event())).toEqual({
      type: "HlpConfigUpdated",
      address: "aa".repeat(20),
      bootstrapBalance: "12500000000",
      minBalanceFloor: "5000000000",
      enabled: true,
      proposalId: "42",
    });
    expect(
      decodeHlpConfigUpdatedEvent(
        event({
          bootstrap_balance: "0",
          min_balance_floor: "0",
          enabled: "false",
          proposal_id: U64_MAX.toString(),
        }),
      ),
    ).toMatchObject({
      enabled: false,
      bootstrapBalance: "0",
      proposalId: U64_MAX.toString(),
    });
  });

  it.each([
    { address: "00".repeat(20) },
    { address: "AA".repeat(20) },
    { address: "aa".repeat(19) },
    { address: "0x" + "aa".repeat(19) },
    { bootstrap_balance: "012" },
    { bootstrap_balance: "-1" },
    { bootstrap_balance: "1.5" },
    { bootstrap_balance: (U64_MAX + 1n).toString() },
    { min_balance_floor: "" },
    { proposal_id: " 1" },
    { enabled: "True" },
    { enabled: "1" },
    { enabled: "true", bootstrap_balance: "0", min_balance_floor: "0" },
    { min_balance_floor: "12500000001" },
  ])("fails closed on a malformed attribute: %#", (overrides) => {
    expect(() => decodeHlpConfigUpdatedEvent(event(overrides))).toThrow(
      /hlp_config_updated/,
    );
  });

  it("fails closed on a wrong type, missing, duplicate or extra attribute", () => {
    expect(() =>
      decodeHlpConfigUpdatedEvent({ ...event(), type: "HlpConfigUpdated" }),
    ).toThrow(/unexpected event type/);
    const base = event();
    expect(() =>
      decodeHlpConfigUpdatedEvent({
        ...base,
        attributes: base.attributes.slice(1),
      }),
    ).toThrow(/missing attribute address/);
    expect(() =>
      decodeHlpConfigUpdatedEvent({
        ...base,
        attributes: [...base.attributes, base.attributes[0]!],
      }),
    ).toThrow(/duplicate attribute address/);
    expect(() =>
      decodeHlpConfigUpdatedEvent({
        ...base,
        attributes: [...base.attributes, { key: "extra", value: "1" }],
      }),
    ).toThrow(/unexpected attribute/);
  });
});
