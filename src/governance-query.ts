import type {
  Address,
  AdminAction,
  CancelAllOrdersForAccount,
  AdminBatchItem,
  AdminSignerRegistry,
  CreateImpactMarket,
  CreateEvent,
  CreateMarket,
  EventOracleSource,
  ExpiryReason,
  ImpactMarketInfo,
  ImpactMarketStatus,
  PriceComparison,
  ProposalPage,
  ProposalDisplayInfo,
  ProposalStatus,
  SetTriggerMarketConfig,
  UpdateAdminSignerRegistry,
} from "./types.js";
import { Outcome } from "./types.js";

/**
 * Typed decoders for the engine's governance READ model — the responses
 * behind `GET /v1/admin/signer-registry`, `GET /v1/proposals`, and
 * `GET /v1/impact_markets`.
 *
 * These mirror engine structs (`exchange-core/src/query.rs`), they do not
 * define them. The engine serializes with `rmp_serde::to_vec` — the COMPACT
 * form — so every struct is a positional array and field ORDER is the wire
 * contract. A decoder that transposes two fields is silently wrong, never
 * loudly wrong, which is why `governance-query.test.ts` pins every function
 * here against golden bytes harvested from the engine's own serializer
 * rather than against hand-written expectations.
 *
 * Four encoding facts these decoders depend on, each confirmed from real
 * engine bytes (not inferred from the struct definitions):
 *
 *  1. `[u8; N]` and `Vec<u8>` serialize as msgpack ARRAYS OF INTEGERS, not
 *     as msgpack `bin`. Addresses and hashes therefore arrive as `number[]`
 *     and must be rebuilt into `Uint8Array`.
 *  2. A unit enum variant is a bare STRING (`"Pending"`).
 *  3. A struct or newtype enum variant is a single-entry MAP keyed by the
 *     variant name (`{ Failed: [4001] }`, `{ CreateMarket: [...] }`); a
 *     struct variant's payload is itself a positional array.
 *  4. `Option<T>` is transparent: `None` is nil, `Some(x)` is `x` with no
 *     wrapper.
 *
 * Integer widths are decoder-visible: msgpack encodes by MAGNITUDE, so a u64
 * field holding a small value arrives as `number` while a large one arrives
 * as `bigint` (the client decodes with `useBigInt64`). Every u64 is
 * normalized to `bigint` here so a field's TypeScript type never depends on
 * how big its value happened to be — the same normalization the client
 * already applies to `nextCursor`.
 */

const U8_MAX = 0xff;
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;

function toUnsignedBigInt(
  value: unknown,
  field: string,
  max = U64_MAX,
): bigint {
  let decoded: bigint;
  if (typeof value === "bigint") {
    decoded = value;
  } else if (typeof value === "number" && Number.isSafeInteger(value)) {
    decoded = BigInt(value);
  } else {
    throw new Error(
      `governance decode: ${field} is not a safe unsigned integer`,
    );
  }
  if (decoded < 0n || decoded > max) {
    throw new Error(
      `governance decode: ${field} is outside the unsigned integer range 0-${max}`,
    );
  }
  return decoded;
}

function toUnsignedNumber(value: unknown, field: string, max: number): number {
  return Number(toUnsignedBigInt(value, field, BigInt(max)));
}

const toU8 = (value: unknown, field: string) =>
  toUnsignedNumber(value, field, U8_MAX);
const toU32 = (value: unknown, field: string) =>
  toUnsignedNumber(value, field, U32_MAX);
const toU64 = (value: unknown, field: string) => toUnsignedBigInt(value, field);

/** A 20-byte governance address. */
const ADDRESS_LEN = 20;
/** A 32-byte domain-separated commitment. */
const HASH_LEN = 32;

