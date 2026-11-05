/**
 * Scenario harness: boots a canonical world against a running node and
 * exposes a fluent API (`w.alice.limitBuy(...)`) so scenario files read
 * like English.
 *
 * Intentionally thin — wraps the existing `ExchangeClient` rather than
 * reimplementing exchange logic. Every user is a fresh random keypair so
 * scenarios don't collide on nonces or CometBFT's tx cache.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Decoder } from "@msgpack/msgpack";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { rejectFloats } from "../codec.js";
import { ready } from "../wasm-loader.js";
import { ExchangeClient } from "../client.js";
import { pacedTransport } from "./pacing.js";
import {
  generateKeypair,
  pubkeyToOwner,
  ownerToHex,
  hexToBytes,
} from "../crypto.js";
import { Side } from "../types.js";
import type {
  Action,
  AccountInfo,
  AdminAction,
  MarketConfig,
  Orderbook,
  PositionInfo,
} from "../types.js";
import { governance, type Governance } from "./governance.js";
import { oracleRelay, type OracleRelay } from "./oracle-relay.js";

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
  /** Defaults to the local stack's gateway. */
  gatewayUrl?: string;
  /** Override user count/names for custom scenarios. */
  users?: readonly string[];
  /** Override starting balance (microUSDC). Default is $100k. */
  seedBalance?: bigint;
  /** Hex-encoded relayer private key (Ed25519). The relayer signs
   *  Deposit / Withdraw flows. Required for any scenario that funds
   *  users (engine handle_deposit gates on the relayer allowlist —
   *  audit B1 / 2026-04-23). */
  relayerPrivateKey?: string;
  /** Hex Ed25519 key of the oracle policy's primary source. */
  oraclePrivateKey?: string;
  /** Hex Ed25519 key of the oracle policy's fallback source. */
  fallbackOraclePrivateKey?: string;
  /** Path to `f16-relay`; defaults to the one on PATH. */
  relayBin?: string;
  /** Hex Ed25519 keys of two admin multisig members, for `createPerp`. */
  adminPrivateKeys?: readonly [string, string];
}

/** Live-stack options from the environment the scenario README documents. */
export function envWorldOptions(): SeedWorldOptions {
  const env = process.env;
  return {
    gatewayUrl: env.GATEWAY_URL,
    relayerPrivateKey: env.RELAYER_PRIVATE_KEY,
    oraclePrivateKey: env.ORACLE_PRIVATE_KEY,
    fallbackOraclePrivateKey: env.FALLBACK_ORACLE_PRIVATE_KEY,
    relayBin: env.F16_RELAY_BIN,
    adminPrivateKeys:
      env.ADMIN1_PRIVATE_KEY && env.ADMIN2_PRIVATE_KEY
        ? [env.ADMIN1_PRIVATE_KEY, env.ADMIN2_PRIVATE_KEY]
        : undefined,
  };
}

/** Whether the environment can create and price a scenario perp, as the README lists. */
export function canCreatePerps(): boolean {
  const env = process.env;
  const relay = env.F16_RELAY_BIN;
  return Boolean(
    env.RPC_URL &&
    env.RELAYER_PRIVATE_KEY &&
    env.ORACLE_PRIVATE_KEY &&
    env.FALLBACK_ORACLE_PRIVATE_KEY &&
    env.ADMIN1_PRIVATE_KEY &&
    env.ADMIN2_PRIVATE_KEY &&
    relay &&
    existsSync(relay) &&
    existsSync(join(dirname(relay), "f16-policy-bundle")),
  );
}

/** What a scenario's own perpetual is created with. */
export interface PerpSpec {
  imBps: number;
  mmBps: number;
  szDecimals: number;
  poolId?: number;
}

/** A perpetual a scenario created, with its config as the chain reads it. */
export interface Perp {
  market: number;
  config: MarketConfig;
  /** Contracts worth `notional` (microUSDC) at `price`. */
  quantityFor(notional: bigint, price: bigint): bigint;
  /** Notional (microUSDC) of `quantity` contracts at `price`. */
  notional(quantity: bigint, price: bigint): bigint;
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
  gatewayUrl: string;
  users: Record<string, User>;
  /** Markets this world created. */
  markets: number[];
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

  /** Net signed position of any owner (hex address) on a market. */
  positionOf(owner: string, market: number): Promise<bigint>;

  /** Hex address of the insurance fund of `market`'s pool. */
  insuranceFund(market: number): Promise<string>;

