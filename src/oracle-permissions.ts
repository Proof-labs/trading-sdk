/** Finalized consensus state, not provider liveness or portfolio authorization. */
export interface OraclePolicyEpoch {
  version: bigint;
  policyHash: string;
  calendarHash: string;
  calendarProvenance: string;
  calendarStart: bigint;
  calendarEnd: bigint;
  validUntil: bigint;
  sources: [OraclePolicySource, OraclePolicySource];
}

export interface OraclePolicySource {
  id: number;
  authority: string;
  basis: string;
  scale: number;
}

export type OracleVerdictStatus = "Fresh" | "Stale" | "Unpriceable";

/**
 * Fault bits of the committed verdict, in exchange `ReasonFlags::FAULTS`
 * order: bit `i` is `ORACLE_FAULT_BITS[i]`. `Disagreement` (bit 7) and
 * `PairTimeMismatch` (bit 13) are
 * no longer produced once the primary-with-fallback policy (exchange#831) is
 * in force; they keep their positions only so the encoding stays stable.
 */
export const ORACLE_FAULT_BITS = [
  "InvalidPolicy",
  "UpdateLimitExceeded",
  "ClockRegression",
  "ManualHalt",
  "SessionUnknown",
  "SessionClosed",
  "BadQuality",
  "Disagreement",
  "ReferenceUnavailable",
  "MovementBound",
  "MissingSource",
  "ExpiredSource",
  "OutsideSession",
  "PairTimeMismatch",
  "RecoveryPending",
] as const;

/** Every reason string a verdict can carry. */
const reasons = [...ORACLE_FAULT_BITS, "Fresh"] as const;
export type OracleVerdictReason = (typeof reasons)[number];

/** The policy slot that priced: slot 0 is the primary, slot 1 the fallback. */
export type OracleSelectedSource = "Primary" | "Fallback";

/**
 * Source-selection diagnostics of a verdict, in bit order. They are
 * monitoring signals, not faults: none of them withholds a certificate.
 */
export const ORACLE_DIAGNOSTIC_BITS = [
  "OnFallback",
  "PrimaryRefusedDivergence",
  "DivergenceUnchecked",
  "FallbackUnusable",
] as const;
export type OracleVerdictDiagnostic = (typeof ORACLE_DIAGNOSTIC_BITS)[number];

export interface CommittedOracleVerdict {
  height: bigint;
  blockTime: bigint;
  status: OracleVerdictStatus;
  reason: OracleVerdictReason;
  /** The selected slot's own price and publish time. */
  certified: { price: bigint; providerTime: bigint } | null;
  eligibleSince: bigint | null;
  /** Raw u32 fault bitset over `ORACLE_FAULT_BITS`. */
  faults: number;
  /** `faults` named in bit order. */
  faultReasons: OracleVerdictReason[];
  validSources: number;
  currentTimes: [bigint | null, bigint | null];
  evidence: [Uint8Array | null, Uint8Array | null];
  lastGood: { price: bigint; providerTime: bigint } | null;
  anchor: { price: bigint | null; coveredMs: bigint; requiredMs: bigint };
  /**
   * The usable slot chosen by priority, present even when a later fault
   * withholds the certificate.
   */
  selected: OracleSelectedSource | null;
  /** Raw u8 diagnostic bitset. */
  diagnostics: number;
  /** `diagnostics` named in bit order. */
  diagnosticFlags: OracleVerdictDiagnostic[];
}

export interface OraclePermissions {
  market: number;
  finalizedHeight: bigint;
  state: "Unavailable" | "Committed";
  /** Satisfied covers this single oracle dependency only, not a whole action. */
  oraclePermission: "Satisfied" | "Unavailable";
  policy: OraclePolicyEpoch | null;
  pending: { effectiveHeight: bigint; policy: OraclePolicyEpoch } | null;
  verdict: CommittedOracleVerdict | null;
}

