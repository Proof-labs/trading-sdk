import { Decoder } from "@msgpack/msgpack";
import { type Action, ActionType, type ActionTypeValue } from "./types.js";
import { getWasm } from "./wasm-loader.js";
import { toWasmFields, fromWasmFields } from "./codec-adapter.js";
import { DOMAIN_PREFIX } from "./crypto.js";

/**
 * The action payload codec and signing now run through the WASM build of the
 * Rust core (`crates/proof-trading-sdk-wasm`), so the bytes are identical to
 * the exchange engine **by construction** — see
 * `docs/adr/0001-wasm-core-vs-parallel-types.md`. The old hand-written
 * positional codec (~770 lines) is gone; this module is a thin, name/enum
 * adapter (`codec-adapter.ts`) plus the outer-envelope framing.
 *
 * **Initialization:** WASM instantiation is asynchronous, so call
 * `await ready()` (re-exported from the SDK entrypoint, or via
 * `ExchangeClient.ready()`) once before any encode/decode/sign call below.
 * After it resolves these functions run synchronously; `getWasm()` throws a
 * clear error if `ready()` has not completed.
 */

/**
 * Envelope version byte — the first element of the wire array
 * `[version, actionType, seq, payload, pubkey, signature]`. The exchange
 * engine accepts only version `2`.
 *
 * Distinct from the signing domain prefix `"ProofExchange-v3"` (see
 * `crypto.ts` and CLAUDE.md "Two distinct version numbers"): the envelope
 * version is `2`, the signing layout is v3.
 */
export const ENVELOPE_VERSION = 2;

// Only the OUTER signed-envelope array is still read with @msgpack — that is a
// trivial positional read (version/type/seq/payload-bytes/pubkey/sig), not the
// action codec, so it needs no WASM. `useBigInt64` keeps large seq values exact.
const decoder = new Decoder({ useBigInt64: true });

// ---------------------------------------------------------------------------
// Encoding + signing (via WASM)
// ---------------------------------------------------------------------------

/**
 * Encode just the payload bytes for an action (no signed envelope). The bytes
 * match `rmp-serde` — and therefore the engine — byte-for-byte.
 */
export function encodePayloadBytes(action: Action): Uint8Array {
  const { actionType, fields } = toWasmFields(action);
  return getWasm().encode_payload(actionType, fields);
}

/**
 * Encode a signed wire envelope from a pre-computed pubkey + signature.
 * Most callers should use `signAndEncode` instead; this exists for paths that
 * already hold raw signature bytes.
 */
export function encodeSignedTx(
  action: Action,
  seq: bigint,
  pubkey: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  const { actionType, fields } = toWasmFields(action);
  const wasm = getWasm();
  const payload = wasm.encode_payload(actionType, fields);
  return wasm.encode_signed_tx(actionType, payload, seq, pubkey, signature);
}

/**
 * Sign an action and encode it as a V2 wire envelope, binding the signature to
 * `chainId` (audit B4). Production signers must pass
 * `chainIdFromString(cometbftChainId)`; only unit tests should pass
 * `UNBOUND_CHAIN_ID`. `ExchangeClient` resolves and caches this automatically —
 * call this directly only when bypassing the client.
 */
export function signAndEncode(
  chainId: Uint8Array,
  action: Action,
  seq: bigint,
  privateKey: Uint8Array,
): Uint8Array {
  const { actionType, fields } = toWasmFields(action);
  const wasm = getWasm();
  const payload = wasm.encode_payload(actionType, fields);
  return wasm.sign_and_encode(chainId, actionType, payload, seq, privateKey);
}

/**
 * Sign and encode a raw pre-encoded payload into a V2 signed envelope. Lower
 * level than `signAndEncode` — callers supply already-encoded payload bytes and
 * the action-type byte directly. Useful for cross-language conformance testing.
 */
export function signEnvelopeFromPayload(
  chainId: Uint8Array,
  actionType: number,
  seq: bigint,
  payloadBytes: Uint8Array,
  privateKey: Uint8Array,
): Uint8Array {
  return getWasm().sign_and_encode(
    chainId,
    actionType,
    payloadBytes,
    seq,
    privateKey,
  );
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** Every wire action-type byte this SDK build knows — the validation set
 *  behind `peekActionType`'s return type. */
const KNOWN_ACTION_TYPES: ReadonlySet<number> = new Set<number>(
  Object.values(ActionType),
);

/** Peek at the action_type byte without a full decode.
 *
 *  Returns `null` both for structurally unreadable bytes AND for an
 *  action-type slot this SDK build does not know (an unassigned byte, a
 *  newer engine's wire type under an older SDK, or a non-numeric msgpack
 *  value), matching its declared return type — never a raw slot value cast
 *  through unvalidated. Callers that need the raw byte of an unknown envelope
 *  should decode the envelope themselves. */
export function peekActionType(bytes: Uint8Array): ActionTypeValue | null {
  try {
    const envelope = decoder.decode(bytes) as unknown[];
    const raw = envelope[1];
    const value =
      typeof raw === "number"
        ? raw
        : typeof raw === "bigint"
          ? Number(raw)
          : NaN;
    return KNOWN_ACTION_TYPES.has(value) ? (value as ActionTypeValue) : null;
  } catch {
    return null;
  }
}

/**
 * Coerce a decoded msgpack int (returned as `number` for a fixint or `bigint`
 * for a uint64) into a single bigint, so `seq` is one stable type regardless of
 * how the encoder chose to represent it on the wire.
 */
function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  throw new Error(`expected number/bigint, got ${typeof v}: ${v}`);
}

