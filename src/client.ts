import { signAndEncode } from "./codec.js";
import { ready as initWasm } from "./wasm-loader.js";
import {
  txEngineError,
  txFromEngineCode,
  txOk,
  txTimeout,
  txTransportError,
} from "./tx-result.js";
import {
  getPublicKey,
  pubkeyToOwner,
  ownerToHex,
  bytesToHex,
  sign,
  UNBOUND_CHAIN_ID,
  chainIdFromString,
} from "./crypto.js";
import type {
  Action,
  TxEvent,
  TxResult,
  PlaceOrder,
  MarketOrder,
  AccountInfo,
  BindingScenarioEntry,
  FeeTier,
  HistoryCashFlow,
  HistoryPositionSnapshot,
  HistoryResolution,
  MarketConfig,
  MarketKind,
  MarkSourceMode,
  OpenOrder,
  AdlQueueEntry,
  Orderbook,
  OrderbookLevel,
  Ticker,
  PositionInfo,
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
  /**
   * Override for the CometBFT RPC endpoint on the **internal**
   * direct-node path (`useGateway: false`). Optional — when omitted it is
   * derived from `gatewayUrl` (remapping local gateway port 9080 → 26657).
   * When `useGateway` is true (the default, and the only supported mode for
   * external clients) chain reads, tx-result polling, and chain-id resolution
   * go through `gatewayUrl` (`/v1/*`) and this value is ignored.
   */
  rpcUrl?: string;
  /**
   * Override for the Go API server endpoint on the **internal**
   * direct-node read path (`useGateway: false`). Optional — when omitted
   * it is derived from `gatewayUrl` (remapping local gateway port
   * 9080 → 8080). When `useGateway` is true (the default) every read/query
   * goes through `gatewayUrl` and this value is ignored. External clients
   * must not rely on direct API-server reachability.
   */
  apiUrl?: string;
  /**
   * WebSocket base URL for the gateway streams (`/account-events`,
   * `/orderbook-deltas`). Defaults to `gatewayUrl` (or `rpcUrl` on the
   * direct-node path) with the scheme swapped to `ws`/`wss`. The gateway
   * serves its feed on a dedicated listener; for a local stack whose WS
   * port differs from the HTTP port, set this explicitly
   * (e.g. `ws://localhost:9091`).
   */
  wsUrl?: string;
  /**
   * CometBFT `chain_id` string — e.g. "proof-testnet-1". Signatures
   * are bound to this value via the v3 envelope
   * (`crypto::signing_message`), closing the cross-chain replay
   * vector audit B4 identified.
   *
   * If omitted, the client auto-resolves it on first submit from the
   * gateway's `/v1/status` (`result.node_info.network`), or from
   * `${rpcUrl}/status` on the direct-node path, and caches it. Pre-warm with
   * `await client.ready()` to surface resolution errors at init time. Pinning
   * `chainId` explicitly is still recommended for production — it keeps
   * signatures deterministic across SDK rebuilds.
   *
   * If `/status` is unreachable AND `allowUnbound: true` is set, the client
   * falls back to `UNBOUND_CHAIN_ID`; otherwise it throws.
   */
  chainId?: string;
  /**
   * When true, allow falling back to `UNBOUND_CHAIN_ID` if `chainId`
   * is omitted AND the chain's `/status` is unreachable (the gateway's
   * `/v1/status`, or `${rpcUrl}/status` on the direct path). Default false.
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
   * Public API gateway endpoint — the single source of truth for where
   * the SDK points. Under the default `useGateway: true` every request
   * (submission, reads, chain queries, WebSocket) goes here, and the
   * direct-node URLs (`rpcUrl` / `apiUrl`) are derived from it. Defaults
   * to `https://api.dev.proof.trade`.
   */
  gatewayUrl?: string;
  /**
   * Master traffic selector. Controls **all** network paths, not just
   * submission, so the SDK honours the gateway-only network policy (see
   * CLAUDE.md → "Network policy — gateway only").
   *
   * - `true` (default, the only supported mode for external clients):
   *   every request — submission, reads/queries, chain status/blocks
   *   (`/v1/status`, `/v1/block`, …), tx-result polling, chain-id resolution,
   *   and the WebSocket feed — goes through `gatewayUrl`. Submission POSTs the
   *   signed wire bytes to `gatewayUrl/exchange`; the gateway verifies the
   *   signature, applies rate limiting, and forwards to CometBFT. This is the
   *   production-facing path.
   *
   * - `false`: the legacy direct-node path — submission goes to CometBFT
   *   `broadcast_tx_sync` over `rpcUrl`, reads to `apiUrl`, and chain
   *   queries to `rpcUrl`. Kept only for in-cluster tools (MMs, HLP,
   *   oracle feeder, retail-flow taker) and the scenario harness that
   *   reach the node directly and don't need the gateway. Never expose
   *   this to external callers.
   *
   * The submission paths are wire-compatible: both submit the same V3
   * signed envelope. Switching only changes which surface validates and
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
   * `resolveChainId()` fetches `${chainBase}/status` (the gateway's
   * `/v1/status`, or `${rpcUrl}/status` on the direct path) on first submit.
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
  /** Unsubscribe handles for every open WebSocket stream, so `disconnect()`
   *  can tear them all down at once. */
  private activeStreams = new Set<() => void>();
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
    // `gatewayUrl` is the single source of truth for where the SDK points.
    // Everything else is derived from it. The direct-node URLs (`rpcUrl`,
    // `apiUrl`) are only consulted on the internal `useGateway: false`
    // path; when omitted they are derived from the gateway by remapping
    // the conventional local gateway port (9080) to the node ports
    // (26657 for CometBFT RPC, 8080 for the Go API). Those port remaps are
    // best-effort fallbacks — deployments that differ should pass `rpcUrl`
    // / `apiUrl` explicitly.
    this.gatewayUrl = stripTrailingSlash(
      opts.gatewayUrl ?? "https://api.dev.proof.trade",
    );
    this.useGateway = opts.useGateway ?? true;
    this.rpcUrl = stripTrailingSlash(
      opts.rpcUrl ?? deriveNodeUrl(this.gatewayUrl, "26657"),
    );
    this.apiUrl = stripTrailingSlash(
      opts.apiUrl ?? deriveNodeUrl(this.gatewayUrl, "8080"),
    );
    this.apiKey = opts.apiKey ?? null;
    // WebSocket base URL (no path). Per-stream methods append the channel
    // path (`/account-events`, `/orderbook-deltas`). Mirrors the Python SDK,
    // which derives the WS base by swapping the gateway URL's scheme. Local
    // stacks whose WS listener is on a different port must pass `wsUrl`.
    this.wsUrl = stripTrailingSlash(
      opts.wsUrl ??
        (this.useGateway ? this.gatewayUrl : this.rpcUrl).replace(
          /^http/,
          "ws",
        ),
    );
    // Bind chainId eagerly when supplied, else leave null. On the direct
    // path resolveChainId() fetches /status on first submit; on the gateway
    // path chainId must be pinned (the gateway does not serve /status).
    this.chainId = opts.chainId ? chainIdFromString(opts.chainId) : null;
    this.allowUnbound = opts.allowUnbound ?? false;
    void opts.concurrentNonces;
  }

  /**
   * Base URL for read/query endpoints (`/v1/*`). Routes through the
   * gateway under the default `useGateway: true`; only the internal
   * direct-node path (`useGateway: false`) targets the bare `apiUrl`.
   */
  private get readBaseUrl(): string {
    return this.useGateway ? this.gatewayUrl : this.apiUrl;
  }

  /**
   * URL for the transaction-status lookup by hash. On the gateway path
   * (default) this is the gateway's native `/v1/tx/{hash}` route, which
   * proxies CometBFT's `/tx?hash=` and returns the body verbatim. On the
   * internal direct-node path (`useGateway: false`) it is CometBFT's native
   * `/tx?hash=0x{hash}`. Both yield the same `{ result: { tx_result, height } }`
   * shape, so callers parse the response identically.
   */
  private txStatusUrl(txHash: string): string {
    return this.useGateway
      ? `${this.gatewayUrl}/v1/tx/${txHash}`
      : `${this.rpcUrl}/tx?hash=0x${txHash}`;
  }

  /**
   * Base URL for CometBFT-style chain reads (`/status`, `/block`,
   * `/block_results`) and the chain-id bootstrap. On the gateway path
   * (default) this is the gateway's `/v1` proxy prefix — the gateway fronts
   * these as `/v1/status`, `/v1/block`, `/v1/block_results` (api-gateway #69)
   * and returns the CometBFT body verbatim. On the internal direct-node path
   * (`useGateway: false`) it is the bare `rpcUrl`. Append the endpoint
   * (`/status`, …); both paths yield the same response shape.
   */
  private get chainBase(): string {
    return this.useGateway ? `${this.gatewayUrl}/v1` : this.rpcUrl;
  }

  /**
   * Resolve and cache the 32-byte chain_id binding. Idempotent and
   * single-flight: concurrent callers share one in-flight promise.
   *
   * Resolution order:
   *   1. Explicit `opts.chainId` from the constructor (already hashed) — return it.
   *   2. Fetch `${chainBase}/status` (the gateway's `/v1/status`, or
   *      `${rpcUrl}/status` on the direct path), hash `result.node_info.network`.
   *   3. On fetch failure: if `allowUnbound`, warn and use `UNBOUND_CHAIN_ID`;
   *      otherwise throw.
   *
   * Public via `ready()`. `broadcastSigned` calls this internally before every
   * submit; the cache means only the first submit pays the round-trip.
   */
  private resolveChainId(): Promise<Uint8Array> {
    if (this.chainId) return Promise.resolve(this.chainId);
    if (this.chainIdPromise) return this.chainIdPromise;
    this.chainIdPromise = (async () => {
      try {
        // `fetchChainId` appends `/status`, so the gateway path resolves from
        // `${gatewayUrl}/v1/status` and the direct path from `${rpcUrl}/status`.
        const bound = await fetchChainId(this.chainBase);
        this.chainId = bound;
        return bound;
      } catch (err) {
        // Reset so a future caller can retry (e.g. node was momentarily down).
        this.chainIdPromise = null;
        if (this.allowUnbound) {
          console.warn(
            `ExchangeClient: failed to resolve chain_id from ${this.chainBase}/status ` +
              `(${(err as Error).message}); falling back to UNBOUND_CHAIN_ID. ` +
              "Production callers should pin chainId or fix the gateway/rpc URL.",
          );
          // Copy the shared singleton — it cannot be frozen, so caching it
          // directly would let an external mutation corrupt our signing key.
          const unbound = UNBOUND_CHAIN_ID.slice();
          this.chainId = unbound;
          return unbound;
        }
        throw new Error(
          `ExchangeClient could not resolve chain_id from ${this.chainBase}/status: ` +
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
    // Initialize the WASM codec/signing core and pre-resolve the chain_id.
    await Promise.all([initWasm(), this.resolveChainId()]);
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
    const res = await fetch(
      `${this.readBaseUrl}/v1/account/${hex}/recent-nonces`,
    );
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
   * before submitting. Whenever the response has a tx hash but no final chain
   * verdict, a fire-and-forget verifier polls `/tx?hash=...` for the actual
   * `DeliverTx` result. It never rewinds or resyncs nonce state: included failed
   * transactions still burn their timestamp nonce by design.
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
    // Spawn the background DeliverTx verifier only if the outcome is still
    // unknown. A synchronous gateway (api-gateway#90) already returns the
    // executed result, so polling for it would be pure waste — and a CheckTx
    // reject is terminal, so there is nothing to verify either.
    //
    // The `timeout` case is the one that still needs it: the gateway broadcast
    // the tx but could not report the outcome in time, so the SDK reconciles by
    // hash on the caller's behalf, exactly as before.
    if (this.autoVerifyDelivery && r.hash && !this.isFinalResult(r)) {
      this.spawnDeliveryVerifier(r.hash);
    }
    return r;
  }

  /**
   * Submit **externally signed** wire bytes — the public counterpart of
   * `submitTx` for callers that never load a private key into the client
   * (hardware or CLI signers, multisig proposers/approvers). Build the bytes
   * with `signingMessage()` → sign anywhere → `encodeSignedTx()`; this method
   * is pure transport for the result.
   *
   * The caller owns everything the loaded-key path normally does: the
   * chain id, a fresh millisecond-timestamp `seq` (one per signature), and
   * the signature itself. The bytes are deliberately treated as opaque —
   * never decoded or validated here — so wire-valid action types this SDK
   * build does not know yet still submit; the gateway and engine are the
   * authorities that reject malformed bytes.
   *
   * Routes exactly like `submitTx` (gateway by default, CometBFT
   * `broadcast_tx_sync` on the internal `useGateway: false` opt-out) with the
   * same delivery-verification semantics: a synchronous gateway verdict is
   * final and returns as-is; a hash-only ambiguous response spawns the same
   * fire-and-forget `/tx?hash=` reconciliation, awaitable via
   * `awaitPendingVerifies()`.
   */
  async submitSignedTx(txBytes: Uint8Array): Promise<TxResult> {
    const r = await this.broadcastSignedBytes(txBytes);
    if (this.autoVerifyDelivery && r.hash && !this.isFinalResult(r)) {
      this.spawnDeliveryVerifier(r.hash);
    }
    return r;
  }

  /**
   * Internal: route pre-signed wire bytes to the configured transport —
   * gateway (`POST /exchange`, default) or CometBFT `broadcast_tx_sync` on
   * the internal `useGateway: false` opt-out. Both submit identical bytes.
   * Shared by `submitSignedTx` and `submitSignedTxCommit`.
   */
  private async broadcastSignedBytes(txBytes: Uint8Array): Promise<TxResult> {
    return this.useGateway
      ? this.submitViaGateway(txBytes)
      : this.submitViaCometBFT(txBytes);
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

    // Initialize the WASM codec/signing core and resolve the chain_id
    // concurrently; both are cached, so only the first submit pays for either.
    const [chainId] = await Promise.all([this.resolveChainId(), initWasm()]);
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
   * The gateway response is an `ExchangeResponse`: a structured chain verdict
   * carries `code` and optionally `height`/`events`; an admitted-but-ambiguous
   * submission carries `txHash` without `code` and must be reconciled. We map
   * every shape to `TxResult`. Engine rejections retain the compatibility error
   * string `"<code>: <message>"`, while the structured `code` is authoritative.
   * For transport-level failures (rate limit, auth, etc.) we synthesize a code
   * from the HTTP status.
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
    // engine produced — synthesize an HTTP-status code and tag the result
    // `outcome: "transport"` so callers don't read it as an ExecError.
    if (res.status === 401) {
      return txTransportError(
        401,
        gatewayBody.error ?? "unauthorized: invalid or missing X-Api-Key",
      );
    }
    if (res.status === 429) {
      return txTransportError(
        429,
        gatewayBody.error ?? gatewayBody.raw ?? "rate limited by gateway",
      );
    }
    if (res.status === 413) {
      return txTransportError(
        413,
        gatewayBody.error ??
          gatewayBody.raw ??
          "request body exceeds max size (default 8192 bytes)",
      );
    }
    if (res.status >= 500) {
      return txTransportError(
        500,
        gatewayBody.error
          ? `gateway error: ${gatewayBody.error}`
          : gatewayBody.raw
            ? `gateway error: ${res.status} ${res.statusText}: ${gatewayBody.raw}`
            : `gateway error: ${res.status} ${res.statusText}`,
      );
    }

    if (!res.ok) {
      const errMsg =
        gatewayBody.error ??
        gatewayBody.raw ??
        `gateway returned HTTP ${res.status} ${res.statusText}`;
      // Non-JSON / unexpected HTTP error with no engine body — transport, not
      // an ExecError. `code` stays 1 for back-compat; `outcome` disambiguates.
      return txTransportError(1, errMsg);
    }

    const json = gatewayBody.json as
      | {
          status?: string;
          error?: string;
          txHash?: string;
          code?: number;
          log?: string;
          height?: number;
          events?: TxEvent[];
        }
      | undefined;

    // The gateway is synchronous on the on-chain result (api-gateway#90): it
    // parks the response on the tx hash and answers with the chain's own
    // `code` / `log` / `height` / `events`. A body carrying a `height` is a
    // FINISHED verdict — the tx is in a block and there is nothing left to
    // poll for, so `submitTx` skips its background verifier and
    // `submitTxCommit` returns immediately instead of polling `/tx?hash=` for
    // up to 9 seconds.
    //
    // Older gateways answer `{status: "ok"}` with no `code`/`height`, so the
    // absence of those fields still means "CheckTx accepted, execution
    // unknown" and the polling paths below stay exactly as they were. That
    // fallback is what makes this safe against a gateway that has not been
    // upgraded yet.
    if (typeof json?.code === "number") {
      const hash = json.txHash ?? txHash;
      // `height` present  → committed: the code IS the ExecTxResult code.
      // `height` absent   → CheckTx reject: never entered a block, and equally
      //                     terminal — no DeliverTx will ever run for it.
      return txFromEngineCode(json.code, {
        hash,
        height: json.height,
        log: json.log ?? json.error,
        events: json.events,
      });
    }

    if (json?.status === "ok") {
      // Legacy gateway: CheckTx ack only, execution still unknown.
      return txOk({ hash: txHash });
    }

    // `status: error` with a `txHash` but NO `code` is not a rejection — it is
    // the gateway saying "I broadcast this and could not tell you the outcome
    // in time" (park deadline exceeded, a byte-identical tx already in flight,
    // or a result it could not parse). The tx may well still commit, so this is
    // a `timeout` outcome to be reconciled by hash, NOT an engine error. Calling
    // it an engine error here would report a phantom rejection for an order
    // that is about to fill.
    if (json?.txHash) {
      return txTimeout(
        json.txHash,
        json.error ?? "gateway returned no on-chain result; reconcile by hash",
      );
    }

    // Fallback: the code embedded in the string as "<engine_code>: <message>".
    // The gateway still emits this format for compatibility, so this path also
    // covers a pre-#90 gateway that sends ONLY the string. Parse the leading code;
    // if missing, surface 1 (DecodeError) as the conservative default.
    const errMsg = json?.error ?? gatewayBody.raw ?? "unknown gateway error";
    const code = parseLeadingErrorCode(errMsg) ?? 1;
    return txEngineError(code, { log: errMsg });
  }

  /**
   * Whether a `TxResult` is already final — i.e. nothing is gained by polling
   * for it.
   *
   * A `height` means the tx executed in a block (the synchronous gateway
   * response carries it). An `engine` outcome without a height is a CheckTx
   * reject: it never entered a block and never will, so DeliverTx will not run.
   * A `transport` failure never reached the chain at all.
   */
  private isFinalResult(r: TxResult): boolean {
    return (
      r.height !== undefined ||
      r.outcome === "engine" ||
      r.outcome === "transport"
    );
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
    return txFromEngineCode(r.code, { hash: r.hash, log: r.log });
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
            const res = await fetch(this.txStatusUrl(txHash));
            const json = await res.json();
            const txResult = json.result?.tx_result;
            if (txResult) {
              const code = txResult.code ?? 0;
              const height = json.result.height
                ? Number(json.result.height)
                : undefined;
              this.deliveryResults.push(
                txFromEngineCode(code, {
                  hash: txHash,
                  height,
                  log: txResult.log ?? "",
                  events: txResult.events,
                }),
              );
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
   * A synchronous gateway verdict returns immediately. If the gateway only
   * acknowledges CheckTx (legacy) or returns a hash-only ambiguous response,
   * this falls back to polling `/tx?hash=...`. The direct-node path likewise
   * uses `broadcast_tx_sync` plus polling instead of CometBFT's less reliable
   * `broadcast_tx_commit` subscription.
   */
  async submitTxCommit(action: Action): Promise<TxResult> {
    if (!this.privateKey) throw new Error("No private key set");

    // Step 1: broadcast via sync (returns after CheckTx). Use the internal
    // path so we don't double-spawn a background verifier — we're going to
    // do our own synchronous verification below.
    const sync = await this.broadcastSigned(action);
    return this.awaitCommit(sync);
  }

  /**
   * Submit **externally signed** wire bytes and wait for block inclusion —
   * the commit counterpart of `submitSignedTx`, for the same callers
   * (hardware/CLI signers, multisig propose/approve) that never load a
   * private key into the client. Shares `submitTxCommit`'s exact finality
   * logic: a synchronous gateway verdict returns immediately; a hash-only
   * ambiguous response or a legacy CheckTx-only ack falls back to polling
   * `/tx?hash=...` (~9 s), scoped to THIS call — no background verifier, no
   * draining the client-global `awaitPendingVerifies()` buffer. Use this
   * when the caller must know definitively whether the tx landed (an
   * operator action, a multisig proposal) rather than fire-and-forget.
   */
  async submitSignedTxCommit(txBytes: Uint8Array): Promise<TxResult> {
    const sync = await this.broadcastSignedBytes(txBytes);
    return this.awaitCommit(sync);
  }

  /**
   * Internal: shared commit-semantics tail of `submitTxCommit` and
   * `submitSignedTxCommit` — take a broadcast's sync result and return the
   * final chain verdict, polling `/tx?hash=` only when the outcome is still
   * unknown.
   */
  private async awaitCommit(sync: TxResult): Promise<TxResult> {
    if (this.isFinalResult(sync)) {
      // Either the gateway already returned the on-chain result (the
      // synchronous submit path — nothing to wait for), or the tx was rejected
      // at CheckTx / never reached the chain, in which case no DeliverTx will
      // ever run. This is the case H14 was filed about: a confirmed order used
      // to cost a 9-second poll loop, and now costs one round-trip.
      return sync;
    }
    if (!sync.ok && sync.outcome !== "timeout") {
      return sync;
    }

    // Step 2: the outcome is still unknown (a pre-#90 gateway that only acks
    // CheckTx, the direct-to-CometBFT path, or a gateway that broadcast the tx
    // but could not report the result in time). Poll /tx?hash=... until found
    // or timeout (~9 seconds).
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
        const res = await fetch(this.txStatusUrl(txHash));
        const json = await res.json();
        const txResult = json.result?.tx_result;
        if (txResult) {
          const code = txResult.code ?? 0;
          return txFromEngineCode(code, {
            hash: txHash,
            height: json.result.height ? Number(json.result.height) : undefined,
            log: txResult.log,
            events: txResult.events,
          });
        }
        // tx not yet indexed → keep polling
      } catch {
        // network blip — retry
      }
    }
    // Timed out waiting for inclusion. We don't know whether it landed, so
    // do not reuse or rewind the timestamp nonce.
    return txTimeout(txHash, "submitTxCommit: timed out polling /tx after 9s");
  }

  // -----------------------------------------------------------------------
  // Convenience action builders
  //
  // Thin wrappers over `submitTx` for the common trader actions. Each fills
  // `owner` from the loaded signer key so callers don't repeat their own
  // address on every action, and returns the same `TxResult` as `submitTx`
  // (CheckTx result + background DeliverTx verification). For inclusion-
  // waiting semantics, build the action yourself and call `submitTxCommit`.
  // -----------------------------------------------------------------------

  /**
   * The loaded signer's 20-byte owner address, or throw if no key is set.
   * Every convenience builder needs it, so the guard lives here.
   */
  private requireOwner(): Uint8Array {
    if (!this.address) {
      throw new Error(
        "No signer key loaded — call setPrivateKey() before submitting actions",
      );
    }
    return this.address;
  }

  /**
   * Place a limit order for the loaded signer. `owner` is supplied
   * automatically. Equivalent to
   * `submitTx({ type: "PlaceOrder", data: { ...params, owner } })`.
   */
  async placeOrder(params: Omit<PlaceOrder, "owner">): Promise<TxResult> {
    return this.submitTx({
      type: "PlaceOrder",
      data: { ...params, owner: this.requireOwner() },
    });
  }

  /** Place a market order (crosses immediately) for the loaded signer. */
  async marketOrder(params: Omit<MarketOrder, "owner">): Promise<TxResult> {
    return this.submitTx({
      type: "MarketOrder",
      data: { ...params, owner: this.requireOwner() },
    });
  }

  /** Cancel a resting order by its engine-assigned order ID. */
  async cancelOrder(orderId: bigint): Promise<TxResult> {
    return this.submitTx({
      type: "CancelOrder",
      data: { orderId, owner: this.requireOwner() },
    });
  }

  /** Cancel a resting order by the owner-scoped client order ID. */
  async cancelClientOrder(clientOrderId: bigint): Promise<TxResult> {
    return this.submitTx({
      type: "CancelClientOrder",
      data: { clientOrderId, owner: this.requireOwner() },
    });
  }

  /**
   * Cancel all resting orders for the loaded signer. Pass a `market` to
   * scope the cancel to one market; omit it to cancel across all markets.
   */
  async cancelAllOrders(market?: number | null): Promise<TxResult> {
    return this.submitTx({
      type: "CancelAllOrders",
      data: { owner: this.requireOwner(), market: market ?? null },
    });
  }

  /**
   * Close the loaded signer's entire position on `market` via an
   * opposite-side IOC order at oracle±spread. Idempotent on an already-flat
   * position.
   */
  async closePosition(market: number): Promise<TxResult> {
    return this.submitTx({
      type: "ClosePosition",
      data: { market, owner: this.requireOwner() },
    });
  }

  // -----------------------------------------------------------------------
  // Query endpoints
  // -----------------------------------------------------------------------

  /**
   * Owner-scoped reads (account, open orders, withdrawal) are deliberately
   * NOT exposed as GETs on the gateway — it 404s them and requires
   * `POST /info` instead (see `api-gateway/src/server.rs`
   * `is_public_node_path`). On the gateway path we POST the matching
   * `/info` request; on the internal `useGateway: false` path we hit the
   * Go API GET directly. The gateway proxies the node body verbatim, so
   * both return the same `{ data: <base64-msgpack> }` shape and callers
   * decode identically.
   */
  private async queryOwnerScoped(
    info: Record<string, unknown>,
    nodePath: string,
  ): Promise<Record<string, unknown>> {
    return this.useGateway
      ? postInfoJson(this.gatewayUrl, info)
      : fetchApiJson(`${this.apiUrl}${nodePath}`);
  }

  async queryOrderbook(market: number): Promise<Orderbook> {
    const json = await fetchApiJson(
      `${this.readBaseUrl}/v1/orderbook/${market}`,
    );
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
    const json = await fetchApiJson(`${this.readBaseUrl}/v1/markets`);
    const bytes = fromBase64(json.data as string);
    const raw = msgpackDecoder.decode(bytes) as unknown[][];
    return raw.map((m) => decodeMarketConfig(m));
  }

  /**
   * Read the current on-chain admin signer registry via the gateway proxy
   * (`GET /v1/admin/signer-registry`). The engine wraps the
   * registry in an `Option`, so the proxy returns MessagePack `[registry|nil]`.
   *
   * Returns `null` when no registry is seeded — which means admin multisig is
   * **inactive** (fail-closed), NOT an empty roster; callers must treat the two
   * differently. When present, the decoded value is the engine's MessagePack
   * registry record (version, threshold, members) as returned by the node; a
   * typed decoder lands with the release-B seed, when a populated registry
   * first exists to pin it against.
   */
  async queryAdminSignerRegistry(): Promise<unknown | null> {
    const json = await fetchApiJson(
      `${this.readBaseUrl}/v1/admin/signer-registry`,
    );
    if (!json.data) return null;
    const bytes = fromBase64(json.data as string);
    const decoded = msgpackDecoder.decode(bytes) as unknown[];
    return decoded[0] ?? null;
  }

  /**
   * List admin governance proposals via the gateway proxy
   * (`GET /v1/proposals`). Optional `status` / `cursor` /
   * `limit` are forwarded as query params (the node clamps oversized limits).
   * The proxy returns MessagePack `[proposals, nextCursor|nil]`.
   *
   * `proposals` is the engine's MessagePack proposal list as returned by the
   * node; a typed per-proposal decoder lands alongside the propose/approve UI,
   * when a live proposal first exists to pin it against.
   */
  async queryProposals(opts?: {
    status?: string;
    cursor?: bigint;
    limit?: number;
  }): Promise<{ proposals: unknown[]; nextCursor: bigint | null }> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.cursor != null) params.set("cursor", String(opts.cursor));
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const json = await fetchApiJson(
      `${this.readBaseUrl}/v1/proposals${qs ? `?${qs}` : ""}`,
    );
    if (!json.data) return { proposals: [], nextCursor: null };
    const bytes = fromBase64(json.data as string);
    const decoded = msgpackDecoder.decode(bytes) as [unknown[], unknown];
    // `useBigInt64` only yields bigint for 64-bit msgpack ints — a small
    // cursor arrives as `number`, so normalize to honor the declared type.
    const rawCursor = decoded[1];
    return {
      proposals: (decoded[0] ?? []) as unknown[],
      nextCursor:
        typeof rawCursor === "number"
          ? BigInt(rawCursor)
          : ((rawCursor ?? null) as bigint | null),
    };
  }

  /** Fetch open orders for an address. Returns an empty array if the
   *  account has no open orders.
   *  Each order is a 6-tuple `[id, market, owner, side, price, quantity]`
   *  decoded from MessagePack. */
  async queryOpenOrders(addressHex?: string): Promise<OpenOrder[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return [];
    const json = await this.queryOwnerScoped(
      { type: "openOrders", user: hex },
      `/v1/orders/${hex}`,
    );
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
      owner: toBytes(order[2]),
      side: order[3] as "Buy" | "Sell",
      price: BigInt(order[4] as number | bigint),
      quantity: BigInt(order[5] as number | bigint),
    }));
  }

  /** Fetch a withdrawal record by id. Returns `null` for unknown ids
   *  (the engine encodes "not found" as msgpack `nil`, not HTTP 404). */
  async queryWithdrawal(id: bigint): Promise<WithdrawalRecord | null> {
    const json = await this.queryOwnerScoped(
      { type: "withdrawalStatus", withdrawalId: Number(id) },
      `/v1/withdrawal/${id}`,
    );
    const bytes = fromBase64(json.data as string);
    const raw = msgpackDecoder.decode(bytes) as unknown[] | null;
    if (raw === null) return null;
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
    const json = await this.queryOwnerScoped(
      { type: "clearinghouseState", user: hex },
      `/v1/account/${hex}`,
    );
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
          owner: toBytes(p[0]),
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
    const res = await fetch(`${this.readBaseUrl}/v1/health`);
    return res.json();
  }

  /** Fetch the auto-deleveraging queue for a market — profitable positions
   *  ranked by `adlScore` desc (highest first). Empty array if the market has
   *  no profitable positions. Routes through the gateway's `/v1/adl/queue`. */
  async queryAdlQueue(market: number): Promise<AdlQueueEntry[]> {
    const res = await fetch(`${this.readBaseUrl}/v1/adl/queue/${market}`);
    const json = await res.json();
    if (json.error) return [];
    const bytes = fromBase64(json.data);
    const raw = msgpackDecoder.decode(bytes);
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[][]).map((row) => ({
      owner: toBytes(row[0]),
      market: Number(row[1]),
      side: row[2] as "Buy" | "Sell",
      size: BigInt(row[3] as number | bigint),
      upnlNow: BigInt(row[4] as number | bigint),
      adlScore: BigInt(row[5] as number | bigint),
    }));
  }

  /** One-round-trip market summary (last / 24h volume / 24h change + funding
   *  and top-of-book blobs). Returns `null` if the market is unknown. Routes
   *  through the gateway's `/v1/ticker`. */
  async queryTicker(market: number): Promise<Ticker | null> {
    const res = await fetch(`${this.readBaseUrl}/v1/ticker/${market}`);
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
    const url = `${this.readBaseUrl}/v1/history/${path}/${hex}${qs ? `?${qs}` : ""}`;
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
    const url = `${this.readBaseUrl}/v1/history/resolutions/${hex}${qs ? `?${qs}` : ""}`;
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
    const url = `${this.readBaseUrl}/v1/history/positions/${hex}${qs ? `?${qs}` : ""}`;
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
  // Chain status & block queries (via the gateway's /v1/* by default)
  // -----------------------------------------------------------------------

  async status(): Promise<{ latestHeight: number; latestAppHash: string }> {
    const res = await fetch(`${this.chainBase}/status`);
    const json = await res.json();
    const info = json.result.sync_info;
    return {
      latestHeight: Number(info.latest_block_height),
      latestAppHash: info.latest_app_hash,
    };
  }

  async getBlock(height?: number): Promise<Record<string, unknown>> {
    const params = height != null ? `?height=${height}` : "";
    const res = await fetch(`${this.chainBase}/block${params}`);
    const json = await res.json();
    if (json.error)
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  async getBlockResults(height: number): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.chainBase}/block_results?height=${height}`);
    const json = await res.json();
    if (json.error)
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  // -----------------------------------------------------------------------
  // WebSocket streams (gateway-native; mirror the Python SDK)
  // -----------------------------------------------------------------------

  /**
   * Subscribe to the account-events stream (`/account-events`). Mirrors the
   * Python SDK's `AccountEventStream`: the gateway sends an initial snapshot
   * frame followed by incremental event frames. The SDK tracks the highest
   * `event_id` seen and replays from it via `after_id` on reconnect, so no
   * events are dropped across a disconnect.
   *
   * Auth: account streams require auth only when the gateway runs with
   * `--api-key`. A browser `WebSocket` cannot send the `X-Api-Key` header, so
   * the SDK uses the gateway's signed-query auth instead — when a private key
   * is loaded (`setPrivateKey`) it signs the `ProofExchange-account-events-v1`
   * message and appends `public_key` / `signature` / `timestamp_ms`. Against
   * an unauthenticated gateway (e.g. devnet) the owner alone is enough.
   *
   * Returns an unsubscribe function; `disconnect()` closes all streams.
   */
  subscribeAccountEvents(
    owner: Uint8Array | string,
    onEvent: (event: Record<string, unknown>) => void,
    opts: WsStreamOptions = {},
  ): () => void {
    const ownerHex = (
      owner instanceof Uint8Array ? bytesToHex(owner) : owner.replace(/^0x/, "")
    ).toLowerCase();
    // Tracked across reconnects for gap recovery. Signed into the auth
    // message too, so the value we send and the value we sign always match.
    let afterId = 0n;

    const buildUrl = async (): Promise<string> => {
      const params = new URLSearchParams({ owner: ownerHex });
      if (afterId > 0n) params.set("after_id", afterId.toString());
      if (this.privateKey && this.publicKey) {
        const chainId = await this.resolveChainId();
        const timestampMs = BigInt(Date.now());
        const msg = accountWsAuthMessage(
          chainId,
          ownerHex,
          afterId,
          timestampMs,
        );
        params.set("public_key", bytesToHex(this.publicKey));
        params.set("signature", bytesToHex(sign(this.privateKey, msg)));
        params.set("timestamp_ms", timestampMs.toString());
      }
      return `${this.wsUrl}/account-events?${params.toString()}`;
    };

    return this.openStream(
      buildUrl,
      (frame) => {
        const id = frame.event_id;
        if (typeof id === "number" || typeof id === "bigint") {
          const big = BigInt(id);
          if (big > afterId) afterId = big;
        }
        onEvent(frame);
      },
      opts,
    );
  }

  /**
   * Subscribe to the L2 orderbook delta stream for a market
   * (`/orderbook-deltas`). Mirrors the Python SDK's `OrderbookDeltaStream`:
   * the first frame is a full `l2Book` snapshot, then incremental deltas.
   * Returns an unsubscribe function.
   */
  subscribeOrderbookDeltas(
    market: number,
    onMessage: (msg: Record<string, unknown>) => void,
    opts: WsStreamOptions = {},
  ): () => void {
    return this.openStream(
      async () => `${this.wsUrl}/orderbook-deltas?market=${market}`,
      onMessage,
      opts,
    );
  }

  /**
   * One-shot L2 orderbook snapshot via a temporary delta-stream connection:
   * opens the stream, resolves the first `l2Book` snapshot frame, and closes.
   * Mirrors the Python SDK's `orderbook_snapshot`.
   */
  orderbookSnapshot(market: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const unsub = this.subscribeOrderbookDeltas(
        market,
        (msg) => {
          if (msg.type === "l2Book") {
            unsub();
            resolve(msg);
          }
        },
        {
          onError: (err) => {
            unsub();
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        },
      );
    });
  }

  /**
   * Internal: open one self-reconnecting WebSocket. `buildUrl` is re-invoked
   * on every (re)connect so per-connect state (fresh auth timestamp, current
   * `after_id`) is rebuilt each time. Reconnects with exponential backoff and
   * jitter. Returns an unsubscribe that stops reconnecting and closes the
   * socket.
   */
  private openStream(
    buildUrl: () => Promise<string>,
    onMessage: (msg: Record<string, unknown>) => void,
    opts: WsStreamOptions,
  ): () => void {
    const backoffCapMs = opts.reconnectBackoffMaxMs ?? 30_000;
    let closed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 500;

    const scheduleReconnect = () => {
      if (closed) return;
      const jitter = backoff * (0.75 + Math.random() * 0.5);
      timer = setTimeout(() => void connect(), jitter);
      backoff = Math.min(backoff * 2, backoffCapMs);
    };

    const connect = async (): Promise<void> => {
      if (closed) return;
      let url: string;
      try {
        url = await buildUrl();
      } catch (err) {
        opts.onError?.(err);
        scheduleReconnect();
        return;
      }
      if (closed) return;
      ws = new WebSocket(url);
      ws.onopen = () => {
        backoff = 500;
      };
      ws.onmessage = (ev) => {
        try {
          onMessage(JSON.parse(ev.data as string) as Record<string, unknown>);
        } catch (err) {
          opts.onError?.(err);
        }
      };
      ws.onerror = (err) => {
        opts.onError?.(err);
      };
      ws.onclose = () => {
        ws = null;
        if (!closed) scheduleReconnect();
      };
    };

    const unsubscribe = () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (ws) {
        ws.close();
        ws = null;
      }
      this.activeStreams.delete(unsubscribe);
    };
    this.activeStreams.add(unsubscribe);
    void connect();
    return unsubscribe;
  }

  /** Close every open WebSocket stream and stop their reconnect loops. */
  disconnect() {
    for (const unsub of [...this.activeStreams]) unsub();
  }
}

/** Options common to the WebSocket stream subscriptions. */
export interface WsStreamOptions {
  /** Called on connect/parse errors. The stream keeps reconnecting; use
   *  this for logging or to surface terminal failures. */
  onError?: (err: unknown) => void;
  /** Max reconnect backoff in milliseconds (default 30000). Backoff starts
   *  at 500ms and doubles with ±25% jitter up to this cap. */
  reconnectBackoffMaxMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the byte string the gateway expects for signed account-events stream
 * auth (`api-gateway` `account_ws_auth_message`):
 *
 *   "ProofExchange-account-events-v1" || chain_id(32B) ||
 *   owner(ascii hex) || after_id(i64 BE) || timestamp_ms(u64 BE)
 *
 * Signed with the account's Ed25519 key; the gateway re-derives the owner
 * from the public key and verifies the signature.
 */
function accountWsAuthMessage(
  chainId: Uint8Array,
  ownerHex: string,
  afterId: bigint,
  timestampMs: bigint,
): Uint8Array {
  const prefix = new TextEncoder().encode("ProofExchange-account-events-v1");
  const ownerBytes = new TextEncoder().encode(ownerHex);
  const msg = new Uint8Array(prefix.length + 32 + ownerBytes.length + 16);
  let o = 0;
  msg.set(prefix, o);
  o += prefix.length;
  msg.set(chainId, o);
  o += 32;
  msg.set(ownerBytes, o);
  o += ownerBytes.length;
  const dv = new DataView(msg.buffer);
  dv.setBigInt64(o, afterId, false);
  o += 8;
  dv.setBigUint64(o, timestampMs, false);
  return msg;
}

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
 * POST a structured `/info` request to the gateway and throw on non-2xx or
 * `json.error`. The gateway proxies the node's response body verbatim, so
 * the returned shape matches the equivalent direct-node GET (e.g.
 * `{ data: <base64-msgpack> }`). Used for owner-scoped reads the gateway
 * does not expose as GETs (account, open orders, withdrawal).
 */
async function postInfoJson(
  gatewayUrl: string,
  info: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${gatewayUrl}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(info),
  });
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

/** Coerce a decoded owner/destination field to bytes. serde encodes `[u8; N]`
 *  as a msgpack ARRAY (not BIN), so the decoder may hand back `number[]`; some
 *  encoders use BIN (`Uint8Array`). Accept both; null/undefined → empty. */
function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array();
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

/**
 * Derive a direct-node URL from the gateway URL by remapping the
 * conventional local gateway port (9080) to a node port. Used only as a
 * fallback for the internal `useGateway: false` path when an explicit
 * `rpcUrl` / `apiUrl` is not supplied.
 *
 * When the gateway has no port (a hosted gateway on 80/443) the node is
 * assumed to sit behind the same host, so the URL is returned unchanged
 * minus any path/query/hash. Callers whose node ports differ from the
 * 26657/8080 convention must pass the URL explicitly.
 */
function deriveNodeUrl(gatewayUrl: string, fallbackPort: string): string {
  try {
    const url = new URL(gatewayUrl);
    if (url.port === "9080") {
      url.port = fallbackPort;
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return stripTrailingSlash(url.toString());
  } catch {
    return `http://localhost:${fallbackPort}`;
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
    maxOpenInterest: optBig(raw[24]),
  };
}
