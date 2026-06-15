/**
 * Scenario harness: boots a canonical world against a running node and
 * exposes a fluent API (`w.alice.limitBuy(...)`) so scenario files read
 * like English.
 *
 * Intentionally thin — wraps the existing `ExchangeClient` rather than
 * reimplementing exchange logic. Every user is a fresh random keypair so
 * scenarios don't collide on nonces or CometBFT's tx cache.
 */
import { Decoder } from "@msgpack/msgpack";
import { ExchangeClient } from "../client.js";
import {
  generateKeypair,
  pubkeyToOwner,
  ownerToHex,
  hexToBytes,
} from "../crypto.js";
import { Side } from "../types.js";
import type { Action, AccountInfo, Orderbook, PositionInfo } from "../types.js";

/** Canonical market IDs seeded by scripts/seed.ts. */
export const BTC_PERP = 1;
export const ETH_PERP = 2;

/** Users the harness seeds by default. Override via SeedWorldOptions.users. */
export const USER_NAMES = ["alice", "bob", "carol"] as const;
export type UserName = (typeof USER_NAMES)[number];

/**
 * Canonical starting balance per seeded user, in microUSDC (6 dp).
 * $100,000 is generous enough to open real leveraged positions on BTC-PERP
 * without margin edge-cases dominating test assertions.
 */
const SEED_BALANCE_MICRO_USDC = 100_000_000_000n;

export interface SeedWorldOptions {
  rpcUrl?: string;
  apiUrl?: string;
  /** Override user count/names for custom scenarios. */
  users?: readonly string[];
  /** Override starting balance (microUSDC). Default is $100k. */
  seedBalance?: bigint;
  /** Hex-encoded relayer private key (Ed25519). The relayer signs
   *  Deposit / Withdraw flows. Required for any scenario that funds
   *  users (engine handle_deposit gates on the relayer allowlist —
   *  audit B1 / 2026-04-23). */
  relayerPrivateKey?: string;
  /** Hex-encoded oracle private key (Ed25519). When set, exposes
   *  `world.pushOracle(...)` so scenarios can drive oracle prices for
   *  liquidation / margin-edge tests. Distinct from the relayer
   *  allowlist; the oracle has its own on-chain authorization. */
  oraclePrivateKey?: string;
}

/** Fluent user API returned for each seeded account. */
export interface User {
  name: string;
  client: ExchangeClient;
  address: Uint8Array;
  addressHex: string;

  /** Submit a limit buy and wait for inclusion. */
  limitBuy(market: number, qty: bigint, price: bigint): Promise<void>;

  /** Submit a limit sell and wait for inclusion. */
  limitSell(market: number, qty: bigint, price: bigint): Promise<void>;

  /** Submit a market order (any side) and wait for inclusion. */
  marketOrder(market: number, side: "Buy" | "Sell", qty: bigint): Promise<void>;

  /** Cancel every open order this user has, across all markets. */
  cancelAll(): Promise<number>;
}

export interface World {
  rpcUrl: string;
  apiUrl: string;
  users: Record<string, User>;
  alice: User;
  bob: User;
  carol: User;

  /** Query the orderbook for a market. */
  orderbook(market: number): Promise<Orderbook>;

  /** Query account state for a named user. */
  account(user: string): Promise<AccountInfo | null>;

  /**
   * Get the net signed position for a user on a market.
   * Positive = long, negative = short, 0n = flat. Returns 0n if no position.
   */
  position(user: string, market: number): Promise<bigint>;

  /** Raw position info (if present) — gives callers the typed SDK shape. */
  positionInfo(user: string, market: number): Promise<PositionInfo | null>;

  /** Push an oracle update via the relayer key. Throws if the harness
   *  was not initialised with `relayerPrivateKey`. Used by liquidation
   *  scenarios (S10+) to drive mark prices toward maintenance margin
   *  without needing market-order flow on the underlying. The price
   *  must be expressed in microUSDC (6 dp), matching engine convention. */
  pushOracle(market: number, priceMicroUsdc: bigint): Promise<void>;

