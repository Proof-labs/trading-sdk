import { signAndEncode } from "./codec.js";
import { getPublicKey, pubkeyToOwner, ownerToHex } from "./crypto.js";
import type {
  Action,
  TxResult,
  AccountInfo,
  Orderbook,
  OrderbookLevel,
  PositionInfo,
} from "./types.js";
import { Decoder } from "@msgpack/msgpack";

const msgpackDecoder = new Decoder({ useBigInt64: true });

export interface ExchangeClientOptions {
  /** CometBFT RPC endpoint. Default: http://localhost:26657 */
  rpcUrl?: string;
  /** Go API server endpoint. Default: http://localhost:8080 */
  apiUrl?: string;
  /** WebSocket URL. Derived from rpcUrl by default. */
  wsUrl?: string;
}

export class ExchangeClient {
  private rpcUrl: string;
  private apiUrl: string;
  private wsUrl: string;
  private privateKey: Uint8Array | null = null;
  private publicKey: Uint8Array | null = null;
  private address: Uint8Array | null = null;
  private addressHex: string | null = null;
  private nonce = 0n;
  private ws: WebSocket | null = null;
  private eventListeners: Array<(event: Record<string, unknown>) => void> = [];
  /**
   * In-flight DeliverTx verification promises spawned by submitTx. When a
   * verification detects a silent DeliverTx failure it calls syncNonce() to
   * recover from the optimistic local-nonce drift. Awaiting this set lets
   * callers serialize against background reconciliation when they need to.
   */
  private pendingVerifies = new Set<Promise<void>>();
  /**
   * When true, submitTx is the safe-by-default fire-and-spawn-verifier mode.
   * Callers that need maximum throughput and don't care about silent drift
   * can flip this off via setUnsafeFastSubmit(true).
   */
  private autoVerifyDelivery = true;

  constructor(opts: ExchangeClientOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? "http://localhost:26657";
    this.apiUrl = opts.apiUrl ?? "http://localhost:8080";
    this.wsUrl =
      opts.wsUrl ?? this.rpcUrl.replace(/^http/, "ws") + "/websocket";
  }

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
   * adjacent ops tools (e.g. `scripts/lib/redis-submit.ts`) can build a
   * signed envelope without re-loading the key from disk. Callers that
   * don't need to bypass the normal `submitTx` path should not use this.
   */
  getPrivateKey(): Uint8Array | null {
    return this.privateKey;
  }

  /**
   * Return the current local (next-to-use) nonce. Same caveat as
   * `getPrivateKey` — only for ops tools that submit via a side channel
   * (Redis stream, gateway bypass) and need to tell the client which
   * nonce to increment past on success.
   */
  getNonce(): bigint {
    return this.nonce;
  }

  /**
   * Increment the local nonce. Only callers submitting outside of the
   * built-in `submitTx` / `submitTxCommit` paths need this — normal
   * submit methods bump the nonce internally on CheckTx success.
   */
  bumpNonce(): void {
    this.nonce++;
  }

  // -----------------------------------------------------------------------
  // Nonce management
  // -----------------------------------------------------------------------

