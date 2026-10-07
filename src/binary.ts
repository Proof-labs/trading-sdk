// An event's one binary book, traded and read in No terms.
//
// Each event has a single binary book priced in Yes. A long No at price `q`
// is the same position as a short Yes at `$1 − q`, so buying No at `q` is
// selling Yes at `$1 − q`, selling No at `q` is buying Yes at `$1 − q`, and a
// No stop or take-profit at `x` is the same limb on the Yes position at
// `$1 − x`. The engine has no No book; these helpers translate on the client.
// The Rust core (`binary.rs`) is the reference, pinned for every binding by
// `conformance/binary.ndjson`.

import { Side, type PlaceOrder, type TriggerLimb } from "./types.js";

/** `$1` in micro-USDC: a binary pays this on its winning outcome. */
export const BINARY_PRICE_MAX = 1_000_000n;

/** Which price could not be mirrored. Matches the Rust core's refusal names. */
export type BinaryErrorName =
  "OrderPriceOutOfRange" | "TriggerPriceOutOfRange" | "EntryAboveOneDollar";

/** A No price, trigger or entry with no mirror inside the book. */
export class BinaryPriceError extends Error {
  constructor(
    readonly reason: BinaryErrorName,
    readonly price: bigint,
  ) {
    super(
      reason === "EntryAboveOneDollar"
        ? `binary entry price ${price} is above ${BINARY_PRICE_MAX}`
        : reason === "OrderPriceOutOfRange"
          ? `No order price ${price} must be above 0 and below ${BINARY_PRICE_MAX} (a No price of $1 is a Yes price of 0)`
          : `No trigger price ${price} must be above 0 and below ${BINARY_PRICE_MAX}`,
    );
    this.name = "BinaryPriceError";
  }
}

function mirror(price: bigint, reason: BinaryErrorName): bigint {
  if (price <= 0n || price >= BINARY_PRICE_MAX) {
    throw new BinaryPriceError(reason, price);
  }
  return BINARY_PRICE_MAX - price;
}

/** The Yes order side that trades `noSide` of No. */
export function yesSide(noSide: Side): Side {
  return noSide === Side.Buy ? Side.Sell : Side.Buy;
}

/**
 * The Yes limb equivalent to a No limb: same role and collar, mirrored
 * trigger price. A stop on a long No fires as No falls to `x`, which is when
 * Yes rises to `$1 − x` — the condition a stop on the mirrored short Yes
 * uses. `maxSlippageBps` is carried unchanged and applies to the Yes price.
 */
export function yesLimb(noLimb: TriggerLimb): TriggerLimb {
  return {
    ...noLimb,
    triggerPrice: mirror(noLimb.triggerPrice, "TriggerPriceOutOfRange"),
  };
}

/**
 * A limit order on an event's binary book, stated in No terms: `side` buys or
 * sells No, `price` and limb trigger prices are No prices. `market` is the
 * event's binary book (`EventInfo.ebyMarket`).
 */
export type NoOrder = Omit<PlaceOrder, "owner">;

/** The Yes order the engine executes for a No order. */
export function yesOrder(no: NoOrder): Omit<PlaceOrder, "owner"> {
  return {
    ...no,
    side: yesSide(no.side),
    price: mirror(no.price, "OrderPriceOutOfRange"),
    stopLoss: no.stopLoss ? yesLimb(no.stopLoss) : no.stopLoss,
    takeProfit: no.takeProfit ? yesLimb(no.takeProfit) : no.takeProfit,
  };
}

/** A binary position read the way a trader holds it. */
export interface BinaryPositionView {
  outcome: "Yes" | "No";
  /** Entry price in the outcome's own terms, in micro-USDC. */
  entryPrice: bigint;
  size: bigint;
}

/**
 * Read a position on an event's binary book: a long Yes as Yes, a short Yes
 * as No at `$1 − entry`. An entry of exactly `$1` (a No-branch conditional
 * close is issued there) reads as No at 0.
 */
export function binaryPositionView(position: {
  side: Side | "Buy" | "Sell";
  entryPrice: bigint;
  size: bigint;
}): BinaryPositionView {
  const { side, entryPrice, size } = position;
  if (entryPrice > BINARY_PRICE_MAX) {
    throw new BinaryPriceError("EntryAboveOneDollar", entryPrice);
  }
  const long = side === Side.Buy || side === "Buy";
  return long
    ? { outcome: "Yes", entryPrice, size }
    : { outcome: "No", entryPrice: BINARY_PRICE_MAX - entryPrice, size };
}