  /** Raw position info (if present) — gives callers the typed SDK shape. */
  positionInfo(user: string, market: number): Promise<PositionInfo | null>;

  /** Set a market's oracle price (microUSDC) through both F16 relay keys
   *  and wait until the chain certifies it. */
  pushOracle(market: number, priceMicroUsdc: bigint): Promise<void>;

  /** Create a perpetual through the admin multisig, install its oracle
   *  settings the same way, and certify `price` as its first price. */
  createPerp(spec: PerpSpec, price: bigint): Promise<Perp>;

  /** Execute an admin action through the two-member multisig. */
  govern(action: AdminAction, label: string): Promise<void>;

  /** Credit `amount` (microUSDC) to a user through a relayer deposit. */
  deposit(user: string, amount: bigint): Promise<void>;

  /** Poll until every named user is flat on `market`; throws after `timeoutMs`. */
  untilFlat(
    names: readonly string[],
    market: number,
    timeoutMs?: number,
  ): Promise<void>;

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
  const gatewayUrl = opts.gatewayUrl ?? "http://127.0.0.1:9080";
  const names = opts.users ?? USER_NAMES;
  const seedBalance = opts.seedBalance ?? SEED_BALANCE_MICRO_USDC;

  // Build the relayer client BEFORE provisioning users so it can sign
  // deposits for them. Eager construction also catches a missing or
  // malformed key at world-init rather than mid-test.
  let relayerClient: ExchangeClient | null = null;
  let relayerAddress: Uint8Array | null = null;
  if (opts.relayerPrivateKey) {
    relayerClient = new ExchangeClient({
      gatewayUrl,
      httpTransport: pacedTransport,
    });
    const privBytes = hexToBytes(opts.relayerPrivateKey);
    relayerClient.setPrivateKey(privBytes);
    relayerClient.setUnsafeFastSubmit(true);
    relayerAddress = relayerClient.getAddress();
    if (!relayerAddress) {
      throw new Error("scenarios harness: failed to derive relayer address");
    }
  }

  let relay: OracleRelay | null = null;
  if (opts.oraclePrivateKey && opts.fallbackOraclePrivateKey) {
    relay = oracleRelay({
      gatewayUrl,
      relayBin: opts.relayBin ?? "f16-relay",
      primaryPrivateKey: opts.oraclePrivateKey,
      fallbackPrivateKey: opts.fallbackOraclePrivateKey,
    });
  }

  let admins: Governance | null = null;
  if (opts.adminPrivateKeys) {
    const [a, b] = opts.adminPrivateKeys.map(hexToBytes);
    admins = governance(gatewayUrl, [a!, b!]);
  }

  const users: Record<string, User> = {};
  for (const name of names) {
    users[name] = await createUser(
      name,
      gatewayUrl,
      seedBalance,
      relayerClient,
      relayerAddress,
    );
  }

  // Query client (no key — just for read endpoints).
  const queryClient = new ExchangeClient({
    gatewayUrl,
    httpTransport: pacedTransport,
  });
  const markets: number[] = [];

  const positionOf = async (owner: string, market: number) => {
    const acct = await queryClient.queryAccount(owner);
    const pos = acct?.positions.find((p) => p.market === market);
    if (!pos) return 0n;
    return pos.side === "Buy" ? pos.size : -pos.size;
  };
  const position = async (user: string, market: number) => {
    const u = users[user];
    if (!u) throw new Error(`unknown user: ${user}`);
    return positionOf(u.addressHex, market);
  };

