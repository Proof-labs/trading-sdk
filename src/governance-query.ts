import { Encoder } from "@msgpack/msgpack";
import type {
  AdminAction,
  AdminSignerRegistry,
  ExpiryReason,
  ProposalPage,
  ProposalDisplayInfo,
  ProposalStatus,
  NodeVersion,
  PendingUpgradePlan,
  LiquidationConfig,
  LiquidationConfigInfo,
  AuthoritiesSnapshot,
  UpgradesInfo,
} from "./types.js";
import { adminActionFromWasm } from "./codec-adapter.js";
import { INITIAL_TAKEOVER_DISCOUNT_BPS } from "./liquidation-config.js";
import { getWasm } from "./wasm-loader.js";

const actionEncoder = new Encoder({ useBigInt64: true });

/** Integers past 32 bits as bigint: the encoder writes such a number as a
 *  float, which the wire refuses. */
function integral(value: unknown): unknown {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return Math.abs(value) > 0xffff_ffff ? BigInt(value) : value;
  }
  if (Array.isArray(value)) return value.map(integral);
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, integral(v)]),
    );
  }
  return value;
}

/**
 * Typed decoders for the engine's governance READ model — the responses
 * behind `GET /v1/admin/signer-registry` and `GET /v1/proposals`. The
 * proposal's `AdminAction` is decoded as its wire type in the Rust core.
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

/// A `LiquidationConfig` as `[targetRatioBps, [numerator, denominator],
/// partialPenaltyBps, maxBookOrders, maxCommittedFills, takeoverDiscountBps?]`.
/// Every newtype is its bare integer; a record without the takeover discount
/// decodes with the engine's initial value.
function decodeLiquidationConfigTuple(
  value: unknown,
  name: string,
): LiquidationConfig {
  const c = toTupleBetween(value, name, 5, 6);
  const threshold = toTuple(c[1], `${name}.fullCloseThreshold`, 2);
  const field = (part: string) => `${name}.${part}`;
  return {
    targetRatioBps: toU32(c[0], field("targetRatioBps")),
    fullCloseThreshold: {
      numerator: toU32(threshold[0], field("fullCloseThreshold.numerator")),
      denominator: toU32(threshold[1], field("fullCloseThreshold.denominator")),
    },
    partialPenaltyBps: toU32(c[2], field("partialPenaltyBps")),
    maxBookOrders: toU32(c[3], field("maxBookOrders")),
    maxCommittedFills: toU32(c[4], field("maxCommittedFills")),
    takeoverDiscountBps:
      c.length > 5
        ? toU32(c[5], field("takeoverDiscountBps"))
        : INITIAL_TAKEOVER_DISCOUNT_BPS,
  };
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

/** `kind` → the engine's `AdminActionType` tag, as a TABLE rather than
 *  arithmetic: a new arm added to `decodeAdminAction` without a row here is
 *  a compile error (`Record` over the closed union), never a silently
 *  inherited neighbour's tag. Mirrors `AdminActionType` in the engine and
 *  `action_type()` in the Rust core — 1/2 are v1, 3/4 are admin-actions v2. */
export const ACTION_TAG_BY_KIND: Record<AdminAction["kind"], number> = {
  CreateMarket: 1,
  UpdateAdminSignerRegistry: 2,
  CreateEvent: 9,
  AttachConditional: 10,
  Batch: 4,
  SetTriggerMarketConfig: 5,
  UnpauseBridge: 6,
  UpdateAuthoritySet: 7,
  CancelAllOrdersForAccount: 8,
  ConfigureOraclePolicy: 12,
  SetOracleGuards: 13,
  FundInsuranceFund: 18,
  WithdrawInsuranceFund: 25,
  ExecInsuranceFund: 26,
  SetMarginOffsetPolicy: 27,
  ScheduleUpgrade: 14,
  CancelUpgrade: 15,
  SetWithdrawalLimit: 19,
  SetLiquidationConfig: 17,
  SetOperatorReceiptRegistry: 20,
  EnableSubAccounts: 21,
};

/** The typed inner operation a proposal carries, decoded as the wire's
 *  `AdminAction` in the Rust core. Fails closed on an unknown variant: an SDK
 *  build that does not know an operation must never let a caller render or
 *  approve it as though it did. */
