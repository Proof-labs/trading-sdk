import type { HistoryCashFlow, HistoryPositionsPage } from "./types.js";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid history record");
  return value as Record<string, unknown>;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`Invalid history ${field}`);
  return value as number;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid history ${field}`);
  return value;
}

function decimal(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^\d+$/.test(result)) throw new Error(`Invalid history ${field}`);
  return result;
}

function time(value: unknown): { timestamp: number; nanos: bigint } {
  const raw = text(value, "block_time");
  const match = raw.match(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?Z$/,
  );
  const timestamp = Date.parse(raw);
  if (!match || !Number.isFinite(timestamp))
    throw new Error("Invalid history block_time");
  return {
    timestamp,
    nanos:
      BigInt(timestamp) * 1_000_000n +
      BigInt((match[1] ?? "").padEnd(9, "0").slice(3)),
  };
}

export function historyOwner(value: string): string {
  const owner = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(owner)) throw new Error("Invalid history owner");
  return owner;
}

export function historySearchParams(opts: {
  fromMs?: number;
  toMs?: number;
  limit?: number;
  cursor?: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ["fromMs", "toMs"] as const) {
    if (opts[key] !== undefined)
      params.set(
        key === "fromMs" ? "from" : "to",
        String(integer(opts[key], key)),
      );
  }
  if (
    opts.fromMs !== undefined &&
    opts.toMs !== undefined &&
    opts.fromMs >= opts.toMs
  )
    throw new Error("Invalid history range");
  if (opts.limit !== undefined) {
    const limit = integer(opts.limit, "limit");
    if (limit < 1 || limit > 5000) throw new Error("Invalid history limit");
    params.set("limit", String(limit));
  }
  if (opts.cursor !== undefined)
    params.set("cursor", text(opts.cursor, "cursor"));
  return params;
}

/** Current indexer page. Closed positions have no side or entry price. */
export function decodeHistoryPositionsPage(
  value: unknown,
  owner: string,
  market?: number,
): HistoryPositionsPage {
  const page = object(value);
  if (!Array.isArray(page.positions) || typeof page.next_cursor !== "string")
    throw new Error("Invalid position history page");
  return {
    positions: page.positions.map((value) => {
      const row = object(value);
      if (
        row.owner !== owner ||
        (market !== undefined && row.market !== market)
      )
        throw new Error("Position history scope mismatch");
      const blockTime = text(row.block_time, "block_time");
      time(blockTime);
      const side = row.side === null ? null : text(row.side, "side");
      if (side !== null && !["buy", "sell", "Buy", "Sell"].includes(side))
        throw new Error("Invalid history side");
      const size = decimal(row.size, "size");
      const entryPrice =
        row.entry_px === null ? null : text(row.entry_px, "entry_px");
      if (entryPrice !== null && !/^\d+(?:\.\d+)?$/.test(entryPrice))
        throw new Error("Invalid history entry_px");
      if ((side === null || entryPrice === null) && BigInt(size) !== 0n)
        throw new Error("Incomplete open position history");
      return {
        owner,
        market: integer(row.market, "market"),
        side,
        entryPrice,
        size,
        blockHeight: integer(row.block_height, "block_height"),
        blockTime,
      };
    }),
    nextCursor: page.next_cursor,
  };
}

/** The indexer orders account events by block_time, then event_id. */
export function decodeCashFlowEvents(
  value: unknown,
  owner: string,
  kind: HistoryCashFlow["kind"],
): { eventId: bigint; nanos: bigint; cashFlow: HistoryCashFlow }[] {
  const page = object(value);
  if (
    !Array.isArray(page.account_events) ||
    typeof page.next_cursor !== "string"
  )
    throw new Error("Invalid account history page");
  return page.account_events.map((value) => {
    const row = object(value);
    const payload = object(row.payload);
    if (
      row.owner !== owner ||
      row.event_type !== kind ||
      (payload.owner !== undefined && payload.owner !== owner)
    )
      throw new Error("Account history scope mismatch");
    const eventId =
      typeof row.event_id === "string"
        ? BigInt(decimal(row.event_id, "event_id"))
        : BigInt(integer(row.event_id, "event_id"));
    const { timestamp, nanos } = time(row.block_time);
    const amount =
      kind === "withdrawal_confirmed" ? "" : decimal(payload.amount, "amount");
    return {
      eventId,
      nanos,
      cashFlow: {
        kind,
        owner,
        amount,
        // Withdrawal events omit the custody fee included in the actual
        // debit/refund. An unknown balance delta must not become +/-amount.
        signedDelta:
          kind === "deposit_confirmed" || kind === "deposited"
            ? amount
            : kind === "withdrawn"
              ? String(-BigInt(amount))
              : kind === "withdrawal_confirmed"
                ? "0"
                : "",
        newBalance:
          payload.new_balance === undefined
            ? ""
            : decimal(payload.new_balance, "new_balance"),
        withdrawalId:
          kind === "deposit_confirmed" ||
          kind === "deposited" ||
          kind === "withdrawn"
            ? ""
            : decimal(payload.withdrawal_id, "withdrawal_id"),
        solanaTxSig:
          payload.solana_tx_sig === undefined
            ? ""
            : text(payload.solana_tx_sig, "solana_tx_sig"),
        solanaDestination:
          payload.solana_destination === undefined
            ? ""
            : text(payload.solana_destination, "solana_destination"),
        reason:
          payload.reason === undefined ? "" : text(payload.reason, "reason"),
        blockHeight: integer(row.block_height, "block_height"),
        timestamp,
      },
    };
  });
}
