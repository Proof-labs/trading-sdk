import {
  GatewayFeed,
  type GatewayFeedOptions,
  type AccountFeedAuth,
} from "./feed.js";
import type { AccountFrame, OrderbookFrame, TradeFrame } from "./feed-types.js";
import {
  portfolioHistorySearchParams,
  decodePortfolioHistoryPage,
  type PortfolioHistoryOptions,
  type PortfolioHistoryPage,
} from "./portfolio-history.js";
import {
  queryOraclePriceHistoryPage,
  type OraclePriceHistoryOptions,
  type OraclePriceHistoryPage,
} from "./oracle-price-history.js";
import { GatewayReads, type GatewayFetch } from "./gateway-reads.js";
import { GatewayHttpError } from "./errors.js";
import {
  decodeCashFlowEvents,
  decodeHistoryPositionsPage,
  historyOwner,
  historySearchParams,
} from "./history.js";
import { toWasmFields } from "./codec-adapter.js";
import { signAndEncode, encodePayloadBytes, encodeSignedTx } from "./codec.js";
import { decodeAccountState, type AccountState } from "./account-state.js";
import {
  fetchFinancialState,
  type FinancialState,
  type FinancialStateSelection,
} from "./financial-state.js";
import { ready as initWasm } from "./wasm-loader.js";
import {
  txEngineError,
  txFromEngineCode,
  txFromQueryResponse,
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
  verify,
  signingMessage,
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
  HistoryFillsPage,
  HistoryPositionSnapshot,
  HistoryPositionsPage,
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
  AdminSignerRegistry,
  ProposalPage,
  EventInfo,
  SetPositionTriggers,
  PositionTriggerInfo,
  TriggerStatus,
  PositionTriggerHistoryFilters,
  PositionTriggerHistoryPage,
  TriggerMarketHistoryFilters,
  TriggerMarketHistoryPage,
  TriggerMarketConfigInfo,
} from "./types.js";
import {
  decodeAdminSignerRegistryInfo,
  decodeEventInfo,
  decodeProposalPage,
} from "./governance-query.js";
import { Decoder } from "@msgpack/msgpack";
import { readMarketsSnapshot } from "./market-snapshot.js";
import type { MarketsSnapshot } from "./types.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  decodePositionTriggerInfos,
  decodeTriggerMarketConfigInfos,
  decodeTriggerStatusJson,
  validateCancelPositionTriggers,
  validateOrderTriggers,
  validateSetPositionTriggers,
} from "./triggers.js";
import {
  decodePositionTriggerHistoryPage,
  decodeTriggerMarketHistoryPage,
  positionTriggerHistorySearchParams,
  triggerMarketHistorySearchParams,
  validateTriggerHistoryMarket,
} from "./trigger-history.js";

const msgpackDecoder = new Decoder({ useBigInt64: true });
import {
  decodeOraclePermissions,
  validateOraclePermissionMarket,
  type OraclePermissions,
} from "./oracle-permissions.js";

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