function invalid(field: string): never {
  throw new Error(`oracle permissions decode: invalid ${field}`);
}
function tuple(raw: unknown, length: number, field: string): unknown[] {
  if (!Array.isArray(raw) || raw.length !== length) return invalid(field);
  return raw;
}
function uint(raw: unknown, field: string, maximum = (1n << 64n) - 1n): bigint {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) raw = BigInt(raw);
  if (typeof raw !== "bigint" || raw < 0n || raw > maximum)
    return invalid(field);
  return raw;
}
function positive(raw: unknown, field: string, maximum?: bigint): bigint {
  const value = uint(raw, field, maximum);
  if (value === 0n) return invalid(field);
  return value;
}
function optional<T>(raw: unknown, decode: (raw: unknown) => T): T | null {
  return raw === null ? null : decode(raw);
}
function hash(raw: unknown, field: string): string {
  if (!(raw instanceof Uint8Array) && !Array.isArray(raw))
    return invalid(field);
  const bytes = Array.from(raw as ArrayLike<unknown>);
  if (
    bytes.length !== 32 ||
    bytes.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 255,
    )
  )
    return invalid(field);
  return (bytes as number[])
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
function digest(raw: unknown, field: string): Uint8Array {
  if (raw instanceof Uint8Array) {
    if (raw.length !== 32) return invalid(field);
    return raw;
  }
  if (!Array.isArray(raw)) return invalid(field);
  const bytes = raw as unknown[];
  if (
    bytes.length !== 32 ||
    bytes.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 255,
    )
  )
    return invalid(field);
  return new Uint8Array(bytes as number[]);
}
function policy(raw: unknown): OraclePolicyEpoch {
  const p = tuple(raw, 8, "policy");
  const sources = tuple(p[7], 2, "sources").map((raw) => {
    const s = tuple(raw, 4, "source");
    return {
      id: Number(uint(s[0], "source.id", 0xffff_ffffn)),
      authority: hash(s[1], "source.authority"),
      basis: hash(s[2], "source.basis"),
      scale: Number(uint(s[3], "source.scale", 255n)),
    };
  }) as [OraclePolicySource, OraclePolicySource];
  if (
    sources[0].id === sources[1].id ||
    sources[0].authority === sources[1].authority ||
    sources.some((s) => s.scale !== 6)
  )
    return invalid("source independence/scale");
  const value = {
    version: positive(p[0], "policy.version"),
    policyHash: hash(p[1], "policy.hash"),
    calendarHash: hash(p[2], "calendar.hash"),
    calendarProvenance: hash(p[3], "calendar.provenance"),
    calendarStart: uint(p[4], "calendar.start"),
    calendarEnd: uint(p[5], "calendar.end"),
    validUntil: uint(p[6], "policy.validUntil"),
    sources,
  };
  if (
    value.calendarStart >= value.calendarEnd ||
    value.validUntil <= value.calendarStart
  )
    return invalid("calendar bounds");
  return value;
}
function bitNames<T extends string>(bits: number, table: readonly T[]): T[] {
  return table.filter((_, index) => (bits & (1 << index)) !== 0);
}
function verdict(raw: unknown): CommittedOracleVerdict {
  const v = tuple(raw, 14, "verdict");
  const status = v[2];
  const reason = v[3];
  if (status !== "Fresh" && status !== "Stale" && status !== "Unpriceable")
    return invalid("verdict.status");
  if (
    typeof reason !== "string" ||
    !(reasons as readonly string[]).includes(reason)
  )
    return invalid("verdict.reason");
  const certified = optional(v[4], (raw) => {
    const c = tuple(raw, 2, "certified");
    return {
      price: positive(c[0], "certified.price"),
      providerTime: uint(c[1], "certified.providerTime"),
    };
  });
  const currentTimesRaw = tuple(v[8], 2, "verdict.currentTimes");
  const evidenceRaw = tuple(v[9], 2, "verdict.evidence");
  const anchorRaw = tuple(v[11], 3, "verdict.anchor");
  const faults = Number(uint(v[6], "verdict.faults", 0xffff_ffffn));
  const selected = v[12];
  if (selected !== null && selected !== "Primary" && selected !== "Fallback")
    return invalid("verdict.selected");
  const diagnostics = Number(uint(v[13], "verdict.diagnostics", 0xffn));
  const value: CommittedOracleVerdict = {
    height: uint(v[0], "verdict.height"),
    blockTime: uint(v[1], "verdict.blockTime"),
    status,
    reason: reason as OracleVerdictReason,
    certified,
    eligibleSince: optional(v[5], (raw) => uint(raw, "eligibleSince")),
    faults,
    faultReasons: bitNames<OracleVerdictReason>(faults, ORACLE_FAULT_BITS),
    validSources: Number(uint(v[7], "verdict.validSources", 0xffn)),
    currentTimes: [
      optional(currentTimesRaw[0], (raw) => uint(raw, "currentTimes[0]")),
      optional(currentTimesRaw[1], (raw) => uint(raw, "currentTimes[1]")),
    ],
    evidence: [
      optional(evidenceRaw[0], (raw) => digest(raw, "evidence[0]")),
      optional(evidenceRaw[1], (raw) => digest(raw, "evidence[1]")),
    ],
    lastGood: optional(v[10], (raw) => {
      const c = tuple(raw, 2, "lastGood");
      return {
        price: positive(c[0], "lastGood.price"),
        providerTime: uint(c[1], "lastGood.providerTime"),
      };
    }),
    anchor: {
      price: optional(anchorRaw[0], (raw) => uint(raw, "anchor.price")),
      coveredMs: uint(anchorRaw[1], "anchor.coveredMs"),
      requiredMs: uint(anchorRaw[2], "anchor.requiredMs"),
    },
    selected,
    diagnostics,
    diagnosticFlags: bitNames(diagnostics, ORACLE_DIAGNOSTIC_BITS),
  };
  if (
    (status === "Fresh") !== (reason === "Fresh") ||
    (status === "Fresh") !== (certified !== null) ||
    (status === "Fresh") !== (value.eligibleSince !== null) ||
    (certified && certified.providerTime > value.blockTime) ||
    (value.lastGood && value.lastGood.providerTime > value.blockTime) ||
    (value.eligibleSince !== null && value.eligibleSince > value.blockTime)
  )
    return invalid("verdict consistency");
  if (!primaryFallbackConsistent(value)) return invalid("verdict selection");
  return value;
}

