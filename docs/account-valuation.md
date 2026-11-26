# Account valuation v2

Use `queryAccountV2(ownerHex)` in TypeScript, `account_v2(owner)` in Python,
or `InfoClient::account_v2(owner)` in Rust. Each reads the gateway's
`GET /v2/account/{owner}`, which the gateway forwards to the node unchanged.
The SDK chooses the route; there is no version parameter. The returned snapshot
contains `{ height, account }`, using the height from the same HTTP response.
TypeScript and Rust export `AccountSnapshot`; Python returns a dictionary.
Missing or malformed heights fail. TypeScript accepts safe nonnegative integers
(up to `Number.MAX_SAFE_INTEGER`); Python and Rust preserve the full `u64` range.

```ts
const snapshot = await client.queryAccountV2(ownerHex);
console.log(snapshot?.height);
for (const position of snapshot?.account.positions ?? []) {
  console.log(
    position.market,
    position.valuationPrice,
    position.bookRestricted,
  );
}
```

- `valuationPrice` is the exact micro-USDC reference used for position PnL and
  margin. For prediction binaries it is the firing payout, not a trading mark;
  `upnlNow` is null.
- `bookRestricted` reports only the conditional thin-book restriction;
  `marketReduceOnly` and `marketHalted` remain separate. It is null for other kinds.
- Older v2 maps omit these fields; missing values stay null, never zero or false.
- Account margins are scenario-aware; per-position margins do not sum to them.
- Integer amounts remain `bigint` in TypeScript and exact integers in Python/Rust.
  Python/Rust use snake_case field names.

The original `queryAccount` / `account` methods retain their v1 response from
`POST /info`. A gateway without the v2 route answers 404, which is an error; a
positional v1 account is a decode error. There is no fallback. Missing/malformed
responses fail rather than becoming empty accounts. This read does not verify a
finalized-state witness.

Rust exposes v2 response enums through `proof_sdk_rs::query_v2` (also
`proof_trading_sdk::query_v2`). Use these enums for v2 reads; the root `Side`
remains the order/legacy-position type.

```rust
use proof_sdk_rs::{query_v2::{Branch, Side}, AccountView};

fn has_long_position(account: &AccountView) -> bool {
    account.positions.iter().any(|position| position.side == Side::Buy)
}

fn has_yes_outcome(account: &AccountView) -> bool {
    account.binding_scenario.iter().any(|outcome| outcome.branch == Branch::Yes)
}
```
