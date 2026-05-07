import { signAndEncodeWithChain } from "./codec.js";
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
  HistoryCashFlow,
  HistoryPositionSnapshot,
  HistoryResolution,
  Orderbook,
  OrderbookLevel,
  PositionInfo,
  Ticker,
} from "./types.js";
import { Decoder } from "@msgpack/msgpack";
import { sha256 } from "@noble/hashes/sha256";

const msgpackDecoder = new Decoder({ useBigInt64: true });

export interface ExchangeClientOptions {
  /** CometBFT RPC endpoint. Default: http://localhost:26657 */
  rpcUrl?: string;
  /** Go API server endpoint. Default: http://localhost:8080 */
  apiUrl?: string;
  /** WebSocket URL. Derived from rpcUrl by default. */
  wsUrl?: string;
  /**
   * CometBFT `chain_id` string — e.g. "proof-testnet-1". Signatures
   * are bound to this value via the v3 envelope
   * (`crypto::signing_message`), closing the cross-chain replay
   * vector audit B4 identified. If omitted, the client signs with
   * `UNBOUND_CHAIN_ID` — OK for local dev against a fresh unbound
   * chain, but **production deployments MUST set this** or every
   * signed tx is replayable on any other unbound chain. The
   * operator-safe default is to source this from the gateway
   * `/v1/status` endpoint at client init time.
   */
  chainId?: string;
  /**
   * Public-API gateway endpoint, used by `submitTx` when `useGateway`
   * is true. Format: `http://<host>:9080` (the Rust API gateway, not
   * the node REST API at `apiUrl`). When `useGateway` is true and
   * this option is omitted, defaults to `http://localhost:9080`.
   */
  gatewayUrl?: string;
  /**
   * Submission path selector.
   *
   * - `true` (default): `submitTx` POSTs the signed wire bytes to
   *   `gatewayUrl/exchange` — the same path external clients use.
   *   The gateway verifies the signature, applies rate limiting, and
   *   publishes to Redis. This is the production-facing path.
   *
   * - `false`: `submitTx` falls back to the legacy CometBFT
   *   `broadcast_tx_sync` over `rpcUrl` — kept for internal tools
   *   (MMs, HLP, oracle feeder, retail-flow taker) that want to skip
   *   the gateway for performance and don't need rate limiting.
   *
   * The two paths are wire-compatible: both submit the same V3 signed
   * envelope. Switching only changes which surface validates and
   * forwards the bytes. CheckTx-level error semantics (code=21
   * InvalidNonce auto-resync) are preserved on both paths.
   */
  useGateway?: boolean;
  /**
   * X-Api-Key header value sent with every gateway-path submission.
   * Required when the gateway is started with `--api-key <key>`. Read
   * endpoints (`POST /info`, `GET /health`) ignore this header.
   * Ignored when `useGateway` is false.
   */
  apiKey?: string;
}

