import { signAndEncode } from "./codec.js";
import {
  getPublicKey,
  pubkeyToOwner,
  ownerToHex,
  bytesToHex,
  UNBOUND_CHAIN_ID,
  chainIdFromString,
} from "./crypto.js";
import type {
  Action,
  TxResult,
  AccountInfo,
  AdlQueueEntry,
  BindingScenarioEntry,
  FeeTier,
  HistoryCashFlow,
  HistoryPositionSnapshot,
  HistoryResolution,
  MarketConfig,
  MarketKind,
  MarkSourceMode,
  OpenOrder,
  Orderbook,
  OrderbookLevel,
  PositionInfo,
  Ticker,
  WithdrawalRecord,
  WithdrawalStatus,
} from "./types.js";
import { Decoder } from "@msgpack/msgpack";
import { sha256 } from "@noble/hashes/sha2.js";

const msgpackDecoder = new Decoder({ useBigInt64: true });

/**
 * Fetch the 32-byte chain_id binding from a CometBFT RPC's `/status`
 * endpoint. Hashes `result.node_info.network` via `chainIdFromString`.
 *
 * `ExchangeClient` resolves this lazily on first submit and caches it
 * — most callers don't need this directly. Use it from offline tooling
 * (raw `signAndEncode` callers, gateway-side helpers) that build wire
 * bytes without going through a client instance.
 */
