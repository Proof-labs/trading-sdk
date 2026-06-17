/**
 * E2E tests for the SDK against a running gateway + exchange-node.
 *
 * Run with:  RPC_URL=https://api.dev.proof.trade npx vitest run src/e2e.test.ts
 *
 * The test generates a fresh keypair per run so submitTx tests get a valid
 * signature.  CheckTx passes (code=0) even without a funded account because
 * the gateway's CheckTx only validates format, signature, and nonce.
 *
 * Skipped when RPC_URL is not set (so `vitest run` still passes in CI).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ExchangeClient } from "./client.js";
import { encodeSignedTx } from "./codec.js";
import { Side, type Action } from "./types.js";
import { generateKeypair, pubkeyToOwner } from "./crypto.js";

const ZERO_PUBKEY = new Uint8Array(32);
const ZERO_SIG = new Uint8Array(64);
const encodeTx = (action: Action, seq: bigint) =>
  encodeSignedTx(action, seq, ZERO_PUBKEY, ZERO_SIG);

const MARKET_ID = 1;
const DEFAULT_PRICE = 100n;
const DEFAULT_QTY = 10n;
const SEQ_1 = 1n;
const MSGPACK_FIXARRAY_6 = 0x96;

const RPC_URL = process.env.RPC_URL;
const describeE2E = RPC_URL ? describe : describe.skip;

describeE2E("e2e: SDK against gateway", () => {
  let client: ExchangeClient;
  const kp = generateKeypair();
  const owner = pubkeyToOwner(kp.publicKey);

  beforeAll(() => {
    client = new ExchangeClient({
      rpcUrl: RPC_URL,
      chainId: process.env.CHAIN_ID ?? "exchange-devnet-1",
    });
    client.setPrivateKey(kp.privateKey);
  });

  it("health returns status and height", async () => {
    const h = await client.queryHealth();
    expect(h.status).toBe("ok");
    expect(h.height).toBeGreaterThan(0);
  });

  it("encodeTx produces non-empty bytes with correct msgpack header", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: MARKET_ID,
        owner,
        side: Side.Buy,
        price: DEFAULT_PRICE,
        quantity: DEFAULT_QTY,
      },
    };
    const bytes = encodeTx(action, SEQ_1);
    expect(bytes.length).toBeGreaterThan(4);
    expect(bytes[0]).toBe(MSGPACK_FIXARRAY_6);
  });

  it("base64 round-trip preserves tx bytes", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: {
        market: MARKET_ID,
        owner,
        side: Side.Buy,
        price: DEFAULT_PRICE,
        quantity: DEFAULT_QTY,
      },
    };
    const bytes = encodeTx(action, SEQ_1);
    const b64 = Buffer.from(bytes).toString("base64");
    const decoded = Buffer.from(b64, "base64");
    expect(new Uint8Array(decoded)).toEqual(bytes);
  });

  it("submitTx PlaceOrder passes CheckTx", async () => {
    const result = await client.submitTx({
      type: "PlaceOrder",
      data: {
        market: MARKET_ID,
        owner,
        side: Side.Buy,
        price: DEFAULT_PRICE,
        quantity: DEFAULT_QTY,
      },
    });
    expect(result.code).toBe(0);
    expect(result.hash).toBeTruthy();
  });

  it("submitTx CancelOrder passes CheckTx", async () => {
    const result = await client.submitTx({
      type: "CancelOrder",
      data: { orderId: 999n, owner },
    });
    expect(result.code).toBe(0);
    expect(result.hash).toBeTruthy();
  });

  it("multiple sequential submits get unique hashes", async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const result = await client.submitTx({
        type: "PlaceOrder",
        data: {
          market: MARKET_ID,
          owner,
          side: Side.Buy,
          price: BigInt(1000 + i),
          quantity: 1n,
        },
      });
      expect(result.code).toBe(0);
      hashes.add(result.hash);
    }
    expect(hashes.size).toBe(3);
  });
});
