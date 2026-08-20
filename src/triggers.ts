import type {
  CancelPositionTriggers,
  PositionTriggerBracket,
  PositionTriggerInfo,
  SetPositionTriggers,
  SetTriggerMarketConfig,
  StoredTriggerLimb,
  TriggerEffectiveAvailability,
  TriggerEvaluation,
  TriggerKind,
  TriggerLimb,
  TriggerLimbState,
  TriggerMarketConfig,
  TriggerMarketConfigInfo,
  TriggerMarketConfigState,
  TriggerOutcomeReason,
  TriggerStatus,
} from "./types.js";

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;
export const MAX_TRIGGER_SLIPPAGE_BPS = 9_999;

function assertU64(name: string, value: bigint, nonzero = false): void {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new Error(`${name} must be an unsigned 64-bit bigint`);
  }
  if (nonzero && value === 0n) throw new Error(`${name} must be non-zero`);
}

function assertU32(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new Error(`${name} must be an unsigned 32-bit integer`);
  }
}

function validateLimb(name: string, limb: TriggerLimb): void {
  assertU64(`${name}.triggerPrice`, limb.triggerPrice, true);
  if (
    !Number.isInteger(limb.maxSlippageBps) ||
    limb.maxSlippageBps < 1 ||
    limb.maxSlippageBps > MAX_TRIGGER_SLIPPAGE_BPS
  ) {
    throw new Error(`${name}.maxSlippageBps must be in 1..=9999`);
  }
  if (limb.clientTriggerId != null) {
    assertU64(`${name}.clientTriggerId`, limb.clientTriggerId, true);
  }
}

/** Validate all state-independent invariants for action 0x25. */
export function validateSetPositionTriggers(action: SetPositionTriggers): void {
  assertU32("market", action.market);
  if (!(action.owner instanceof Uint8Array) || action.owner.length !== 20) {
    throw new Error("owner must be exactly 20 bytes");
  }
  assertU64("expectedPositionEpoch", action.expectedPositionEpoch, true);
  if (action.stopLoss == null && action.takeProfit == null) {
    throw new Error("at least one of stopLoss or takeProfit is required");
  }
  if (action.stopLoss != null) validateLimb("stopLoss", action.stopLoss);
  if (action.takeProfit != null) validateLimb("takeProfit", action.takeProfit);
  if (action.clientGroupId != null) {
    assertU64("clientGroupId", action.clientGroupId, true);
  }
  const stopId = action.stopLoss?.clientTriggerId;
  const takeId = action.takeProfit?.clientTriggerId;
  if (stopId != null && takeId != null && stopId === takeId) {
    throw new Error(
      "stopLoss and takeProfit clientTriggerId values must differ",
    );
  }
}

/** Validate all state-independent invariants for action 0x26. */
export function validateCancelPositionTriggers(
  action: CancelPositionTriggers,
): void {
  assertU32("market", action.market);
  if (!(action.owner instanceof Uint8Array) || action.owner.length !== 20) {
    throw new Error("owner must be exactly 20 bytes");
  }
  assertU64("expectedPositionEpoch", action.expectedPositionEpoch, true);
}

/** Validate the state-independent portion of admin action tag 0x05. */
export function validateSetTriggerMarketConfig(
  config: SetTriggerMarketConfig,
): void {
  assertU32("market", config.market);
  if (typeof config.enabled !== "boolean") {
    throw new Error("enabled must be boolean");
  }
  if (config.expectedCurrentVersion != null) {
    assertU64("expectedCurrentVersion", config.expectedCurrentVersion);
  }
  if (
    !Number.isInteger(config.maxTriggerSlippageBps) ||
    config.maxTriggerSlippageBps < 0 ||
    config.maxTriggerSlippageBps > MAX_TRIGGER_SLIPPAGE_BPS
  ) {
    throw new Error("maxTriggerSlippageBps must be in 0..=9999");
  }
  assertU64("maxMarkAgeMs", config.maxMarkAgeMs);
  assertU64("maxFuturePublishSkewMs", config.maxFuturePublishSkewMs);
  assertU64("maxActiveBrackets", config.maxActiveBrackets);
  if (
    config.enabled &&
    (config.maxTriggerSlippageBps === 0 ||
      config.maxMarkAgeMs === 0n ||
      config.maxFuturePublishSkewMs === 0n ||
      config.maxActiveBrackets === 0n)
  ) {
    throw new Error(
      "enabled trigger config requires non-zero slippage, mark-age, future-skew and bracket bounds",
    );
  }
}

