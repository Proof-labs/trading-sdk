import { sha256 } from "@noble/hashes/sha2.js";
import {
  canonicalFinancialSelection,
  decodeFinancialState,
  decodeFinancialPayload,
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
export interface FinancialAuditPins {
  artifactSha256: string;
  snapshotSha256: string;
  executableSha256: string;
  chainId: string;
  height: bigint;
  timeMs: bigint;
}

/** Decode an operator-attested local artifact, not a cryptographic state proof.
 * Pins must come from the separately trusted export/build record, not this artifact. */
export function decodeFinancialAuditArtifact(
  text: string,
  pins: FinancialAuditPins,
  selection: FinancialStateSelection,
): {
  audit: FinancialAudit;
  provenance: string;
  trust: "operator-attested-local-snapshot-not-full-state-proof";
} {
  if (text.length > 1024 * 1024 + 8192) return invalid("artifact size");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 1024 * 1024 + 8192) return invalid("artifact size");
  const digest = Array.from(sha256(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  if (
    !/^[0-9a-f]{64}$/.test(pins.artifactSha256) ||
    digest !== pins.artifactSha256
  )
    return invalid("artifact digest");
  const r: unknown = JSON.parse(text);
  const keys = [
    "protocol",
    "trust",
    "provenance",
    "snapshotSha256",
    "executableSha256",
    "chainId",
    "height",
    "timeMs",
    "timeSource",
    "markets",
    "owners",
    "data",
  ];
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== keys.length
  )
    return invalid("artifact wrapper");
  const record = r as Record<string, unknown>;
  if (keys.some((k) => typeof record[k] !== "string"))
    return invalid("artifact fields");
  const trust = "operator-attested-local-snapshot-not-full-state-proof";
  if (
    record.protocol !== "proof-financial-audit/offline-v1" ||
    record.trust !== trust ||
    record.timeSource !== "operator-attested-same-height-header"
  )
    return invalid("artifact trust contract");
  if (
    !/^[0-9a-f]{64}$/.test(pins.snapshotSha256) ||
    !/^[0-9a-f]{64}$/.test(pins.executableSha256) ||
    record.snapshotSha256 !== pins.snapshotSha256 ||
    record.executableSha256 !== pins.executableSha256 ||
    record.chainId !== pins.chainId ||
    !pins.chainId.length ||
    pins.chainId.length > 128
  )
    return invalid("artifact pins");
  const height = uint(pins.height, 64);
  const time = uint(pins.timeMs, 64);
  if (
    record.height !== height.toString() ||
    record.timeMs !== time.toString() ||
    (height > 0n && time === 0n)
  )
    return invalid("artifact height/time");
  const expected = canonicalFinancialSelection(selection);
  if (
    record.markets !== expected.markets.join(",") ||
    record.owners !== expected.owners.join(",")
  )
    return invalid("artifact selectors");
  const provenance = record.provenance as string;
  if (!provenance.trim() || provenance.length > 512)
    return invalid("artifact provenance");
  const audit = decodeFinancialAudit(
    decodeFinancialPayload(record.data as string, true),
    expected,
  );
  if (
    audit.ledger.finalizedHeight !== height ||
    audit.ledger.finalizedTimeMs !== time
  )
    return invalid("artifact ledger height/time");
  return { audit, provenance, trust };
}
