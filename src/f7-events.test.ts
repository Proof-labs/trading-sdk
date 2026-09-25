import { describe, expect, it } from "vitest";
import {
  F7_EVENT_TYPES,
  decodeBadDebtAlarmBudgetSetEvent,
  decodeBadDebtAlarmRaisedEvent,
  decodeBadDebtRecordedEvent,
  decodeF7Event,
  decodeInsuranceFundFundedEvent,
  decodeLiquidationConfigUpdatedEvent,
  decodeLiquidationPenaltyChargedEvent,
  decodeLiquidationTransferredEvent,
  decodeOpenInterestOffsetRecordedEvent,
  decodeTreasurySourceDebitedEvent,
  decodeTreasurySourceRegistryUpdatedEvent,
  type TxEvent,
} from "./index.js";

// Engine-rendered ABCI events (PROVISIONAL, pending engine merge). Each list
// is the output of `Event::encode_abci` from `exchange-wire` on the named
// exchange draft branch head, parsed from the AbciEventWriter byte format the
// node forwards to CometBFT. They are not hand-written: the generator was a
// throwaway crate depending on that branch's `exchange-wire` by path, because
// the SDK's crates/spec generator is pinned to the published proof-wire tag
// (v2.3.0), which carries none of these variants.
// - #793 feat/en-26-bad-debt-ledger @ 9b84e248 (includes #781's events)
const EN26: TxEvent[] = [
  {
    type: "liquidation_transferred",
    attributes: [
      {
        key: "owner",
        value: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      },
      {
        key: "counterparty",
        value: "0202020202020202020202020202020202020202",
      },
      {
        key: "market",
        value: "1",
      },
      {
        key: "side",
        value: "sell",
      },
      {
        key: "size",
        value: "3",
      },
      {
        key: "price",
        value: "123000000",
      },
    ],
  },
  {
    type: "open_interest_offset_recorded",
    attributes: [
      {
        key: "owner",
        value: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      },
      {
        key: "market",
        value: "4294967295",
      },
      {
        key: "side",
        value: "buy",
      },
      {
        key: "size",
        value: "18446744073709551615",
      },
      {
        key: "price",
        value: "0",
      },
      {
        key: "reason",
        value: "plp_cash_short",
      },
      {
        key: "net_size",
        value: "-9223372036854775808",
      },
    ],
  },
  {
    type: "open_interest_offset_recorded",
    attributes: [
      {
        key: "owner",
        value: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      },
      {
        key: "market",
        value: "2",
      },
      {
        key: "side",
        value: "sell",
      },
      {
        key: "size",
        value: "5",
      },
      {
        key: "price",
        value: "7",
      },
      {
        key: "reason",
        value: "auto_deleveraged",
      },
      {
        key: "net_size",
        value: "5",
      },
    ],
  },
  {
    type: "liquidation_penalty_charged",
    attributes: [
      {
        key: "owner",
        value: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      },
      {
        key: "assessed",
        value: "1000",
      },
      {
        key: "collected",
        value: "600",
      },
      {
        key: "waived",
        value: "400",
      },
      {
        key: "to_insurance",
        value: "300",
      },
      {
        key: "to_plp",
        value: "300",
      },
      {
        key: "plp",
        value: "0202020202020202020202020202020202020202",
      },
    ],
  },
  {
    type: "liquidation_penalty_charged",
    attributes: [
      {
        key: "owner",
        value: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      },
      {
        key: "assessed",
        value: "1000",
      },
      {
        key: "collected",
        value: "1000",
      },
      {
        key: "waived",
        value: "0",
      },
      {
        key: "to_insurance",
        value: "1000",
      },
      {
        key: "to_plp",
        value: "0",
      },
      {
        key: "plp",
        value: "",
      },
    ],
  },
  {
    type: "bad_debt_recorded",
    attributes: [
      {
        key: "pool_id",
        value: "7",
      },
      {
        key: "deficit_market",
        value: "100",
      },
      {
        key: "source",
        value: "resolution",
      },
      {
        key: "owner",
        value: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      },
      {
        key: "event_id",
        value: "42",
      },
      {
        key: "requested",
        value: "25",
      },
      {
        key: "unfunded",
        value: "11",
      },
      {
        key: "cumulative",
        value: "982",
      },
    ],
  },
  {
    type: "bad_debt_recorded",
    attributes: [
      {
        key: "pool_id",
        value: "255",
      },
      {
        key: "deficit_market",
        value: "1",
      },
      {
        key: "source",
        value: "funding",
      },
      {
        key: "owner",
        value: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
      },
      {
        key: "event_id",
        value: "",
      },
      {
        key: "requested",
        value: "25",
      },
      {
        key: "unfunded",
        value: "25",
      },
      {
        key: "cumulative",
        value: "25",
      },
    ],
  },
  {
    type: "bad_debt_alarm_raised",
    attributes: [
      {
        key: "pool_id",
        value: "7",
      },
      {
        key: "epoch",
        value: "20720",
      },
      {
        key: "epoch_bad_debt",
        value: "11",
      },
      {
        key: "budget",
        value: "0",
      },
    ],
  },
  {
    type: "bad_debt_alarm_budget_set",
    attributes: [
      {
        key: "pool_id",
        value: "0",
      },
      {
        key: "budget",
        value: "25000000000",
      },
      {
        key: "proposal_id",
        value: "9",
      },
    ],
  },
];
// - #796 feat/liquidation-config-record @ e0f0168d
const LIQUIDATION_CONFIG: TxEvent[] = [
  {
    type: "liquidation_config_updated",
    attributes: [
      {
        key: "penalty_bps",
        value: "100",
      },
      {
        key: "insurance_share_bps",
        value: "5000",
      },
      {
        key: "plp_share_bps",
        value: "5000",
      },
      {
        key: "proposal_id",
        value: "12",
      },
    ],
  },
];
// - #798 feat/en-11-if-funding-action @ 5e6560cd
const EN11: TxEvent[] = [
  {
    type: "treasury_source_registry_updated",
    attributes: [
      {
        key: "source",
        value: "abababababababababababababababababababab",
      },
      {
        key: "registered",
        value: "true",
      },
      {
        key: "proposal_id",
        value: "5",
      },
    ],
  },
  {
    type: "treasury_source_registry_updated",
    attributes: [
      {
        key: "source",
        value: "abababababababababababababababababababab",
      },
      {
        key: "registered",
        value: "false",
      },
      {
        key: "proposal_id",
        value: "6",
      },
    ],
  },
  {
    type: "treasury_source_debited",
    attributes: [
      {
        key: "funding_id",
        value: "7",
      },
      {
        key: "source",
        value: "abababababababababababababababababababab",
      },
      {
        key: "amount",
        value: "1000000",
      },
      {
        key: "balance_after",
        value: "0",
      },
      {
        key: "proposal_id",
        value: "8",
      },
    ],
  },
  {
    type: "insurance_fund_funded",
    attributes: [
      {
        key: "funding_id",
        value: "7",
      },
      {
        key: "source",
        value: "abababababababababababababababababababab",
      },
      {
        key: "pool_id",
        value: "0",
      },
      {
        key: "amount",
        value: "1000000",
      },
      {
        key: "cumulative_funded",
        value: "1000000",
      },
      {
        key: "proposal_id",
        value: "8",
      },
    ],
  },
];

