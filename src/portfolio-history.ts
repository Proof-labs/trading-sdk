import { GatewayHttpError } from "./gateway-reads.js";

export interface PortfolioHistoryOptions {
  /** Millisecond bounds must stay fixed across pages. */
  fromMs: number;
  toMs: number;
  limit?: number;
  /** Opaque indexer cursor; never decoded or numerically coerced. */
  cursor?: string;
  signal?: AbortSignal;
}
export interface PortfolioHistoryPage {
  points: { t: string; accountValue: bigint; equitySource: string | null }[];
  nextCursor: string;
}
export async function fetchPortfolioHistory(
  base: string,
  owner: string,
  opts: PortfolioHistoryOptions,
): Promise<PortfolioHistoryPage> {
  if (!/^(?:0x)?[a-fA-F0-9]{40}$/.test(owner))
    throw new Error("Invalid portfolio owner");
  if (
    !Number.isSafeInteger(opts.fromMs) ||
    !Number.isSafeInteger(opts.toMs) ||
    opts.fromMs < 0 ||
    opts.toMs <= opts.fromMs
  )
    throw new Error("Invalid portfolio history range");
  const limit = opts.limit ?? 5000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
    throw new Error("Invalid portfolio history limit");
  opts.signal?.throwIfAborted();
  const params = new URLSearchParams({
    from: String(opts.fromMs),
    to: String(opts.toMs),
    limit: String(limit),
  });
  if (opts.cursor) params.set("cursor", opts.cursor);
  const res = await fetch(
    `${base}/v1/history/portfolio/${encodeURIComponent(owner)}?${params}`,
    { signal: opts.signal },
  );
  if (!res.ok) throw new GatewayHttpError(res.status, res);
  const json = await res.json();
  opts.signal?.throwIfAborted();
  if (
    !json ||
    !Array.isArray(json.points) ||
    typeof json.next_cursor !== "string"
  )
    throw new Error("Invalid portfolio history page");
  if (json.owner !== owner) throw new Error("Portfolio history owner mismatch");
  let previous = -Infinity;
  const points = json.points.map(
    (p: {
      t: string;
      account_value: number;
      equity_source?: string | null;
    }) => {
      const t = p && typeof p.t === "string" ? Date.parse(p.t) : NaN;
      if (
        !Number.isFinite(t) ||
        t < opts.fromMs ||
        t >= opts.toMs ||
        t < previous ||
        !Number.isSafeInteger(p.account_value) ||
        (p.equity_source != null && typeof p.equity_source !== "string")
      )
        throw new Error("Invalid portfolio history point");
      previous = t;
      // account_value is micro-USDC. Keep provenance, including unknown strings.
      return {
        t: p.t,
        accountValue: BigInt(p.account_value),
        equitySource: p.equity_source ?? null,
      };
    },
  );
  return { points, nextCursor: json.next_cursor };
}
