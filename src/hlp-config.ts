import type { HlpConfigUpdatedEvent, SetHlpConfig, TxEvent } from "./types.js";

const U64_MAX = (1n << 64n) - 1n;
const ADDRESS_LEN = 20;

/** The ABCI event type the engine emits for `Event::HlpConfigUpdated`
 *  (snake_case variant name, proof-wire 2.3.0). */
export const HLP_CONFIG_UPDATED_EVENT_TYPE = "hlp_config_updated";

/** Attribute keys of `hlp_config_updated`, in the engine's emission order. */
const HLP_CONFIG_UPDATED_KEYS = [
  "address",
  "bootstrap_balance",
  "min_balance_floor",
  "enabled",
  "proposal_id",
] as const;

function isZeroAddress(address: Uint8Array): boolean {
  return address.every((b) => b === 0);
}

/** The engine's state-independent shape rules shared by the action and the
 *  post-write event (`validate_set_hlp_config`, exchange#748). */
function checkHlpShape(
  addressIsZero: boolean,
  bootstrapBalance: bigint,
  minBalanceFloor: bigint,
  enabled: boolean,
  what: string,
): void {
  if (addressIsZero) {
    throw new Error(`${what}: HLP address must be non-zero`);
  }
  if (enabled && bootstrapBalance === 0n) {
    throw new Error(`${what}: bootstrapBalance must be positive when enabled`);
  }
  if (minBalanceFloor > bootstrapBalance) {
    throw new Error(`${what}: minBalanceFloor cannot exceed bootstrapBalance`);
  }
}

function checkU64(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
    throw new Error(`SetHlpConfig: ${field} must be an unsigned 64-bit bigint`);
  }
  return value;
}

/**
 * Mirror the engine's `validate_set_hlp_config` rules for `SetHlpConfig`
 * (inner admin tag 16 / 0x10): the address is 20 non-zero bytes, a positive
 * `bootstrapBalance` is required when `enabled`, and `minBalanceFloor` is at
 * most `bootstrapBalance`. Both balances are unsigned 64-bit microUSDC. The
 * engine re-validates at propose and execute time; governance authorization
 * stays an engine check.
 */
export function validateSetHlpConfig(action: SetHlpConfig): void {
  if (
    !(action.address instanceof Uint8Array) ||
    action.address.length !== ADDRESS_LEN
  ) {
    throw new Error("SetHlpConfig: address must be a 20-byte Uint8Array");
  }
  const bootstrap = checkU64(action.bootstrapBalance, "bootstrapBalance");
  const floor = checkU64(action.minBalanceFloor, "minBalanceFloor");
  if (typeof action.enabled !== "boolean") {
    throw new Error("SetHlpConfig: enabled must be a boolean");
  }
  checkHlpShape(
    isZeroAddress(action.address),
    bootstrap,
    floor,
    action.enabled,
    "SetHlpConfig",
  );
}

/** A canonical unsigned decimal u64: no sign, no leading zeros, in range. */
function canonicalU64(value: string, field: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(
      `hlp_config_updated: ${field} is not a canonical unsigned decimal`,
    );
  }
  const n = BigInt(value);
  if (n > U64_MAX) {
    throw new Error(`hlp_config_updated: ${field} exceeds u64`);
  }
  return n;
}

/**
 * Decode an ABCI `hlp_config_updated` event (the engine's
 * `Event::HlpConfigUpdated`, emitted when a `SetHlpConfig` proposal executes)
 * into its typed form. Fails closed: the event type must match, the attribute
 * set must be exactly `address`, `bootstrap_balance`, `min_balance_floor`,
 * `enabled`, `proposal_id` (no duplicates, no extras), the address must be 40
 * lowercase hex characters, integers must be canonical u64 decimals, `enabled`
 * must be `"true"` or `"false"`, and the carried post-write state must satisfy
 * the engine's `SetHlpConfig` shape rules. Anything else throws rather than
 * returning a plausible-looking backstop configuration.
 */
export function decodeHlpConfigUpdatedEvent(
  event: TxEvent,
): HlpConfigUpdatedEvent {
  if (event?.type !== HLP_CONFIG_UPDATED_EVENT_TYPE) {
    throw new Error(
      `hlp_config_updated: unexpected event type ${JSON.stringify(event?.type)}`,
    );
  }
  if (!Array.isArray(event.attributes)) {
    throw new Error("hlp_config_updated: attributes is not an array");
  }
  const allowed: ReadonlySet<string> = new Set(HLP_CONFIG_UPDATED_KEYS);
  const attrs = new Map<string, string>();
  for (const attr of event.attributes) {
    if (
      typeof attr?.key !== "string" ||
      typeof attr.value !== "string" ||
      !allowed.has(attr.key)
    ) {
      throw new Error(
        `hlp_config_updated: unexpected attribute ${JSON.stringify(attr?.key)}`,
      );
    }
    if (attrs.has(attr.key)) {
      throw new Error(`hlp_config_updated: duplicate attribute ${attr.key}`);
    }
    attrs.set(attr.key, attr.value);
  }
  for (const key of HLP_CONFIG_UPDATED_KEYS) {
    if (!attrs.has(key)) {
      throw new Error(`hlp_config_updated: missing attribute ${key}`);
    }
  }
  const address = attrs.get("address")!;
  if (!/^[0-9a-f]{40}$/.test(address)) {
    throw new Error(
      "hlp_config_updated: address is not 40 lowercase hex characters",
    );
  }
  const bootstrapBalance = canonicalU64(
    attrs.get("bootstrap_balance")!,
    "bootstrap_balance",
  );
  const minBalanceFloor = canonicalU64(
    attrs.get("min_balance_floor")!,
    "min_balance_floor",
  );
  const proposalId = canonicalU64(attrs.get("proposal_id")!, "proposal_id");
  const enabledText = attrs.get("enabled")!;
  if (enabledText !== "true" && enabledText !== "false") {
    throw new Error('hlp_config_updated: enabled is not "true" or "false"');
  }
  const enabled = enabledText === "true";
  checkHlpShape(
    /^0+$/.test(address),
    bootstrapBalance,
    minBalanceFloor,
    enabled,
    "hlp_config_updated",
  );
  return {
    type: "HlpConfigUpdated",
    address,
    bootstrapBalance: bootstrapBalance.toString(),
    minBalanceFloor: minBalanceFloor.toString(),
    enabled,
    proposalId: proposalId.toString(),
  };
}
