import { GatewayHttpError } from "./errors.js";
import type { MarketKind } from "./types.js";

/** Named gateway reads for consumers that retain their own decoders and caches.
 * Responses are unmodified, including msgpack envelopes and pagination keys.
 * Inject fetch to retain application deadlines, scheduling and error policy.
 */
export interface GatewayReadOptions {
  signal?: AbortSignal;
}
export type GatewayFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;
export interface HistoryWindow {
  from?: number;
  to?: number;
  limit?: number;
}
export interface OwnerHistoryParams extends HistoryWindow {
  user: string;
}
export interface CandleHistoryParams {
  market: number;
  resolution: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}
export interface AccountEventsParams {
  owner: string;
  order: "asc" | "desc";
  event_type?: string;
  limit?: number;
  cursor?: string;
  from?: string;
  to?: string;
}

// ---------------------------------------------------------------------------
// F2 trigger-expansion read shapes (contract §7-G)
// ---------------------------------------------------------------------------

/** One SL/TP limb as gateway JSON emits it (snake_case wire fields,
 *  micro-USDC integers). Mirrors the SDK's camelCase `TriggerLimb`. */
export interface GatewayTriggerLimbJson {
  trigger_price: number;
  max_slippage_bps: number;
  client_trigger_id: number | null;
}

/**
 * One pending (pre-fill) trigger row from the additive `pending` section
 * of `GET /v1/triggers/{owner}` (contract §7-G). The row exists only while
 * its bound order is live and unfilled: the order's first fill promotes it
 * into a real bracket (it disappears from `pending`), and any terminal
 * order state discards it. `client_order_id` is null when the order
 * carried no client id.
 */
export interface GatewayPendingTriggerRow {
  market: number;
  order_id: number;
  client_order_id: number | null;
  side: "Buy" | "Sell";
  stop_loss?: GatewayTriggerLimbJson | null;
  take_profit?: GatewayTriggerLimbJson | null;
  accepted_height: number;
}

/**
 * F2 addition to the owner trigger read's position rows: `market_kind`
 * tells clients which market family a bracket protects, so binary-market
 * trigger levels can be rendered in dollars at display time
 * (µUSDC / 1_000_000) without transforming signed values. Absent on
 * pre-2.1.0 gateways — treat presence as a capability probe, never
 * require it.
 */
export interface GatewayTriggerPositionRow {
  market_kind?: MarketKind;
}
export class GatewayReads {
  constructor(
    private readonly base: string,
    private readonly transport: GatewayFetch,
  ) {}
  private async request(
    path: string,
    init: RequestInit,
    opts: GatewayReadOptions,
  ): Promise<Response> {
    opts.signal?.throwIfAborted();
    const res = await this.transport(`${this.base}${path}`, {
      ...init,
      signal: opts.signal,
    });
    if (!res.ok) {
      let errorCode: string | undefined;
      try {
        const body = await res.clone().json();
        if (typeof body?.errorCode === "string") errorCode = body.errorCode;
      } catch {
        /* non-JSON error body — leave errorCode undefined */
      }
      throw new GatewayHttpError(res.status, res, errorCode);
    }
    return res;
  }
  private info(
    type: string,
    params: object,
    opts: GatewayReadOptions,
  ): Promise<Response> {
    return this.request(
      "/info",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...params, type }),
      },
      opts,
    );
  }
  private get(
    path: string,
    params: object,
    opts: GatewayReadOptions,
  ): Promise<Response> {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value != null) qs.set(key, String(value));
    return this.request(
      `${path}${qs.toString() ? `?${qs}` : ""}`,
      { method: "GET" },
      opts,
    );
  }
  meta(opts: GatewayReadOptions = {}) {
    return this.info("meta", {}, opts);
  }
  /** Every event with its binaries and attached conditionals (the node's
   * default page; the gateway proxies `GET /v1/events`). */
  events(opts: GatewayReadOptions = {}) {
    return this.info("events", {}, opts);
  }
  /** One event by id; the gateway passes the node's 404 through. */
  event(id: number, opts: GatewayReadOptions = {}) {
    return this.info("event", { id }, opts);
  }
  l2Book(market: number, opts: GatewayReadOptions = {}) {
    return this.info("l2Book", { market }, opts);
  }
  fundingRate(market: number, opts: GatewayReadOptions = {}) {
    return this.info("fundingRate", { market }, opts);
  }
  clearinghouseState(user: string, opts: GatewayReadOptions = {}) {
    return this.info("clearinghouseState", { user }, opts);
  }
  openOrders(
    user: string,
    opts: GatewayReadOptions & { market?: number; limit?: number } = {},
  ) {
    return this.info(
      "openOrders",
      { user, market: opts.market, limit: opts.limit },
      opts,
    );
  }
  historyOrders(params: OwnerHistoryParams, opts: GatewayReadOptions = {}) {
    return this.info("historyOrders", params, opts);
  }
  historyFills(params: OwnerHistoryParams, opts: GatewayReadOptions = {}) {
    return this.info("historyFills", params, opts);
  }
  historyTrades(
    params: HistoryWindow & { market: number },
    opts: GatewayReadOptions = {},
  ) {
    return this.info("historyTrades", params, opts);
  }
  historyPositions(
    params: OwnerHistoryParams & { market?: number },
    opts: GatewayReadOptions = {},
  ) {
    return this.info("historyPositions", params, opts);
  }
  historyResolutions(
    params: OwnerHistoryParams & { event_id?: number },
    opts: GatewayReadOptions = {},
  ) {
    return this.info("historyResolutions", params, opts);
  }
  ticker(market: number, opts: GatewayReadOptions = {}) {
    return this.get(`/v1/ticker/${market}`, {}, opts);
  }
  health(opts: GatewayReadOptions = {}) {
    return this.get("/v1/health", {}, opts);
  }
  /** Operational freshness for trading UI guards; not trading authorization.
   * Preserve unavailable-feeder responses; thresholds belong to the caller.
   */
  oracleHealth(opts: GatewayReadOptions = {}) {
    return this.get("/v1/oracle/health", {}, opts);
  }
  candles(params: CandleHistoryParams, opts: GatewayReadOptions = {}) {
    return this.get("/v1/history/candles", params, opts);
  }
  accountEvents(params: AccountEventsParams, opts: GatewayReadOptions = {}) {
    return this.get("/v1/history/account-events", params, opts);
  }
}