/**
 * Rebuild a byte field. See encoding fact 1: these arrive as `number[]`, but
 * a `Uint8Array` is tolerated so a future encoder switch to msgpack `bin`
 * does not break every caller.
 *
 * Validated rather than coerced, and `expectedLen` is mandatory for the
 * fixed-width fields. `Uint8Array.from` is lossy in exactly the way that
 * matters here: it truncates out-of-range values modulo 256 and turns
 * non-numbers into 0, so `[300, -1, "x"]` would silently become a
 * well-formed-looking `[44, 255, 0]`. On this path the byte fields ARE the
 * identities and the commitments a signer approves against — a corrupted
 * address that still renders as a plausible address is worse than a refusal,
 * so a malformed field fails closed here instead of reaching a caller.
 * The engine's own newtypes are fixed-width (`SignerAddress([u8; 20])`);
 * this keeps the mirror as strict as the thing it mirrors.
 */
function toBytes(
  value: unknown,
  field: string,
  expectedLen?: number,
): Uint8Array {
  let bytes: Uint8Array;
  if (value instanceof Uint8Array) {
    bytes = value;
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const b: unknown = value[i];
      if (typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255) {
        throw new Error(
          `governance decode: ${field}[${i}] is not a byte (0-255 integer)`,
        );
      }
    }
    bytes = Uint8Array.from(value as number[]);
  } else {
    throw new Error(`governance decode: ${field} is not a byte sequence`);
  }
  if (expectedLen != null && bytes.length !== expectedLen) {
    throw new Error(
      `governance decode: ${field} is ${bytes.length} bytes, expected ${expectedLen}`,
    );
  }
  return bytes;
}

function toArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`governance decode: ${field} is not an array`);
}

function toTuple(
  value: unknown,
  field: string,
  expectedLength: number,
): unknown[] {
  const fields = toArray(value, field);
  if (fields.length !== expectedLength) {
    throw new Error(
      `governance decode: ${field} has ${fields.length} fields, expected exactly ${expectedLength}`,
    );
  }
  return fields;
}

function toString(value: unknown, field: string): string {
  if (typeof value === "string") return value;
  throw new Error(`governance decode: ${field} is not a string`);
}

/** The single entry of an externally-tagged enum map (encoding fact 3). */
function variantOf(
  value: unknown,
  field: string,
): { name: string; payload: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`governance decode: ${field} is not an enum variant`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) {
    throw new Error(
      `governance decode: ${field} has ${entries.length} variant keys, expected exactly 1`,
    );
  }
  const [name, payload] = entries[0]!;
  return { name, payload };
}

/** `CreateMarket` as the engine's 12-field positional payload. Distinct from
 *  `decodeMarketConfig` in client.ts: that decodes the STORED market config,
 *  this decodes the proposed action. */
function decodeCreateMarket(value: unknown): CreateMarket {
  const raw = toTuple(value, "createMarket", 12);
  return {
    market: toU32(raw[0], "createMarket.market"),
    imBps: toU32(raw[1], "createMarket.imBps"),
    mmBps: toU32(raw[2], "createMarket.mmBps"),
    takerFeeBps: toU32(raw[3], "createMarket.takerFeeBps"),
    makerFeeBps: toU32(raw[4], "createMarket.makerFeeBps"),
    signer: toBytes(raw[5], "createMarket.signer", ADDRESS_LEN),
    fundingIntervalMs: toU64(raw[6], "createMarket.fundingIntervalMs"),
    maxFundingRateBps: toU32(raw[7], "createMarket.maxFundingRateBps"),
    poolId: toU8(raw[8], "createMarket.poolId"),
    szDecimals: toU8(raw[9], "createMarket.szDecimals"),
    ticker: toString(raw[10], "createMarket.ticker"),
    maxOpenInterest: toU64(raw[11], "createMarket.maxOpenInterest"),
  };
}

function toTupleBetween(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number,
): unknown[] {
  const fields = toArray(value, field);
  if (fields.length < minLength || fields.length > maxLength) {
    throw new Error(
      `governance decode: ${field} has ${fields.length} fields, expected ` +
        `${minLength}-${maxLength}`,
    );
  }
  return fields;
}

const PRICE_COMPARISONS: readonly PriceComparison[] = [
  "GreaterThan",
  "LessThan",
  "GreaterThanOrEqual",
  "LessThanOrEqual",
];

