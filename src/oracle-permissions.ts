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
const reasons = [
  "InvalidPolicy",
  "UpdateLimitExceeded",
  "ClockRegression",
  "ManualHalt",
  "SessionUnknown",
  "SessionClosed",
  "BadQuality",
  "Disagreement",
  "AnchorUnavailable",
  "MovementBound",
  "MissingSource",
  "ExpiredSource",
  "OutsideSession",
  "PairTimeMismatch",
  "RecoveryPending",
  "Fresh",
] as const;
export type OracleVerdictReason = (typeof reasons)[number];

export interface CommittedOracleVerdict {
  height: bigint;
  blockTime: bigint;
  status: OracleVerdictStatus;
  reason: OracleVerdictReason;
  certified: { price: bigint; providerTime: bigint } | null;
  eligibleSince: bigint | null;
}

export interface OraclePermissions {
  market: number;
  finalizedHeight: bigint;
  activationHeight: bigint | null;
  oracleActive: boolean;
  state: "Legacy" | "Unavailable" | "Committed";
  /** Satisfied covers this single oracle dependency only, not a whole action. */
  oraclePermission: "Satisfied" | "Unavailable" | null;
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
function verdict(raw: unknown): CommittedOracleVerdict {
  const v = tuple(raw, 6, "verdict");
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
  const value: CommittedOracleVerdict = {
    height: uint(v[0], "verdict.height"),
    blockTime: uint(v[1], "verdict.blockTime"),
    status,
    reason: reason as OracleVerdictReason,
    certified,
    eligibleSince: optional(v[5], (raw) => uint(raw, "eligibleSince")),
  };
  if (
    (status === "Fresh") !== (reason === "Fresh") ||
    (status === "Fresh") !== (certified !== null) ||
    (status === "Fresh") !== (value.eligibleSince !== null) ||
    (certified && certified.providerTime > value.blockTime) ||
    (value.eligibleSince !== null && value.eligibleSince > value.blockTime)
  )
    return invalid("verdict consistency");
  return value;
}

export function validateOraclePermissionMarket(market: number): void {
  if (!Number.isSafeInteger(market) || market < 1 || market > 0xffff_ffff)
    throw new Error("oracle permission market must be a positive uint32");
}

/** Decode the engine's frozen 9-slot MessagePack read without lossy integers. */
export function decodeOraclePermissions(
  raw: unknown,
  expectedMarket?: number,
): OraclePermissions {
  const r = tuple(raw, 9, "response");
  const market = Number(positive(r[0], "market", 0xffff_ffffn));
  if (expectedMarket !== undefined && market !== expectedMarket)
    return invalid("market binding");
  const finalizedHeight = uint(r[1], "finalizedHeight");
  const activationHeight = optional(r[2], (raw) =>
    uint(raw, "activationHeight"),
  );
  if (typeof r[3] !== "boolean") return invalid("oracleActive");
  const oracleActive = r[3];
  if (
    oracleActive !==
    (activationHeight !== null && finalizedHeight >= activationHeight)
  )
    return invalid("activation binding");
  const state = r[4];
  if (state !== "Legacy" && state !== "Unavailable" && state !== "Committed")
    return invalid("state");
  const oraclePermission = r[5];
  if (
    oraclePermission !== null &&
    oraclePermission !== "Satisfied" &&
    oraclePermission !== "Unavailable"
  )
    return invalid("permission");
  const effectivePolicy = optional(r[6], policy);
  const pending = optional(r[7], (raw) => {
    const p = tuple(raw, 2, "pending");
    return {
      effectiveHeight: uint(p[0], "pending.effectiveHeight"),
      policy: policy(p[1]),
    };
  });
  const committed = optional(r[8], verdict);
  if (state === "Legacy") {
    if (
      oracleActive ||
      oraclePermission !== null ||
      effectivePolicy ||
      pending ||
      committed
    )
      return invalid("legacy consistency");
  } else {
    if (!oracleActive || oraclePermission === null)
      return invalid("active consistency");
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
  }
  if (
    pending &&
    (pending.effectiveHeight <= finalizedHeight ||
      (effectivePolicy && pending.policy.version <= effectivePolicy.version))
  )
    return invalid("pending epoch");
  return {
    market,
    finalizedHeight,
    activationHeight,
    oracleActive,
    state,
    oraclePermission,
    policy: effectivePolicy,
    pending,
    verdict: committed,
  };
}