/** Vendor-neutral Ed25519 signer. The SDK owns domain, encoding and nonces. */
export interface ExternalSigner {
  publicKey: Uint8Array;
  signRaw(message: Uint8Array): Promise<Uint8Array>;
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
  /** Inventory reconciliation requires the caller's pin, not auto-discovery. */
  private readonly inventoryChainId: Uint8Array | null;
  private allowUnbound: boolean;
  /** Single-flight guard so concurrent submits share one /status fetch. */
  private chainIdPromise: Promise<Uint8Array> | null = null;
  private privateKey: Uint8Array | null = null;
  private externalSigner: ExternalSigner | null = null;
  private signerRevision = 0;
  private gatewayFeed: GatewayFeed | null = null;
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
    this.inventoryChainId = this.chainId?.slice() ?? null;
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
    this.externalSigner = null;
    this.signerRevision++;
    this.privateKey = key;
    this.publicKey = getPublicKey(key);
    this.address = pubkeyToOwner(this.publicKey);
    this.addressHex = ownerToHex(this.address);
  }

  /** Replace the signing connection; no private key is retained. */
  setExternalSigner(signer: ExternalSigner): void {
    if (signer.publicKey.length !== 32)
      throw new Error("External signer public key must be 32 bytes");
    this.signerRevision++;
    this.privateKey = null;
    this.externalSigner = {
      publicKey: signer.publicKey.slice(),
      signRaw: signer.signRaw.bind(signer),
    };
    this.publicKey = this.externalSigner.publicKey.slice();
    this.address = pubkeyToOwner(this.publicKey);
    this.addressHex = ownerToHex(this.address);
  }

  /** Sign only. Cancellation or a replaced connection prevents submission. */
  async signTx(
    action: Action,
    opts: { signal?: AbortSignal } = {},
  ): Promise<Uint8Array> {
    opts.signal?.throwIfAborted();
    const signer = this.externalSigner;
    const key = this.privateKey?.slice();
    const revision = this.signerRevision;
    if (!signer && !key) throw new Error("No signer set");
    // Freeze caller-owned inputs before any await (wallet prompts may be long).
    const snapshot = cloneSigningInput(action);
    const [chainId] = await Promise.all([this.resolveChainId(), initWasm()]);
    opts.signal?.throwIfAborted();
    if (revision !== this.signerRevision)
      throw new Error("Signing connection changed");
    const seq = this.nextTimestampNonce();
    if (!signer) return signAndEncode(chainId, snapshot, seq, key!);
    const payload = encodePayloadBytes(snapshot);
    const message = signingMessage(
      chainId,
      toWasmFields(snapshot).actionType,
      seq,
      payload,
    );
    const signature = cloneSigningInput(await signer.signRaw(message.slice()));
    opts.signal?.throwIfAborted();
    if (revision !== this.signerRevision)
      throw new Error("Signing connection changed");
    if (
      !(signature instanceof Uint8Array) ||
      signature.length !== 64 ||
      !verify(signer.publicKey, signature, message)
    ) {
      throw new Error("External signer returned an invalid signature");
    }
    return encodeSignedTx(snapshot, seq, signer.publicKey, signature);
  }

  /** Sign existing gateway account-events auth bytes; call again per reconnect.
   * Direct owner keys only; no delegated-owner authorization is inferred.
   */
  async accountAuth(
    owner = this.addressHex ?? "",
    afterId = 0n,
  ): Promise<AccountFeedAuth> {
    const ownerHex = owner.replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(ownerHex) || ownerHex !== this.addressHex)
      throw new Error("Account auth owner does not match signer");
    if (afterId < 0n || afterId > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Invalid account auth cursor");
    const signer = this.externalSigner;
    const key = this.privateKey?.slice();
    const publicKey = this.publicKey?.slice();
    const revision = this.signerRevision;
    if (!publicKey || (!signer && !key)) throw new Error("No signer set");
    const chainId = await this.resolveChainId();
    if (revision !== this.signerRevision)
      throw new Error("Signing connection changed");
    const timestampMs = BigInt(Date.now());
    const message = accountWsAuthMessage(
      chainId,
      ownerHex,
      afterId,
      timestampMs,
    );
    const signature = signer
      ? cloneSigningInput(await signer.signRaw(message.slice()))
      : sign(key!, message);
    if (revision !== this.signerRevision)
      throw new Error("Signing connection changed");
    if (
      !ArrayBuffer.isView(signature) ||
      signature.byteLength !== 64 ||
      !verify(publicKey, signature, message)
    )
      throw new Error("External signer returned an invalid signature");
    return {
      public_key: bytesToHex(publicKey),
      signature: bytesToHex(signature),
      timestamp_ms: Number(timestampMs),
      ...(afterId > 0n ? { after_id: Number(afterId) } : {}),
    };
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
   * Algorithm: `max(now_ms, last_nonce + 1)`. Refuse allocation above
   * `now_ms + 60s` without rewinding or repeating the last nonce.
   *
   * Engine window: `[block_time - 2 days, block_time + 1 day]`. All four
   * rejection modes (too old, too far future, replay, below oldest) map to
   * code 21 `InvalidNonce`. Nonces are burned on success — no rewinding.
   *
   * Concurrent calls on this client reserve distinct nonces synchronously.
   */
  private nextTimestampNonce(): bigint {
    const now = BigInt(Date.now());
    const max = now + 60_000n;
    const next =
      this.lastTimestampNonce >= now ? this.lastTimestampNonce + 1n : now;
    if (next > max)
      throw new Error("Timestamp nonce allocation exceeds clock safety window");
    this.lastTimestampNonce = next;
    return next;
  }

  /** Highest locally allocated nonce; never rewound after rejection. */
  get currentNonce(): bigint {
    return this.lastTimestampNonce;
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
    return this.broadcastSignedBytes(await this.signTx(action));
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
    let res: Response;
    let gatewayBody: Awaited<ReturnType<typeof readGatewayBody>>;
    try {
      res = await fetch(`${this.gatewayUrl}/exchange`, {
        method: "POST",
        headers,
        body,
      });
      gatewayBody = await readGatewayBody(res);
    } catch {
      // A dropped response does not prove the signed transaction was rejected.
      return txTimeout(
        txHash,
        "gateway transport interrupted; reconcile by hash",
      );
    }

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
    const refusal = preAdmissionRefusal(res.status, gatewayBody.json);
    // Gateway ExchangeResponse::err is hashless: a structured 503 proves
    // the transaction never entered the broadcaster queue.
    if (res.status === 503 && refusal !== undefined) {
      return txTransportError(503, refusal);
    }
    if (res.status >= 500) {
      return txTimeout(
        txHash,
        `gateway HTTP ${res.status}; reconcile by hash${gatewayBody.error || gatewayBody.raw ? `: ${gatewayBody.error ?? gatewayBody.raw}` : ""}`,
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

    const json = gatewayBody.json as GatewayResponseBody | undefined;

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
        info: json.info,
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
    // Hashless gateway refusals are terminal; unrecognized bodies remain unknown.
    const errMsg = json?.error ?? gatewayBody.raw ?? "unknown gateway error";
    const code = parseLeadingErrorCode(errMsg);
    if (code !== null) return txEngineError(code, { log: errMsg });
    if (res.status === 200 && refusal !== undefined) {
      return txTransportError(1, refusal);
    }
    return txTimeout(txHash, "gateway returned no verdict; reconcile by hash");
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
        const result = await this.waitForDelivery(
          txTimeout(txHash, "awaiting delivery"),
          { timeoutMs: 5_000 },
        );
        if (result.outcome !== "timeout") this.deliveryResults.push(result);
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
    return this.waitForDelivery(sync);
  }

  /** Per-submission finality. Timeout/cancellation retains the hash as unknown.
   * Never resubmits writes. Use setUnsafeFastSubmit(true) to avoid a second poller.
   */
  async waitForDelivery(
    sync: TxResult,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<TxResult> {
    if (this.isFinalResult(sync)) return sync;
    if (!sync.hash) throw new Error("submitTx returned no tx hash");
    const timeoutMs = opts.timeoutMs ?? 9_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new Error("Invalid delivery timeout");
    const deadline = Date.now() + timeoutMs;
    let pollDelay = 200;
    while (Date.now() < deadline && !opts.signal?.aborted) {
      await abortableDelay(
        Math.min(pollDelay, deadline - Date.now()),
        opts.signal,
      );
      pollDelay = Math.min(pollDelay + 100, 600);
      const remaining = deadline - Date.now();
      if (remaining <= 0 || opts.signal?.aborted) break;
      const request = readDeadline(Math.ceil(remaining), opts.signal);
      try {
        const res = await fetch(this.txStatusUrl(sync.hash), {
          signal: request.signal,
        });
        if (!res.ok) continue;
        const result = txFromQueryResponse(await res.json(), sync.hash);
        if (!opts.signal?.aborted && result) return result;
      } catch {
        /* Read failures leave the write outcome unknown. */
      } finally {
        request.dispose();
      }
    }
    return txTimeout(
      sync.hash,
      opts.signal?.aborted
        ? "delivery wait cancelled; reconcile by hash"
        : "delivery wait timed out; reconcile by hash",
    );
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
   * Optional `stopLoss`/`takeProfit` limbs attach a pre-fill bracket that
   * installs on the order's first fill (validated client-side here and in
   * the codec path; encoded as the proof-wire 2.1.0 trailing fields).
   */
  async placeOrder(params: Omit<PlaceOrder, "owner">): Promise<TxResult> {
    validateOrderTriggers(params);
    return this.submitTx({
      type: "PlaceOrder",
      data: { ...params, owner: this.requireOwner() },
    });
  }

  /**
   * Place a market order (crosses immediately) for the loaded signer.
   * Optional `stopLoss`/`takeProfit` limbs are validated like
   * {@link ExchangeClient.placeOrder}.
   */
  async marketOrder(params: Omit<MarketOrder, "owner">): Promise<TxResult> {
    validateOrderTriggers(params);
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

  /** Atomically replace a complete SL/TP bracket. When `owner` is omitted,
   * use the loaded signer; a version-active trading agent may pass the
   * delegated owner explicitly. The engine remains the authorization source. */
  async setPositionTriggers(
    params: Omit<SetPositionTriggers, "owner"> & { owner?: Uint8Array },
  ): Promise<TxResult> {
    const data: SetPositionTriggers = {
      ...params,
      owner: params.owner ?? this.requireOwner(),
    };
    validateSetPositionTriggers(data);
    return this.submitTx({ type: "SetPositionTriggers", data });
  }

  /** Cancel the loaded signer's bracket for one exact position generation. */
  async cancelPositionTriggers(
    market: number,
    expectedPositionEpoch: bigint,
    owner?: Uint8Array,
  ): Promise<TxResult> {
    const data = {
      market,
      owner: owner ?? this.requireOwner(),
      expectedPositionEpoch,
    };
    validateCancelPositionTriggers(data);
    return this.submitTx({ type: "CancelPositionTriggers", data });
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

  /** One atomic committed inventory. Requires explicit chainId; never falls
   * back to a node or synthesizes inventory from independent list reads. */
  async queryMarketsSnapshot(): Promise<MarketsSnapshot> {
    if (!this.inventoryChainId) {
      throw new Error("market snapshot requires an explicit pinned chainId");
    }
    return readMarketsSnapshot(this.gatewayUrl, this.inventoryChainId);
  }

  /** List all registered market configs. */
  async queryMarkets(): Promise<MarketConfig[]> {
    const json = await fetchApiJson(`${this.readBaseUrl}/v1/markets`);
    const bytes = fromBase64(json.data as string);
    const raw = msgpackDecoder.decode(bytes) as unknown[][];
    return raw.map((m) => decodeMarketConfig(m));
  }

  /** All events: each is two prediction-binary books (EBY/EBN) under one
   *  `EventInfo`, plus every conditional attached to it. Fail-closed like the
   *  governance reads: a missing envelope or malformed row is a refusal.
   *  Decoder pinned to the engine golden vector in governance-query.test.ts. */
  async queryEvents(): Promise<EventInfo[]> {
    const json = await fetchApiJson(`${this.readBaseUrl}/v1/events`);
    if (typeof json.data !== "string") {
      throw new Error(
        "governance decode: events response has no encoded-data envelope",
      );
    }
    const raw = msgpackDecoder.decode(fromBase64(json.data));
    if (!Array.isArray(raw)) {
      throw new Error("governance decode: events is not an array");
    }
    return raw.map((r, i) => decodeEventInfo(r, i));
  }

  /** A single event by id, or `null` if it does not exist. The node returns
   *  404 for a missing event (the engine's msgpack-nil), so a raw fetch is used
   *  here to map 404 -> null while still throwing on real transport / decode
   *  failures. */
  async queryEvent(eventId: number): Promise<EventInfo | null> {
    const res = await fetch(`${this.readBaseUrl}/v1/event/${eventId}`);
    if (res.status === 404) return null;
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok || json.error) {
      const msg = (json.error as string) ?? `HTTP ${res.status}`;
      throw new Error(`API error: ${msg}`);
    }
    if (typeof json.data !== "string") {
      throw new Error(
        "governance decode: event response has no encoded-data envelope",
      );
    }
    const raw = msgpackDecoder.decode(fromBase64(json.data));
    if (raw == null) return null;
    return decodeEventInfo(raw);
  }

  /** Current whole-position trigger brackets for one owner. Immutable
   * lifecycle history is a separate gateway/indexer query below. */
  async queryPositionTriggers(
    addressHex?: string,
  ): Promise<PositionTriggerInfo[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) throw new Error("No address available");
    if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
      throw new Error("trigger owner must be a 40-character hex address");
    }
    const path = `/v1/triggers/${hex.toLowerCase()}`;
    const json = await fetchApiJson(`${this.readBaseUrl}${path}`);
    const bytes = fromBase64(requireEncodedData(json, path));
    return decodePositionTriggerInfos(msgpackDecoder.decode(bytes));
  }

  /** Read the complete governed trigger-market policy registry. Missing
   * markets are disabled; callers must never synthesize a default policy. */
  async queryTriggerMarketConfigs(): Promise<TriggerMarketConfigInfo[]> {
    const path = "/v1/triggers/markets";
    const json = await fetchApiJson(`${this.readBaseUrl}${path}`);
    const bytes = fromBase64(requireEncodedData(json, path));
    return decodeTriggerMarketConfigInfos(msgpackDecoder.decode(bytes));
  }

  /** Read the fail-closed next-height trigger admission predicate. Heights
   * are parsed from raw JSON into bigint without a lossy Number round-trip.
   *
   * @deprecated `GET /v1/triggers/status` is deleted upstream: the node
   * dropped it with its activation gates (exchange#619, genesis-first) and
   * the gateway drops it in gateway 4.0.0 (api-gateway#175). Trigger actions
   * are permanently active, so there is nothing to read. Against a gateway or
   * node that no longer serves the route this rejects with an `API error`
   * for the 404 response. It will be removed in the next major version. */
  async queryTriggerStatus(): Promise<TriggerStatus> {
    const path = "/v1/triggers/status";
    const res = await fetch(`${this.readBaseUrl}${path}`);
    const text = await res.text();
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const body = JSON.parse(text) as { error?: unknown };
        if (typeof body.error === "string") message = body.error;
      } catch {
        // Keep the HTTP fallback for a non-JSON upstream response.
      }
      throw new Error(`API error: ${message}`);
    }
    return decodeTriggerStatusJson(text);
  }

  /** One committed oracle dependency, not provider health or action authorization. */
  async queryOraclePermissions(market: number): Promise<OraclePermissions> {
    validateOraclePermissionMarket(market);
    const path = `/v1/oracle/permissions/${market}`;
    const json = await fetchApiJson(`${this.readBaseUrl}${path}`);
    const bytes = fromBase64(requireEncodedData(json, path));
    return decodeOraclePermissions(msgpackDecoder.decode(bytes), market);
  }

  /** Immutable owner-bearing trigger lifecycle history. This always uses the
   * public gateway, including when the client is configured for direct-node
   * current-state reads; the node does not own indexer history. */
  async queryPositionTriggerHistory(
    addressHex?: string,
    filters: PositionTriggerHistoryFilters = {},
  ): Promise<PositionTriggerHistoryPage> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) throw new Error("No address available");
    if (!/^[0-9a-fA-F]{40}$/.test(hex)) {
      throw new Error(
        "trigger history owner must be a 40-character hex address",
      );
    }
    const canonicalOwner = hex.toLowerCase();
    const params = positionTriggerHistorySearchParams(filters);
    const qs = params.toString();
    const json = await fetchApiJson(
      `${this.gatewayUrl}/v1/history/triggers/${canonicalOwner}${qs ? `?${qs}` : ""}`,
    );
    return decodePositionTriggerHistoryPage(
      json,
      canonicalOwner,
      filters.market,
    );
  }

  /** Shared market-level deferred/resumed trigger transitions. These are not
   * duplicated into every owner's history and always route through gateway. */
  async queryTriggerMarketHistory(
    market: number,
    filters: TriggerMarketHistoryFilters = {},
  ): Promise<TriggerMarketHistoryPage> {
    validateTriggerHistoryMarket(market);
    const params = triggerMarketHistorySearchParams(filters);
    const qs = params.toString();
    const json = await fetchApiJson(
      `${this.gatewayUrl}/v1/history/trigger-markets/${market}${qs ? `?${qs}` : ""}`,
    );
    return decodeTriggerMarketHistoryPage(json, market);
  }

  /**
   * Read the current on-chain admin signer registry via the gateway proxy
   * (`GET /v1/admin/signer-registry`). The engine wraps the
   * registry in an `Option`, so the proxy returns MessagePack `[registry|nil]`.
   *
   * Returns `null` when no registry is seeded — which means admin multisig is
   * **inactive** (fail-closed), NOT an empty roster; callers must treat the two
   * differently.
   */
  async queryAdminSignerRegistry(): Promise<AdminSignerRegistry | null> {
    const json = await fetchApiJson(
      `${this.readBaseUrl}/v1/admin/signer-registry`,
    );
    const bytes = fromBase64(
      requireEncodedData(json, "/v1/admin/signer-registry"),
    );
    return decodeAdminSignerRegistryInfo(msgpackDecoder.decode(bytes));
  }

  /**
   * List admin governance proposals via the gateway proxy
   * (`GET /v1/proposals`). Optional `status` / `cursor` /
   * `limit` are forwarded as query params (the node clamps oversized limits).
   * The proxy returns MessagePack `[proposals, nextCursor|nil]`.
   *
   * Each proposal is decoded into a `ProposalDisplayInfo` — including the
   * canonical action bytes and content hash an approving signer needs to
   * rebuild their approval locally. Decoding fails closed: a proposal
   * carrying an operation or status this SDK build does not know throws
   * rather than being returned partially rendered.
   */
  async queryProposals(opts?: {
    status?: string;
    cursor?: bigint;
    limit?: number;
  }): Promise<ProposalPage> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.cursor != null) params.set("cursor", String(opts.cursor));
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const json = await fetchApiJson(
      `${this.readBaseUrl}/v1/proposals${qs ? `?${qs}` : ""}`,
    );
    const bytes = fromBase64(requireEncodedData(json, "/v1/proposals"));
    return decodeProposalPage(msgpackDecoder.decode(bytes));
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

  /** Raw finalized ledger facts, independent of oracle valuation. Not authorization. */
  async queryFinancialState(
    selection: FinancialStateSelection,
  ): Promise<FinancialState> {
    return fetchFinancialState(this.gatewayUrl, selection);
  }

  /** Raw finalized ledger facts, independent of oracle valuation. Not authorization. */
  async queryAccountState(addressHex?: string): Promise<AccountState> {
    const hex = addressHex ?? this.addressHex;
    if (!hex || !/^[0-9a-fA-F]{40}$/.test(hex)) {
      throw new Error("account state owner must be a 40-character hex address");
    }
    const owner = hex.toLowerCase();
    const path = `/v1/account/${owner}/state`;
    const json = await fetchApiJson(`${this.readBaseUrl}${path}`);
    return decodeAccountState(
      msgpackDecoder.decode(fromBase64(requireEncodedData(json, path))),
      owner,
    );
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
        // Optional enrichments (indices 6-13) shipped incrementally:
        //   6-11: scenario-aware brief fields, 2026-04-24 (P1 #2).
        //   12  : adlScore, 2026-04-25 (item 7 — ADL rank surface).
        //   13  : persistent position epoch (first-attach trigger input).
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
          positionEpoch: optBig(p[13]),
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
          eventId: Number(t[0]),
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

  /** Direct relayer deposits and custody-confirmed deposits, newest first.
   * Returns a bounded merged head, not a cursor over the complete history. */
  async queryHistoryDeposits(
    addressHex?: string,
    opts?: { fromMs?: number; toMs?: number; limit?: number },
  ): Promise<HistoryCashFlow[]> {
    return this.queryHistoryCashFlow("deposits", addressHex, opts);
  }

  /** Direct relayer withdrawals and indexed custody events, newest first,
   * capped after merging each kind's first page. This is not withdrawal status:
   * ownerless confirmation events
   * are not indexed for the account. Use queryWithdrawal(id) for status.
   * Request/refund amounts exclude fees; unknown signedDelta stays empty. */
  async queryHistoryWithdrawals(
    addressHex?: string,
    opts?: { fromMs?: number; toMs?: number; limit?: number },
  ): Promise<HistoryCashFlow[]> {
    return this.queryHistoryCashFlow("withdrawals", addressHex, opts);
  }

  /** Owner-filtered indexer events; never the removed node history routes. */
  private async queryHistoryCashFlow(
    path: "deposits" | "withdrawals",
    addressHex?: string,
    opts: { fromMs?: number; toMs?: number; limit?: number } = {},
  ): Promise<HistoryCashFlow[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return [];
    const owner = historyOwner(hex);
    const limit = opts.limit ?? 200;
    const params = historySearchParams({ ...opts, limit });
    params.set("owner", owner);
    params.set("order", "desc");
    const kinds: HistoryCashFlow["kind"][] =
      path === "deposits"
        ? ["deposited", "deposit_confirmed"]
        : [
            "withdrawn",
            "withdraw_requested",
            "withdrawal_confirmed",
            "withdrawal_failed",
          ];
    const pages = await Promise.all(
      kinds.map(async (kind) => {
        const query = new URLSearchParams(params);
        query.set("event_type", kind);
        const json = await fetchApiJson(
          `${this.gatewayUrl}/v1/history/account-events?${query}`,
        );
        return decodeCashFlowEvents(json, owner, kind);
      }),
    );
    return pages
      .flat()
      .sort((a, b) => {
        if (a.nanos !== b.nanos) return a.nanos > b.nanos ? -1 : 1;
        return a.eventId > b.eventId ? -1 : a.eventId < b.eventId ? 1 : 0;
      })
      .slice(0, limit)
      .map((event) => event.cashFlow);
  }

  /** Per-user position-at-resolution log — each row is one settlement or
   * voided-conditional snapshot. Feeds the Portfolio "Resolved" tab
   * (P2 #7). Optional `eventId` filter scopes to one event.
   *
   * `fromMs` / `toMs` are unix-ms timestamps; omit for unbounded.
   * `limit` caps at 1000 server-side. Results are newest-first. */
  async queryHistoryResolutions(
    addressHex?: string,
    opts?: {
      eventId?: number;
      fromMs?: number;
      toMs?: number;
      limit?: number;
    },
  ): Promise<HistoryResolution[]> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return [];
    const params = new URLSearchParams();
    if (opts?.eventId !== undefined)
      params.set("event_id", String(opts.eventId));
    if (opts?.fromMs !== undefined) params.set("from", String(opts.fromMs));
    if (opts?.toMs !== undefined) params.set("to", String(opts.toMs));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const url = `${this.readBaseUrl}/v1/history/resolutions/${hex}${qs ? `?${qs}` : ""}`;
    const json = await fetchApiArray(url);
    return (json as Array<Record<string, unknown>>).map((row) => ({
      kind: row.kind as HistoryResolution["kind"],
      eventId: String(row.event_id ?? ""),
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

  /** Named gateway responses for HTTP consumers that own body parsing, deadlines
   * and scheduling. Prefer typed query methods when raw response metadata is unnecessary.
   * Uses this client's gateway; never targets a node, even in internal node mode.
   */
  reads(opts: { fetch?: GatewayFetch } = {}): GatewayReads {
    return new GatewayReads(
      this.gatewayUrl,
      opts.fetch ?? ((url, init) => fetch(url, init)),
    );
  }

  /** Gateway/indexer portfolio page, including in internal node mode.
   * Keep bounds fixed across opaque cursors. */
  async queryPortfolioHistory(
    owner: string,
    opts: PortfolioHistoryOptions,
  ): Promise<PortfolioHistoryPage> {
    const canonicalOwner = owner.replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(canonicalOwner))
      throw new Error("Invalid portfolio owner");
    const params = portfolioHistorySearchParams(opts);
    opts.signal?.throwIfAborted();
    const res = await fetch(
      `${this.gatewayUrl}/v1/history/portfolio/${canonicalOwner}?${params}`,
      { signal: opts.signal },
    );
    if (!res.ok) throw new GatewayHttpError(res.status, res);
    const page: unknown = await res.json();
    opts.signal?.throwIfAborted();
    return decodePortfolioHistoryPage(page, canonicalOwner, opts);
  }

  /** One newest-first gateway page of a market's indexed `price_updated`
   * history. Keep market and bounds fixed across opaque cursors. */
  async queryOraclePriceHistory(
    market: number,
    options: OraclePriceHistoryOptions,
  ): Promise<OraclePriceHistoryPage> {
    return queryOraclePriceHistoryPage(this.gatewayUrl, market, options);
  }

  /** Compatibility array of position snapshots. Absent close fields are empty
   * strings and timestamps are milliseconds. Use queryHistoryPositionsPage for
   * nullable fields, exact block times and opaque cursor continuation. */
  async queryHistoryPositions(
    addressHex?: string,
    opts?: {
      market?: number;
      fromMs?: number;
      toMs?: number;
      limit?: number;
    },
  ): Promise<HistoryPositionSnapshot[]> {
    const page = await this.queryHistoryPositionsPage(addressHex, opts);
    return page.positions.map((row) => ({
      owner: row.owner,
      market: String(row.market),
      side: row.side ?? "",
      entryPrice: row.entryPrice ?? "",
      size: row.size,
      blockHeight: row.blockHeight,
      timestamp: Date.parse(row.blockTime),
    }));
  }

  /** Gateway/indexer snapshots, newest first. Preserve filters when passing an
   * opaque nextCursor back in opts.cursor. Null close fields stay null. */
  async queryHistoryPositionsPage(
    addressHex?: string,
    opts: {
      market?: number;
      fromMs?: number;
      toMs?: number;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<HistoryPositionsPage> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return { positions: [], nextCursor: "" };
    const owner = historyOwner(hex);
    const params = historySearchParams(opts);
    if (opts.market !== undefined) {
      if (
        !Number.isInteger(opts.market) ||
        opts.market < 0 ||
        opts.market > 0x7fffffff
      )
        throw new Error("Invalid history market");
      params.set("market", String(opts.market));
    }
    const query = params.toString();
    const json = await fetchApiJson(
      `${this.gatewayUrl}/v1/history/positions/${owner}${query ? `?${query}` : ""}`,
    );
    return decodeHistoryPositionsPage(json, owner, opts.market);
  }

  /**
   * Executed fills for an owner, newest first, keyset-paged. The endpoint
   * returns an envelope rather than a bare array: pass `opts.cursor` from a
   * previous page's `nextCursor` to continue; an empty `nextCursor` is the
   * last page. `fromMs` is inclusive, `toMs` exclusive (the API's uniform
   * half-open window), both epoch milliseconds. Omitting `addressHex` with
   * no bound key yields an empty page, matching the other history queries.
   */
  async queryHistoryFills(
    addressHex?: string,
    opts?: {
      market?: number;
      fromMs?: number;
      toMs?: number;
      limit?: number;
      cursor?: string;
    },
  ): Promise<HistoryFillsPage> {
    const hex = addressHex ?? this.addressHex;
    if (!hex) return { fills: [], nextCursor: "" };
    const params = new URLSearchParams();
    if (opts?.market !== undefined) params.set("market", String(opts.market));
    if (opts?.fromMs !== undefined) params.set("from", String(opts.fromMs));
    if (opts?.toMs !== undefined) params.set("to", String(opts.toMs));
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined && opts.cursor !== "") {
      params.set("cursor", opts.cursor);
    }
    const qs = params.toString();
    const url = `${this.readBaseUrl}/v1/history/fills/${hex}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url);
    const json = (await res.json()) as unknown;
    const body = (json ?? {}) as Record<string, unknown>;
    if (!res.ok || "error" in body) {
      const msg = (body.error as string) ?? `HTTP ${res.status}`;
      throw new Error(`API error: ${msg}`);
    }
    const rows = Array.isArray(body.fills)
      ? (body.fills as Array<Record<string, unknown>>)
      : [];
    return {
      fills: rows.map((row) => ({
        fillId: String(row.fill_id ?? "0"),
        market: Number(row.market ?? 0),
        blockHeight: Number(row.block_height ?? 0),
        blockTime: String(row.block_time ?? ""),
        price: String(row.price ?? "0"),
        quantity: String(row.quantity ?? "0"),
        makerOwner: String(row.maker_owner ?? ""),
        takerOwner: String(row.taker_owner ?? ""),
        makerSide: String(row.maker_side ?? ""),
        takerFee: Number(row.taker_fee ?? 0),
        makerFee: Number(row.maker_fee ?? 0),
      })),
      nextCursor: String(body.next_cursor ?? ""),
    };
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
   * the SDK uses the gateway's signed-query auth instead — when a private key or external signer
   * is connected it signs the `ProofExchange-account-events-v1`
   * message and appends `public_key` / `signature` / `timestamp_ms`. Against
   * an unauthenticated gateway (e.g. devnet) the owner alone is enough.
   *
   * Returns an unsubscribe function; `disconnect()` closes all streams.
   */
  subscribeAccountEvents(
    owner: Uint8Array | string,
    onEvent: (event: Record<string, unknown>) => void,
    opts: WsStreamOptions & { auth?: false } = {},
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
      if (opts.auth !== false && (this.privateKey || this.externalSigner)) {
        const auth = await this.accountAuth(ownerHex, afterId);
        for (const [key, value] of Object.entries(auth))
          params.set(key, String(value));
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

  /** Shared multiplexed /ws feed. Options apply on first creation only.
   * Reconnect restores snapshots, not missed events. Default auth reads the current signer.
   */
  feed(opts: Partial<GatewayFeedOptions> = {}): GatewayFeed {
    if (!this.gatewayFeed) {
      let base = this.wsUrl;
      if (!base && typeof globalThis.location !== "undefined")
        base = globalThis.location.origin.replace(/^http/, "ws");
      this.gatewayFeed = new GatewayFeed({
        url: `${base}/ws`,
        accountAuth: async (owner) =>
          this.privateKey || this.externalSigner ? this.accountAuth(owner) : {},
        headers: this.apiKey ? { "X-Api-Key": this.apiKey } : undefined,
        ...opts,
      });
    }
    return this.gatewayFeed;
  }

  /** Account snapshot plus live stream, with auth renewed per reconnect. */
  subscribeAccount(
    onFrame: (frame: AccountFrame) => void,
    opts: { owner?: string; auth?: false } = {},
  ): () => void {
    const owner = opts.owner ?? this.addressHex;
    if (!owner) throw new Error("No account owner available");
    return this.feed().subscribeAccount(owner, onFrame, async (address) =>
      opts.auth !== false && (this.privateKey || this.externalSigner)
        ? this.accountAuth(address)
        : {},
    );
  }

  subscribeOrderbook(
    market: number,
    onFrame: (frame: OrderbookFrame) => void,
  ): () => void {
    return this.feed().subscribeOrderbook(market, onFrame);
  }

  subscribeTrades(
    market: number,
    onFrame: (frame: TradeFrame) => void,
  ): () => void {
    return this.feed().subscribeTrades(market, onFrame);
  }

  /** Close every open WebSocket stream and stop their reconnect loops. */
  disconnect() {
    this.gatewayFeed?.close();
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
 * Governance reads carry a MessagePack envelope in `data`. A successful HTTP
 * response without that envelope is malformed, not an inactive registry or
 * an empty proposal page.
 */
function requireEncodedData(
  json: Record<string, unknown>,
  endpoint: string,
): string {
  if (typeof json.data !== "string" || json.data.length === 0) {
    throw new Error(`API error: ${endpoint} response is missing encoded data`);
  }
  return json.data;
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
  // The error keeps an unread copy, so callers can still read the body.
  const unread = res.clone();
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (error) {
    if (!res.ok) throw new GatewayHttpError(res.status, unread);
    throw error;
  }
  // A JSON `null` or scalar body has no fields; it must not hide the status.
  const json: Record<string, unknown> =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  if (!res.ok || json.error) {
    const errorCode =
      typeof json.errorCode === "string" ? json.errorCode : undefined;
    const detail = typeof json.error === "string" ? json.error : undefined;
    throw new GatewayHttpError(res.status, unread, errorCode, detail);
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

/** Shape of a gateway `/exchange` JSON response body — the same envelope
 * both the engine-result decode below and `preAdmissionRefusal` read, kept
 * as one declaration so a new field is visible to both. */
interface GatewayResponseBody {
  status?: string;
  error?: string;
  txHash?: string;
  code?: number;
  log?: string;
  info?: string;
  height?: number;
  events?: TxEvent[];
  mode?: string;
  retryAfterMs?: number;
}

/** Only a fixed, known set of (HTTP status, message) pairs is hashless proof
 * of a pre-admission refusal — mirrors
 * `crates/proof-trading-sdk/src/gateway/mod.rs::pre_admission_refusal`
 * exactly for the statuses reached here (200, 503). ExchangeResponse::err
 * omits admission/verdict and rate-limit fields, but the shape alone is not
 * enough: an unrecognized message in that same shape can come from a generic
 * failure (an intermediary, a proxy) rather than the gateway's own refusal
 * path, and contradictory or unknown evidence must not become a terminal
 * refusal for a transaction that may have executed. */
const PRE_ADMISSION_REFUSAL_FIELDS = new Set([
  "status",
  "error",
  "mode",
  "retryAfterMs",
]);

function preAdmissionRefusal(
  status: number,
  value: unknown,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const body = value as GatewayResponseBody;
  // Mirrors `RefusalRead`'s `#[serde(deny_unknown_fields)]`: any field
  // outside this exact set — including ones this SDK doesn't know about
  // yet — makes the body unrecognized, not refusal evidence.
  if (
    body.status !== "error" ||
    typeof body.error !== "string" ||
    Object.keys(body).some((key) => !PRE_ADMISSION_REFUSAL_FIELDS.has(key))
  )
    return undefined;

  if (
    status === 503 &&
    body.error === "maintenance: signed writes are not open"
  ) {
    if (body.retryAfterMs !== undefined) return undefined;
    return body.mode === "paused" || body.mode === "cancel-only"
      ? body.error
      : undefined;
  }
  if (body.mode !== undefined || body.retryAfterMs !== undefined)
    return undefined;

  if (
    status === 503 &&
    (body.error === "service overloaded" ||
      body.error === "service unavailable")
  )
    return body.error;
  if (
    status === 200 &&
    (body.error === "invalid request body" ||
      body.error === "invalid action parameters" ||
      body.error === "invalid base64 in action field" ||
      body.error === "invalid signature" ||
      body.error === "internal encoding error" ||
      body.error ===
        "action type 0x1d is proposer-only and cannot enter through the gateway")
  )
    return body.error;
  return undefined;
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

/** Copy protocol inputs without structuredClone or cross-realm instanceof checks. */
function cloneSigningInput<T>(value: T): T {
  if (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  ) {
    const bytes = value as unknown as Uint8Array;
    return new Uint8Array(bytes) as T;
  }
  if (Array.isArray(value)) return value.map(cloneSigningInput) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, cloneSigningInput(v)]),
    ) as T;
  }
  return value;
}

/** Abort interrupts the sleep; callers inspect the signal for their own result policy. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Per-read deadline with explicit cleanup, without AbortSignal.any/timeout. */
function readDeadline(
  ms: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}