function toPriceComparison(value: unknown, field: string): PriceComparison {
  if (
    typeof value === "string" &&
    (PRICE_COMPARISONS as readonly string[]).includes(value)
  ) {
    return value as PriceComparison;
  }
  throw new Error(`governance decode: ${field} is not a known PriceComparison`);
}

/** `Option<EventOracleSource>`: `None` is nil (fact 4), the unit variant is a
 *  bare string (fact 2), the struct variants are single-entry maps with
 *  positional payloads (fact 3). Fails closed on an unknown variant — a
 *  resolution mode this build cannot name must never render as one it can.
 *  Exported for the client's impact-market read, which carries the same
 *  enum in the same compact-rmp form. */
export function decodeOracleSource(
  value: unknown,
  field: string,
): EventOracleSource | undefined {
  if (value === null || value === undefined) return undefined;
  if (value === "RelayerAttested") return { kind: "RelayerAttested" };
  const { name, payload } = variantOf(value, field);
  switch (name) {
    case "UnderlyingPriceVsStrike": {
      const raw = toTuple(payload, field, 2);
      return {
        kind: "UnderlyingPriceVsStrike",
        strikePrice: toU64(raw[0], `${field}.strikePrice`),
        comparison: toPriceComparison(raw[1], `${field}.comparison`),
      };
    }
    case "MarketOracle": {
      const raw = toTuple(payload, field, 3);
      return {
        kind: "MarketOracle",
        market: toU32(raw[0], `${field}.market`),
        strikePrice: toU64(raw[1], `${field}.strikePrice`),
        comparison: toPriceComparison(raw[2], `${field}.comparison`),
      };
    }
    default:
      throw new Error(
        `governance decode: ${field} has unknown EventOracleSource variant "${name}"`,
      );
  }
}

const OUTCOMES: Record<string, Outcome> = {
  Yes: Outcome.Yes,
  No: Outcome.No,
  Void: Outcome.Void,
};

/** Impact-market lifecycle status: unit variants are bare strings (fact 2);
 *  `Resolved(Outcome)` is a single-entry map whose newtype payload is the
 *  outcome's variant name — a bare string, no array wrapper (confirmed from
 *  engine bytes, not inferred). Fails closed: a status or outcome this build
 *  cannot name must never render as one it can — these drive settle/void
 *  displays. */
function decodeImpactStatus(value: unknown, field: string): ImpactMarketStatus {
  if (value === "Trading") return { kind: "Trading" };
  if (value === "PreResolution") return { kind: "PreResolution" };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const { name, payload } = variantOf(value, field);
    if (name !== "Resolved") {
      throw new Error(
        `governance decode: ${field} has unknown ImpactMarketStatus variant "${name}"`,
      );
    }
    const outcome = typeof payload === "string" ? OUTCOMES[payload] : undefined;
    if (outcome === undefined) {
      throw new Error(
        `governance decode: ${field} has unknown Outcome ${JSON.stringify(payload)}`,
      );
    }
    return { kind: "Resolved", outcome };
  }
  throw new Error(
    `governance decode: ${field} is not a known ImpactMarketStatus`,
  );
}

/**
 * One `ImpactMarketDisplayInfo` row from `GET /v1/impact_markets` /
 * `/v1/impact_market/{id}` (exchange-core/src/query.rs), as the engine's
 * positional array: 12 required slots, plus trailers shipped incrementally —
 * [12] `oracleSource` (BE-54), [13] `description` and [14] `rules`
 * (admin-actions v2). Older gateways serve shorter tuples; missing trailers
 * stay `undefined` so callers can tell "not served" from "empty". Anything
 * outside the supported 12–15 shapes — including trailing fields — is a
 * refusal, same fail-closed posture as every decoder in this file.
 */