export function decodeAdminAction(
  value: unknown,
  field = "action",
): AdminAction {
  try {
    const wasm = getWasm();
    return adminActionFromWasm(
      wasm.decode_read(
        wasm.ReadKind.AdminAction,
        actionEncoder.encode(integral(value)),
      ),
    );
  } catch (e) {
    throw new Error(
      `governance decode: ${field}: ${e instanceof Error ? e.message : String(e)}`,
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
  const action =
    fields[12] == null ? null : decodeAdminAction(fields[12], `${at}.action`);
  if (action !== null) {
    const expectedActionTag = ACTION_TAG_BY_KIND[action.kind];
    if (actionTag !== expectedActionTag) {
      throw new Error(
        `governance decode: ${at}.actionTag ${actionTag} does not match ${action.kind} tag ${expectedActionTag}`,
      );
    }
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

const AUTHORITIES_FIELDS = [
  "relayer",
  "oracle",
  "cexComposite",
  "custody",
  "marketParams",
  "scheduledOps",
] as const;

/**
 * Decode the engine's six-field `AuthoritiesSnapshot`. Fails closed on any
 * other shape: a partially decoded set would present a missing authority as
 * an empty one.
 */
export function decodeAuthoritiesSnapshot(raw: unknown): AuthoritiesSnapshot {
  const fields = toTuple(raw, "authorities", AUTHORITIES_FIELDS.length);
  const out = {} as AuthoritiesSnapshot;
  AUTHORITIES_FIELDS.forEach((name, i) => {
    out[name] = toArray(fields[i], `authorities.${name}`).map((a, j) =>
      toBytes(a, `authorities.${name}[${j}]`, ADDRESS_LEN),
    );
  });
  return out;
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

/** Decode the engine's `UpgradesInfo` (`GET /v1/upgrades`). */
export function decodeUpgradesInfo(raw: unknown): UpgradesInfo {
  const fields = toTuple(raw, "upgrades", 2);
  let plan: PendingUpgradePlan | null = null;
  if (fields[0] != null) {
    const p = toTuple(fields[0], "upgrades.plan", 5);
    plan = {
      targetHeight: toU64(p[0], "upgrades.plan.targetHeight"),
      major: toU32(p[1], "upgrades.plan.major"),
      minor: toU32(p[2], "upgrades.plan.minor"),
      successorSha256: toBytes(p[3], "upgrades.plan.successorSha256", HASH_LEN),
      scheduledHeight: toU64(p[4], "upgrades.plan.scheduledHeight"),
    };
  }
  const executed = toArray(fields[1], "upgrades.executed").map((e, i) => {
    const x = toTuple(e, `upgrades.executed[${i}]`, 3);
    return {
      activatedHeight: toU64(x[0], `upgrades.executed[${i}].activatedHeight`),
      major: toU32(x[1], `upgrades.executed[${i}].major`),
      minor: toU32(x[2], `upgrades.executed[${i}].minor`),
    };
  });
  return { plan, executed };
}

/** Decode `GET /v1/liquidation-config`: `[sequence, config]`. */
export function decodeLiquidationConfigInfo(
  raw: unknown,
): LiquidationConfigInfo {
  const fields = toTuple(raw, "liquidationConfig", 2);
  return {
    sequence: toU64(fields[0], "liquidationConfig.sequence"),
    config: decodeLiquidationConfigTuple(fields[1], "liquidationConfig.config"),
  };
}

/** Validate the node's JSON `GET /v1/version` body. */
export function decodeNodeVersion(raw: unknown): NodeVersion {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("version decode: body is not an object");
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string => {
    if (typeof o[k] !== "string") {
      throw new Error(`version decode: ${k} is not a string`);
    }
    return o[k] as string;
  };
  const sha = str("engine_lib_sha256");
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error("version decode: engine_lib_sha256 is not 64 hex chars");
  }
  return {
    node: str("node"),
    engine: str("engine"),
    engineAbiVersion: toU32(o.engine_abi_version, "version.engine_abi_version"),
    engineMajor: toU32(o.engine_major, "version.engine_major"),
    engineMinor: toU32(o.engine_minor, "version.engine_minor"),
    engineLibSha256: sha,
  };
}