const A1 = "a1".repeat(20);
const P = "02".repeat(20);
const AB = "ab".repeat(20);

/** A copy of `event` with attribute `key` set to `value`. */
function withAttr(event: TxEvent, key: string, value: string): TxEvent {
  return {
    type: event.type,
    attributes: event.attributes.map((a) =>
      a.key === key ? { key, value } : { ...a },
    ),
  };
}

describe("F7 event decoders (provisional, pending engine merge)", () => {
  it("decodes every engine-rendered event", () => {
    expect(EN26.map((e) => decodeF7Event(e))).toEqual([
      {
        type: "LiquidationTransferred",
        owner: A1,
        counterparty: P,
        market: "1",
        side: "sell",
        size: "3",
        price: "123000000",
      },
      {
        type: "OpenInterestOffsetRecorded",
        owner: A1,
        market: "4294967295",
        side: "buy",
        size: "18446744073709551615",
        price: "0",
        reason: "plp_cash_short",
        netSize: "-9223372036854775808",
      },
      {
        type: "OpenInterestOffsetRecorded",
        owner: A1,
        market: "2",
        side: "sell",
        size: "5",
        price: "7",
        reason: "auto_deleveraged",
        netSize: "5",
      },
      {
        type: "LiquidationPenaltyCharged",
        owner: A1,
        assessed: "1000",
        collected: "600",
        waived: "400",
        toInsurance: "300",
        toPlp: "300",
        plp: P,
      },
      {
        type: "LiquidationPenaltyCharged",
        owner: A1,
        assessed: "1000",
        collected: "1000",
        waived: "0",
        toInsurance: "1000",
        toPlp: "0",
        plp: null,
      },
      {
        type: "BadDebtRecorded",
        poolId: "7",
        deficitMarket: "100",
        source: "resolution",
        owner: A1,
        eventId: "42",
        requested: "25",
        unfunded: "11",
        cumulative: "982",
      },
      {
        type: "BadDebtRecorded",
        poolId: "255",
        deficitMarket: "1",
        source: "funding",
        owner: A1,
        eventId: null,
        requested: "25",
        unfunded: "25",
        cumulative: "25",
      },
      {
        type: "BadDebtAlarmRaised",
        poolId: "7",
        epoch: "20720",
        epochBadDebt: "11",
        budget: "0",
      },
      {
        type: "BadDebtAlarmBudgetSet",
        poolId: "0",
        budget: "25000000000",
        proposalId: "9",
      },
    ]);
    expect(decodeF7Event(LIQUIDATION_CONFIG[0])).toEqual({
      type: "LiquidationConfigUpdated",
      penaltyBps: 100,
      insuranceShareBps: 5000,
      plpShareBps: 5000,
      proposalId: "12",
    });
    expect(EN11.map((e) => decodeF7Event(e))).toEqual([
      {
        type: "TreasurySourceRegistryUpdated",
        source: AB,
        registered: true,
        proposalId: "5",
      },
      {
        type: "TreasurySourceRegistryUpdated",
        source: AB,
        registered: false,
        proposalId: "6",
      },
      {
        type: "TreasurySourceDebited",
        fundingId: "7",
        source: AB,
        amount: "1000000",
        balanceAfter: "0",
        proposalId: "8",
      },
      {
        type: "InsuranceFundFunded",
        fundingId: "7",
        source: AB,
        poolId: "0",
        amount: "1000000",
        cumulativeFunded: "1000000",
        proposalId: "8",
      },
    ]);
  });

  it("returns null for non-F7 event types and covers every F7 type", () => {
    expect(
      decodeF7Event({ type: "trade_executed", attributes: [] }),
    ).toBeNull();
    expect(
      decodeF7Event({ type: "hasOwnProperty", attributes: [] }),
    ).toBeNull();
    const seen = new Set(
      [...EN26, ...LIQUIDATION_CONFIG, ...EN11].map((e) => e.type),
    );
    expect([...seen].sort()).toEqual(Object.values(F7_EVENT_TYPES).sort());
  });

  const all = [...EN26, ...LIQUIDATION_CONFIG, ...EN11];
  it.each(all.map((e, i) => [`${e.type}#${i}`, e] as const))(
    "%s fails closed on structural damage",
    (_name, event) => {
      const cases: TxEvent[] = [
        { ...event, type: event.type + "_v2" },
        { type: event.type, attributes: event.attributes.slice(1) },
        {
          type: event.type,
          attributes: [...event.attributes, { key: "extra", value: "1" }],
        },
        {
          type: event.type,
          attributes: [...event.attributes].reverse(),
        },
        {
          type: event.type,
          attributes: event.attributes.map((a, i) =>
            i === 0 ? { key: a.key.toUpperCase(), value: a.value } : a,
          ),
        },
        {
          type: event.type,
          attributes: event.attributes.map((a, i) =>
            i === 0 ? ({ key: a.key, value: 1 } as unknown as typeof a) : a,
          ),
        },
      ];
      for (const bad of cases) {
        if (bad.type !== event.type) {
          // A renamed type is simply not an F7 event for the dispatcher...
          expect(decodeF7Event(bad)).toBeNull();
        } else {
          expect(() => decodeF7Event(bad)).toThrow(event.type);
        }
      }
      // ...but the specific decoder refuses it.
      const specific = {
        [F7_EVENT_TYPES.LiquidationTransferred]:
          decodeLiquidationTransferredEvent,
        [F7_EVENT_TYPES.OpenInterestOffsetRecorded]:
          decodeOpenInterestOffsetRecordedEvent,
        [F7_EVENT_TYPES.LiquidationPenaltyCharged]:
          decodeLiquidationPenaltyChargedEvent,
        [F7_EVENT_TYPES.BadDebtRecorded]: decodeBadDebtRecordedEvent,
        [F7_EVENT_TYPES.BadDebtAlarmRaised]: decodeBadDebtAlarmRaisedEvent,
        [F7_EVENT_TYPES.BadDebtAlarmBudgetSet]:
          decodeBadDebtAlarmBudgetSetEvent,
        [F7_EVENT_TYPES.LiquidationConfigUpdated]:
          decodeLiquidationConfigUpdatedEvent,
        [F7_EVENT_TYPES.TreasurySourceRegistryUpdated]:
          decodeTreasurySourceRegistryUpdatedEvent,
        [F7_EVENT_TYPES.TreasurySourceDebited]:
          decodeTreasurySourceDebitedEvent,
        [F7_EVENT_TYPES.InsuranceFundFunded]: decodeInsuranceFundFundedEvent,
      }[event.type]!;
      expect(() => specific(cases[0])).toThrow("unexpected event type");
      expect(() => specific(null as unknown as TxEvent)).toThrow();
    },
  );

  it.each([
    // Non-canonical scalars.
    [EN26[0], "owner", "A1".repeat(20)],
    [EN26[0], "owner", "0x" + "a1".repeat(19)],
    [EN26[0], "market", "4294967296"],
    [EN26[0], "market", "01"],
    [EN26[0], "size", "18446744073709551616"],
    [EN26[0], "size", "-1"],
    [EN26[0], "size", ""],
    [EN26[0], "side", "Sell"],
    [EN26[0], "counterparty", A1],
    [EN26[1], "reason", "PlpCashShort"],
    [EN26[1], "reason", "refused"],
    [EN26[1], "net_size", "-0"],
    [EN26[1], "net_size", "9223372036854775808"],
    [EN26[1], "net_size", "-9223372036854775809"],
    [EN26[1], "net_size", "+5"],
    // Penalty identities.
    [EN26[3], "waived", "401"],
    [EN26[3], "to_plp", "301"],
    [EN26[3], "plp", A1],
    [EN26[3], "plp", "02"],
    [EN26[4], "to_insurance", "999"],
    [withAttr(EN26[4], "to_insurance", "999"), "to_plp", "1"],
    // Bad-debt identities.
    [EN26[5], "pool_id", "256"],
    [EN26[5], "unfunded", "0"],
    [EN26[5], "unfunded", "26"],
    [EN26[5], "cumulative", "10"],
    [EN26[5], "event_id", ""],
    [EN26[5], "event_id", "4294967296"],
    [EN26[5], "source", "Resolution"],
    [EN26[6], "event_id", "1"],
    [EN26[7], "epoch_bad_debt", "0"],
    [EN26[8], "pool_id", "-1"],
    // Liquidation config shape rules (DEC-216).
    [LIQUIDATION_CONFIG[0], "penalty_bps", "0"],
    [LIQUIDATION_CONFIG[0], "penalty_bps", "101"],
    [LIQUIDATION_CONFIG[0], "plp_share_bps", "4999"],
    // Insurance funding.
    [EN11[0], "registered", "True"],
    [EN11[0], "registered", "1"],
    [EN11[0], "source", "00".repeat(20)],
    [EN11[2], "amount", "0"],
    [EN11[2], "amount", "9223372036854775808"],
    [EN11[2], "source", "00".repeat(20)],
    [EN11[3], "cumulative_funded", "999999"],
    [EN11[3], "amount", "0"],
    [EN11[3], "source", "00".repeat(20)],
  ])("%s rejects %s = %j", (event, key, value) => {
    expect(() => decodeF7Event(withAttr(event, key, value))).toThrow(
      event.type,
    );
  });
});