export function decodeImpactMarketInfo(
  value: unknown,
  index?: number,
): ImpactMarketInfo {
  const f = index == null ? "impactMarket" : `impactMarket[${index}]`;
  const raw = toTupleBetween(value, f, 12, 15);
  const info: ImpactMarketInfo = {
    impactMarketId: toU32(raw[0], `${f}.impactMarketId`),
    underlyingMarket: toU32(raw[1], `${f}.underlyingMarket`),
    cpyMarket: toU32(raw[2], `${f}.cpyMarket`),
    cpnMarket: toU32(raw[3], `${f}.cpnMarket`),
    ebyMarket: toU32(raw[4], `${f}.ebyMarket`),
    ebnMarket: toU32(raw[5], `${f}.ebnMarket`),
    question: toString(raw[6], `${f}.question`),
    deadlineMs: toU64(raw[7], `${f}.deadlineMs`),
    resolutionWindowMs: toU64(raw[8], `${f}.resolutionWindowMs`),
    status: decodeImpactStatus(raw[9], `${f}.status`),
    createdMs: toU64(raw[10], `${f}.createdMs`),
    resolvedMs: toU64(raw[11], `${f}.resolvedMs`),
  };
  if (raw.length > 12) {
    const oracleSource = decodeOracleSource(raw[12], `${f}.oracleSource`);
    if (oracleSource) info.oracleSource = oracleSource;
  }
  if (raw.length > 13) info.description = toString(raw[13], `${f}.description`);
  if (raw.length > 14) info.rules = toString(raw[14], `${f}.rules`);
  return info;
}

/** `CreateImpactMarket` as the engine's positional payload: 13 required
 *  fields plus three `serde(default)` trailers (oracleSource, description,
 *  rules). The engine's decoder tolerates the trailers' absence, so this
 *  mirror does too — same tolerance, same defaults. */
function decodeCreateImpactMarket(value: unknown): CreateImpactMarket {
  const f = "createImpactMarket";
  const raw = toTupleBetween(value, f, 13, 16);
  const decoded: CreateImpactMarket = {
    impactMarketId: toU32(raw[0], `${f}.impactMarketId`),
    underlyingMarket: toU32(raw[1], `${f}.underlyingMarket`),
    childMarketBase: toU32(raw[2], `${f}.childMarketBase`),
    question: toString(raw[3], `${f}.question`),
    deadlineMs: toU64(raw[4], `${f}.deadlineMs`),
    resolutionWindowMs: toU64(raw[5], `${f}.resolutionWindowMs`),
    imBps: toU32(raw[6], `${f}.imBps`),
    mmBps: toU32(raw[7], `${f}.mmBps`),
    takerFeeBps: toU32(raw[8], `${f}.takerFeeBps`),
    makerFeeBps: toU32(raw[9], `${f}.makerFeeBps`),
    fundingIntervalMs: toU64(raw[10], `${f}.fundingIntervalMs`),
    maxFundingRateBps: toU32(raw[11], `${f}.maxFundingRateBps`),
    signer: toBytes(raw[12], `${f}.signer`, ADDRESS_LEN),
    description: raw.length > 14 ? toString(raw[14], `${f}.description`) : "",
    rules: raw.length > 15 ? toString(raw[15], `${f}.rules`) : "",
  };
  const oracleSource =
    raw.length > 13
      ? decodeOracleSource(raw[13], `${f}.oracleSource`)
      : undefined;
  if (oracleSource) decoded.oracleSource = oracleSource;
  return decoded;
}

/** Standalone event: nine required fields and the engine's three default trailers. */
function decodeCreateEvent(value: unknown): CreateEvent {
  const f = "createEvent";
  const raw = toTupleBetween(value, f, 9, 12);
  const decoded: CreateEvent = {
    eventId: toU32(raw[0], `${f}.eventId`),
    childMarketBase: toU32(raw[1], `${f}.childMarketBase`),
    poolId: toU8(raw[2], `${f}.poolId`),
    question: toString(raw[3], `${f}.question`),
    settlementMs: toU64(raw[4], `${f}.settlementMs`),
    resolutionWindowMs: toU64(raw[5], `${f}.resolutionWindowMs`),
    takerFeeBps: toU32(raw[6], `${f}.takerFeeBps`),
    makerFeeBps: toU32(raw[7], `${f}.makerFeeBps`),
    signer: toBytes(raw[8], `${f}.signer`, ADDRESS_LEN),
    description: raw.length > 10 ? toString(raw[10], `${f}.description`) : "",
    rules: raw.length > 11 ? toString(raw[11], `${f}.rules`) : "",
  };
  const oracleSource =
    raw.length > 9
      ? decodeOracleSource(raw[9], `${f}.oracleSource`)
      : undefined;
  if (oracleSource) decoded.oracleSource = oracleSource;
  return decoded;
}