export async function fetchChainId(rpcUrl: string): Promise<Uint8Array> {
  const res = await fetch(`${rpcUrl}/status`);
  if (!res.ok) throw new Error(`/status returned HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: { node_info?: { network?: string } };
  };
  const network = json.result?.node_info?.network;
  if (!network) {
    throw new Error("/status response missing result.node_info.network");
  }
  return chainIdFromString(network);
}

export interface ExchangeClientOptions {
  /** CometBFT RPC endpoint. Default: https://api.dev.proof.trade */
  rpcUrl?: string;
  /** Go API server endpoint. Default: https://api.dev.proof.trade */
  apiUrl?: string;
  /** WebSocket URL. Derived from rpcUrl by default. */
  wsUrl?: string;
  /**
   * CometBFT `chain_id` string — e.g. "proof-testnet-1". Signatures
   * are bound to this value via the v3 envelope
   * (`crypto::signing_message`), closing the cross-chain replay
   * vector audit B4 identified.
   *
   * If omitted, the client lazily fetches it from `${rpcUrl}/status`
   * (`result.node_info.network`) on first submit and caches the
   * result. Pre-warm with `await client.ready()` to surface
   * resolution errors at init time instead of mid-flow.
   *
   * If `/status` is unreachable AND `allowUnbound: true` is set, the
   * client falls back to `UNBOUND_CHAIN_ID`. Otherwise it throws.
   * Production callers should pin `chainId` explicitly to keep
   * signatures deterministic across SDK rebuilds.
   */
  chainId?: string;
  /**
   * When true, allow falling back to `UNBOUND_CHAIN_ID` if `chainId`
   * is omitted AND `${rpcUrl}/status` is unreachable. Default false.
   *
   * The fallback exists for local fixtures where the chain isn't up
   * yet (e.g. constructing a client that will never submit, just to
   * sign offline). Any production or CI path that submits MUST leave
   * this false: an UNBOUND signature against a real chain is
   * replayable across deployments and will be rejected by any engine
   * with a real chain_id binding.
   */
  allowUnbound?: boolean;
  /**
   * Public-API gateway endpoint, used by `submitTx` when `useGateway`
   * is true. When omitted, defaults to the rpcUrl host with port 26657
   * remapped to 9080 (or the same host if no port match).
   */
  gatewayUrl?: string;
  /**
   * Submission path selector.
   *
   * - `true` (default): `submitTx` POSTs the signed wire bytes to
   *   `gatewayUrl/exchange` — the same path external clients use.
   *   The gateway verifies the signature, applies rate limiting, and
   *   forwards to CometBFT's `broadcast_tx_sync`. This is the
   *   production-facing path.
   *
   * - `false`: `submitTx` falls back to the legacy CometBFT
   *   `broadcast_tx_sync` over `rpcUrl` — kept for internal tools
   *   (MMs, HLP, oracle feeder, retail-flow taker) that want to skip
   *   the gateway for performance and don't need rate limiting.
   *
   * The two paths are wire-compatible: both submit the same V3 signed
   * envelope. Switching only changes which surface validates and
   * forwards the bytes. The nonce in that envelope is a client-chosen
   * millisecond Unix timestamp; code=21 means pick a fresh timestamp.
   */
  useGateway?: boolean;
  /**
   * X-Api-Key header value sent with every gateway-path submission.
   * Required when the gateway is started with `--api-key <key>`. Read
   * endpoints (`POST /info`, `GET /health`) ignore this header.
   * Ignored when `useGateway` is false.
   */
  apiKey?: string;
  /**
   * Deprecated compatibility option. Timestamp nonces are inherently
   * concurrency-safe, so the SDK ignores this flag.
   */
  concurrentNonces?: boolean;
}

export class ExchangeClient {
  private rpcUrl: string;
  private apiUrl: string;
  private gatewayUrl: string;
  private useGateway: boolean;
  private apiKey: string | null;
  private wsUrl: string;
  /**
   * 32-byte chain_id binding for v3 signatures (audit B4). `null` until
   * either an explicit `opts.chainId` is hashed in the constructor or
   * `resolveChainId()` fetches `${rpcUrl}/status` on first submit.
   */
  private chainId: Uint8Array | null;
  private allowUnbound: boolean;
  /** Single-flight guard so concurrent submits share one /status fetch. */
  private chainIdPromise: Promise<Uint8Array> | null = null;
  private privateKey: Uint8Array | null = null;
  private publicKey: Uint8Array | null = null;
  private address: Uint8Array | null = null;
  private addressHex: string | null = null;
  private lastTimestampNonce = 0n;
  private ws: WebSocket | null = null;
  private eventListeners: Array<(event: Record<string, unknown>) => void> = [];
  /**
   * In-flight DeliverTx verification promises spawned by submitTx. Awaiting
   * this set lets callers serialize against block inclusion when they need to;
   * timestamp nonces do not require drift reconciliation.
   */
  private pendingVerifies = new Set<Promise<void>>();
  /**
   * Completed DeliverTx results collected by background verifiers. Cleared on
   * each `awaitPendingVerifies()` call. Non-zero code entries indicate a tx
   * passed CheckTx but failed at inclusion time — the caller should handle
   * these (e.g. retry or log).
   */
  private deliveryResults: TxResult[] = [];
  /**
   * When true, submitTx is the safe-by-default fire-and-spawn-verifier mode.
   * Callers that need maximum throughput and don't need inclusion polling can
   * flip this off via setUnsafeFastSubmit(true).
   */
  private autoVerifyDelivery = true;

  constructor(opts: ExchangeClientOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? "https://api.dev.proof.trade";
    this.apiUrl = opts.apiUrl ?? "https://api.dev.proof.trade";
    this.gatewayUrl = stripTrailingSlash(
      opts.gatewayUrl ?? deriveGatewayUrl(this.rpcUrl),
    );
    this.useGateway = opts.useGateway ?? true;
    this.apiKey = opts.apiKey ?? null;
    this.wsUrl =
      opts.wsUrl ?? this.rpcUrl.replace(/^http/, "ws") + "/websocket";
    // Bind chainId eagerly when supplied, else leave null and let
    // resolveChainId() fetch from /status on first submit.
    this.chainId = opts.chainId ? chainIdFromString(opts.chainId) : null;
    this.allowUnbound = opts.allowUnbound ?? false;
    void opts.concurrentNonces;
  }

  /**
   * Resolve and cache the 32-byte chain_id binding. Idempotent and
   * single-flight: concurrent callers share one in-flight promise.
   *
   * Resolution order:
   *   1. Explicit `opts.chainId` from the constructor (already hashed) — return it.
   *   2. Fetch `${rpcUrl}/status`, hash `result.node_info.network`, cache.
   *   3. On fetch failure: if `allowUnbound`, warn and use `UNBOUND_CHAIN_ID`;
   *      otherwise throw.
   *
   * Public via `ready()`. `broadcastSigned` calls this internally
   * before every submit; the cache means only the first submit pays
   * the round-trip.
   */
  private resolveChainId(): Promise<Uint8Array> {
    if (this.chainId) return Promise.resolve(this.chainId);
    if (this.chainIdPromise) return this.chainIdPromise;
    this.chainIdPromise = (async () => {
      try {
        const bound = await fetchChainId(this.rpcUrl);
        this.chainId = bound;
        return bound;
      } catch (err) {
        // Reset so a future caller can retry (e.g. node was momentarily down).
        this.chainIdPromise = null;
        if (this.allowUnbound) {
          console.warn(
            `ExchangeClient: failed to resolve chain_id from ${this.rpcUrl}/status ` +
              `(${(err as Error).message}); falling back to UNBOUND_CHAIN_ID. ` +
              "Production callers must pin chainId or fix the rpcUrl.",
          );
          this.chainId = UNBOUND_CHAIN_ID;
          return UNBOUND_CHAIN_ID;
        }
        throw new Error(
          `ExchangeClient could not resolve chain_id from ${this.rpcUrl}/status: ` +
            `${(err as Error).message}. Pass opts.chainId explicitly, or set ` +
            "opts.allowUnbound = true if you intend to sign for an unbound chain.",
        );
      }
    })();
    return this.chainIdPromise;
  }

  /**
   * Pre-resolve the chain_id binding before any `submitTx` call. Surfaces
   * `/status`-fetch errors at init time rather than mid-flow. Optional —
   * `submitTx` resolves lazily on its own.
   */
  async ready(): Promise<void> {
    await this.resolveChainId();
  }

  /**
   * Return the cached chain_id binding. `null` if `ready()` hasn't run
   * and no explicit `opts.chainId` was passed. Callers that bypass
   * `submitTx` (e.g. signing wire bytes for an out-of-band submit
   * path) should `await client.ready()` first, then use this to feed
   * `signAndEncode`.
   */
  getChainId(): Uint8Array | null {
    return this.chainId;
  }

  // -----------------------------------------------------------------------
  // Chain-id discovery
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Wallet management
  // -----------------------------------------------------------------------

  /** Set the private key for signing transactions. */
  setPrivateKey(key: Uint8Array): void {
    this.privateKey = key;
    this.publicKey = getPublicKey(key);
    this.address = pubkeyToOwner(this.publicKey);
    this.addressHex = ownerToHex(this.address);
  }

  getAddress(): Uint8Array | null {
    return this.address;
  }

  getAddressHex(): string | null {
    return this.addressHex;
  }

  getPublicKey(): Uint8Array | null {
    return this.publicKey;
  }

  /**
   * Return the private key the client is signing with. Exposed so
   * adjacent ops tools can build a signed envelope without re-loading
   * the key from disk. Callers that don't need to bypass the normal
   * `submitTx` path should not use this.
   */
  getPrivateKey(): Uint8Array | null {
    return this.privateKey;
  }

  // -----------------------------------------------------------------------
  // Nonce diagnostics
  // -----------------------------------------------------------------------

  /** Fetch the retained timestamp nonce set from the node, for diagnostics. */
  async getRecentNonces(addressHex?: string): Promise<bigint[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) throw new Error("No address available");
    const res = await fetch(`${this.apiUrl}/v1/account/${hex}/recent-nonces`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    const recent = (json.recent ?? []) as Array<number | bigint | string>;
    return recent.map((n) => BigInt(n));
  }

  /**
   * Allocate the next timestamp nonce.
   *
   * Algorithm: `max(now_ms, last_nonce + 1)` capped at `now_ms + 60s` to
   * bound the growth if the clock stops ticking.
   *
   * Engine window: `[block_time - 2 days, block_time + 1 day]`. All four
   * rejection modes (too old, too far future, replay, below oldest) map to
   * code 21 `InvalidNonce`. Nonces are burned on success — no rewinding.
   *
   * Thread-safe only through external serialization (caller's responsibility).
   */
  private nextTimestampNonce(): bigint {
    const now = BigInt(Date.now());
    const max = now + 60_000n;
    let next =
      this.lastTimestampNonce >= now ? this.lastTimestampNonce + 1n : now;
    if (next > max) next = max;
    this.lastTimestampNonce = next;
    return next;
  }

  // -----------------------------------------------------------------------
  // Transaction submission
  // -----------------------------------------------------------------------

  /**
   * Sign and submit a transaction via broadcast_tx_sync.
   *
   * The SDK signs each transaction with a fresh millisecond timestamp nonce
   * before submitting. On `CheckTx code=0`, a fire-and-forget background
   * verifier is spawned. The verifier polls `/tx?hash=...` for the actual
   * `DeliverTx` result, but it never rewinds or resyncs nonce state: included
   * failed transactions still burn their timestamp nonce by design.
   *
   * Callers that need to know definitively whether a tx landed should use
   * `submitTxCommit`, which awaits the same verification synchronously.
   *
   * Callers needing to serialize against in-flight verifications (e.g. before
   * issuing a tx that depends on the previous tx's effect) can call
   * `awaitPendingVerifies()` first.
   *
   * No nonce sync call is required before the first transaction.
   */
  async submitTx(action: Action): Promise<TxResult> {
    const r = await this.broadcastSigned(action);
    // On CheckTx success, spawn the background DeliverTx verifier for
    // inclusion visibility. Skipped when the caller has opted into unsafe
    // fast mode.
    if (r.code === 0 && r.hash && this.autoVerifyDelivery) {
      this.spawnDeliveryVerifier(r.hash);
    }
    return r;
  }

  /**
   * Internal: sign + submit with a fresh timestamp nonce. Does NOT spawn a
   * background verifier — the public `submitTx` adds that.
   * `submitTxCommit` uses this directly so it can run its own
   * synchronous verification without two pollers racing for the same
   * tx hash.
   *
   * Routes via the gateway (`POST gatewayUrl/exchange`) when
   * `useGateway` is true (default), or via CometBFT
   * `broadcast_tx_sync` when false (internal-tools opt-out path).
   * Both paths submit identical signed wire bytes.
   */
  private async broadcastSigned(action: Action): Promise<TxResult> {
    if (!this.privateKey) throw new Error("No private key set");

    const chainId = await this.resolveChainId();
    const seq = this.nextTimestampNonce();
    const txBytes = signAndEncode(chainId, action, seq, this.privateKey);

    const r = this.useGateway
      ? await this.submitViaGateway(txBytes)
      : await this.submitViaCometBFT(txBytes);

    return r;
  }

  /**
   * Submit signed wire bytes via the public API gateway
   * (`POST gatewayUrl/exchange`). Sends the **pre-signed** JSON shape
   * the gateway accepts (`{"action": "<base64-wire-bytes>"}`) since
   * the SDK already has the wire bytes — saves the gateway from
   * re-encoding from structured JSON.
   *
   * The gateway re-verifies the signature, applies rate limiting and,
   * when configured with `--api-key`, checks the `X-Api-Key` header.
   * On success it forwards the wire bytes to CometBFT's
   * `broadcast_tx_sync`.
   *
   * The gateway response shape is `{status: "ok"|"error", error?}`.
   * We map it to `TxResult` so callers can branch on `code` the same
   * way they do for the CometBFT path. For engine-level rejections
   * the error string is `"<code>: <message>"` (mirroring the
   * ExecErrorCode table in `api-gateway/openapi.yaml`). For transport-
   * level failures (rate limit, auth, etc.) we synthesize a code from
   * the HTTP status.
   */
  private async submitViaGateway(txBytes: Uint8Array): Promise<TxResult> {
    const txHash = computeCometTxHash(txBytes);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) headers["X-Api-Key"] = this.apiKey;

    const body = JSON.stringify({ action: toBase64(txBytes) });
    const res = await fetch(`${this.gatewayUrl}/exchange`, {
      method: "POST",
      headers,
      body,
    });
    const gatewayBody = await readGatewayBody(res);

    // Auth/rate-limit transport failures don't have a JSON body the
    // engine produced — synthesize a code so callers can branch.
    if (res.status === 401) {
      return {
        code: 401,
        hash: "",
        log: gatewayBody.error ?? "unauthorized: invalid or missing X-Api-Key",
      };
    }
    if (res.status === 429) {
      return {
        code: 429,
        hash: "",
        log: gatewayBody.error ?? gatewayBody.raw ?? "rate limited by gateway",
      };
    }
    if (res.status === 413) {
      return {
        code: 413,
        hash: "",
        log:
          gatewayBody.error ??
          gatewayBody.raw ??
          "request body exceeds max size (default 8192 bytes)",
      };
    }
    if (res.status >= 500) {
      return {
        code: 500,
        hash: "",
        log: gatewayBody.error
          ? `gateway error: ${gatewayBody.error}`
          : gatewayBody.raw
            ? `gateway error: ${res.status} ${res.statusText}: ${gatewayBody.raw}`
            : `gateway error: ${res.status} ${res.statusText}`,
      };
    }

    if (!res.ok) {
      const errMsg =
        gatewayBody.error ??
        gatewayBody.raw ??
        `gateway returned HTTP ${res.status} ${res.statusText}`;
      return { code: 1, hash: "", log: errMsg };
    }

    const json = gatewayBody.json as
      | {
          status?: string;
          error?: string;
        }
      | undefined;
    if (json?.status === "ok") {
      return { code: 0, hash: txHash, log: "" };
    }
    // Gateway error shape: error string is "<engine_code>: <message>"
    // (per ExecErrorCode table in api-gateway/openapi.yaml). Parse the
    // leading code so callers branch on it; if missing, surface 1
    // (DecodeError) as the conservative default.
    const errMsg = json?.error ?? gatewayBody.raw ?? "unknown gateway error";
    const code = parseLeadingErrorCode(errMsg) ?? 1;
    return { code, hash: "", log: errMsg };
  }

  /**
   * Submit signed wire bytes via CometBFT `broadcast_tx_sync`. Used
   * when `useGateway` is false (internal-tools opt-out). Bypasses
   * gateway auth/rate-limit and goes directly to CometBFT.
   */
  private async submitViaCometBFT(txBytes: Uint8Array): Promise<TxResult> {
    const b64 = toBase64(txBytes);
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "broadcast_tx_sync",
        params: { tx: b64 },
      }),
    });

    const json = await res.json();
    if (json.error) {
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    }

    const r = json.result;
    return {
      code: r.code,
      hash: r.hash,
      log: r.log,
    };
  }

  /**
   * Internal: spawn a fire-and-forget verifier that polls /tx?hash for the
   * DeliverTx result. Timestamp nonces are intentionally not reconciled on
   * DeliverTx failure or timeout.
   * The promise is added to `pendingVerifies` so callers can await it via
   * `awaitPendingVerifies()` when they need synchronization.
   *
   * The cleanup (Set deletion) is performed INSIDE the verifier's finally
   * block rather than via a chained .finally() so there's no microtask race
   * between p settling and the awaitPendingVerifies() loop seeing size==0.
   */
  private spawnDeliveryVerifier(txHash: string): void {
    let self: Promise<void>;
    const verify = async (): Promise<void> => {
      try {
        // Poll up to 5 s — enough for normal block time (~1 s).
        const deadline = Date.now() + 5_000;
        let pollDelay = 250;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollDelay));
          pollDelay = Math.min(pollDelay + 100, 600);
          try {
            const res = await fetch(`${this.rpcUrl}/tx?hash=0x${txHash}`);
            const json = await res.json();
            const txResult = json.result?.tx_result;
            if (txResult) {
              const code = txResult.code ?? 0;
              const height = json.result.height
                ? Number(json.result.height)
                : undefined;
              this.deliveryResults.push({
                code,
                hash: txHash,
                height,
                log: txResult.log ?? "",
                events: txResult.events,
              });
              return;
            }
            // Tx not yet indexed — keep polling.
          } catch {
            // Network blip — retry.
          }
        }
        // Timed out without seeing the result. The timestamp nonce may have
        // landed or may be reusable only if never included; do not rewind.
      } finally {
        this.pendingVerifies.delete(self);
      }
    };
    self = verify();
    this.pendingVerifies.add(self);
  }

  /**
   * Wait for every in-flight DeliverTx verifier spawned by submitTx to settle,
   * then return the collected delivery results. Each entry is the DeliverTx
   * result observed by the background poller — `code === 0` means the tx was
   * included successfully, non-zero means it passed CheckTx but failed at
   * inclusion. Call this before a tx that depends on a previous tx's state
   * having actually landed.
   *
   * Results are drained from the internal buffer: subsequent calls return
   * only verifications that completed *after* the previous drain.
   */
  async awaitPendingVerifies(): Promise<TxResult[]> {
    // Snapshot then await — verifiers self-remove from the set in their
    // finally blocks, but new ones could be spawned mid-wait. Loop until
    // the set is genuinely empty.
    while (this.pendingVerifies.size > 0) {
      const snapshot = Array.from(this.pendingVerifies);
      await Promise.allSettled(snapshot);
    }
    const results = [...this.deliveryResults];
    this.deliveryResults = [];
    return results;
  }

  /**
   * Opt out of background DeliverTx verification. Only use this for
   * high-throughput stress workloads that do not need inclusion polling.
   */
  setUnsafeFastSubmit(unsafe: boolean): void {
    this.autoVerifyDelivery = !unsafe;
  }

  /**
   * Submit and wait for block inclusion (slower, but confirms execution).
   *
   * Implementation note: CometBFT's `broadcast_tx_commit` JSON-RPC method
   * has a known reliability issue where the internal event subscription
   * occasionally fails to fire before the 10s timeout, even though the tx
   * is correctly applied to state. To work around this, we use
   * `broadcast_tx_sync` (CheckTx-only) and then poll `/tx?hash=...` to
   * fetch the DeliverTx result. This is faster (avg ~1.2s) AND more
   * reliable than the native commit endpoint.
   */
  async submitTxCommit(action: Action): Promise<TxResult> {
    if (!this.privateKey) throw new Error("No private key set");

    // Step 1: broadcast via sync (returns after CheckTx). Use the internal
    // path so we don't double-spawn a background verifier — we're going to
    // do our own synchronous verification below.
    const sync = await this.broadcastSigned(action);
    if (sync.code !== 0) {
      // CheckTx rejected (envelope-level failure). No DeliverTx will run.
      return sync;
    }

    // Step 2: poll /tx?hash=... until found or timeout (~9 seconds)
    const txHash = sync.hash;
    if (!txHash) {
      throw new Error("submitTx returned no tx hash");
    }
    const deadline = Date.now() + 9_000;
    let pollDelay = 200;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollDelay));
      pollDelay = Math.min(pollDelay + 100, 600);
      try {
        const res = await fetch(`${this.rpcUrl}/tx?hash=0x${txHash}`);
        const json = await res.json();
        const txResult = json.result?.tx_result;
        if (txResult) {
          const code = txResult.code ?? 0;
          return {
            code,
            hash: txHash,
            height: json.result.height ? Number(json.result.height) : undefined,
            log: txResult.log,
            events: txResult.events,
          };
        }
        // tx not yet indexed → keep polling
      } catch {
        // network blip — retry
      }
    }
    // Timed out waiting for inclusion. We don't know whether it landed, so
    // do not reuse or rewind the timestamp nonce.
    return {
      code: -1,
      hash: txHash,
      log: "submitTxCommit: timed out polling /tx after 9s",
    };
  }

  // -----------------------------------------------------------------------
  // Query endpoints (via Go API server)
  // -----------------------------------------------------------------------

  async queryOrderbook(market: number): Promise<Orderbook> {
    const json = await fetchApiJson(`${this.apiUrl}/v1/orderbook/${market}`);
    const bytes = fromBase64(json.data as string);
    const raw = msgpackDecoder.decode(bytes) as [unknown[], unknown[]];
    const parseLevel = (arr: unknown[]): OrderbookLevel => ({
      price: BigInt(arr[0] as number | bigint),
      totalQty: BigInt(arr[1] as number | bigint),
      orderCount: Number(arr[2]),
    });
    return {
      bids: (raw[0] as unknown[][]).map(parseLevel),
      asks: (raw[1] as unknown[][]).map(parseLevel),
    };
  }

  /** List all registered market configs. */
  async queryMarkets(): Promise<MarketConfig[]> {
    const json = await fetchApiJson(`${this.apiUrl}/v1/markets`);
    const bytes = fromBase64(json.data as string);
    const raw = msgpackDecoder.decode(bytes) as unknown[][];
    return raw.map((m) => decodeMarketConfig(m));
  }

  /** Fetch open orders for an address. Returns an empty array if the
   *  account has no open orders.
   *  Each order is a 6-tuple `[id, market, owner, side, price, quantity]`
   *  decoded from MessagePack. */
  async queryOpenOrders(addressHex?: string): Promise<OpenOrder[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return [];
    const json = await fetchApiJson(`${this.apiUrl}/v1/orders/${hex}`);
    if (!json.data) return [];
    const bytes = fromBase64(json.data as string);
    let decoded: unknown;
    try {
      decoded = msgpackDecoder.decode(bytes);
    } catch {
      return [];
    }
    if (!Array.isArray(decoded)) return [];
    return (decoded as unknown[][]).map((order) => ({
      id: BigInt(order[0] as number | bigint),
      market: Number(order[1]),
      owner: (order[2] as Uint8Array) ?? new Uint8Array(),
      side: order[3] as "Buy" | "Sell",
      price: BigInt(order[4] as number | bigint),
      quantity: BigInt(order[5] as number | bigint),
    }));
  }

  /** Fetch the auto-deleveraging queue for a market. Returns
   *  profitable positions ranked by `adlScore` desc — highest first
   *  is most-likely to be ADL'd if a counterparty blows through the
   *  earlier waterfall tiers. UIs use this to compute a per-position
   *  percentile rank (search by owner+market, find your row index,
   *  divide by total entries). Empty array if the market has no
   *  profitable positions or if the gateway predates the endpoint. */
  async queryAdlQueue(market: number): Promise<AdlQueueEntry[]> {
    const json = await fetchApiJson(`${this.apiUrl}/v1/adl/queue/${market}`);
    const bytes = fromBase64(json.data as string);
    const raw = msgpackDecoder.decode(bytes);
    if (!Array.isArray(raw)) return [];
    return raw.map((row) => {
      const r = row as unknown[];
      return {
        owner: r[0] as Uint8Array,
        market: Number(r[1]),
        side: r[2] as "Buy" | "Sell",
        size: BigInt(r[3] as number | bigint),
        upnlNow: BigInt(r[4] as number | bigint),
        adlScore: BigInt(r[5] as number | bigint),
      };
    });
  }

  /** Fetch a withdrawal record by id. Returns `null` for unknown ids
   *  (the engine encodes "not found" as msgpack `nil`, not HTTP 404). */
  async queryWithdrawal(id: bigint): Promise<WithdrawalRecord | null> {
    const json = await fetchApiJson(`${this.apiUrl}/v1/withdrawal/${id}`);
    const bytes = fromBase64(json.data as string);
    const raw = msgpackDecoder.decode(bytes) as unknown[] | null;
    if (raw === null) return null;
    // serde encodes `[u8; N]` as msgpack ARRAY (not BIN), so the
    // decoder hands back `number[]` for owner/destination — coerce.
    const toBytes = (v: unknown): Uint8Array =>
      v instanceof Uint8Array ? v : Uint8Array.from(v as number[]);
    return {
      id: BigInt(raw[0] as number | bigint),
      owner: toBytes(raw[1]),
      amount: BigInt(raw[2] as number | bigint),
      solanaDestination: toBytes(raw[3]),
      status: raw[4] as WithdrawalStatus,
      requestHeight: BigInt(raw[5] as number | bigint),
    };
  }

  async queryAccount(addressHex?: string): Promise<AccountInfo | null> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return null;
    const json = await fetchApiJson(`${this.apiUrl}/v1/account/${hex}`);
    const bytes = fromBase64(json.data as string);
    const raw = msgpackDecoder.decode(bytes) as unknown[];
    const balance = BigInt(raw[0] as number | bigint);
    const positions: PositionInfo[] = ((raw[1] ?? []) as unknown[][]).map(
      (p) => {
        // Optional enrichments (indices 6-12) shipped incrementally:
        //   6-11: scenario-aware brief fields, 2026-04-24 (P1 #2).
        //   12  : adlScore, 2026-04-25 (item 7 — ADL rank surface).
        // Older gateways return shorter tuples; missing fields are
        // surfaced as `undefined` so the UI can show a "—" placeholder.
        const optBig = (v: unknown): bigint | undefined =>
          v === undefined || v === null
            ? undefined
            : BigInt(v as number | bigint);
        return {
          owner: p[0] as Uint8Array,
          market: Number(p[1]),
          side: p[2] as "Buy" | "Sell",
          entryPrice: BigInt(p[3] as number | bigint),
          size: BigInt(p[4] as number | bigint),
          lastFundingIndex: BigInt((p[5] as number | bigint) ?? 0),
          upnlNow: optBig(p[6]),
          mmNow: optBig(p[7]),
          imNow: optBig(p[8]),
          pnlIfFires: optBig(p[9]),
          pnlIfDies: optBig(p[10]),
          fundingSince: optBig(p[11]),
          adlScore: optBig(p[12]),
        };
      },
    );
    const equity = BigInt((raw[2] as number | bigint) ?? 0);
    const totalMm = BigInt((raw[3] as number | bigint) ?? 0);
    const totalIm = BigInt((raw[4] as number | bigint) ?? 0);
    const marginRatioBps = BigInt((raw[5] as number | bigint) ?? 0);
    // Index [6] — shipped 2026-04-24 (Sprint 1 Day 2 / P1 #3). Older
    // gateways omit this field; leave bindingScenario undefined rather
    // than defaulting to [] so callers can tell "no data available"
    // from "empty (perp-only account)".
    let bindingScenario: BindingScenarioEntry[] | undefined;
    if (raw[6] !== undefined) {
      bindingScenario = ((raw[6] as unknown[]) ?? []).map((e) => {
        const t = e as [number | bigint, string];
        return {
          impactMarketId: Number(t[0]),
          branch: t[1] as "Yes" | "No",
        };
      });
    }
    // Index [7] — added 2026-05-03 (BE-45). Cumulative trading fees
    // paid (positive) or rebates received (negative). Older gateways
    // omit this field; leave feesAccrued undefined so callers can
    // distinguish "no data" from "0 fees".
    let feesAccrued: bigint | undefined;
    if (raw[7] !== undefined) {
      feesAccrued = BigInt((raw[7] as number | bigint) ?? 0);
    }
    // Index [8] — added 2026-05-17. Rolling 30-day taker volume in
    // micro-USDC at the account's last volume update. Used by the
    // fee-tier program; older gateways omit it.
    let volume30dMicroUsdc: bigint | undefined;
    if (raw[8] !== undefined) {
      volume30dMicroUsdc = BigInt((raw[8] as number | bigint) ?? 0);
    }
    return {
      balance,
      positions,
      equity,
      totalMm,
      totalIm,
      marginRatioBps,
      bindingScenario,
      feesAccrued,
      volume30dMicroUsdc,
    };
  }

  /** Convenience: fetch just the USDC balance (microUSDC) for an address. */
  async queryBalance(addressHex?: string): Promise<bigint | null> {
    const acct = await this.queryAccount(addressHex);
    return acct ? acct.balance : null;
  }

  /** Convenience: fetch just the equity (microUSDC) for an address. */
  async queryEquity(addressHex?: string): Promise<bigint | null> {
    const acct = await this.queryAccount(addressHex);
    return acct ? acct.equity : null;
  }

  async queryHealth(): Promise<{ status: string; height: number }> {
    const res = await fetch(`${this.apiUrl}/v1/health`);
    return res.json();
  }

  /** One-round-trip market summary. Bundles last / 24h volume / 24h
   * change with pass-through msgpack blobs for funding + orderbook
   * top-of-book. Meant for the Markets grid card rail — previously
   * required N round-trips per card. Sprint 2 Day 5 (P2 #4).
   *
   * `openInterest` is null in every response today — the engine
   * doesn't track OI yet. UI should render "—" or "coming soon". */
  async queryTicker(market: number): Promise<Ticker | null> {
    const res = await fetch(`${this.apiUrl}/v1/ticker/${market}`);
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`API error: HTTP ${res.status}`);
    }
    const row = (await res.json()) as Record<string, unknown>;
    return {
      market: String(row.market ?? market),
      lastPrice: String(row.last_price ?? "0"),
      volume24hContracts: String(row.volume_24h_contracts ?? "0"),
      change24hBps: String(row.change_24h_bps ?? "0"),
      fundingMsgpackB64: String(row.funding_msgpack_b64 ?? ""),
      orderbookMsgpackB64: String(row.orderbook_msgpack_b64 ?? ""),
      openInterest:
        row.open_interest === null || row.open_interest === undefined
          ? null
          : String(row.open_interest),
    };
  }

  /** Per-user deposit log — every `deposit_confirmed` event for this
   * owner, newest first. Feeds Portfolio EquityChart equity-over-time
   * reconstruction (P2 #6). */
  async queryHistoryDeposits(
    addressHex?: string,
    opts?: { fromMs?: number; toMs?: number; limit?: number },
  ): Promise<HistoryCashFlow[]> {
    return this.queryHistoryCashFlow("deposits", addressHex, opts);
  }

  /** Per-user withdrawal lifecycle log — withdraw_requested /
   * withdrawal_confirmed / withdrawal_failed, newest first. Filter by
   * `kind` client-side if you want only pending requests. P2 #6. */
  async queryHistoryWithdrawals(
    addressHex?: string,
    opts?: { fromMs?: number; toMs?: number; limit?: number },
  ): Promise<HistoryCashFlow[]> {
    return this.queryHistoryCashFlow("withdrawals", addressHex, opts);
  }

  /** Internal: shared decoder for the two cash-flow endpoints. They
   * return identical row shapes (HistoryCashFlow); the difference is
   * which kinds the server includes. */
  private async queryHistoryCashFlow(
    path: "deposits" | "withdrawals",
    addressHex?: string,
    opts?: { fromMs?: number; toMs?: number; limit?: number },
  ): Promise<HistoryCashFlow[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return [];
    const params = new URLSearchParams();
    if (opts?.fromMs !== undefined) params.set("from", String(opts.fromMs));
    if (opts?.toMs !== undefined) params.set("to", String(opts.toMs));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const url = `${this.apiUrl}/v1/history/${path}/${hex}${qs ? `?${qs}` : ""}`;
    const json = await fetchApiArray(url);
    return (json as Array<Record<string, unknown>>).map((row) => ({
      kind: row.kind as HistoryCashFlow["kind"],
      owner: String(row.owner ?? ""),
      amount: String(row.amount ?? ""),
      signedDelta: String(row.signed_delta ?? "0"),
      newBalance: String(row.new_balance ?? ""),
      withdrawalId: String(row.withdrawal_id ?? ""),
      solanaTxSig: String(row.solana_tx_sig ?? ""),
      solanaDestination: String(row.solana_destination ?? ""),
      reason: String(row.reason ?? ""),
      blockHeight: Number(row.block_height ?? 0),
      timestamp: Number(row.timestamp ?? 0),
    }));
  }

  /** Per-user position-at-resolution log — each row is one settlement or
   * voided-conditional snapshot. Feeds the Portfolio "Resolved" tab
   * (P2 #7). Optional `impactMarketId` filter scopes to one event family.
   *
   * `fromMs` / `toMs` are unix-ms timestamps; omit for unbounded.
   * `limit` caps at 1000 server-side. Results are newest-first. */
  async queryHistoryResolutions(
    addressHex?: string,
    opts?: {
      impactMarketId?: number;
      fromMs?: number;
      toMs?: number;
      limit?: number;
    },
  ): Promise<HistoryResolution[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return [];
    const params = new URLSearchParams();
    if (opts?.impactMarketId !== undefined)
      params.set("impact_market_id", String(opts.impactMarketId));
    if (opts?.fromMs !== undefined) params.set("from", String(opts.fromMs));
    if (opts?.toMs !== undefined) params.set("to", String(opts.toMs));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const url = `${this.apiUrl}/v1/history/resolutions/${hex}${qs ? `?${qs}` : ""}`;
    const json = await fetchApiArray(url);
    return (json as Array<Record<string, unknown>>).map((row) => ({
      kind: row.kind as HistoryResolution["kind"],
      impactMarketId: String(row.impact_market_id ?? ""),
      market: String(row.market ?? ""),
      owner: String(row.owner ?? ""),
      side: String(row.side ?? ""),
      size: String(row.size ?? ""),
      entryPrice: String(row.entry_price ?? ""),
      settlementPrice: String(row.settlement_price ?? ""),
      realizedPnl: String(row.realized_pnl ?? "0"),
      blockHeight: Number(row.block_height ?? 0),
      timestamp: Number(row.timestamp ?? 0),
    }));
  }

  /** Per-user position-history snapshot log. Each row is one
   * point-in-time snapshot persisted after a fill that changes the
   * position. A `size === "0"` row is a CLOSE event; the immediately
   * preceding non-zero snapshot for the same `(owner, market, side)`
   * carries the entry price. Feeds the trading-UI Position History tab
   * (FE-23). Optional `market` filter scopes to one book; `fromMs` /
   * `toMs` window the timestamps; `limit` caps server-side at 5000. */
  async queryHistoryPositions(
    addressHex?: string,
    opts?: {
      market?: number;
      fromMs?: number;
      toMs?: number;
      limit?: number;
    },
  ): Promise<HistoryPositionSnapshot[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return [];
    const params = new URLSearchParams();
    if (opts?.market !== undefined) params.set("market", String(opts.market));
    if (opts?.fromMs !== undefined) params.set("from", String(opts.fromMs));
    if (opts?.toMs !== undefined) params.set("to", String(opts.toMs));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const url = `${this.apiUrl}/v1/history/positions/${hex}${qs ? `?${qs}` : ""}`;
    const json = await fetchApiArray(url);
    return (json as Array<Record<string, unknown>>).map((row) => ({
      owner: String(row.owner ?? ""),
      market: String(row.market ?? ""),
      side: String(row.side ?? ""),
      entryPrice: String(row.entry_price ?? "0"),
      size: String(row.size ?? "0"),
      blockHeight: Number(row.block_height ?? 0),
      timestamp: Number(row.timestamp ?? 0),
    }));
  }

  // -----------------------------------------------------------------------
  // CometBFT status & block queries
  // -----------------------------------------------------------------------

  async status(): Promise<{ latestHeight: number; latestAppHash: string }> {
    const res = await fetch(`${this.rpcUrl}/status`);
    const json = await res.json();
    const info = json.result.sync_info;
    return {
      latestHeight: Number(info.latest_block_height),
      latestAppHash: info.latest_app_hash,
    };
  }

  async getBlock(height?: number): Promise<Record<string, unknown>> {
    const params = height != null ? `?height=${height}` : "";
    const res = await fetch(`${this.rpcUrl}/block${params}`);
    const json = await res.json();
    if (json.error)
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  async getBlockResults(height: number): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.rpcUrl}/block_results?height=${height}`);
    const json = await res.json();
    if (json.error)
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  // -----------------------------------------------------------------------
  // WebSocket subscriptions
  // -----------------------------------------------------------------------

  /** Subscribe to CometBFT events via WebSocket. */
  subscribeBlocks(
    onEvent: (event: Record<string, unknown>) => void,
  ): () => void {
    this.eventListeners.push(onEvent);
    this.ensureWebSocket();

    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== onEvent);
    };
  }

  private wsReconnectAttempts = 0;
  private wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private ensureWebSocket() {
    if (this.ws) return;

    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      this.wsReconnectAttempts = 0;
      // Subscribe to both new blocks and tx events
      this.ws!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "subscribe",
          id: 1,
          params: { query: "tm.event='NewBlock'" },
        }),
      );
      this.ws!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "subscribe",
          id: 2,
          params: { query: "tm.event='Tx'" },
        }),
      );
    };

    this.ws.onmessage = (msg) => {
      try {
        const json = JSON.parse(msg.data);
        if (json.result?.data) {
          for (const listener of this.eventListeners) {
            listener(json.result.data);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.eventListeners.length === 0) return;
      // Exponential backoff: 2s, 4s, 8s, 16s, … capped at 60s, with
      // ±25% jitter to avoid thundering-herd on server restart.
      const attempts = this.wsReconnectAttempts++;
      const baseDelay = Math.min(2000 * Math.pow(2, attempts), 60_000);
      const jitter = baseDelay * (0.75 + Math.random() * 0.5);
      this.wsReconnectTimer = setTimeout(() => this.ensureWebSocket(), jitter);
    };
  }

  disconnect() {
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    this.wsReconnectAttempts = 0;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch JSON from the API server and throw on non-2xx or `json.error`.
 * Returns the parsed JSON body on success.
 */
async function fetchApiJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.error) {
    const msg = (json.error as string) ?? `HTTP ${res.status}`;
    throw new Error(`API error: ${msg}`);
  }
  return json;
}

