import type { Action } from "./types.js";

/**
 * Pluggable HTTP transport for `ExchangeClient` (#220).
 *
 * The SDK does not implement admission, pacing, retry or deadline policy for
 * its HTTP requests. A process that needs one, such as a market maker that
 * runs every request through shared priority lanes, passes an
 * `ExchangeHttpTransport` and receives each request with a context saying
 * what the client is doing. The transport owns the whole request; the SDK
 * never holds anything across the sleeps between confirmation polls.
 *
 * The default transport is `globalThis.fetch`, so a client built without one
 * behaves exactly as before.
 */

/** How urgently a request should be admitted. Cancels are `urgent`. */
export type ExchangeHttpPriority = "urgent" | "critical" | "background";

/** What a request is for. */
export type ExchangeHttpPurpose =
  "chain_id" | "submit" | "confirmation" | "account" | "query";

export interface ExchangeHttpRequestContext {
  purpose: ExchangeHttpPurpose;
  priority: ExchangeHttpPriority;
  /** Stable endpoint label for per-request telemetry, e.g. `api_orderbook`. */
  surface: string;
  /**
   * The originating action, for a submission and its confirmation polls, so
   * a transport can keep safety priority without decoding signed bytes.
   */
  action?: Action;
}

export type ExchangeHttpTransport = (
  input: string,
  init: RequestInit | undefined,
  context: ExchangeHttpRequestContext,
) => Promise<Response>;

/** `globalThis.fetch`, called with exactly the arguments the request has. */
export const defaultExchangeHttpTransport: ExchangeHttpTransport = (
  input,
  init,
) =>
  init === undefined ? globalThis.fetch(input) : globalThis.fetch(input, init);

/** Cancellation traffic and its confirmation are safety-urgent. */
export function exchangeHttpPriorityForAction(
  action: Action,
): ExchangeHttpPriority {
  return action.type === "CancelOrder" ||
    action.type === "CancelClientOrder" ||
    action.type === "CancelAllOrders"
    ? "urgent"
    : "critical";
}

/**
 * Context for a read. Owner-scoped reads (account, open orders, owner
 * history) are `urgent`: a maker reconciles its exposure from them. Other
 * reads are `critical`.
 */
export function readContext(
  url: string,
  purpose: "account" | "query",
): ExchangeHttpRequestContext {
  return {
    purpose,
    priority: purpose === "account" ? "urgent" : "critical",
    surface: surfaceFor(url),
  };
}

/**
 * Context for a `reads()` request, which carries no method-level context of
 * its own. A read is owner-scoped, and so `urgent`, when its `/info` body
 * names a `user` or its query string names a `user` or `owner`. An `/info`
 * read is labelled by its type (`api_info_openOrders`), as the typed reads
 * are.
 */
export function gatewayReadContext(
  url: string,
  init: RequestInit | undefined,
): ExchangeHttpRequestContext {
  let infoType: string | undefined;
  let owned = false;
  if (typeof init?.body === "string") {
    try {
      const body: unknown = JSON.parse(init.body);
      if (body !== null && typeof body === "object") {
        const fields = body as Record<string, unknown>;
        if (typeof fields.type === "string") infoType = fields.type;
        owned = typeof fields.user === "string";
      }
    } catch {
      /* not a JSON body: classified by its URL alone */
    }
  }
  const query = url.includes("?")
    ? new URLSearchParams(url.slice(url.indexOf("?") + 1))
    : undefined;
  if (query?.has("user") || query?.has("owner")) owned = true;
  const context = readContext(url, owned ? "account" : "query");
  return infoType === undefined
    ? context
    : { ...context, surface: `api_info_${infoType}` };
}

const ID_SEGMENT = /^(0x)?[0-9a-fA-F]{40}$|^(0x)?[0-9a-fA-F]{64}$|^\d+$/;

/**
 * A stable label for a request URL: `api_` plus the path below `/v1/`, with
 * owner, hash and numeric id segments dropped, so `/v1/orderbook/7` and
 * `/v1/orderbook/9` share `api_orderbook`. A path outside `/v1/` is labelled
 * by its own segments (`/info` becomes `api_info`).
 */
export function surfaceFor(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split("?")[0] ?? url;
  }
  const segments = path
    .split("/")
    .filter((s) => s !== "" && s !== "v1" && !ID_SEGMENT.test(s))
    .map((s) => s.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase());
  return `api_${segments.join("_") || "root"}`;
}