/** One item of a governance `Batch` — the CLOSED market-creation subset.
 *  Fails closed on any other variant name: a batch item this build cannot
 *  decode must never let the batch around it render as understood. */
function decodeBatchItem(value: unknown, field: string): AdminBatchItem {
  const { name, payload } = variantOf(value, field);
  switch (name) {
    case "CreateMarket":
      return { kind: "CreateMarket", value: decodeCreateMarket(payload) };
    case "CreateImpactMarket":
      return {
        kind: "CreateImpactMarket",
        value: decodeCreateImpactMarket(payload),
      };
    default:
      throw new Error(
        `governance decode: ${field} has unknown AdminBatchItem variant "${name}" — this SDK build cannot render it`,
      );
  }
}

function decodeUpdateRegistry(value: unknown): UpdateAdminSignerRegistry {
  const raw = toTuple(value, "updateRegistry", 2);
  return {
    newThreshold: toU32(raw[0], "updateRegistry.newThreshold"),
    newMembers: toArray(raw[1], "updateRegistry.newMembers").map((m, i) =>
      toBytes(m, `updateRegistry.newMembers[${i}]`, ADDRESS_LEN),
    ),
  };
}

function decodeCancelAllOrdersForAccount(
  value: unknown,
): CancelAllOrdersForAccount {
  const raw = toTuple(value, "cancelAllOrdersForAccount", 2);
  const market = raw[1];
  return {
    owner: toBytes(raw[0], "cancelAllOrdersForAccount.owner", ADDRESS_LEN),
    market:
      market === null || market === undefined
        ? null
        : toU32(market, "cancelAllOrdersForAccount.market"),
  };
}

function decodeSetTriggerMarketConfig(value: unknown): SetTriggerMarketConfig {
  const raw = toTuple(value, "setTriggerMarketConfig", 7);
  if (typeof raw[2] !== "boolean") {
    throw new Error(
      "governance decode: setTriggerMarketConfig.enabled is not boolean",
    );
  }
  return {
    market: toU32(raw[0], "setTriggerMarketConfig.market"),
    expectedCurrentVersion:
      raw[1] == null
        ? null
        : toU64(raw[1], "setTriggerMarketConfig.expectedCurrentVersion"),
    enabled: raw[2],
    maxTriggerSlippageBps: toU32(
      raw[3],
      "setTriggerMarketConfig.maxTriggerSlippageBps",
    ),
    maxMarkAgeMs: toU64(raw[4], "setTriggerMarketConfig.maxMarkAgeMs"),
    maxFuturePublishSkewMs: toU64(
      raw[5],
      "setTriggerMarketConfig.maxFuturePublishSkewMs",
    ),
    maxActiveBrackets: toU64(
      raw[6],
      "setTriggerMarketConfig.maxActiveBrackets",
    ),
  };
}

/** `kind` → the engine's `AdminActionType` tag, as a TABLE rather than
 *  arithmetic: a new arm added to `decodeAdminAction` without a row here is
 *  a compile error (`Record` over the closed union), never a silently
 *  inherited neighbour's tag. Mirrors `AdminActionType` in the engine and
 *  `action_type()` in the Rust core — 1/2 are v1, 3/4 are admin-actions v2. */
const ACTION_TAG_BY_KIND: Record<AdminAction["kind"], number> = {
  CreateMarket: 1,
  UpdateAdminSignerRegistry: 2,
  CreateImpactMarket: 3,
  Batch: 4,
  SetTriggerMarketConfig: 5,
  UnpauseBridge: 6,
  // Tag 7's TypeScript mirror is tracked separately under exchange#472.
  CancelAllOrdersForAccount: 8,
  CreateEvent: 9,
  ConfigureOraclePolicy: 12,
};