/**
 * Fetch a JSON array from the API server and throw on non-2xx or
 * `json.error`. Returns the parsed array on success.
 */
async function fetchApiArray(url: string): Promise<unknown[]> {
  const res = await fetch(url);
  const json = (await res.json()) as unknown;
  if (
    !res.ok ||
    (json !== null &&
      typeof json === "object" &&
      "error" in (json as Record<string, unknown>))
  ) {
    const msg =
      ((json as Record<string, unknown> | null)?.error as string) ??
      `HTTP ${res.status}`;
    throw new Error(`API error: ${msg}`);
  }
  if (!Array.isArray(json)) {
    throw new Error(`API error: expected array, got ${typeof json}`);
  }
  return json;
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function deriveGatewayUrl(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    if (url.port === "26657") {
      url.port = "9080";
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return stripTrailingSlash(url.toString());
  } catch {
    return "http://localhost:9080";
  }
}

function computeCometTxHash(txBytes: Uint8Array): string {
  return bytesToHex(sha256(txBytes)).toUpperCase();
}

async function readGatewayBody(res: Response): Promise<{
  json?: unknown;
  error?: string;
  raw?: string;
}> {
  const raw = await res.text();
  if (!raw) return {};
  try {
    const json = JSON.parse(raw) as unknown;
    const error =
      typeof json === "object" &&
      json !== null &&
      "error" in json &&
      typeof (json as { error?: unknown }).error === "string"
        ? (json as { error: string }).error
        : undefined;
    return { json, error, raw };
  } catch {
    return { raw };
  }
}

/**
 * Parse the leading numeric code from a gateway error string.
 *
 * The gateway formats engine errors as `"<code>: <message>"` per the
 * `ExecErrorCode` table in `api-gateway/openapi.yaml`. This helper lets
 * the SDK branch on `code === 21` (fresh timestamp required) and similar
 * patterns the same way it does for CometBFT-path responses.
 *
 * Returns `null` when the string doesn't match the expected shape so
 * callers can fall back to a conservative default.
 *
 * Examples:
 *   "21: invalid nonce: expected 5, got 4" → 21
 *   "12: insufficient margin"               → 12
 *   "signature verification failed"         → null
 */
function parseLeadingErrorCode(s: string): number | null {
  const m = s.match(/^(\d+):\s/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// MarketConfig decoder
// ---------------------------------------------------------------------------

/** Decode a single MarketConfig from its MessagePack positional array.
 *  Field order mirrors the Rust struct in exchange-core/src/types.rs.
 *  Null-safe reads on every optional field. */
function decodeMarketConfig(raw: unknown[]): MarketConfig {
  const optBig = (v: unknown): bigint | undefined =>
    v == null ? undefined : BigInt(v as number | bigint);
  const addr = (v: unknown): Uint8Array | undefined =>
    v == null
      ? undefined
      : v instanceof Uint8Array
        ? v
        : Uint8Array.from(v as number[]);

  let kind: MarketKind | undefined;
  if (raw[7] != null) {
    if (typeof raw[7] === "string") {
      kind = raw[7] as MarketKind;
    } else if (typeof raw[7] === "object" && raw[7] !== null) {
      const obj = raw[7] as Record<string, unknown>;
      if (Array.isArray(obj.ConditionalPerp))
        kind = {
          ConditionalPerp: [
            Number((obj.ConditionalPerp as unknown[])[0]),
            (obj.ConditionalPerp as unknown[])[1] as "Yes" | "No",
          ],
        };
      else if (Array.isArray(obj.PredictionBinary))
        kind = {
          PredictionBinary: [
            Number((obj.PredictionBinary as unknown[])[0]),
            (obj.PredictionBinary as unknown[])[1] as "Yes" | "No",
          ],
        };
    }
  }

  let feeTiers: FeeTier[] | undefined;
  if (Array.isArray(raw[13])) {
    feeTiers = (raw[13] as unknown[][]).map((t) => ({
      min30dVolumeMicroUsdc: BigInt(t[0] as number | bigint),
      makerFeeTenthBps: Number(t[1]),
      takerFeeTenthBps: Number(t[2]),
    }));
  }

  return {
    market: Number(raw[0]),
    imBps: Number(raw[1]),
    mmBps: Number(raw[2]),
    takerFeeBps: Number(raw[3]),
    makerFeeBps: Number(raw[4]),
    fundingIntervalMs: BigInt(raw[5] as number | bigint),
    maxFundingRateBps: Number(raw[6]),
    kind,
    maxPositionSize: optBig(raw[8]),
    defaultTtlMs: optBig(raw[9]),
    netDeltaMargin: raw[10] == null ? undefined : Boolean(raw[10]),
    poolId: raw[11] == null ? undefined : Number(raw[11]),
    markPriceMaxOracleAgeMs: optBig(raw[12]),
    feeTiers,
    tickSize: optBig(raw[14]),
    lotSize: optBig(raw[15]),
    primaryOracleSigner: addr(raw[16]),
    oracleStalenessMs: optBig(raw[17]),
    markSourceMode: raw[18] == null ? undefined : (raw[18] as MarkSourceMode),
    maxMarkSpreadBps: raw[19] == null ? undefined : Number(raw[19]),
    cexCompositeStalenessMs: optBig(raw[20]),
    partialLiquidationEnabled: raw[21] == null ? undefined : Boolean(raw[21]),
    szDecimals: raw[22] == null ? undefined : Number(raw[22]),
    ticker: raw[23] == null ? undefined : String(raw[23]),
  };
}
