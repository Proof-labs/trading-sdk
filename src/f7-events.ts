/**
 * Fail-closed decoders for the F7 liquidation-counterparty, bad-debt and
 * insurance-funding ABCI events.
 *
 * PROVISIONAL: the events are defined on unmerged exchange draft PRs (#781
 * `feat/en-13-plp-transfer`, #793 `feat/en-26-bad-debt-ledger`, #796
 * `feat/liquidation-config-record`, #798 `feat/en-11-if-funding-action`) and
 * are not in the SDK's pinned proof-wire (v2.3.0). The attribute layout is the
 * engine's `AbciEvent` derive: the snake_case variant name as the type, one
 * attribute per field in declaration order, `u8`/`u32`/`u64` as canonical
 * decimals, `i64` as a signed decimal, `[u8; 20]` as 40 lowercase hex
 * characters, `bool` as `true`/`false`, enums through their `Display`, and a
 * `None` optional as an empty value. None of these events carries the four
 * trigger coordinate attributes.
 *
 * Each decoder throws unless the type matches, the attribute keys are exactly
 * the expected set in the expected order (no duplicates or extras), every
 * value is canonical, and the documented cross-field identities hold. An
 * appended field on the engine side therefore fails loudly until the SDK is
 * updated.
 */
import type {
  BadDebtAlarmBudgetSetEvent,
  BadDebtAlarmRaisedEvent,
  BadDebtRecordedEvent,
  BadDebtSource,
  InsuranceFundFundedEvent,
  LiquidationConfigUpdatedEvent,
  LiquidationPenaltyChargedEvent,
  LiquidationTransferredEvent,
  OffsetReason,
  OpenInterestOffsetRecordedEvent,
  TreasurySourceDebitedEvent,
  TreasurySourceRegistryUpdatedEvent,
  TxEvent,
} from "./types.js";
import { validateSetLiquidationConfig } from "./f7-admin.js";

const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** ABCI event types of the F7 events, keyed by `ExchangeEvent` type. */
export const F7_EVENT_TYPES = {
  LiquidationTransferred: "liquidation_transferred",
  OpenInterestOffsetRecorded: "open_interest_offset_recorded",
  LiquidationPenaltyCharged: "liquidation_penalty_charged",
  BadDebtRecorded: "bad_debt_recorded",
  BadDebtAlarmRaised: "bad_debt_alarm_raised",
  BadDebtAlarmBudgetSet: "bad_debt_alarm_budget_set",
  LiquidationConfigUpdated: "liquidation_config_updated",
  TreasurySourceRegistryUpdated: "treasury_source_registry_updated",
  TreasurySourceDebited: "treasury_source_debited",
  InsuranceFundFunded: "insurance_fund_funded",
} as const;

const OFFSET_REASONS: ReadonlySet<string> = new Set<OffsetReason>([
  "no_plp_config",
  "plp_disabled",
  "self_transfer",
  "position_limit",
  "account_market_limit",
  "below_floor",
  "plp_trigger_policy",
  "auto_deleveraged",
  "plp_mark_unavailable",
  "plp_cash_short",
]);

const BAD_DEBT_SOURCES: ReadonlySet<string> = new Set<BadDebtSource>([
  "liquidation",
  "resolution",
  "funding",
]);

/** Attribute reader for one event: checks the type and the exact ordered key
 *  list, then parses values on demand. */
class Attrs {
  private readonly values = new Map<string, string>();

  constructor(
    private readonly type: string,
    event: TxEvent,
    keys: readonly string[],
  ) {
    if (event?.type !== type) {
      this.fail(`unexpected event type ${JSON.stringify(event?.type)}`);
    }
    if (!Array.isArray(event.attributes)) {
      this.fail("attributes is not an array");
    }
    if (event.attributes.length !== keys.length) {
      this.fail(
        `expected ${keys.length} attributes, got ${event.attributes.length}`,
      );
    }
    event.attributes.forEach((attr, i) => {
      if (typeof attr?.key !== "string" || typeof attr.value !== "string") {
        this.fail(`attribute ${i} is not a string pair`);
      }
      if (attr.key !== keys[i]) {
        this.fail(
          `attribute ${i} is ${JSON.stringify(attr.key)}, expected ${keys[i]}`,
        );
      }
      this.values.set(attr.key, attr.value);
    });
  }

  fail(message: string): never {
    throw new Error(`${this.type}: ${message}`);
  }

  private raw(key: string): string {
    return this.values.get(key)!;
  }

