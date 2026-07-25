import type {
  Address,
  AdminAction,
  AdminSignerRegistry,
  CreateMarket,
  ExpiryReason,
  ProposalDisplayInfo,
  ProposalStatus,
  UpdateAdminSignerRegistry,
} from "./types.js";

/**
 * Typed decoders for the engine's governance READ model — the responses
 * behind `GET /v1/admin/signer-registry` and `GET /v1/proposals`.
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

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  throw new Error(`governance decode: ${field} is not an integer`);
}

function toNumber(value: unknown, field: string): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`governance decode: ${field} is not an integer`);
}

/** Rebuild a byte field. See encoding fact 1: these arrive as `number[]`,
 *  but tolerate a `Uint8Array` so a future encoder switch to msgpack `bin`
 *  does not break every caller. */
function toBytes(value: unknown, field: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error(`governance decode: ${field} is not a byte sequence`);
}

function toArray(value: unknown, field: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new Error(`governance decode: ${field} is not an array`);
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
function decodeCreateMarket(raw: unknown[]): CreateMarket {
  return {
    market: toNumber(raw[0], "createMarket.market"),
    imBps: toNumber(raw[1], "createMarket.imBps"),
    mmBps: toNumber(raw[2], "createMarket.mmBps"),
    takerFeeBps: toNumber(raw[3], "createMarket.takerFeeBps"),
    makerFeeBps: toNumber(raw[4], "createMarket.makerFeeBps"),
    signer: toBytes(raw[5], "createMarket.signer"),
    fundingIntervalMs: toBigInt(raw[6], "createMarket.fundingIntervalMs"),
    maxFundingRateBps: toNumber(raw[7], "createMarket.maxFundingRateBps"),
    poolId: toNumber(raw[8], "createMarket.poolId"),
    szDecimals: toNumber(raw[9], "createMarket.szDecimals"),
    ticker: String(raw[10] ?? ""),
    maxOpenInterest: toBigInt(raw[11], "createMarket.maxOpenInterest"),
  };
}

function decodeUpdateRegistry(raw: unknown[]): UpdateAdminSignerRegistry {
  return {
    newThreshold: toNumber(raw[0], "updateRegistry.newThreshold"),
    newMembers: toArray(raw[1], "updateRegistry.newMembers").map((m, i) =>
      toBytes(m, `updateRegistry.newMembers[${i}]`),
    ),
  };
}

/** The typed inner operation a proposal carries. Fails closed on an unknown
 *  variant: an SDK build that does not know an operation must never let a
 *  caller render or approve it as though it did. */
export function decodeAdminAction(
  value: unknown,
  field = "action",
): AdminAction {
  const { name, payload } = variantOf(value, field);
  switch (name) {
    case "CreateMarket":
      return {
        kind: "CreateMarket",
        value: decodeCreateMarket(toArray(payload, `${field}.CreateMarket`)),
      };
    case "UpdateAdminSignerRegistry":
      return {
        kind: "UpdateAdminSignerRegistry",
        value: decodeUpdateRegistry(
          toArray(payload, `${field}.UpdateAdminSignerRegistry`),
        ),
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
  const fields = toArray(payload, `${field}.${name}`);
  switch (name) {
    case "Failed":
      return {
        kind: "Failed",
        code: toNumber(fields[0], `${field}.Failed.code`),
      };
    case "Rejected":
      return {
        kind: "Rejected",
        by: toBytes(fields[0], `${field}.Rejected.by`),
      };
    case "Expired": {
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
  return {
    proposalId: toBigInt(raw[0], `${at}.proposalId`),
    statusStored: decodeProposalStatus(raw[1], `${at}.statusStored`),
    statusEffective: decodeProposalStatus(raw[2], `${at}.statusEffective`),
    registryVersion: toBigInt(raw[3], `${at}.registryVersion`),
    threshold: toNumber(raw[4], `${at}.threshold`),
    proposer: toBytes(raw[5], `${at}.proposer`),
    approvals: toArray(raw[6], `${at}.approvals`).map((a, i) =>
      toBytes(a, `${at}.approvals[${i}]`),
    ),
    rejections: toArray(raw[7], `${at}.rejections`).map((r, i) =>
      toBytes(r, `${at}.rejections[${i}]`),
    ),
    createdHeight: toBigInt(raw[8], `${at}.createdHeight`),
    createdMs: toBigInt(raw[9], `${at}.createdMs`),
    expiryMs: toBigInt(raw[10], `${at}.expiryMs`),
    actionTag: toNumber(raw[11], `${at}.actionTag`),
    action: decodeAdminAction(raw[12], `${at}.action`),
    actionCanonicalBytes: toBytes(raw[13], `${at}.actionCanonicalBytes`),
    contentHash: toBytes(raw[14], `${at}.contentHash`),
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
  const fields = toArray(raw, "registry");
  return {
    version: toBigInt(fields[0], "registry.version"),
    threshold: toNumber(fields[1], "registry.threshold"),
    members: toArray(fields[2], "registry.members").map((m, i) =>
      toBytes(m, `registry.members[${i}]`),
    ),
  };
}