function tuple(value: unknown, name: string, size: number): unknown[] {
  if (!Array.isArray(value) || value.length !== size) {
    throw new Error(
      `trigger decode: ${name} must be exactly a ${size}-field tuple`,
    );
  }
  return value;
}

function uint(value: unknown, name: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n && value <= U64_MAX) return value;
  } else if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= U64_MAX) return parsed;
  } else if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }
  throw new Error(`trigger decode: ${name} is not an exact u64`);
}

function uint32(value: unknown, name: string): number {
  const n = Number(uint(value, name));
  if (n > U32_MAX) throw new Error(`trigger decode: ${name} exceeds u32`);
  return n;
}

function bytes20(value: unknown, name: string): Uint8Array {
  if (
    Array.isArray(value) &&
    !value.every(
      (byte) =>
        typeof byte === "number" &&
        Number.isInteger(byte) &&
        byte >= 0 &&
        byte <= 255,
    )
  ) {
    throw new Error(`trigger decode: ${name} contains a non-byte value`);
  }
  const bytes =
    value instanceof Uint8Array
      ? value
      : Array.isArray(value)
        ? Uint8Array.from(value as number[])
        : null;
  if (bytes === null || bytes.length !== 20) {
    throw new Error(`trigger decode: ${name} must be exactly 20 bytes`);
  }
  return bytes;
}

const KINDS = new Set<TriggerKind>(["StopLoss", "TakeProfit"]);
const STATES = new Set<TriggerLimbState>([
  "Armed",
  "Filled",
  "Partial",
  "NoFill",
  "Rejected",
  "Cancelled",
  "Invalidated",
]);
const REASONS = new Set<TriggerOutcomeReason>([
  "PositionClosed",
  "PositionEpochChanged",
  "PositionSideChanged",
  "BelowMaintenance",
  "IndeterminateAccount",
  "MarketDisabled",
  "MarkUnavailable",
  "MarkStale",
  "MarkFutureDated",
  "NoEligibleLiquidity",
  "SelfTradePrevention",
  "WorkLimitReached",
  "ExecutionRejected",
]);

function exactEnum<T extends string>(
  value: unknown,
  allowed: Set<T>,
  name: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new Error(`trigger decode: unknown ${name} ${String(value)}`);
  }
  return value as T;
}

function decodeEvaluation(value: unknown): TriggerEvaluation | null {
  if (value == null) return null;
  const row = tuple(value, "TriggerEvaluation", 7);
  const requestedQuantity = uint(row[3], "evaluation.requested_quantity");
  const filledQuantity = uint(row[4], "evaluation.filled_quantity");
  const residualQuantity = uint(row[5], "evaluation.residual_quantity");
  if (filledQuantity + residualQuantity !== requestedQuantity) {
    throw new Error("trigger decode: evaluation quantities do not conserve");
  }
  return {
    height: uint(row[0], "evaluation.height"),
    frozenMark: uint(row[1], "evaluation.frozen_mark"),
    limitPrice: row[2] == null ? null : uint(row[2], "evaluation.limit_price"),
    requestedQuantity,
    filledQuantity,
    residualQuantity,
    reason:
      row[6] == null
        ? null
        : exactEnum(row[6], REASONS, "TriggerOutcomeReason"),
  };
}