  /** Canonical unsigned decimal bounded by `max`; returned as a string. */
  unsigned(key: string, max: bigint = U64_MAX): string {
    const value = this.raw(key);
    if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > max) {
      this.fail(`${key} is not a canonical unsigned decimal <= ${max}`);
    }
    return value;
  }

  signed64(key: string): string {
    const value = this.raw(key);
    if (!/^(0|-?[1-9][0-9]*)$/.test(value)) {
      this.fail(`${key} is not a canonical signed decimal`);
    }
    const n = BigInt(value);
    if (n < I64_MIN || n > I64_MAX) this.fail(`${key} exceeds i64`);
    return value;
  }

  address(key: string): string {
    const value = this.raw(key);
    if (!/^[0-9a-f]{40}$/.test(value)) {
      this.fail(`${key} is not 40 lowercase hex characters`);
    }
    return value;
  }

  optionalAddress(key: string): string | null {
    return this.raw(key) === "" ? null : this.address(key);
  }

  bool(key: string): boolean {
    const value = this.raw(key);
    if (value !== "true" && value !== "false") {
      this.fail(`${key} is not "true" or "false"`);
    }
    return value === "true";
  }

  side(key: string): "buy" | "sell" {
    const value = this.raw(key);
    if (value !== "buy" && value !== "sell") {
      this.fail(`${key} is not "buy" or "sell"`);
    }
    return value;
  }

  oneOf<T extends string>(key: string, allowed: ReadonlySet<string>): T {
    const value = this.raw(key);
    if (!allowed.has(value))
      this.fail(`${key} ${JSON.stringify(value)} is unknown`);
    return value as T;
  }

  optionalUnsigned(key: string, max: bigint): string | null {
    return this.raw(key) === "" ? null : this.unsigned(key, max);
  }
}

const U8 = 0xffn;
const U32 = 0xffff_ffffn;

/** Decode `liquidation_transferred` (#781, provisional). */
export function decodeLiquidationTransferredEvent(
  event: TxEvent,
): LiquidationTransferredEvent {
  const a = new Attrs(F7_EVENT_TYPES.LiquidationTransferred, event, [
    "owner",
    "counterparty",
    "market",
    "side",
    "size",
    "price",
  ]);
  const owner = a.address("owner");
  const counterparty = a.address("counterparty");
  if (owner === counterparty) {
    a.fail("counterparty equals owner (a self-transfer is an offset)");
  }
  return {
    type: "LiquidationTransferred",
    owner,
    counterparty,
    market: a.unsigned("market", U32),
    side: a.side("side"),
    size: a.unsigned("size"),
    price: a.unsigned("price"),
  };
}

/** Decode `open_interest_offset_recorded` (#781, provisional). */
export function decodeOpenInterestOffsetRecordedEvent(
  event: TxEvent,
): OpenInterestOffsetRecordedEvent {
  const a = new Attrs(F7_EVENT_TYPES.OpenInterestOffsetRecorded, event, [
    "owner",
    "market",
    "side",
    "size",
    "price",
    "reason",
    "net_size",
  ]);
  return {
    type: "OpenInterestOffsetRecorded",
    owner: a.address("owner"),
    market: a.unsigned("market", U32),
    side: a.side("side"),
    size: a.unsigned("size"),
    price: a.unsigned("price"),
    reason: a.oneOf<OffsetReason>("reason", OFFSET_REASONS),
    netSize: a.signed64("net_size"),
  };
}

/** Decode `liquidation_penalty_charged` (#781, provisional). Enforces
 *  `assessed == collected + waived`, `collected == to_insurance + to_plp`,
 *  `to_plp == 0` when `plp` is absent, and `plp != owner`. */
export function decodeLiquidationPenaltyChargedEvent(
  event: TxEvent,
): LiquidationPenaltyChargedEvent {
  const a = new Attrs(F7_EVENT_TYPES.LiquidationPenaltyCharged, event, [
    "owner",
    "assessed",
    "collected",
    "waived",
    "to_insurance",
    "to_plp",
    "plp",
  ]);
  const decoded: LiquidationPenaltyChargedEvent = {
    type: "LiquidationPenaltyCharged",
    owner: a.address("owner"),
    assessed: a.unsigned("assessed"),
    collected: a.unsigned("collected"),
    waived: a.unsigned("waived"),
    toInsurance: a.unsigned("to_insurance"),
    toPlp: a.unsigned("to_plp"),
    plp: a.optionalAddress("plp"),
  };
  if (
    BigInt(decoded.collected) + BigInt(decoded.waived) !==
    BigInt(decoded.assessed)
  ) {
    a.fail("assessed != collected + waived");
  }
  if (
    BigInt(decoded.toInsurance) + BigInt(decoded.toPlp) !==
    BigInt(decoded.collected)
  ) {
    a.fail("collected != to_insurance + to_plp");
  }
  if (decoded.plp === null && decoded.toPlp !== "0") {
    a.fail("to_plp is non-zero with no PLP recipient");
  }
  if (decoded.plp === decoded.owner) {
    a.fail("the PLP recipient is the liquidated owner");
  }
  return decoded;
}

