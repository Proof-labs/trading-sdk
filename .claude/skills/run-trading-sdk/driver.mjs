// Smoke driver for @proof/trading-sdk — drives the library's value-bearing
// OFFLINE path end to end (no network): WASM init -> key generation -> owner
// derivation -> sign+encode a signed wire envelope -> peek action type ->
// decode -> assert the round-trip. This is the exact surface the WASM codec
// cutover touches, and the one most PRs here need to exercise.
//
// Run from the repo root AFTER `npm run build` (needs dist/ + dist/wasm):
//   node .claude/skills/run-trading-sdk/driver.mjs
// Exits 0 on success, 1 with a diagnostic on the first failed assertion.
//
// It imports the BUILT package entrypoint (dist/index.js) via an explicit
// path so it doesn't depend on cwd or self-reference config.

import { fileURLToPath } from "node:url";

const distIndex = new URL("../../../dist/index.js", import.meta.url);
const {
  ready,
  generateKeypair,
  getPublicKey,
  pubkeyToOwner,
  ownerToHex,
  chainIdFromString,
  signAndEncode,
  peekActionType,
  decodeTx,
  encodePayloadBytes,
  ENVELOPE_VERSION,
  Side,
  ActionType,
} = await import(distIndex.href);

let checks = 0;
function assert(cond, msg) {
  checks++;
  if (!cond) {
    console.error(`✗ FAIL: ${msg}`);
    process.exit(1);
  }
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 1. WASM core must initialize before any codec/signing call (async by design).
await ready();
console.log("✓ WASM core ready()");

// 2. Key generation + owner derivation (pure, no network).
const { publicKey, privateKey } = generateKeypair();
assert(publicKey.length === 32, `pubkey is 32 bytes (got ${publicKey.length})`);
assert(
  privateKey.length === 32,
  `privkey is 32 bytes (got ${privateKey.length})`,
);
const owner = pubkeyToOwner(publicKey);
assert(owner.length === 20, `owner is 20 bytes (got ${owner.length})`);
const addrHex = ownerToHex(owner);
console.log(`✓ keypair + owner: 0x${addrHex}`);
// Derived pubkey from the private key must match the generated one.
assert(
  bytesEqual(getPublicKey(privateKey), publicKey),
  "getPublicKey(priv) == pub",
);

// 3. Build a PlaceOrder, encode just the payload (WASM encode_payload path).
const action = {
  type: "PlaceOrder",
  data: { market: 1, owner, side: Side.Buy, price: 5_000_000n, quantity: 1n },
};
const payload = encodePayloadBytes(action);
assert(
  payload instanceof Uint8Array && payload.length > 0,
  "encodePayloadBytes -> non-empty bytes",
);
console.log(`✓ encodePayloadBytes: ${payload.length} bytes`);

// 4. Sign + encode a full signed envelope, bound to a chain id.
const chainId = chainIdFromString("exchange-devnet-1");
assert(chainId.length === 32, `chainId is 32 bytes (got ${chainId.length})`);
const seq = 1_700_000_000_000n; // wall-clock-ms style nonce
const wire = signAndEncode(chainId, action, seq, privateKey);
assert(
  wire instanceof Uint8Array && wire.length > 0,
  "signAndEncode -> non-empty wire",
);
console.log(`✓ signAndEncode: ${wire.length}-byte signed envelope`);

// 5. Peek the action-type byte without a full decode.
assert(
  peekActionType(wire) === ActionType.PlaceOrder,
  "peekActionType == PlaceOrder",
);

// 6. Decode and assert the round-trip.
const decoded = decodeTx(wire);
assert(decoded.version === ENVELOPE_VERSION, `version == ${ENVELOPE_VERSION}`);
assert(decoded.seq === seq, `seq round-trips (${decoded.seq} == ${seq})`);
assert(
  decoded.action.type === "PlaceOrder",
  "decoded action type == PlaceOrder",
);
assert(decoded.action.data.market === 1, "market round-trips");
assert(decoded.action.data.side === Side.Buy, "side round-trips");
assert(decoded.action.data.price === 5_000_000n, "price round-trips (bigint)");
assert(decoded.action.data.quantity === 1n, "quantity round-trips (bigint)");
assert(bytesEqual(decoded.action.data.owner, owner), "owner bytes round-trip");
assert(
  bytesEqual(decoded.pubkey, publicKey),
  "envelope pubkey == signer pubkey",
);
assert(
  decoded.signature.length === 64,
  `signature is 64 bytes (got ${decoded.signature.length})`,
);
console.log("✓ decodeTx round-trip: action, seq, pubkey, signature all match");

// 7. Determinism: re-signing the same inputs yields byte-identical wire (Ed25519
//    is deterministic; the codec is pure). Guards against nondeterministic drift.
const wire2 = signAndEncode(chainId, action, seq, privateKey);
assert(bytesEqual(wire, wire2), "signAndEncode is deterministic");
console.log("✓ deterministic re-encode");

console.log(
  `\nALL ${checks} CHECKS PASSED — offline sign/encode/decode path is live.`,
);
