# Web integration

Use `@proof-labs/trading-sdk` for gateway transport and signing. The application
retains wallet-provider integration, cache scheduling, reducers and display units.

## External signer

```ts
import { ExchangeClient } from "@proof-labs/trading-sdk";

const client = new ExchangeClient({
  gatewayUrl: "",
  chainId: "exchange-devnet-1",
});
client.setExternalSigner({ publicKey, signRaw }); // async Ed25519, returns 64 bytes
client.setUnsafeFastSubmit(true); // caller owns each delivery wait
await client.syncNonce(); // optional observation; never a sequential floor
const admitted = await client.submitTx(action);
const delivered = await client.waitForDelivery(admitted, { timeoutMs: 20_000 });
```

`setPrivateKey` and `setExternalSigner` replace one another. `signTx(action,
{signal})` supports offline signing and cancellation before broadcast. Signer
failure, invalid signatures and connection replacement reject without sending.
Inputs are copied before awaiting the signer. Each call reserves a distinct
millisecond nonce; failures never rewind it. `syncNonce` only remembers an observed
value to avoid; the engine accepts out-of-order timestamps, so a future retained
nonce does not become a local floor. `currentNonce` is the highest local allocation. Allocation beyond the clock safety
window rejects instead of repeating a nonce.

`submitSignedTx` / `submitSignedTxCommit` remain available for already signed
bytes. Raw callers own their chain ID and nonce; the connected-signer path owns
both. No payload extraction or dummy envelope is required.

A result with `height` is committed. `outcome: 'engine'` is a terminal engine
rejection; `outcome: 'transport'` is a terminal HTTP rejection. `outcome: 'ok'`
without height can be a legacy admission acknowledgement. `outcome: 'timeout'`
is uncertain and retains the transaction hash. Network/body interruption, HTTP
5xx and unclassified successful HTTP responses are uncertain. Delivery waits
only repeat reads, never writes. Cancelling or timing out a delivery wait returns
an uncertain result with the original hash; it does not cancel the transaction.

## Named reads

`GatewayReads({gatewayUrl, fetch?})` offers named methods with typed parameters
and a final `{signal?}` option. Its injected fetch receives the SDK-built URL,
body and signal, allowing existing application deadlines and concurrency limits.
Methods return the original `Response`; non-2xx responses throw
`GatewayHttpError` with `status` and `response`. Transport and abort errors retain
their original identity. No generic route or `/info` type escape hatch is exposed.

- `/info`: `meta`, `impactMarkets`, `impactMarket`, `allEvents` (wire `events`),
  `event`, `l2Book`, `fundingRate`, `clearinghouseState`, `nonce`, `openOrders`,
  `historyOrders`, `historyFills`, `historyTrades`, `historyPositions`,
  `historyResolutions`.
- GET: `ticker`, `health`, `oracleHealth`, `candles`, `accountEvents`.
- `gatewayUrl: ''` uses same-origin HTTP. Servers should supply an absolute URL.
- History wrappers and msgpack envelopes are unchanged. ISO candle bounds and
  resolution tokens are preserved. `/info` history windows use numeric bounds;
  they do not claim cursor support the gateway does not forward.

`client.queryPortfolioHistory(owner, {fromMs, toMs, limit?, cursor?, signal?})`
returns one oldest-first `{points, nextCursor}` page. Keep `[fromMs, toMs)` fixed
across cursors. `accountValue` is bigint micro-USDC and `equitySource` preserves
source provenance (including unknown strings and null). Malformed owners, ranges,
unsafe integer values, owner mismatches and invalid points reject. Cursors remain
opaque. The caller owns complete-page accumulation and repeated-cursor detection.

## Multiplexed feed

`GatewayFeed` preserves the exchange SDK's `/ws` constructor, frame shapes,
subscribe/unsubscribe helpers, refcounts, heartbeat and reconnect lifecycle.
`client.feed(opts?)` shares one feed; `client.disconnect()` closes it.
`subscribeOrderbook` and `subscribeTrades` are client conveniences.
For authenticated accounts use `client.subscribeAccount(callback, {owner})` or
configure the shared feed with `accountAuth: owner => client.accountAuth(owner)`.
`GatewayFeed.subscribeAccount(owner, callback, authProvider)` also accepts a
per-subscription provider. The provider runs on every subscribe/reconnect; pending
auth never sends unsigned frames, and stale completions after unsubscribe, close
or reconnect are discarded. Static raw auth params remain supported for existing
callers. `accountAuth` supports direct owner keys and existing gateway bytes only;
it does not infer agent delegation. `timestamp_ms`/`after_id` are JSON numbers;
unsafe cursors reject rather than lose precision.

A reconnect replays subscriptions and receives fresh snapshots. Missed live events
are **not** replayed. Account auth params are forwarded unchanged except that they
cannot override the subscribed owner. Browser WebSockets cannot send API-key upgrade headers; private gateways use
the SDK-generated signed subscription fields. Feed auth failures surface via
`onError`; applications keep their existing HTTP fallback. Watch-only clients on
open gateways can explicitly omit auth. Account switching must still dispose the
old FE subscription; signed auth validates that owner matches the connected key. Existing standalone
`subscribeAccountEvents` / `subscribeOrderbookDeltas` methods remain separate.

## Contract evidence

`src/fixtures/web-legacy-codec-vectors.json` was captured by the frontend workstream
from incumbent `@exchange/sdk` 0.4.0 and `@proof/trading-sdk` 3.0.0 before migration. It is never regenerated from
this SDK. Tests pin fifteen action envelopes across nonce widths, action IDs and the
chain signing domain, plus external/private-key byte parity. Codec, crypto, wire
crates and backend sources are unchanged.

## Runtime and scope

The new browser APIs use ES2022, fetch, WebSocket and AbortController. They do not
require `structuredClone`, `URLSearchParams.size` or `AbortSignal.any`/`timeout`.
The npm package still declares Node >=20. The local tarball keeps its existing
version and is not a registry release; release numbering is separate.

ADR-0002 predates the existing Web-UI oracle-health consumer and states there are
no trading/admin consumers. This explicitly authorized migration preserves that
consumer through a named raw gateway read; it adds no monitoring model or new
source of truth. The ADR and organization decision register remain unchanged.
This task-specific scope override does not ratify a new organization-wide policy.

Client-level watch-only streams can explicitly omit auth with
`subscribeAccount(callback, { owner, auth: false })` or
`subscribeAccountEvents(owner, callback, { auth: false })`. Private gateways may reject unsigned subscriptions.
`feed(options)` configures the shared feed only on its first call; its default auth provider reads the current signer on every subscribe/reconnect.
Signing inputs support the SDK Action schema (acyclic data and Uint8Array bytes), not arbitrary structured-clone values.