/** Decode `bad_debt_recorded` (#793, provisional). Enforces
 *  `0 < unfunded <= requested`, `unfunded <= cumulative`, and `event_id`
 *  present exactly for a `resolution` source. */
export function decodeBadDebtRecordedEvent(
  event: TxEvent,
): BadDebtRecordedEvent {
  const a = new Attrs(F7_EVENT_TYPES.BadDebtRecorded, event, [
    "pool_id",
    "deficit_market",
    "source",
    "owner",
    "event_id",
    "requested",
    "unfunded",
    "cumulative",
  ]);
  const decoded: BadDebtRecordedEvent = {
    type: "BadDebtRecorded",
    poolId: a.unsigned("pool_id", U8),
    deficitMarket: a.unsigned("deficit_market", U32),
    source: a.oneOf<BadDebtSource>("source", BAD_DEBT_SOURCES),
    owner: a.address("owner"),
    eventId: a.optionalUnsigned("event_id", U32),
    requested: a.unsigned("requested"),
    unfunded: a.unsigned("unfunded"),
    cumulative: a.unsigned("cumulative"),
  };
  const unfunded = BigInt(decoded.unfunded);
  if (unfunded === 0n || unfunded > BigInt(decoded.requested)) {
    a.fail("unfunded is not in 1..=requested");
  }
  if (unfunded > BigInt(decoded.cumulative)) {
    a.fail("cumulative is below unfunded");
  }
  if ((decoded.eventId !== null) !== (decoded.source === "resolution")) {
    a.fail("event_id must be present exactly for a resolution loss");
  }
  return decoded;
}

/** Decode `bad_debt_alarm_raised` (#793, provisional). Enforces
 *  `epoch_bad_debt > budget`. */
export function decodeBadDebtAlarmRaisedEvent(
  event: TxEvent,
): BadDebtAlarmRaisedEvent {
  const a = new Attrs(F7_EVENT_TYPES.BadDebtAlarmRaised, event, [
    "pool_id",
    "epoch",
    "epoch_bad_debt",
    "budget",
  ]);
  const decoded: BadDebtAlarmRaisedEvent = {
    type: "BadDebtAlarmRaised",
    poolId: a.unsigned("pool_id", U8),
    epoch: a.unsigned("epoch"),
    epochBadDebt: a.unsigned("epoch_bad_debt"),
    budget: a.unsigned("budget"),
  };
  if (BigInt(decoded.epochBadDebt) <= BigInt(decoded.budget)) {
    a.fail("epoch_bad_debt does not exceed budget");
  }
  return decoded;
}

/** Decode `bad_debt_alarm_budget_set` (#793, provisional). */
export function decodeBadDebtAlarmBudgetSetEvent(
  event: TxEvent,
): BadDebtAlarmBudgetSetEvent {
  const a = new Attrs(F7_EVENT_TYPES.BadDebtAlarmBudgetSet, event, [
    "pool_id",
    "budget",
    "proposal_id",
  ]);
  return {
    type: "BadDebtAlarmBudgetSet",
    poolId: a.unsigned("pool_id", U8),
    budget: a.unsigned("budget"),
    proposalId: a.unsigned("proposal_id"),
  };
}

/** Decode `liquidation_config_updated` (#796, provisional). The post-write
 *  state must satisfy the `SetLiquidationConfig` shape rules (DEC-216). */
export function decodeLiquidationConfigUpdatedEvent(
  event: TxEvent,
): LiquidationConfigUpdatedEvent {
  const a = new Attrs(F7_EVENT_TYPES.LiquidationConfigUpdated, event, [
    "penalty_bps",
    "insurance_share_bps",
    "plp_share_bps",
    "proposal_id",
  ]);
  const decoded: LiquidationConfigUpdatedEvent = {
    type: "LiquidationConfigUpdated",
    penaltyBps: Number(a.unsigned("penalty_bps", U32)),
    insuranceShareBps: Number(a.unsigned("insurance_share_bps", U32)),
    plpShareBps: Number(a.unsigned("plp_share_bps", U32)),
    proposalId: a.unsigned("proposal_id"),
  };
  try {
    validateSetLiquidationConfig(decoded);
  } catch (e) {
    a.fail((e as Error).message);
  }
  return decoded;
}

/** Decode `treasury_source_registry_updated` (#798, provisional). */
export function decodeTreasurySourceRegistryUpdatedEvent(
  event: TxEvent,
): TreasurySourceRegistryUpdatedEvent {
  const a = new Attrs(F7_EVENT_TYPES.TreasurySourceRegistryUpdated, event, [
    "source",
    "registered",
    "proposal_id",
  ]);
  const source = a.address("source");
  if (/^0+$/.test(source)) a.fail("source is the zero account");
  return {
    type: "TreasurySourceRegistryUpdated",
    source,
    registered: a.bool("registered"),
    proposalId: a.unsigned("proposal_id"),
  };
}

