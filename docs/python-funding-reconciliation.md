# Python funding reconciliation

Use the cumulative index to check an account's funding payment. The funding mark
is already represented in that index; it is unnecessary for this calculation.
Recomputing the **index increment itself** from a rate requires the historical
funding mark and is a separate check.

## Integer units and rounding

This contract describes the engine's current perpetual funding settlement.
Conditionals and prediction binaries do not accrue funding.

| Value                                        | Raw unit                                                  |
| -------------------------------------------- | --------------------------------------------------------- |
| Price / funding mark                         | Micro-USDC per whole unit of the base asset               |
| Cash / signed payment                        | Micro-USDC; `1_000_000` = 1 USDC                          |
| Position `size`                              | `10^-sz_decimals` whole base units                        |
| Cumulative and position `last_funding_index` | Micro-USDC per whole base unit, multiplied by `1_000_000` |
| Funding rate                                 | Integer basis points; `10_000` = 100%                     |

Let `delta = cumulative_funding - last_funding_index`. The **full accrued
payment**, positive for a credit and negative for a debit, is:

```python
sign = -1 if side == "Buy" else 1  # Buy = long; Sell = short
payment_micro_usdc = (sign * delta * raw_size) // 1_000_000 // (10 ** sz_decimals)
```

Apply the side **before** dividing. Both divisions round down toward negative
infinity (`div_euclid` with positive divisors in Rust, `//` in Python). A payer's
fractional micro-USDC rounds to a larger debit; a receiver's fraction rounds to a
smaller credit. Do not truncate toward zero, round to nearest, use floats, or
negate an already-rounded unsigned payment.

The index increment for a tick is
`funding_mark_micro_usdc * funding_rate_bps * 1_000_000 / 10_000`, using checked
integer arithmetic with division toward zero. With the current scale the
numerator is divisible by `10_000`. Position payments are rounded separately,
after multiplying the signed index difference by raw size.

The indexes and payment are signed 64-bit integers; raw size is unsigned 64-bit.
The engine checks the intermediate product in signed 128-bit arithmetic. Markets
created under the current contract allow `sz_decimals` from 0 through 18. The
[executable reference](../python/examples/reconcile_funding.py) rejects values
outside these ranges instead of silently overflowing or guessing a scale.

## Existing Python reads

- `client.markets()` supplies the market's `sz_decimals`. The representation
  scale is set at creation and immutable afterwards; `UpdateMarketFees` cannot
  change it (see the public [wire types](https://github.com/Proof-labs/wire/blob/326aa30f/src/types.rs)).
  This is distinct from `lot_size`, which is an order increment.
- `client.get_block_results(height)` reads the committed height through the
  gateway. Its `result.finalize_block_events` contains `funding_applied` with
  `market`, `funding_rate_bps`, `cumulative_funding` and `timestamp_ms`, and
  `funding_settled` with `owner`, `market` and signed `payment`.
- `client.history_funding(owner)` reads indexed **settled cash payments**.
  Paginate using `next_cursor`; do not treat one page as complete history.
- Before settlement, retain `side`, raw `size`, and `last_funding_index` from
  `client.account(owner).positions`, with the observed position epoch and market.
  Do not replace this input with the position's post-settlement index.
  The current Python account decoder defaults an absent legacy index to `0`.
  If the source could omit that field, zero is ambiguous: obtain a complete
  retained position record instead of treating it as a confirmed zero index.

A current immutable market scale can be combined with retained indexes on the
same chain. For a historical protocol migration or a chain reset, retain the
applicable market config and engine version too; the example cannot establish
that continuity. It also does not reconstruct an arbitrary historical position.
Missing scale, a missing event, a wrong response height or an ambiguous match
is an error, never a zero payment. A zero or fully deferred debit may emit no
cash event. The example refuses missing and multiple cash events in
`finalize_block_events` instead of choosing one or inventing zero. A fill or a
`LiquidateAccounts` transaction in the same block emits its `funding_settled` in
`txs_results[i].events`. The example refuses the block if it finds one for the
same owner and market: a retained pre-block position cannot isolate the final
settlement after an earlier transaction-level payment.

Run the read-only example with your preserved position inputs:

```sh
python python/examples/reconcile_funding.py \
  --chain-id exchange-devnet-1 --height 10013501 --market 3 \
  --owner YOUR_20_BYTE_OWNER_HEX --side Buy --raw-size 1 \
  --last-index 727219862587400
```

All network calls use the Python SDK and gateway. No key, signature, transaction
or account funding is required. The script checks chain identity, reads the
market scale and the selected committed block, then compares the independently
computed full amount with the owner's recorded cash payment.
These are trusted gateway observations, not cryptographic witness or proof
verification. A correct arithmetic match does not establish gateway honesty.

## Fractional-unit examples

These are full-payment examples; the short rows use the same hypothetical raw
size and prior index as the corresponding long rows.

|   Index difference | Raw size | `sz_decimals` | Long payment | Short payment |
| -----------------: | -------: | ------------: | -----------: | ------------: |
|  `171_557_716_500` |        1 |             2 |     `-1_716` |       `1_715` |
| `-171_557_716_500` |        1 |             2 |      `1_715` |      `-1_716` |
|                `1` |        1 |             0 |         `-1` |           `0` |
|      `200_000_000` |      100 |             2 |       `-200` |         `200` |

The first long row reproduces the reported DevNet market 3 settlement at height
`10013501`: index `727_391_420_303_900` minus retained last index
`727_219_862_587_400`, with size `1` and market scale `2`, gives `-1_716`
micro-USDC. The scale comes from the market config, not from fitting the observed
payment. The committed block independently records `-1_716`; the preserved
account snapshots recorded the same cash change. The published rate was 19 bps,
but it is not needed to calculate the payment from indexes.

## Accrued funding versus settled cash

A payer may lack free cash after prediction-binary reserves, or the reserve may
be unpriceable. The engine can settle only part of a debit or defer it, retaining
unpaid debt in the position's index. A credit settles in full. Position resizing,
closing and liquidation also have debt-allocation rules. Therefore a mismatch
between the full accrued amount and one cash event is **not by itself a bug**.
A total account balance difference can also contain fees, trades, transfers and
other markets' funding; match the owner, market, height and settlement context.

The current `funding_applied` event does not publish the historical funding mark.
Replaying rate-to-index accrual needs an upstream historical mark read or an event
field added by the engine and exposed through the gateway/indexer. Neither a
current risk mark nor an inferred mark is a substitute. A general historical
settlement audit also needs the position and reserve/debt context at that time.
The example verifies the supplied pre-settlement position's index arithmetic and
recorded cash event; it does not certify those additional inputs.