function decodeStoredLimb(value: unknown): StoredTriggerLimb | null {
  if (value == null) return null;
  const row = tuple(value, "StoredTriggerLimb", 7);
  const limbId = uint(row[0], "limb_id");
  const triggerPrice = uint(row[2], "trigger_price");
  if (limbId === 0n || triggerPrice === 0n) {
    throw new Error(
      "trigger decode: limb id and trigger price must be non-zero",
    );
  }
  const maxSlippageBps = uint32(row[3], "max_slippage_bps");
  if (maxSlippageBps < 1 || maxSlippageBps > MAX_TRIGGER_SLIPPAGE_BPS) {
    throw new Error("trigger decode: limb slippage is outside 1..=9999");
  }
  const clientTriggerId =
    row[4] == null ? null : uint(row[4], "client_trigger_id");
  if (clientTriggerId === 0n) {
    throw new Error("trigger decode: client trigger id must be non-zero");
  }
  return {
    limbId,
    kind: exactEnum(row[1], KINDS, "TriggerKind"),
    triggerPrice,
    maxSlippageBps,
    clientTriggerId,
    state: exactEnum(row[5], STATES, "TriggerLimbState"),
    lastEvaluation: decodeEvaluation(row[6]),
  };
}

function decodeConfig(value: unknown): TriggerMarketConfig | null {
  if (value == null) return null;
  const row = tuple(value, "TriggerMarketConfig", 6);
  if (typeof row[1] !== "boolean") {
    throw new Error("trigger decode: config.enabled is not boolean");
  }
  const version = uint(row[0], "config.version");
  if (version === 0n) throw new Error("trigger decode: config version is zero");
  const config = {
    version,
    enabled: row[1],
    maxTriggerSlippageBps: uint32(row[2], "config.max_trigger_slippage_bps"),
    maxMarkAgeMs: uint(row[3], "config.max_mark_age_ms"),
    maxFuturePublishSkewMs: uint(row[4], "config.max_future_publish_skew_ms"),
    maxActiveBrackets: uint(row[5], "config.max_active_brackets"),
  } satisfies TriggerMarketConfig;
  validateSetTriggerMarketConfig({
    market: 0,
    expectedCurrentVersion: null,
    enabled: config.enabled,
    maxTriggerSlippageBps: config.maxTriggerSlippageBps,
    maxMarkAgeMs: config.maxMarkAgeMs,
    maxFuturePublishSkewMs: config.maxFuturePublishSkewMs,
    maxActiveBrackets: config.maxActiveBrackets,
  });
  return config;
}

function decodeConfigState(value: unknown): TriggerMarketConfigState {
  const row = tuple(value, "TriggerMarketConfigState", 2);
  const current = decodeConfig(row[0]);
  let pending: TriggerMarketConfigState["pending"] = null;
  if (row[1] != null) {
    const pendingRow = tuple(row[1], "PendingTriggerMarketConfig", 3);
    const config = decodeConfig(pendingRow[0]);
    if (config === null) {
      throw new Error("trigger decode: pending config is null");
    }
    const acceptedHeight = uint(pendingRow[1], "pending.accepted_height");
    const effectiveHeight = uint(pendingRow[2], "pending.effective_height");
    if (
      acceptedHeight === 0n ||
      acceptedHeight === U64_MAX ||
      effectiveHeight !== acceptedHeight + 1n
    ) {
      throw new Error("trigger decode: invalid pending effective height");
    }
    const expectedVersion = current === null ? 1n : current.version + 1n;
    if (config.version !== expectedVersion) {
      throw new Error("trigger decode: pending config version is not next");
    }
    pending = { config, acceptedHeight, effectiveHeight };
  }
  if (current === null && pending === null) {
    throw new Error("trigger decode: empty trigger market config state");
  }
  return { current, pending };
}

/** Decode the canonical, market-sorted trigger-policy registry. */
export function decodeTriggerMarketConfigInfos(
  value: unknown,
): TriggerMarketConfigInfo[] {
  if (!Array.isArray(value)) {
    throw new Error("trigger decode: market configs response is not an array");
  }
  let previousMarket = -1;
  return value.map((entry) => {
    const row = tuple(entry, "TriggerMarketConfigInfo", 2);
    const market = uint32(row[0], "market");
    if (market <= previousMarket) {
      throw new Error(
        "trigger decode: market configs are not strictly market-sorted",
      );
    }
    previousMarket = market;
    return { market, state: decodeConfigState(row[1]) };
  });
}

