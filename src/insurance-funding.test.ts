import { describe, expect, it } from "vitest";
import { adminActionToWasm } from "./codec-adapter.js";
import { adminProposalContentHash, decodeTx, encodeSignedTx } from "./codec.js";
import {
  ACTION_TAG_BY_KIND,
  decodeAdminAction,
  decodeProposalDisplayInfo,
} from "./governance-query.js";
import {
  validateFundInsuranceFund,
  validateWithdrawInsuranceFund,
} from "./insurance-funding.js";
import type { Action, AdminAction, FundInsuranceFund } from "./types.js";

const address = (byte: number) => new Uint8Array(20).fill(byte);
const funding = (): FundInsuranceFund => ({
  fundingId: 0n,
  source: address(1),
  allocations: [{ poolId: 0, amount: 25_000_000_000n }],
});

describe("governed insurance funding", () => {
  it("uses withdrawal tag 25 without aliasing existing governance actions", () => {
    const proposal = [
      1,
      "Pending",
      "Pending",
      1,
      2,
      Array.from(address(2)),
      [],
      [],
      100,
      1000,
      2000,
      25,
      { WithdrawInsuranceFund: [7, Array.from(address(3)), [[0, 12]]] },
      [],
      Array(32).fill(0),
    ];
    expect(decodeProposalDisplayInfo(proposal).actionTag).toBe(25);
    for (const tag of [17, 18, 20, 21, 22, 23, 24]) {
      expect(() =>
        decodeProposalDisplayInfo(
          proposal.map((value, index) => (index === 11 ? tag : value)),
        ),
      ).toThrow(/does not match/);
    }
    expect(ACTION_TAG_BY_KIND.FundInsuranceFund).toBe(18);
    expect(ACTION_TAG_BY_KIND.WithdrawInsuranceFund).toBe(25);
    expect(ACTION_TAG_BY_KIND.SetLiquidationConfig).toBe(17);
    expect(ACTION_TAG_BY_KIND.EnableSubAccounts).toBe(21);
    const tags = Object.values(ACTION_TAG_BY_KIND);
    expect(new Set(tags).size).toBe(tags.length);
  });
  it("keeps superseded executor actions unavailable to proposal decoders", () => {
    for (const name of [
      "PublishLiquidationPolicy",
      "RevokeLiquidationPolicy",
      "RestartLiquidationPlan",
      "ReleaseLiquidationPlan",
    ]) {
      expect(name in ACTION_TAG_BY_KIND).toBe(false);
      expect(() => decodeAdminAction({ [name]: [] })).toThrow();
    }
  });
  it("round trips both proposals through the authoritative Rust/WASM codec", () => {
    const actions: AdminAction[] = [
      { kind: "FundInsuranceFund", value: funding() },
      {
        kind: "WithdrawInsuranceFund",
        value: {
          withdrawalId: 0n,
          recipient: address(1),
          allocations: [{ poolId: 0, amount: 12n }],
        },
      },
    ];
    for (const action of actions) {
      const proposal: Action = {
        type: "ProposeAdminAction",
        data: { proposer: address(2), registryVersion: 1n, action },
      };
      const wire = encodeSignedTx(
        proposal,
        123n,
        new Uint8Array(32),
        new Uint8Array(64),
      );
      expect(decodeTx(wire).action).toEqual(proposal);
    }
  });
  it("preserves exact integers and address in the WASM adapter", () => {
    const value = funding();
    value.fundingId = (1n << 64n) - 1n;
    expect(adminActionToWasm({ kind: "FundInsuranceFund", value })).toEqual({
      FundInsuranceFund: {
        funding_id: value.fundingId,
        source: value.source,
        allocations: [{ pool_id: 0, amount: 25_000_000_000n }],
      },
    });
  });
  it("binds insurance transfers and approval envelopes to their exact content", () => {
    const actions = [
      { kind: "FundInsuranceFund", value: funding() },
      {
        kind: "WithdrawInsuranceFund",
        value: {
          withdrawalId: 0n,
          recipient: address(1),
          allocations: [{ poolId: 0, amount: 25_000_000_000n }],
        },
      },
    ] satisfies AdminAction[];
    const context = {
      chainId: new Uint8Array(32).fill(1),
      proposalId: 7n,
      registryVersion: 2n,
      threshold: 2,
      proposer: address(2),
      createdHeight: 3n,
      createdMs: 4n,
      expiryMs: 5n,
    };
    const hashes = actions.map((action) =>
      adminProposalContentHash({ ...context, action }),
    );
    expect(hashes[0]).not.toEqual(hashes[1]);
    for (const action of actions) {
      const contentHash = adminProposalContentHash({ ...context, action });
      const changed = {
        ...action,
        value: {
          ...action.value,
          allocations: [{ poolId: 0, amount: 24_999_999_999n }],
        },
      } as AdminAction;
      expect(
        adminProposalContentHash({ ...context, action: changed }),
      ).not.toEqual(contentHash);
      const approval: Action = {
        type: "ApproveAdminAction",
        data: {
          proposalId: context.proposalId,
          registryVersion: context.registryVersion,
          threshold: context.threshold,
          proposer: context.proposer,
          createdHeight: context.createdHeight,
          createdMs: context.createdMs,
          expiryMs: context.expiryMs,
          approver: address(3),
          contentHash,
          action,
        },
      };
      expect(
        decodeTx(
          encodeSignedTx(
            approval,
            123n,
            new Uint8Array(32),
            new Uint8Array(64),
          ),
        ).action,
      ).toEqual(approval);
    }
  });
  it("decodes compact proposal fields with byte-sized pools", () => {
    expect(
      decodeAdminAction({
        FundInsuranceFund: [0, Array.from(address(1)), [[255, 12]]],
      }),
    ).toEqual({
      kind: "FundInsuranceFund",
      value: {
        fundingId: 0n,
        source: address(1),
        allocations: [{ poolId: 255, amount: 12n }],
      },
    });
    expect(() =>
      decodeAdminAction({
        FundInsuranceFund: [0, Array.from(address(1)), [[256, 12]]],
      }),
    ).toThrow();
    expect(() =>
      decodeAdminAction({ FundInsuranceFund: [0, [1], [[0, 12]]] }),
    ).toThrow();
  });
  it("rejects invalid funding IDs without lossy number conversion", () => {
    for (const fundingId of [-1n, 1n << 64n, 123 as unknown as bigint])
      expect(() =>
        validateFundInsuranceFund({ ...funding(), fundingId }),
      ).toThrow();
  });
  it("rejects empty, oversized, duplicate, unsorted and invalid allocations", () => {
    for (const allocations of [
      [],
      Array.from({ length: 9 }, (_, poolId) => ({ poolId, amount: 1n })),
      [
        { poolId: 1, amount: 1n },
        { poolId: 1, amount: 1n },
      ],
      [
        { poolId: 2, amount: 1n },
        { poolId: 1, amount: 1n },
      ],
      [{ poolId: -1, amount: 1n }],
      [{ poolId: 256, amount: 1n }],
      [{ poolId: 0.5, amount: 1n }],
      [{ poolId: 0, amount: 0n }],
      [{ poolId: 0, amount: -1n }],
      [{ poolId: 0, amount: 1n << 63n }],
      [
        { poolId: 0, amount: (1n << 63n) - 1n },
        { poolId: 1, amount: 1n },
      ],
    ]) {
      expect(() =>
        adminActionToWasm({
          kind: "FundInsuranceFund",
          value: { ...funding(), allocations },
        }),
      ).toThrow();
    }
  });
  it("rejects zero and malformed source addresses", () => {
    for (const source of [address(0), new Uint8Array(19), new Uint8Array(21)])
      expect(() =>
        validateFundInsuranceFund({ ...funding(), source }),
      ).toThrow();
  });
  it("preserves withdrawal boundaries and rejects malformed decoded shapes", () => {
    const value = {
      withdrawalId: (1n << 64n) - 1n,
      recipient: address(4),
      allocations: [{ poolId: 255, amount: (1n << 63n) - 1n }],
    };
    expect(adminActionToWasm({ kind: "WithdrawInsuranceFund", value })).toEqual(
      {
        WithdrawInsuranceFund: {
          withdrawal_id: value.withdrawalId,
          recipient: value.recipient,
          allocations: [{ pool_id: 255, amount: value.allocations[0]!.amount }],
        },
      },
    );
    for (const name of ["FundInsuranceFund", "WithdrawInsuranceFund"]) {
      for (const allocations of [
        [],
        [[0, 0]],
        [
          [0, 1],
          [0, 1],
        ],
        [
          [2, 1],
          [1, 1],
        ],
        [[0, 1n << 63n]],
      ]) {
        expect(() =>
          decodeAdminAction({
            [name]: [0, Array.from(address(1)), allocations],
          }),
        ).toThrow();
      }
      expect(() =>
        decodeAdminAction({ [name]: [0, Array.from(address(0)), [[0, 1]]] }),
      ).toThrow();
    }
  });
  it("decodes withdrawals and rejects the retired registry variant", () => {
    const value = {
      withdrawalId: 7n,
      recipient: address(3),
      allocations: [{ poolId: 0, amount: 12n }],
    };
    expect(() => validateWithdrawInsuranceFund(value)).not.toThrow();
    expect(
      decodeAdminAction({
        WithdrawInsuranceFund: [7, Array.from(address(3)), [[0, 12]]],
      }),
    ).toEqual({ kind: "WithdrawInsuranceFund", value });
    expect(() =>
      decodeAdminAction({ UpdateTreasurySources: [[], []] }),
    ).toThrow();
    for (const withdrawalId of [-1n, 1n << 64n])
      expect(() =>
        validateWithdrawInsuranceFund({ ...value, withdrawalId }),
      ).toThrow();
    expect(() =>
      validateWithdrawInsuranceFund({ ...value, recipient: address(0) }),
    ).toThrow(/insurance withdrawal recipient/);
    expect(() =>
      validateWithdrawInsuranceFund({ ...value, allocations: [] }),
    ).toThrow(/insurance withdrawal requires 1\.\.8 allocations/);
    expect(() =>
      validateWithdrawInsuranceFund({
        ...value,
        allocations: [
          { poolId: 1, amount: 1n },
          { poolId: 1, amount: 1n },
        ],
      }),
    ).toThrow(/insurance withdrawal allocations\[1\]\.poolId/);
  });
});