  /** Trigger end-of-block liquidation sweep. The engine runs this
   *  every FinalizeBlock; this method is a thin wait-for-block helper
   *  that sleeps long enough for at least one block to land so any
   *  margin breach has time to be acted on. */
  waitOneBlock(): Promise<void>;
}

/**
 * Boot a world with canonical users funded to the seed balance.
 *
 * Assumes the node is running on RPC_URL (default localhost:26657) and
 * seeded with markets (scripts/seed.ts). Funding happens via the
 * relayer key: the engine's `handle_deposit` requires the signer to
 * be on the relayer allowlist (audit B1 / 2026-04-23). The harness
 * therefore needs `relayerPrivateKey` for any test that funds users.
 * Read-only scenarios (e.g. orderbook query smoke tests) can omit it.
 */
export async function seedWorld(opts: SeedWorldOptions = {}): Promise<World> {
  // Defaults are the local dev-stack endpoints. Tests that want to hit a
  // different node (CI runner, remote testnet) can pass explicit rpcUrl /
  // apiUrl, or read their own env vars — we don't touch `process` here
  // so this module stays free of Node-type dependencies and builds as
  // part of the published SDK cleanly.
  const rpcUrl = opts.rpcUrl ?? "http://localhost:26657";
  const apiUrl = opts.apiUrl ?? "http://localhost:8080";
  const names = opts.users ?? USER_NAMES;
  const seedBalance = opts.seedBalance ?? SEED_BALANCE_MICRO_USDC;

  // Build the relayer client BEFORE provisioning users so it can sign
  // deposits for them. Eager construction also catches a missing or
  // malformed key at world-init rather than mid-test.
  let relayerClient: ExchangeClient | null = null;
  let relayerAddress: Uint8Array | null = null;
  if (opts.relayerPrivateKey) {
    relayerClient = new ExchangeClient({ rpcUrl, apiUrl });
    const privBytes = hexToBytes(opts.relayerPrivateKey);
    relayerClient.setPrivateKey(privBytes);
    relayerClient.setUnsafeFastSubmit(true);
    relayerAddress = relayerClient.getAddress();
    if (!relayerAddress) {
      throw new Error("scenarios harness: failed to derive relayer address");
    }
  }

  // Oracle client — separate allowlist from the relayer (engine gates
  // OracleUpdate on `is_oracle_authorized(signer)` at engine.rs:288).
  let oracleClient: ExchangeClient | null = null;
  let oracleAddress: Uint8Array | null = null;
  if (opts.oraclePrivateKey) {
    oracleClient = new ExchangeClient({ rpcUrl, apiUrl });
    oracleClient.setPrivateKey(hexToBytes(opts.oraclePrivateKey));
    oracleClient.setUnsafeFastSubmit(true);
    oracleAddress = oracleClient.getAddress();
    if (!oracleAddress) {
      throw new Error("scenarios harness: failed to derive oracle address");
    }
  }

  const users: Record<string, User> = {};
  for (const name of names) {
    users[name] = await createUser(
      name,
      rpcUrl,
      apiUrl,
      seedBalance,
      relayerClient,
      relayerAddress,
    );
  }

  // Query client (no key — just for read endpoints).
  const queryClient = new ExchangeClient({ rpcUrl, apiUrl });

  return {
    rpcUrl,
    apiUrl,
    users,
    alice: users.alice!,
    bob: users.bob!,
    carol: users.carol!,

    orderbook: (market) => queryClient.queryOrderbook(market),

    account: (user) => {
      const u = users[user];
      if (!u) throw new Error(`unknown user: ${user}`);
      return queryClient.queryAccount(u.addressHex);
    },

    positionInfo: async (user, market) => {
      const u = users[user];
      if (!u) throw new Error(`unknown user: ${user}`);
      const acct = await queryClient.queryAccount(u.addressHex);
      return acct?.positions.find((p) => p.market === market) ?? null;
    },

    position: async (user, market) => {
      const u = users[user];
      if (!u) throw new Error(`unknown user: ${user}`);
      const acct = await queryClient.queryAccount(u.addressHex);
      const pos = acct?.positions.find((p) => p.market === market);
      if (!pos) return 0n;
      // SDK stores (side, size). Expose as a signed bigint: +long / -short.
      return pos.side === "Buy" ? pos.size : -pos.size;
    },

    pushOracle: async (market, price) => {
      if (!oracleClient || !oracleAddress) {
        throw new Error(
          "world.pushOracle: harness was not initialised with oraclePrivateKey. " +
            "Pass `{ oraclePrivateKey: '<hex>' }` to seedWorld() or set the " +
            "ORACLE_PRIVATE_KEY env var in your test runner.",
        );
      }
      // OracleUpdate is a relayer/oracle-authorised admin action. The
      // engine checks signer == cmd.signer AND is_oracle_authorized
      // (engine.rs:288). Timestamp must monotonically advance per
      // market (audit B3 replay protection).
      const action: Action = {
        type: "OracleUpdate",
        data: {
          market,
          price,
          signer: oracleAddress,
          publishTimeMs: BigInt(Date.now()),
        },
      };
      const r = await oracleClient.submitTxCommit(action);
      if (r.code !== 0) {
        throw new Error(
          `pushOracle(${market}, ${price}) failed: code=${r.code} log=${r.log ?? ""}`,
        );
      }
    },

    waitOneBlock: async () => {
      // Default block time is ~400ms; a 1.2s wait covers at least 2-3
      // blocks worst-case (PrepareProposal cadence + worst-case timeout).
      // Tests that need tighter timing can poll height via the RPC.
      await new Promise((r) => setTimeout(r, 1_200));
    },
  };
}