function decodeAvailability(value: unknown): TriggerEffectiveAvailability {
  const simple = new Set([
    "Available",
    "TriggerActionsInactive",
    "PendingActivation",
    "MigrationIncomplete",
    "ConfigurationMissing",
    "MarketDisabled",
  ] as const);
  if (typeof value === "string" && simple.has(value as never)) {
    return { kind: value } as TriggerEffectiveAvailability;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const reason = (value as Record<string, unknown>).Deferred;
    if (reason !== undefined) {
      return {
        kind: "Deferred",
        reason: exactEnum(reason, REASONS, "TriggerOutcomeReason"),
      };
    }
  }
  throw new Error("trigger decode: unknown TriggerEffectiveAvailability");
}

function decodeBracket(value: unknown): PositionTriggerBracket {
  const row = tuple(value, "PositionTriggerBracket", 10);
  const side = row[4];
  if (side !== "Buy" && side !== "Sell") {
    throw new Error(`trigger decode: unknown position side ${String(side)}`);
  }
  const groupId = uint(row[0], "group_id");
  const positionEpoch = uint(row[3], "position_epoch");
  const acceptedHeight = uint(row[5], "accepted_height");
  const activeFromHeight = uint(row[6], "active_from_height");
  if (groupId === 0n || positionEpoch === 0n || acceptedHeight === 0n) {
    throw new Error("trigger decode: bracket ids/heights must be non-zero");
  }
  if (activeFromHeight !== acceptedHeight + 1n) {
    throw new Error("trigger decode: invalid active_from_height");
  }
  const stopLoss = decodeStoredLimb(row[8]);
  const takeProfit = decodeStoredLimb(row[9]);
  if (stopLoss === null && takeProfit === null) {
    throw new Error("trigger decode: bracket has no limbs");
  }
  if (stopLoss !== null && stopLoss.kind !== "StopLoss") {
    throw new Error("trigger decode: stopLoss has wrong kind");
  }
  if (takeProfit !== null && takeProfit.kind !== "TakeProfit") {
    throw new Error("trigger decode: takeProfit has wrong kind");
  }
  if (
    stopLoss !== null &&
    takeProfit !== null &&
    (stopLoss.limbId === takeProfit.limbId ||
      (stopLoss.clientTriggerId !== null &&
        stopLoss.clientTriggerId === takeProfit.clientTriggerId))
  ) {
    throw new Error("trigger decode: bracket has duplicate limb identity");
  }
  const clientGroupId = row[7] == null ? null : uint(row[7], "client_group_id");
  if (clientGroupId === 0n) {
    throw new Error("trigger decode: client group id must be non-zero");
  }
  return {
    groupId,
    owner: bytes20(row[1], "owner"),
    market: uint32(row[2], "market"),
    positionEpoch,
    positionSide: side,
    acceptedHeight,
    activeFromHeight,
    clientGroupId,
    stopLoss,
    takeProfit,
  };
}

/** Decode the engine's positional `Vec<PositionTriggerInfo>` response. */
export function decodePositionTriggerInfos(
  value: unknown,
): PositionTriggerInfo[] {
  if (!Array.isArray(value)) {
    throw new Error("trigger decode: response is not an array");
  }
  return value.map((entry) => {
    const row = tuple(entry, "PositionTriggerInfo", 3);
    return {
      bracket: decodeBracket(row[0]),
      marketConfig: decodeConfig(row[1]),
      availability: decodeAvailability(row[2]),
    };
  });
}

/** Parse trigger-status JSON without routing 64-bit heights through Number. */
export function decodeTriggerStatusJson(text: string): TriggerStatus {
  const protectedText = text.replace(
    /("(?:finalized_height|admission_height)"\s*:\s*)(-?\d+)/g,
    '$1"$2"',
  );
  let value: unknown;
  try {
    value = JSON.parse(protectedText);
  } catch {
    throw new Error("trigger status decode: malformed JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("trigger status decode: expected an object");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.actions_active !== "boolean") {
    throw new Error("trigger status decode: actions_active is not boolean");
  }
  const finalizedHeight = uint(row.finalized_height, "finalized_height");
  const admissionHeight = uint(row.admission_height, "admission_height");
  if (admissionHeight !== finalizedHeight + 1n) {
    throw new Error(
      "trigger status decode: admission height is not next height",
    );
  }
  return {
    finalizedHeight,
    admissionHeight,
    actionsActive: row.actions_active,
  };
}
