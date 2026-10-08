import { readFileSync } from "node:fs";
import { Decoder } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { decodeFinancialState } from "./financial-state.js";
import { decodePartialLiquidationFee } from "./partial-liquidation-fee.js";

// Produced and pinned by the actual canonical partial executor + financial
// query in exchange-core's partial_accounting_export_matches_real_engine_query_vector.
// This is offline selected-ledger evidence, NOT a gateway/live or full-ADL pass.
const vector = JSON.parse(
  readFileSync(
    new URL("./fixtures/partial-liquidation-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  before: string;
  after: string;
  owner: string;
  maker: string;
  receipts_abci_hex: string[];
};
const selection = { markets: [1], owners: [vector.owner, vector.maker].sort() };
const snapshot = (hex: string) =>
  decodeFinancialState(
    new Decoder({ useBigInt64: true }).decode(Buffer.from(hex, "hex")),
    selection,
  );

// Test-only reader of the engine's exact LE length-prefixed ABCI writer output.
function attrs(hex: string): Record<string, string> {
  const bytes = Buffer.from(hex, "hex");
  let offset = 0;
  const u16 = () => {
    if (offset + 2 > bytes.length) throw new Error("truncated ABCI length");
    const value = bytes.readUInt16LE(offset);
    offset += 2;
    return value;
  };
  const text = () => {
    const size = u16();
    if (offset + size > bytes.length) throw new Error("truncated ABCI value");
    const value = bytes.subarray(offset, offset + size).toString("utf8");
    offset += size;
    return value;
  };
  expect(text()).toBe("partial_liquidation_fee");
  const count = u16();
  expect(count).toBe(10);
  const result: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const key = text();
    if (Object.hasOwn(result, key)) throw new Error("duplicate ABCI attribute");
    result[key] = text();
  }
  expect(offset).toBe(bytes.length);
  return result;
}

describe("independent real-engine partial accounting vector", () => {
  it("preserves funded opposite binary claims and value in both conditional outcomes", () => {
    const conditional = JSON.parse(
      readFileSync(
        new URL("./fixtures/partial-conditional-v1.json", import.meta.url),
        "utf8",
      ),
    ) as typeof vector;
    const select = {
      markets: [1, 100, 103],
      owners: [conditional.owner, conditional.maker].sort(),
    };
    const decode = (hex: string) =>
      decodeFinancialState(
        new Decoder({ useBigInt64: true }).decode(Buffer.from(hex, "hex")),
        select,
      );
    const before = decode(conditional.before),
      after = decode(conditional.after);
    const ledgerValue = (s: typeof before, noWins: boolean) => {
      expect(s.accounts).toHaveLength(2);
      let total = s.feePool! + s.insurancePools[0].balance!;
      for (const account of s.accounts) {
        expect(account.balance).not.toBeNull();
        let value = account.balance!;
        for (const position of account.positions) {
          const market = s.markets.find((m) => m.market === position.market)!;
          const scale = 10n ** BigInt(market.szDecimals);
          const sign = position.side === "Buy" ? 1n : -1n;
          if (position.market === 100) {
            // The actual fixture seeds entry/reference at 100; the losing
            // branch contributes no CP claim. No contingent gain is cash.
            expect(position.entryPrice).toBe(100n);
            if (!noWins)
              value +=
                (sign * (100n - position.entryPrice) * position.size) / scale;
          } else {
            expect(position.market).toBe(103);
            expect(position.size).toBe(1n);
            expect(position.entryPrice).toBe(0n);
            if (position.side === "Sell")
              expect(account.balance!).toBeGreaterThanOrEqual(
                (1_000_000n * position.size) / scale,
              );
            value +=
              (sign *
                ((noWins ? 1_000_000n : 0n) - position.entryPrice) *
                position.size) /
              scale;
          }
        }
        total += value;
      }
      return total;
    };
    for (const noWins of [false, true])
      expect(ledgerValue(after, noWins)).toBe(ledgerValue(before, noWins));
    for (const account of after.accounts)
      expect(account.positions.find((p) => p.market === 100)!.size).toBe(88n);
    const receipt = decodePartialLiquidationFee(
      attrs(conditional.receipts_abci_hex[0]),
    );
    expect(receipt.market).toBe(100);
    expect(receipt.collected).toBe(12n);
    expect(
      after.accounts.find((a) => a.owner === conditional.owner)!.balance,
    ).toBe(463n);
  });
  it("decodes exact executed cash and both reduced positions", () => {
    const before = snapshot(vector.before),
      after = snapshot(vector.after);
    expect(before.accounts).toHaveLength(2);
    expect(after.accounts).toHaveLength(2);
    expect(before.plp).toBeNull();
    expect(after.plp).toBeNull();
    const ownerBefore = before.accounts.find((a) => a.owner === vector.owner)!;
    const ownerAfter = after.accounts.find((a) => a.owner === vector.owner)!;
    const makerAfter = after.accounts.find((a) => a.owner === vector.maker)!;
    expect(ownerBefore.balance).toBe(475n);
    expect(ownerAfter.balance).toBe(463n);
    expect(makerAfter.balance).toBe(10000n);
    expect(ownerAfter.positions[0].size).toBe(88n);
    expect(makerAfter.positions[0].size).toBe(88n);
    expect(after.insurancePools).toEqual([{ pool: 0, balance: 12n }]);
  });
  it("cash receipts reconcile exactly once to the owner debit and insurance credit", () => {
    const before = snapshot(vector.before),
      after = snapshot(vector.after);
    const receipts = vector.receipts_abci_hex.map((hex) =>
      decodePartialLiquidationFee(attrs(hex)),
    );
    expect(receipts.map((r) => r.fillId)).toEqual([1n, 2n]);
    expect(new Set(receipts.map((r) => r.fillId)).size).toBe(receipts.length);
    expect(
      receipts.every(
        (r) =>
          r.owner === vector.owner &&
          r.poolId === 0 &&
          r.market === 1 &&
          r.waived === 0n,
      ),
    ).toBe(true);
    const collected = receipts.reduce((sum, r) => sum + r.collected, 0n);
    expect(collected).toBe(12n);
    const ownerCash = (s: typeof before) =>
      s.accounts.find((a) => a.owner === vector.owner)!.balance!;
    expect(ownerCash(after) - ownerCash(before)).toBe(-collected);
    expect(
      after.insurancePools[0].balance! - before.insurancePools[0].balance!,
    ).toBe(collected);
  });
  it("conserves selected cash without adding fee counters or invented absent balances", () => {
    const cash = (s: ReturnType<typeof snapshot>) => {
      const rows = [
        ...s.accounts.map((a) => a.balance),
        ...s.insurancePools.map((p) => p.balance),
        s.feePool,
      ];
      expect(rows.every((value) => value !== null)).toBe(true);
      return rows.reduce<bigint>((sum, value) => sum + value!, 0n);
    };
    expect(cash(snapshot(vector.after))).toBe(cash(snapshot(vector.before)));
  });
});
