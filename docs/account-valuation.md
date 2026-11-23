# Account valuation v2

Use `queryAccountV2(ownerHex)` in TypeScript, `account_v2(owner)` in Python,
or `InfoClient::account_v2(owner)` in Rust. Each requests gateway
`POST /info` with `type: "clearinghouseState"` and `version: 2`.

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

The original `queryAccount` / `account` methods retain their v1 response.
A gateway that ignores `version: 2` and returns a v1 array causes a decode error;
there is no fallback. Missing/malformed responses fail rather than becoming empty
accounts. This read does not verify a finalized-state witness.
