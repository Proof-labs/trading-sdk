import {
  canonicalFinancialSelection,
  decodeFinancialState,
  fetchFinancialPayload,
  type FinancialState,
  type FinancialStateSelection,
} from "./financial-state.js";

export interface FinancialMarketEvidence {
  market: number;
  kind: "Perp" | "Conditional" | "Binary";
  event: number | null;
  branch: "Yes" | "No" | null;
  underlying: number | null;
  phase: "Trading" | "PreResolution" | "ResolvedYes" | "ResolvedNo" | null;
  openInterest: { long: bigint; short: bigint } | null;
}
export interface FinancialAudit {
  format: 2;
  ledger: FinancialState;
  markets: FinancialMarketEvidence[];
}
function invalid(field: string): never {
  throw new Error(`financial audit decode: invalid ${field}`);
}
function tuple(raw: unknown, length: number): unknown[] {
  if (!Array.isArray(raw) || raw.length !== length) return invalid("tuple");
  return raw;
}
function uint(raw: unknown, bits: number): bigint {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) raw = BigInt(raw);
  if (typeof raw !== "bigint" || raw < 0n || raw >= 1n << BigInt(bits))
    return invalid("integer");
  return raw;
}
function id(raw: unknown): number {
  const n = uint(raw, 32);
  if (n === 0n) return invalid("zero ID");
  return Number(n);
}
export function decodeFinancialAudit(
  raw: unknown,
  selection: FinancialStateSelection,
): FinancialAudit {
  const expected = canonicalFinancialSelection(selection);
  const r = tuple(raw, 3);
  if (uint(r[0], 8) !== 2n) return invalid("format");
  const ledger = decodeFinancialState(r[1], expected);
  const rows = tuple(r[2], expected.markets.length);
  const markets = rows.map((value, index): FinancialMarketEvidence => {
    const m = tuple(value, 7);
    const market = id(m[0]);
    if (market !== expected.markets[index])
      return invalid("market coverage/order");
    const kind = m[1];
    if (kind !== "Perp" && kind !== "Conditional" && kind !== "Binary")
      return invalid("kind");
    const event = m[2] === null ? null : id(m[2]);
    const branch = m[3];
    if (branch !== null && branch !== "Yes" && branch !== "No")
      return invalid("branch");
    const underlying = m[4] === null ? null : id(m[4]);
    const phase = m[5];
    if (
      phase !== null &&
      phase !== "Trading" &&
      phase !== "PreResolution" &&
      phase !== "ResolvedYes" &&
      phase !== "ResolvedNo"
    )
      return invalid("phase");
    if (kind === "Perp") {
      if (
        event !== null ||
        branch !== null ||
        underlying !== null ||
        phase !== null
      )
        return invalid("perp metadata");
    } else if (
      event === null ||
      branch === null ||
      phase === null ||
      (kind === "Conditional"
        ? underlying === null || underlying === market
        : underlying !== null)
    ) {
      return invalid("event metadata");
    }
    const oi = m[6] === null ? null : tuple(m[6], 2);
    return {
      market,
      kind,
      event,
      branch,
      underlying,
      phase,
      openInterest:
        oi === null ? null : { long: uint(oi[0], 64), short: uint(oi[1], 64) },
    };
  });
  for (const account of ledger.accounts) {
    for (const position of account.positions) {
      if (!expected.markets.includes(position.market))
        return invalid("unselected position");
    }
  }
  return { format: 2, ledger, markets };
}
export async function fetchFinancialAudit(
  gatewayUrl: string,
  selection: FinancialStateSelection,
): Promise<FinancialAudit> {
  return decodeFinancialAudit(
    await fetchFinancialPayload(gatewayUrl, selection, "audit"),
    selection,
  );
}