/** Decode `treasury_source_debited` (#798, provisional). Enforces
 *  `amount` in `1..=i64::MAX` and a non-zero source. */
export function decodeTreasurySourceDebitedEvent(
  event: TxEvent,
): TreasurySourceDebitedEvent {
  const a = new Attrs(F7_EVENT_TYPES.TreasurySourceDebited, event, [
    "funding_id",
    "source",
    "amount",
    "balance_after",
    "proposal_id",
  ]);
  const decoded: TreasurySourceDebitedEvent = {
    type: "TreasurySourceDebited",
    fundingId: a.unsigned("funding_id"),
    source: a.address("source"),
    amount: a.unsigned("amount", I64_MAX),
    balanceAfter: a.unsigned("balance_after"),
    proposalId: a.unsigned("proposal_id"),
  };
  if (/^0+$/.test(decoded.source)) a.fail("source is the zero account");
  if (decoded.amount === "0") a.fail("amount is zero");
  return decoded;
}

/** Decode `insurance_fund_funded` (#798, provisional). Enforces `amount` in
 *  `1..=i64::MAX`, `cumulative_funded >= amount` and a non-zero source. */
export function decodeInsuranceFundFundedEvent(
  event: TxEvent,
): InsuranceFundFundedEvent {
  const a = new Attrs(F7_EVENT_TYPES.InsuranceFundFunded, event, [
    "funding_id",
    "source",
    "pool_id",
    "amount",
    "cumulative_funded",
    "proposal_id",
  ]);
  const decoded: InsuranceFundFundedEvent = {
    type: "InsuranceFundFunded",
    fundingId: a.unsigned("funding_id"),
    source: a.address("source"),
    poolId: a.unsigned("pool_id", U8),
    amount: a.unsigned("amount", I64_MAX),
    cumulativeFunded: a.unsigned("cumulative_funded"),
    proposalId: a.unsigned("proposal_id"),
  };
  if (/^0+$/.test(decoded.source)) a.fail("source is the zero account");
  if (decoded.amount === "0") a.fail("amount is zero");
  if (BigInt(decoded.cumulativeFunded) < BigInt(decoded.amount)) {
    a.fail("cumulative_funded is below amount");
  }
  return decoded;
}

/** Any decoded F7 event. */
export type F7Event =
  | LiquidationTransferredEvent
  | OpenInterestOffsetRecordedEvent
  | LiquidationPenaltyChargedEvent
  | BadDebtRecordedEvent
  | BadDebtAlarmRaisedEvent
  | BadDebtAlarmBudgetSetEvent
  | LiquidationConfigUpdatedEvent
  | TreasurySourceRegistryUpdatedEvent
  | TreasurySourceDebitedEvent
  | InsuranceFundFundedEvent;

const DECODERS: Record<string, (event: TxEvent) => F7Event> = {
  [F7_EVENT_TYPES.LiquidationTransferred]: decodeLiquidationTransferredEvent,
  [F7_EVENT_TYPES.OpenInterestOffsetRecorded]:
    decodeOpenInterestOffsetRecordedEvent,
  [F7_EVENT_TYPES.LiquidationPenaltyCharged]:
    decodeLiquidationPenaltyChargedEvent,
  [F7_EVENT_TYPES.BadDebtRecorded]: decodeBadDebtRecordedEvent,
  [F7_EVENT_TYPES.BadDebtAlarmRaised]: decodeBadDebtAlarmRaisedEvent,
  [F7_EVENT_TYPES.BadDebtAlarmBudgetSet]: decodeBadDebtAlarmBudgetSetEvent,
  [F7_EVENT_TYPES.LiquidationConfigUpdated]:
    decodeLiquidationConfigUpdatedEvent,
  [F7_EVENT_TYPES.TreasurySourceRegistryUpdated]:
    decodeTreasurySourceRegistryUpdatedEvent,
  [F7_EVENT_TYPES.TreasurySourceDebited]: decodeTreasurySourceDebitedEvent,
  [F7_EVENT_TYPES.InsuranceFundFunded]: decodeInsuranceFundFundedEvent,
};

/**
 * Decode `event` if its type is one of the F7 event types; return `null` for
 * any other type. A recognised type with a malformed body throws, so a
 * caller filtering a transaction's events never silently drops a broken F7
 * event.
 */
export function decodeF7Event(event: TxEvent): F7Event | null {
  const type = event?.type;
  if (
    typeof type !== "string" ||
    !Object.prototype.hasOwnProperty.call(DECODERS, type)
  )
    return null;
  return DECODERS[type](event);
}