/**
 * Invariants of exchange#831's `State::select` / `classify` as exposed by the
 * read: the fault word is exactly the named faults (and names the primary
 * reason), the usable-slot mask agrees with the selected slot, and each
 * diagnostic implies the slot state that raises it.
 */
function primaryFallbackConsistent(v: CommittedOracleVerdict): boolean {
  const fresh = v.status === "Fresh";
  const valid = v.validSources;
  const diagnostics = v.diagnostics;
  const has = (flag: OracleVerdictDiagnostic) =>
    v.diagnosticFlags.includes(flag);
  return (
    v.faults >>> ORACLE_FAULT_BITS.length === 0 &&
    fresh === (v.faults === 0) &&
    (fresh ||
      v.faultReasons.includes(
        v.reason as (typeof ORACLE_FAULT_BITS)[number],
      )) &&
    diagnostics >>> ORACLE_DIAGNOSTIC_BITS.length === 0 &&
    valid <= 0b11 &&
    (!fresh || v.selected !== null) &&
    (v.selected === "Primary") === ((valid & 0b01) !== 0) &&
    (v.selected === "Fallback") === (valid === 0b10) &&
    has("OnFallback") === (v.selected === "Fallback") &&
    (!has("PrimaryRefusedDivergence") || v.selected === "Fallback") &&
    (!has("DivergenceUnchecked") || valid === 0b11) &&
    (!has("FallbackUnusable") || (valid & 0b10) === 0)
  );
}

export function validateOraclePermissionMarket(market: number): void {
  if (!Number.isSafeInteger(market) || market < 1 || market > 0xffff_ffff)
    throw new Error("oracle permission market must be a positive uint32");
}

/** Decode the engine's seven-slot MessagePack read without lossy integers. */
export function decodeOraclePermissions(
  raw: unknown,
  expectedMarket?: number,
): OraclePermissions {
  const r = tuple(raw, 7, "response");
  const market = Number(positive(r[0], "market", 0xffff_ffffn));
  if (expectedMarket !== undefined && market !== expectedMarket)
    return invalid("market binding");
  const finalizedHeight = uint(r[1], "finalizedHeight");
  const state = r[2];
  if (state !== "Unavailable" && state !== "Committed") return invalid("state");
  const oraclePermission = r[3];
  if (oraclePermission !== "Satisfied" && oraclePermission !== "Unavailable")
    return invalid("permission");
  const effectivePolicy = optional(r[4], policy);
  const pending = optional(r[5], (raw) => {
    const p = tuple(raw, 2, "pending");
    return {
      effectiveHeight: uint(p[0], "pending.effectiveHeight"),
      policy: policy(p[1]),
    };
  });
  const committed = optional(r[6], verdict);
  if (
    state === "Unavailable" &&
    (effectivePolicy || committed || oraclePermission !== "Unavailable")
  )
    return invalid("unavailable consistency");
  if (
    state === "Committed" &&
    (!effectivePolicy ||
      !committed ||
      committed.height !== finalizedHeight ||
      (oraclePermission === "Satisfied") !== (committed.status === "Fresh"))
  )
    return invalid("committed consistency");
  if (
    pending &&
    (pending.effectiveHeight <= finalizedHeight ||
      (effectivePolicy && pending.policy.version <= effectivePolicy.version))
  )
    return invalid("pending epoch");
  return {
    market,
    finalizedHeight,
    state,
    oraclePermission,
    policy: effectivePolicy,
    pending,
    verdict: committed,
  };
}