/** Decode wire bytes into an action + sequence number + auth fields. */
export function decodeTx(bytes: Uint8Array): {
  action: Action;
  seq: bigint;
  version: number;
  pubkey: Uint8Array;
  signature: Uint8Array;
} {
  const envelope = decoder.decode(bytes) as unknown[];
  const version = envelope[0] as number;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`unsupported version: ${version}`);
  }
  const actionType = envelope[1] as ActionTypeValue;
  const seq = toBigInt(envelope[2]);
  const payloadBytes = envelope[3] as Uint8Array;
  // The action payload is decoded by the WASM core (authoritative), then mapped
  // back to the TS `Action` shape by the adapter.
  const action = fromWasmFields(
    actionType,
    getWasm().decode_payload(actionType, payloadBytes),
  );
  return {
    action,
    seq,
    version,
    pubkey: envelope[4] as Uint8Array,
    signature: envelope[5] as Uint8Array,
  };
}

// ---------------------------------------------------------------------------
// Signing-preimage decode (signer-side review)
// ---------------------------------------------------------------------------

const ACTION_TYPE_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(ActionType).map(([name, byte]) => [byte, name]),
);

/**
 * Decoded form of a v3 **signing preimage** — the exact bytes
 * `signingMessage()` produces and an external signer signs. Not to be
 * confused with the wire envelope `decodeTx()` decodes (which additionally
 * carries the pubkey and signature).
 */
export interface DecodedSigningMessage {
  /** The 32-byte chain id the signature will bind to (cross-chain replay guard). */
  chainId: Uint8Array;
  /** Wire action-type byte. */
  actionType: number;
  /** SDK name for `actionType`, or null when this SDK build doesn't know the byte. */
  actionName: string | null;
  /** Per-signer sequence field (u64; big-endian on the wire). */
  seq: bigint;
  /** Raw payload bytes (a MessagePack positional array). */
  payloadBytes: Uint8Array;
  /** The decoded action, or null when the payload could not be decoded. */
  action: Action | null;
  /** Present exactly when `action` is null — why the payload didn't decode. */
  decodeError: string | null;
}

/**
 * Decode a v3 signing preimage (`DOMAIN_PREFIX(16) || chain_id(32) ||
 * action_type(1) || seq_be(8) || payload`) back into its parts, so a
 * signer-side tool can show a human WHAT they are about to sign on a trust
 * base independent of whoever built the bytes — the external-signer
 * counterpart of `decodeTx()`.
 *
 * Throws when the input is structurally not a Proof v3 signing preimage
 * (too short, or wrong domain prefix) — a signer tool should treat that as
 * "refuse loudly", not display garbage. An unknown action-type byte or an
 * undecodable payload is NOT structural: the envelope fields still parse
 * and are returned, with `action: null` and `decodeError` explaining why —
 * newer wire actions than this SDK build must degrade to "cannot decode,
 * here are the raw bytes", never to a false structural rejection.
 *
 * The payload is decoded — and re-encoded for the canonical-form check —
 * through the WASM core, so the accepted preimage bytes are exactly those
 * `signAndEncode` produces.
 */
export function decodeSigningMessage(msg: Uint8Array): DecodedSigningMessage {
  const headerLen = DOMAIN_PREFIX.length + 32 + 1 + 8;
  if (msg.length < headerLen) {
    throw new Error(
      `not a Proof v3 signing message: ${msg.length} bytes is shorter than ` +
        `the ${headerLen}-byte fixed header`,
    );
  }
  for (let i = 0; i < DOMAIN_PREFIX.length; i++) {
    if (msg[i] !== DOMAIN_PREFIX[i]) {
      throw new Error(
        'not a Proof v3 signing message: missing the "ProofExchange-v3" ' +
          "domain prefix",
      );
    }
  }

  let offset = DOMAIN_PREFIX.length;
  const chainId = msg.slice(offset, offset + 32);
  offset += 32;
  const actionType = msg[offset++];
  const seq = new DataView(msg.buffer, msg.byteOffset + offset, 8).getBigUint64(
    0,
    false, // big-endian, mirroring signingMessage()
  );
  offset += 8;
  const payloadBytes = msg.slice(offset);

  const actionName = ACTION_TYPE_NAMES.get(actionType) ?? null;
  let action: Action | null = null;
  let decodeError: string | null = null;
  if (actionName === null) {
    decodeError = `unknown action type 0x${actionType.toString(16).padStart(2, "0")} — not in this SDK build`;
  } else {
    try {
      // Decode via the WASM core (authoritative), then confirm the bytes are
      // the canonical representation by re-encoding through the same core and
      // comparing — a non-canonical payload is not something we can safely
      // display, so it degrades to `decodeError`.
      const decodedAction = fromWasmFields(
        actionType as ActionTypeValue,
        getWasm().decode_payload(actionType, payloadBytes),
      );
      const canonicalPayloadBytes = encodePayloadBytes(decodedAction);
      const isCanonical =
        canonicalPayloadBytes.length === payloadBytes.length &&
        canonicalPayloadBytes.every((byte, i) => byte === payloadBytes[i]);
      if (!isCanonical) {
        throw new Error(
          "payload is not the canonical representation this SDK can safely display",
        );
      }
      action = decodedAction;
    } catch (e) {
      decodeError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    chainId,
    actionType,
    actionName,
    seq,
    payloadBytes,
    action,
    decodeError,
  };
}
