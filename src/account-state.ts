/** Raw settled ledger facts. Never equity, margin, or withdrawal authorization. */
export interface RawAccountPosition {
  owner: string;
  market: number;
  side: "Buy" | "Sell";
  entryPrice: bigint;
  size: bigint;
  lastFundingIndex: bigint;
}
export interface AccountState {
  owner: string;
  finalizedHeight: bigint;
  balance: bigint;
  positions: RawAccountPosition[];
}

function invalid(field: string): never {
  throw new Error(`account state decode: invalid ${field}`);
}
function tuple(value: unknown, length: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length !== length) return invalid(field);
  return value;
}
function integer(value: unknown, field: string, signed = false): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value))
    value = BigInt(value);
  const min = signed ? -(1n << 63n) : 0n;
  const max = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  if (typeof value !== "bigint" || value < min || value > max)
    return invalid(field);
  return value;
}
function owner(value: unknown): string {
  if (!(value instanceof Uint8Array) && !Array.isArray(value))
    return invalid("owner");
  const bytes = Array.from(value as ArrayLike<unknown>);
  if (
    bytes.length !== 20 ||
    bytes.some(
      (b) => typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255,
    )
  )
    return invalid("owner");
  return (bytes as number[])
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function decodeAccountState(
  raw: unknown,
  expectedOwner?: string,
): AccountState {
  const fields = tuple(raw, 4, "response");
  const address = owner(fields[0]);
  if (expectedOwner !== undefined && address !== expectedOwner.toLowerCase())
    return invalid("owner binding");
  if (!Array.isArray(fields[3]) || fields[3].length > 2048)
    return invalid("positions");
  let previous = -1n;
  const positions = fields[3].map((rawPosition): RawAccountPosition => {
    const p = tuple(rawPosition, 6, "position");
    const positionOwner = owner(p[0]);
    const market = integer(p[1], "market");
    if (market > 0xffffffffn || market <= previous || positionOwner !== address)
      return invalid("position binding/order");
    previous = market;
    const side = p[2];
    if (side !== "Buy" && side !== "Sell") return invalid("side");
    return {
      owner: positionOwner,
      market: Number(market),
      side,
      entryPrice: integer(p[3], "entry price"),
      size: integer(p[4], "size"),
      lastFundingIndex: integer(p[5], "funding index", true),
    };
  });
  return {
    owner: address,
    finalizedHeight: integer(fields[1], "height"),
    balance: integer(fields[2], "balance"),
    positions,
  };
}
