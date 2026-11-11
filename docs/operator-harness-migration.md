# Operator harness compatibility

Current SDK builds support `CreateMarket.tickSize` and `lotSize` together with
`SubmitOracleObservation`. Use the current engine contract rather than a
maintenance package that restores retired actions.

The TypeScript package root exports `CreateMarket`, `SubmitOracleObservation`
and `ConfigureOraclePolicy`. Python exports the matching builders from
`proof_trading_sdk`. These are privileged operator surfaces, not trader APIs.

## Port a harness

1. Supply nonzero tick and lot sizes when creating a market.
   Quantize every order and fixture onto those grids.
   Quantity is an integer count of `10^-szDecimals` base units.
2. Replace direct price-setting fixtures with authenticated
   `SubmitOracleObservation` calls under the market's installed policy.
   Match its policy version, source IDs, signing authorities and provider time.
   A submitted observation is not by itself evidence of a certified mark.
3. Install policy changes through the existing governed
   `ConfigureOraclePolicy` path with independently reviewed bundle bytes.
   Do not infer permission to submit or activate from codec success.
4. Observe scheduled funding or liquidation through production paths rather
   than resurrecting removed test-only action tags or the testing subpath.
5. Submit through `ExchangeClient` and the API gateway.
   Treat codec fixtures as offline compatibility checks, not live-engine proof.

The public-barrel test compiles these payload types and exercises their codec
paths. The cross-language conformance suite pins the current wire bytes.
The harness still needs its own live scenario run after migration.

No maintenance release, package downgrade, dist-tag change, or trusted-publishing
change is needed for these type exports.