  /** Fetch current nonce from the node for a given address. */
  async fetchNonce(addressHex?: string): Promise<bigint> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) throw new Error("No address available");
    const res = await fetch(`${this.apiUrl}/v1/nonce/${hex}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    const bytes = fromBase64(json.data);
    const nonce = msgpackDecoder.decode(bytes) as bigint | number;
    return BigInt(nonce);
  }

  /** Sync nonce from the node. Call before first transaction. */
  async syncNonce(): Promise<void> {
    this.nonce = await this.fetchNonce();
  }

  // -----------------------------------------------------------------------
  // Transaction submission
  // -----------------------------------------------------------------------

  /**
   * Sign and submit a transaction via broadcast_tx_sync.
   *
   * On `CheckTx code=0`, the local nonce is optimistically incremented and a
   * fire-and-forget background verifier is spawned. The verifier polls
   * `/tx?hash=...` for the actual `DeliverTx` result; if `DeliverTx` later
   * silently fails, the verifier calls `syncNonce()` to recover from drift.
   *
   * This means the fast path stays fast (one HTTP round-trip) while still
   * being self-healing — sustained drift was the failure mode that caused
   * cascading `InvalidNonce` errors in the market maker. Callers that need
   * to know definitively whether a tx landed should still use
   * `submitTxCommit`, which awaits the same verification synchronously.
   *
   * Callers needing to serialize against in-flight verifications (e.g. before
   * issuing a tx that depends on the previous tx's effect) can call
   * `awaitPendingVerifies()` first.
   *
   * Call `syncNonce()` once before the first transaction so the local
   * counter is initialized.
   */
  async submitTx(action: Action): Promise<TxResult> {
    const r = await this.broadcastSigned(action);
    // On CheckTx success, spawn the background DeliverTx verifier so silent
    // DeliverTx failures self-heal via syncNonce(). Skipped when the caller
    // has opted into unsafe fast mode.
    if (r.code === 0 && r.hash && this.autoVerifyDelivery) {
      this.spawnDeliveryVerifier(r.hash);
    }
    return r;
  }

  /**
   * Internal: sign + broadcast_tx_sync, manage local nonce. Does NOT spawn
   * a background verifier — the public submitTx adds that. submitTxCommit
   * uses this directly so it can run its own synchronous verification
   * without two pollers racing for the same tx hash.
   */
  private async broadcastSigned(action: Action): Promise<TxResult> {
    if (!this.privateKey) throw new Error("No private key set");

    const seq = this.nonce;
    const txBytes = signAndEncode(action, seq, this.privateKey);
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
    if (r.code === 0) {
      // Only increment nonce on successful CheckTx.
      this.nonce++;
    } else if (r.code === 21) {
      // CheckTx rejected with InvalidNonce — local cache is stale, resync
      // immediately so the next call starts from a clean slate.
      this.syncNonce().catch(() => {});
    }

    return {
      code: r.code,
      hash: r.hash,
      log: r.log,
    };
  }

  /**
   * Internal: spawn a fire-and-forget verifier that polls /tx?hash for the
   * DeliverTx result and calls syncNonce() on failure to reconcile drift.
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
              if (code !== 0) {
                // DeliverTx silently failed. Resync from chain. We don't
                // decrement directly because subsequent submits may have
                // moved the nonce.
                try {
                  await this.syncNonce();
                } catch {
                  /* tolerate transient network errors — next call will retry */
                }
              }
              return;
            }
            // Tx not yet indexed — keep polling.
          } catch {
            // Network blip — retry.
          }
        }
        // Timed out without seeing the result. Resync defensively.
        try {
          await this.syncNonce();
        } catch {
          /* swallow */
        }
      } finally {
        this.pendingVerifies.delete(self);
      }
    };
    self = verify();
    this.pendingVerifies.add(self);
  }

  /**
   * Wait for every in-flight DeliverTx verifier spawned by submitTx to settle.
   * Call this before a tx that depends on a previous tx's state having
   * actually landed (e.g. a cancel that depends on a place that may have
   * silently failed at DeliverTx time).
   */
  async awaitPendingVerifies(): Promise<void> {
    // Snapshot then await — verifiers self-remove from the set in their
    // finally blocks, but new ones could be spawned mid-wait. Loop until
    // the set is genuinely empty.
    while (this.pendingVerifies.size > 0) {
      const snapshot = Array.from(this.pendingVerifies);
      await Promise.allSettled(snapshot);
    }
  }

  /**
   * Opt out of background DeliverTx verification. Only use this for
   * high-throughput stress workloads that knowingly accept silent drift and
   * reconcile via their own out-of-band syncNonce() schedule.
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
      // broadcastSigned already left this.nonce unchanged in this case.
      return sync;
    }
    // broadcastSigned already incremented this.nonce optimistically. We'll
    // undo the increment if DeliverTx turns out to have failed.

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
          if (code !== 0) {
            // DeliverTx failed — engine did not increment chain nonce, so
            // roll back the optimistic local nonce increment from submitTx.
            this.nonce--;
          }
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
    // Timed out waiting for inclusion. We don't know whether it landed.
    // Resync nonce from chain so the caller is in a sane state.
    try {
      await this.syncNonce();
    } catch {}
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
    const res = await fetch(`${this.apiUrl}/v1/orderbook/${market}`);
    const json = await res.json();
    if (json.error) return { bids: [], asks: [] };
    const bytes = fromBase64(json.data);
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

  async queryAccount(addressHex?: string): Promise<AccountInfo | null> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return null;
    const res = await fetch(`${this.apiUrl}/v1/account/${hex}`);
    const json = await res.json();
    if (json.error) return null;
    const bytes = fromBase64(json.data);
    const raw = msgpackDecoder.decode(bytes) as unknown[];
    const balance = BigInt(raw[0] as number | bigint);
    const positions: PositionInfo[] = ((raw[1] ?? []) as unknown[][]).map(
      (p) => ({
        owner: p[0] as Uint8Array,
        market: Number(p[1]),
        side: p[2] as "Buy" | "Sell",
        entryPrice: BigInt(p[3] as number | bigint),
        size: BigInt(p[4] as number | bigint),
        lastFundingIndex: BigInt((p[5] as number | bigint) ?? 0),
      }),
    );
    const equity = BigInt((raw[2] as number | bigint) ?? 0);
    const totalMm = BigInt((raw[3] as number | bigint) ?? 0);
    const totalIm = BigInt((raw[4] as number | bigint) ?? 0);
    const marginRatioBps = BigInt((raw[5] as number | bigint) ?? 0);
    return { balance, positions, equity, totalMm, totalIm, marginRatioBps };
  }

  async queryHealth(): Promise<{ status: string; height: number }> {
    const res = await fetch(`${this.apiUrl}/v1/health`);
    return res.json();
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

  private ensureWebSocket() {
    if (this.ws) return;

    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
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
      // Auto-reconnect after 2 seconds
      if (this.eventListeners.length > 0) {
        setTimeout(() => this.ensureWebSocket(), 2000);
      }
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
