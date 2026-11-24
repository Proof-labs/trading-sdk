# Account valuation v2

Use `queryAccountV2(ownerHex)` in TypeScript, `account_v2(owner)` in Python,
or `InfoClient::account_v2(owner)` in Rust. Each reads the gateway's
`GET /v2/account/{owner}`, which the gateway forwards to the node unchanged.
The SDK chooses the route; there is no version parameter.

```ts
const account = await client.queryAccountV2(ownerHex);
for (const position of account?.positions ?? []) {
  console.log(position.market, position.settlePrice, position.bookRestricted);
}
```

- `settlePrice` is the exact micro-USDC reference used for position PnL and
  margin. For prediction binaries it is the firing payout, not a trading mark;
  `upnlNow` is null.
- `bookRestricted` reports the conditional book's taker/trigger restriction.
  It is null for other market kinds.
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
