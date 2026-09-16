import { GatewayHttpError } from "./errors.js";

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
    if (!res.ok) throw new GatewayHttpError(res.status, res);
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
  impactMarkets(opts: GatewayReadOptions = {}) {
    return this.info("impactMarkets", {}, opts);
  }
  impactMarket(id: number, opts: GatewayReadOptions = {}) {
    return this.info("impactMarket", { id }, opts);
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
    params: OwnerHistoryParams & { impact_market_id?: number },
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
  candles(params: CandleHistoryParams, opts: GatewayReadOptions = {}) {
    return this.get("/v1/history/candles", params, opts);
  }
  accountEvents(params: AccountEventsParams, opts: GatewayReadOptions = {}) {
    return this.get("/v1/history/account-events", params, opts);
  }
}