export class ExchangeClient {
  private rpcUrl: string;
  private apiUrl: string;
  private gatewayUrl: string;
  private useGateway: boolean;
  private apiKey: string | null;
  private wsUrl: string;
  /** 32-byte chain_id binding for v3 signatures (see audit B4). */
  private chainId: Uint8Array;
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
    this.gatewayUrl = stripTrailingSlash(
      opts.gatewayUrl ?? deriveGatewayUrl(this.rpcUrl),
    );
    this.useGateway = opts.useGateway ?? true;
    this.apiKey = opts.apiKey ?? null;
    this.wsUrl =
      opts.wsUrl ?? this.rpcUrl.replace(/^http/, "ws") + "/websocket";
    // Derive 32-byte chain binding: keccak256 of the chain_id string,
    // or `UNBOUND_CHAIN_ID` when not provided. Production callers
    // must supply `chainId` — see options docstring.
    this.chainId = opts.chainId
      ? chainIdFromString(opts.chainId)
      : UNBOUND_CHAIN_ID;
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
   * Internal: sign + submit, manage local nonce. Does NOT spawn a
   * background verifier — the public `submitTx` adds that.
   * `submitTxCommit` uses this directly so it can run its own
   * synchronous verification without two pollers racing for the same
   * tx hash.
   *
   * Routes via the gateway (`POST gatewayUrl/exchange`) when
   * `useGateway` is true (default), or via CometBFT
   * `broadcast_tx_sync` when false (internal-tools opt-out path).
   * Both paths submit identical signed wire bytes; CheckTx-level
   * error semantics (code=21 InvalidNonce auto-resync) are preserved.
   */
  private async broadcastSigned(action: Action): Promise<TxResult> {
    if (!this.privateKey) throw new Error("No private key set");

    const seq = this.nonce;
    const txBytes = signAndEncodeWithChain(
      this.chainId,
      action,
      seq,
      this.privateKey,
    );

    const r = this.useGateway
      ? await this.submitViaGateway(txBytes)
      : await this.submitViaCometBFT(txBytes);

    if (r.code === 0) {
      // Only increment nonce on successful CheckTx.
      this.nonce++;
    } else if (r.code === 21) {
      // CheckTx rejected with InvalidNonce — local cache is stale, resync
      // BEFORE returning so the next caller starts from a clean slate.
      // Pre-2026-04-25 this was fire-and-forget (`.catch(() => {})`),
      // which meant the next submit could fire while the resync was
      // still in flight — visible in the impact-mm logs as cascades of
      // `expected N, got N+1` / `expected N, got N+2` etc. Awaiting
      // here serialises the recovery.
      await this.syncNonce().catch(() => {});
    }

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
   * On success it publishes to Redis; the downstream consumer feeds
   * CometBFT.
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
   * gateway auth/rate-limit/Redis, going directly to CometBFT.
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

  /**
   * BE-40 — convenience wrapper for the relayer-only `FailDeposit`
   * action. Marks a Solana deposit signature as permanently failed;
   * the engine records the sig in the failed-deposits set and emits
   * `DepositFailed`. Idempotent on retry — a repeat (or a race with
   * `ConfirmDeposit`) is a silent no-op (`code = 0`, no events).
   *
   * The caller's loaded private key MUST derive to a relayer-allowlisted
   * address; otherwise the engine returns `UnauthorizedRelayer`.
   *
   * `solanaSignature` is the raw bytes of the Solana tx sig (typically
   * 64 bytes). Same byte sequence the matching `ConfirmDeposit` would
   * carry — that's how the dedup keyspace identifies "this same deposit".
   */
  async failDeposit(
    solanaSignature: Uint8Array,
    reason: import("./types.js").FailDepositReason,
  ): Promise<TxResult> {
    if (!this.address) {
      throw new Error("failDeposit: client has no signer key loaded");
    }
    return this.submitTx({
      type: "FailDeposit",
      data: {
        solanaSignature,
        reason,
        signer: this.address,
      },
    });
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

  /** Fetch the auto-deleveraging queue for a market. Returns
   *  profitable positions ranked by `adlScore` desc — highest first
   *  is most-likely to be ADL'd if a counterparty blows through the
   *  earlier waterfall tiers. UIs use this to compute a per-position
   *  percentile rank (search by owner+market, find your row index,
   *  divide by total entries). Empty array if the market has no
   *  profitable positions or if the gateway predates the endpoint. */
  async queryAdlQueue(market: number): Promise<AdlQueueEntry[]> {
    const res = await fetch(`${this.apiUrl}/v1/adl/queue/${market}`);
    const json = await res.json();
    if (json.error) return [];
    const bytes = fromBase64(json.data);
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
    return {
      balance,
      positions,
      equity,
      totalMm,
      totalIm,
      marginRatioBps,
      bindingScenario,
      feesAccrued,
    };
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
    if (!res.ok) return null;
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
    const res = await fetch(url);
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return [];
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
    const res = await fetch(url);
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return [];
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
    const res = await fetch(url);
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) return [];
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
 * the SDK branch on `code === 21` (InvalidNonce → resync) and similar
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
