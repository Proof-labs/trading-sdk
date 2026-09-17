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
export function portfolioHistorySearchParams(
  opts: PortfolioHistoryOptions,
): URLSearchParams {
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
  return params;
}

/** Validate one oldest-first page without changing units, cursors or provenance. */
export function decodePortfolioHistoryPage(
  value: unknown,
  owner: string,
  opts: PortfolioHistoryOptions,
): PortfolioHistoryPage {
  const json = value as {
    owner?: unknown;
    points?: unknown;
    next_cursor?: unknown;
  } | null;
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
