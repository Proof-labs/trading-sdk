/**
 * E2E tests for the SDK against a running CometBFT + exchange-node.
 *
 * Run with:  RPC_URL=http://localhost:26657 npx vitest run src/e2e.test.ts
 *
 * Skipped when RPC_URL is not set (so `vitest run` still passes in CI).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ExchangeClient } from "./client.js";
import { encodeSignedTx } from "./codec.js";
import { Side, type Action } from "./types.js";
import { randomBytes } from "crypto";

const ZERO_PUBKEY = new Uint8Array(32);
const ZERO_SIG = new Uint8Array(64);
const encodeTx = (action: Action, seq: bigint) =>
  encodeSignedTx(action, seq, ZERO_PUBKEY, ZERO_SIG);

const RPC_URL = process.env.RPC_URL;
const describeE2E = RPC_URL ? describe : describe.skip;

/** Random owner each test run to avoid CometBFT tx cache collisions. */
function randomOwner(): Uint8Array {
  return new Uint8Array(randomBytes(20));
}

/** Poll blocks until we find a tx with the given hash, or timeout. */
async function waitForTx(
  client: ExchangeClient,
  hash: string,
  timeoutMs = 5000,
): Promise<number> {
  const start = Date.now();
  const seen = new Set<number>();
  while (Date.now() - start < timeoutMs) {
    const { latestHeight } = await client.status();
    for (let h = Math.max(1, latestHeight - 3); h <= latestHeight; h++) {
      if (seen.has(h)) continue;
      seen.add(h);
      const block = await client.getBlock(h);
      const txs = (
        (block.block as Record<string, unknown>).data as Record<string, unknown>
      ).txs as string[] | null;
      if (txs && txs.length > 0) return h;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`tx ${hash} not found in blocks within ${timeoutMs}ms`);
}

describeE2E("e2e: SDK → CometBFT", () => {
  let client: ExchangeClient;
  const owner = randomOwner();

  beforeAll(() => {
    client = new ExchangeClient({ rpcUrl: RPC_URL });
  });

  it("status returns height and appHash", async () => {
    const s = await client.status();
    expect(s.latestHeight).toBeGreaterThanOrEqual(0);
    expect(typeof s.latestAppHash).toBe("string");
  });

  it("getBlock returns latest block", async () => {
    const result = await client.getBlock();
    expect(result).toHaveProperty("block");
    expect(result).toHaveProperty("block_id");
  });

  it("getBlock by height returns that block", async () => {
    const { latestHeight } = await client.status();
    if (latestHeight < 1) return;
    const result = await client.getBlock(1);
    const header = (result.block as Record<string, unknown>).header as Record<
      string,
      unknown
    >;
    expect(Number(header.height)).toBe(1);
  });

  it("encodeTx produces non-empty bytes with correct msgpack header", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: { market: 1, owner, side: Side.Buy, price: 100n, quantity: 10n },
    };
    const bytes = encodeTx(action, 1n);
    expect(bytes.length).toBeGreaterThan(4);
    expect(bytes[0]).toBe(0x96); // msgpack fixarray(6)
  });

  it("base64 round-trip preserves tx bytes", () => {
    const action: Action = {
      type: "PlaceOrder",
      data: { market: 1, owner, side: Side.Buy, price: 100n, quantity: 10n },
    };
    const bytes = encodeTx(action, 1n);
    const b64 = Buffer.from(bytes).toString("base64");
    const decoded = Buffer.from(b64, "base64");
    expect(new Uint8Array(decoded)).toEqual(bytes);
  });

  it("submitTx PlaceOrder passes CheckTx", async () => {
    const result = await client.submitTx({
      type: "PlaceOrder",
      data: { market: 1, owner, side: Side.Buy, price: 100n, quantity: 10n },
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

  it("submitTx OracleUpdate passes CheckTx", async () => {
    const signer = randomOwner();
    const result = await client.submitTx({
      type: "OracleUpdate",
      data: { market: 1, price: 5000n, signer },
    });
    expect(result.code).toBe(0);
    expect(result.hash).toBeTruthy();
  });

  it("submitted tx is included in a block", async () => {
    const result = await client.submitTx({
      type: "PlaceOrder",
      data: { market: 1, owner, side: Side.Sell, price: 200n, quantity: 5n },
    });
    expect(result.code).toBe(0);

    const height = await waitForTx(client, result.hash);
    expect(height).toBeGreaterThan(0);
  }, 10_000);

  it("submitted tx appears in block data", async () => {
    const result = await client.submitTx({
      type: "PlaceOrder",
      data: { market: 1, owner, side: Side.Buy, price: 300n, quantity: 1n },
    });
    expect(result.code).toBe(0);

    const height = await waitForTx(client, result.hash);
    const block = await client.getBlock(height);
    const data = (block.block as Record<string, unknown>).data as Record<
      string,
      unknown
    >;
    const txs = data.txs as string[];
    expect(txs.length).toBeGreaterThan(0);
  }, 10_000);

  it("multiple sequential submits get unique hashes", async () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const result = await client.submitTx({
        type: "PlaceOrder",
        data: {
          market: 1,
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