/** The typed inner operation a proposal carries. Fails closed on an unknown
 *  variant: an SDK build that does not know an operation must never let a
 *  caller render or approve it as though it did. */
export function decodeAdminAction(
  value: unknown,
  field = "action",
): AdminAction {
  // Unit variants (no fields) arrive as a bare string, not a single-entry map.
  // Only the known unit variant is accepted here; any other bare string falls
  // through to `variantOf`, which rejects it as "not an enum variant".
  if (value === "UnpauseBridge") return { kind: "UnpauseBridge" };
  const { name, payload } = variantOf(value, field);
  switch (name) {
    case "CreateEvent":
      return { kind: "CreateEvent", value: decodeCreateEvent(payload) };
    case "CancelAllOrdersForAccount":
      return {
        kind: "CancelAllOrdersForAccount",
        value: decodeCancelAllOrdersForAccount(payload),
      };
    case "ConfigureOraclePolicy": {
      const raw = toTuple(payload, "configureOraclePolicy", 2);
      return {
        kind: "ConfigureOraclePolicy",
        value: {
          effectiveHeight: toU64(
            raw[0],
            "configureOraclePolicy.effectiveHeight",
          ),
          bundle: toBytes(raw[1], "configureOraclePolicy.bundle"),
        },
      };
    }
    case "CreateMarket":
      return {
        kind: "CreateMarket",
        value: decodeCreateMarket(payload),
      };
    case "UpdateAdminSignerRegistry":
      return {
        kind: "UpdateAdminSignerRegistry",
        value: decodeUpdateRegistry(payload),
      };
    case "CreateImpactMarket":
      return {
        kind: "CreateImpactMarket",
        value: decodeCreateImpactMarket(payload),
      };
    case "Batch":
      return {
        kind: "Batch",
        value: toArray(payload, `${field}.batch`).map((item, i) =>
          decodeBatchItem(item, `${field}.batch[${i}]`),
        ),
      };
    case "SetTriggerMarketConfig":
      return {
        kind: "SetTriggerMarketConfig",
        value: decodeSetTriggerMarketConfig(payload),
      };
    default:
      throw new Error(
        `governance decode: ${field} has unknown AdminAction variant "${name}" — this SDK build cannot render it`,
      );
  }
}

/** Proposal status. Unit variants are strings, payload variants are
 *  single-entry maps whose payload is a positional array (facts 2 and 3). */
export function decodeProposalStatus(
  value: unknown,
  field = "status",
): ProposalStatus {
  if (typeof value === "string") {
    if (value === "Pending") return { kind: "Pending" };
    if (value === "Executed") return { kind: "Executed" };
    throw new Error(
      `governance decode: ${field} has unknown ProposalStatus "${value}" — this SDK build cannot render it`,
    );
  }
  const { name, payload } = variantOf(value, field);
  switch (name) {
    case "Failed": {
      const fields = toTuple(payload, `${field}.${name}`, 1);
      return {
        kind: "Failed",
        code: toU32(fields[0], `${field}.Failed.code`),
      };
    }
    case "Rejected": {
      const fields = toTuple(payload, `${field}.${name}`, 1);
      return {
        kind: "Rejected",
        by: toBytes(fields[0], `${field}.Rejected.by`, ADDRESS_LEN),
      };
    }
    case "Expired": {
      const fields = toTuple(payload, `${field}.${name}`, 1);
      const reason = fields[0];
      if (reason !== "Ttl" && reason !== "RegistryChanged") {
        throw new Error(
          `governance decode: ${field} has unknown ExpiryReason "${String(reason)}"`,
        );
      }
      return { kind: "Expired", reason: reason as ExpiryReason };
    }
    default:
      throw new Error(
        `governance decode: ${field} has unknown ProposalStatus variant "${name}" — this SDK build cannot render it`,
      );
  }
}