  return {
    gatewayUrl,
    users,
    markets,
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

    position,
    positionOf,

    insuranceFund: async (market) => {
      const config = (await queryClient.queryMarkets()).find(
        (m) => m.market === market,
      );
      return insuranceFundAddress(config?.poolId ?? 0);
    },

    pushOracle: async (market, price) => {
      if (!relay) {
        throw new Error(
          "world.pushOracle: pass oraclePrivateKey and fallbackOraclePrivateKey " +
            "(ORACLE_PRIVATE_KEY / FALLBACK_ORACLE_PRIVATE_KEY) to seedWorld()",
        );
      }
      await relay.setPrice(market, price);
    },

    createPerp: async (spec, price) => {
      if (!admins || !relay) {
        throw new Error(
          "world.createPerp: pass adminPrivateKeys and both oracle keys to seedWorld()",
        );
      }
      const govern = admins;
      // Caller ids are bounded to i32::MAX; a random one avoids reruns.
      const market = 1_000 + Math.floor(Math.random() * 2_000_000_000);
      const ticker = `SDK${market}`;
      await govern.execute(
        {
          kind: "CreateMarket",
          value: {
            market,
            imBps: spec.imBps,
            mmBps: spec.mmBps,
            takerFeeBps: 5,
            makerFeeBps: 2,
            signer: new Uint8Array(20),
            fundingIntervalMs: 0n,
            maxFundingRateBps: 0,
            poolId: spec.poolId ?? 0,
            szDecimals: spec.szDecimals,
            ticker,
            maxOpenInterest: 0n,
            tickSize: 1n,
            lotSize: 1n,
          },
        },
        `CreateMarket(${market})`,
      );
      await relay.installSettings(market, ticker, (effectiveHeight, bundle) =>
        govern.execute(
          { kind: "ConfigureOraclePolicy", value: { effectiveHeight, bundle } },
          `ConfigureOraclePolicy(${market})`,
        ),
      );
      await relay.setPrice(market, price);
      const config = (await queryClient.queryMarkets()).find(
        (m) => m.market === market,
      );
      if (!config)
        throw new Error(`market ${market} not readable after creation`);
      markets.push(market);
      const scale = 10n ** BigInt(config.szDecimals ?? 0);
      return {
        market,
        config,
        quantityFor: (notional, at) => (notional * scale) / at,
        notional: (quantity, at) => (quantity * at) / scale,
      };
    },

    govern: async (action, label) => {
      if (!admins) {
        throw new Error("world.govern: pass adminPrivateKeys to seedWorld()");
      }
      await admins.execute(action, label);
    },

    deposit: async (user, amount) => {
      const u = users[user];
      if (!u) throw new Error(`unknown user: ${user}`);
      if (!relayerClient || !relayerAddress) {
        throw new Error("world.deposit: pass relayerPrivateKey to seedWorld()");
      }
      const r = await relayerClient.submitTxCommit({
        type: "Deposit",
        data: { owner: u.address, amount, signer: relayerAddress },
      });
      if (r.code !== 0) {
        throw new Error(
          `deposit to ${user} failed: code=${r.code} log=${r.log ?? ""}`,
        );
      }
    },

    untilFlat: async (names, market, timeoutMs = 15_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const sizes = await Promise.all(names.map((n) => position(n, market)));
        if (sizes.every((size) => size === 0n)) return;
        if (Date.now() > deadline) {
          const open = names
            .map((n, i) => `${n}=${sizes[i]}`)
            .filter((_, i) => sizes[i] !== 0n);
          throw new Error(
            `untilFlat: market ${market} still open after ${timeoutMs}ms: ${open.join(", ")}`,
          );
        }
        await new Promise((r) => setTimeout(r, 200));
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
  gatewayUrl: string,
  seedBalance: bigint,
  relayerClient: ExchangeClient | null,
  relayerAddress: Uint8Array | null,
): Promise<User> {
  const { privateKey, publicKey } = generateKeypair();
  const address = pubkeyToOwner(publicKey);
  const addressHex = ownerToHex(address);

  const client = new ExchangeClient({
    gatewayUrl,
    httpTransport: pacedTransport,
  });
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
      const orderIds = await fetchOpenOrderIds(gatewayUrl, addressHex);
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

/** The engine's derived insurance account of `pool` (exchange-wire `derive_vault`). */
export function insuranceFundAddress(pool: number): string {
  const domain = new TextEncoder().encode("ProofExchange-vault-v1");
  const hash = keccak_256(new Uint8Array([...domain, 0, pool]));
  return ownerToHex(hash.subarray(0, 20));
}

const msgpackDecoder = new Decoder({ useBigInt64: true });

/**
 * Fetch open order IDs for an address via /v1/orders/{addr}. Returns an
 * empty array if the account has no open orders or the endpoint is
 * unreachable. Used by cancelAll — doesn't belong in the fluent client
 * surface because order IDs are a transient runtime concept, not a
 * stable caller-facing identifier.
 */
async function fetchOpenOrderIds(
  gatewayUrl: string,
  addressHex: string,
): Promise<bigint[]> {
  const res = await fetch(`${gatewayUrl}/v1/orders/${addressHex}`);
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: string };
  if (!json.data) return [];

  const raw = Uint8Array.from(atob(json.data), (c) => c.charCodeAt(0));
  await ready();
  let decoded: unknown;
  try {
    decoded = msgpackDecoder.decode(raw);
  } catch {
    return [];
  }
  rejectFloats(raw);
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
