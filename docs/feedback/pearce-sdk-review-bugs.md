# Pearce SDK review bugs

Feedback from testing the TypeScript SDK on DevNet: version 9.2.0 in a fresh container, about 1,000 transactions plus offline and failure-case tests. We ran every SDK check in the master rollout plan. This file lists only what went wrong; the other checks worked well.

Every finding below was rechecked on 10.1.0. This is the TypeScript counterpart to the Python findings in issues #351–#362.

## Same as the Python findings

- `SetUserMarketLeverage` fails in TypeScript too. The engine answers `unknown action_type: 0x16`, so the fault looks like the engine's, not either SDK's.
- `queryOpenOrders` drops `clientOrderId`, although the raw response has it.
- Timeouts and bad responses aren't typed cleanly. Most network calls have no default deadline, `query*` calls take no `signal`, and network failures escape as a raw `TypeError`.

## TypeScript only

- **Unknown action fields are silently dropped.** `MarketOrder` has no `reduceOnly` or `maxSlippageBps`, so passing them changes nothing. On DevNet a "reduce-only" market order opened a short. Typos such as `postonly` are dropped the same way.
- **No engine version check.** 9.2.0 ran against DevNet's newer protocol without a warning.
- **`seq` wraps instead of being rejected:** 2^64 signs as 0, and -1 as 2^64-1.
- **README:** it says an empty `queryTriggerMarketConfigs()` means triggers are disabled, but they still work.

## Outside the SDK

- DevNet perps and conditionals have tick size 0, so triggers are refused.
- The gateway returns HTTP 500 for malformed envelopes, which the SDK reports as pending.

## What held up

Encoding, signing and error decoding match the conformance vectors byte for byte. Witness checks reject every tampered input. Order, cancel and amend hold up under concurrency.