/**
 * Construct a funded user against the live node. The steps:
 *
 *   1. Generate a fresh keypair. Fresh = no nonce history, no open orders.
 *   2. Wire the key into an `ExchangeClient` and sync its nonce (0 for a
 *      brand-new account).
 *   3. Submit a self-signed Deposit for the seed balance. Dev-mode engine
 *      accepts this because signer == owner. In production the deposit
 *      flow runs through the Solana relayer (ConfirmDeposit), but that
 *      path requires a separate relayer key and is unnecessary for
 *      scenario tests.
 *   4. Wait for the Deposit to commit (submitTxCommit blocks until
 *      inclusion). After this the user is fully usable.
 */
async function createUser(
  name: string,
  rpcUrl: string,
  apiUrl: string,
  seedBalance: bigint,
  relayerClient: ExchangeClient | null,
  relayerAddress: Uint8Array | null,
): Promise<User> {
  const { privateKey, publicKey } = generateKeypair();
  const address = pubkeyToOwner(publicKey);
  const addressHex = ownerToHex(address);

  const client = new ExchangeClient({ rpcUrl, apiUrl });
  client.setPrivateKey(privateKey);
  // Use submitTxCommit everywhere in the harness; skip the fire-and-verify
  // background check so scenario assertions use submitTxCommit directly.
  client.setUnsafeFastSubmit(true);

  // Fund via relayer-signed Deposit. Engine's handle_deposit (audit
  // B1, 2026-04-23) rejects with code=13 (UnauthorizedRelayer)
  // unless the envelope signer is on the on-chain relayer allowlist.
  if (!relayerClient || !relayerAddress) {
    throw new Error(
      `scenario harness: cannot fund ${name} without a relayerPrivateKey. ` +
        "Pass `{ relayerPrivateKey: '<hex>' }` to seedWorld() or set the " +
        "RELAYER_PRIVATE_KEY env var. Read-only scenarios can pass " +
        "`seedBalance: 0n` to skip the deposit step (not yet implemented).",
    );
  }
  const depositResult = await relayerClient.submitTxCommit({
    type: "Deposit",
    data: { owner: address, amount: seedBalance, signer: relayerAddress },
  });
  if (depositResult.code !== 0) {
    throw new Error(
      `scenario harness: failed to fund ${name} (code=${depositResult.code}, log=${depositResult.log})`,
    );
  }

  return {
    name,
    client,
    address,
    addressHex,

    async limitBuy(market, qty, price) {
      const action: Action = {
        type: "PlaceOrder",
        data: {
          market,
          owner: address,
          side: Side.Buy,
          price,
          quantity: qty,
          clientOrderId: null,
        },
      };
      const r = await client.submitTxCommit(action);
      if (r.code !== 0) {
        throw new Error(
          `${name}.limitBuy failed: code=${r.code} log=${r.log ?? ""}`,
        );
      }
    },

    async limitSell(market, qty, price) {
      const action: Action = {
        type: "PlaceOrder",
        data: {
          market,
          owner: address,
          side: Side.Sell,
          price,
          quantity: qty,
          clientOrderId: null,
        },
      };
      const r = await client.submitTxCommit(action);
      if (r.code !== 0) {
        throw new Error(
          `${name}.limitSell failed: code=${r.code} log=${r.log ?? ""}`,
        );
      }
    },

    async marketOrder(market, side, qty) {
      const action: Action = {
        type: "MarketOrder",
        data: {
          market,
          owner: address,
          side: side === "Buy" ? Side.Buy : Side.Sell,
          quantity: qty,
          clientOrderId: null,
        },
      };
      const r = await client.submitTxCommit(action);
      if (r.code !== 0) {
        throw new Error(
          `${name}.marketOrder failed: code=${r.code} log=${r.log ?? ""}`,
        );
      }
    },

    async cancelAll() {
      // Fetch open orders via the node's REST API. The SDK client doesn't
      // expose a native `queryOpenOrders`, but /v1/orders/{addr} returns
      // an rmp-serde-encoded Vec<Order> we can decode inline. Avoids
      // threading a second query surface through the SDK just for this.
      const orderIds = await fetchOpenOrderIds(apiUrl, addressHex);
      let cancelled = 0;
      for (const orderId of orderIds) {
        const r = await client.submitTxCommit({
          type: "CancelOrder",
          data: { orderId, owner: address },
        });
        if (r.code === 0) cancelled++;
        // If the cancel fails with "order not found" another path already
        // matched it — count it as success for scenario purposes.
        else if (/not found|code=2/i.test(r.log ?? "")) cancelled++;
      }
      return cancelled;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const msgpackDecoder = new Decoder({ useBigInt64: true });

/**
 * Fetch open order IDs for an address via /v1/orders/{addr}. Returns an
 * empty array if the account has no open orders or the endpoint is
 * unreachable. Used by cancelAll — doesn't belong in the fluent client
 * surface because order IDs are a transient runtime concept, not a
 * stable caller-facing identifier.
 */
async function fetchOpenOrderIds(
  apiUrl: string,
  addressHex: string,
): Promise<bigint[]> {
  const res = await fetch(`${apiUrl}/v1/orders/${addressHex}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: string };
  if (!json.data) return [];

  const raw = Uint8Array.from(atob(json.data), (c) => c.charCodeAt(0));
  let decoded: unknown;
  try {
    decoded = msgpackDecoder.decode(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];

  // Each order is encoded as a positional array: [id, market, owner, side,
  // price, quantity]. We only need field 0 (the id) for CancelOrder.
  const ids: bigint[] = [];
  for (const order of decoded) {
    if (!Array.isArray(order) || order.length < 1) continue;
    const rawId = order[0];
    if (typeof rawId === "bigint") ids.push(rawId);
    else if (typeof rawId === "number") ids.push(BigInt(rawId));
  }
  return ids;
}
