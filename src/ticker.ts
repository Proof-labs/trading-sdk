/**
 * The market ticker rule, checked before the SDK signs a market creation.
 *
 * Source of truth: `proof_wire::ticker::validate_ticker` in the shared
 * `proof-wire` crate (Proof-labs/exchange#1351). The SDK pins an older
 * proof-wire, so this is a copy of the same rule with the same refusal
 * messages; replace it with the proof-wire function at the next proof-wire
 * upgrade. The Rust core carries the same copy in
 * `crates/proof-trading-sdk/src/ticker.rs`.
 *
 * A ticker is 1 to {@link MAX_TICKER_LEN} bytes of capital letters A-Z,
 * digits 0-9 and hyphens, starting with a capital letter
 * (`^[A-Z][A-Z0-9-]{0,23}$`). A market cannot be renamed, so a bad ticker is
 * refused here rather than discovered on chain. Read paths never check it:
 * markets created before the rule still decode.
 */

/** Longest ticker the engine accepts, in UTF-8 bytes. */
export const MAX_TICKER_LEN = 24;

/** Why a ticker was refused. The fields mirror the engine's refusal. */
export type TickerRefusal =
  | { kind: "Empty" }
  | { kind: "TooLong"; len: number }
  | { kind: "BadStart"; char: string }
  | { kind: "BadChar"; char: string; index: number };

/** A market ticker broke the ticker rule. `message` is the engine's text. */
export class InvalidTickerError extends Error {
  constructor(
    public readonly ticker: string,
    public readonly reason: TickerRefusal,
  ) {
    super(tickerRefusalMessage(reason));
    this.name = "InvalidTickerError";
  }
}

/** The engine's refusal text for `reason`, word for word. */
export function tickerRefusalMessage(reason: TickerRefusal): string {
  switch (reason.kind) {
    case "Empty":
      return "ticker is empty";
    case "TooLong":
      return `ticker is ${reason.len} bytes, over the ${MAX_TICKER_LEN}-byte limit`;
    case "BadStart":
      return `ticker must start with a capital letter A-Z, not ${quoteChar(reason.char)}`;
    case "BadChar":
      return `ticker may hold only A-Z, 0-9 and '-', found ${quoteChar(reason.char)} at character ${reason.index}`;
  }
}

const UTF8 = new TextEncoder();

const RUST_ESCAPES: Record<string, string> = {
  "\0": "\\0",
  "\t": "\\t",
  "\r": "\\r",
  "\n": "\\n",
  "'": "\\'",
  "\\": "\\\\",
};

// Characters Rust's `char::escape_debug` writes as `\u{...}`: control,
// format, private-use, unassigned and surrogate code points, line and
// paragraph separators, spaces other than U+0020, and combining marks.
const RUST_UNPRINTABLE =
  /^[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}\p{Mn}\p{Me}]$|^(?! )\p{Zs}$/u;

/**
 * Quote `c` the way the engine does: it formats the character with Rust's
 * `{:?}`, which is `'c'` for an ordinary character and escapes quotes,
 * backslashes and invisible characters (`'\''`, `'\t'`, `'\u{200b}'`).
 */
function quoteChar(c: string): string {
  const escaped =
    RUST_ESCAPES[c] ??
    (RUST_UNPRINTABLE.test(c) ? `\\u{${c.codePointAt(0)!.toString(16)}}` : c);
  return `'${escaped}'`;
}

/**
 * Check `ticker` against the rule without throwing. Returns `null` when it
 * passes, otherwise the first refusal in the engine's order: length, empty,
 * first character, then the rest. `index` counts Unicode code points from 0.
 */
export function checkTicker(ticker: string): TickerRefusal | null {
  const len = UTF8.encode(ticker).length;
  if (len > MAX_TICKER_LEN) return { kind: "TooLong", len };
  // Iterate by code point, not UTF-16 unit, so `index` matches Rust's chars().
  const chars = Array.from(ticker);
  if (chars.length === 0) return { kind: "Empty" };
  if (!isUpper(chars[0])) return { kind: "BadStart", char: chars[0] };
  for (let i = 1; i < chars.length; i++) {
    const c = chars[i];
    if (!isUpper(c) && !isDigit(c) && c !== "-") {
      return { kind: "BadChar", char: c, index: i };
    }
  }
  return null;
}

/** Throw {@link InvalidTickerError} unless `ticker` follows the rule. */
export function validateTicker(ticker: string): void {
  const reason = checkTicker(ticker);
  if (reason) throw new InvalidTickerError(ticker, reason);
}

function isUpper(c: string): boolean {
  return c >= "A" && c <= "Z" && c.length === 1;
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9" && c.length === 1;
}