/**
 * One proposal, as the engine shapes it for display and offline
 * verification (`ProposalDisplayInfo`). `actionCanonicalBytes` is the EXACT
 * stored payload the content hash covers — an approving signer rebuilds
 * their approval from these fields rather than trusting anything a UI
 * rendered, so every field is decoded, none are skipped.
 */
export function decodeProposalDisplayInfo(
  raw: unknown[],
  index?: number,
): ProposalDisplayInfo {
  // Name the page position in errors: one malformed proposal in a page of
  // fifty is otherwise an unlocatable failure.
  const at = index == null ? "proposal" : `proposal[${index}]`;
  if (!Array.isArray(raw)) {
    throw new Error(`governance decode: ${at} is not an array`);
  }
  const fields = toTuple(raw, at, 15);
  const actionTag = toU8(fields[11], `${at}.actionTag`);
  const action = decodeAdminAction(fields[12], `${at}.action`);
  const expectedActionTag = ACTION_TAG_BY_KIND[action.kind];
  if (actionTag !== expectedActionTag) {
    throw new Error(
      `governance decode: ${at}.actionTag ${actionTag} does not match ${action.kind} tag ${expectedActionTag}`,
    );
  }
  return {
    proposalId: toU64(fields[0], `${at}.proposalId`),
    statusStored: decodeProposalStatus(fields[1], `${at}.statusStored`),
    statusEffective: decodeProposalStatus(fields[2], `${at}.statusEffective`),
    registryVersion: toU64(fields[3], `${at}.registryVersion`),
    threshold: toU32(fields[4], `${at}.threshold`),
    proposer: toBytes(fields[5], `${at}.proposer`, ADDRESS_LEN),
    approvals: toArray(fields[6], `${at}.approvals`).map((a, i) =>
      toBytes(a, `${at}.approvals[${i}]`, ADDRESS_LEN),
    ),
    rejections: toArray(fields[7], `${at}.rejections`).map((r, i) =>
      toBytes(r, `${at}.rejections[${i}]`, ADDRESS_LEN),
    ),
    createdHeight: toU64(fields[8], `${at}.createdHeight`),
    createdMs: toU64(fields[9], `${at}.createdMs`),
    expiryMs: toU64(fields[10], `${at}.expiryMs`),
    actionTag,
    action,
    // Variable length by nature — it is the stored action payload, whose
    // size depends on the operation. Still element-validated.
    actionCanonicalBytes: toBytes(fields[13], `${at}.actionCanonicalBytes`),
    contentHash: toBytes(fields[14], `${at}.contentHash`, HASH_LEN),
  };
}

/**
 * The installed signer registry, or `null` when none is seeded.
 *
 * `null` means admin multisig is INACTIVE (fail-closed), which is not the
 * same as an empty roster — callers must treat the two differently, so this
 * takes the already-unwrapped `Option` payload from the client.
 */
export function decodeAdminSignerRegistry(
  raw: unknown,
): AdminSignerRegistry | null {
  if (raw == null) return null;
  const fields = toTuple(raw, "registry", 3);
  return {
    version: toU64(fields[0], "registry.version"),
    threshold: toU32(fields[1], "registry.threshold"),
    members: toArray(fields[2], "registry.members").map((m, i) =>
      toBytes(m, `registry.members[${i}]`, ADDRESS_LEN),
    ),
  };
}

/** Decode the engine's one-field `AdminSignerRegistryInfo` envelope. */
export function decodeAdminSignerRegistryInfo(
  raw: unknown,
): AdminSignerRegistry | null {
  const fields = toTuple(raw, "registryInfo", 1);
  return decodeAdminSignerRegistry(fields[0]);
}

/** Decode and validate the engine's two-field proposal-page envelope. */
export function decodeProposalPage(raw: unknown): ProposalPage {
  const fields = toTuple(raw, "proposalPage", 2);
  const proposals = toArray(fields[0], "proposalPage.items").map(
    (proposal, i) =>
      decodeProposalDisplayInfo(
        toArray(proposal, `proposalPage.items[${i}]`),
        i,
      ),
  );
  return {
    proposals,
    nextCursor:
      fields[1] == null ? null : toU64(fields[1], "proposalPage.nextCursor"),
  };
}
