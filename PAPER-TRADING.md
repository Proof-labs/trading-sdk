# Paper-Trading Competition — Getting Started

> **This guide is specifically for paper-trading competition participants.**
> If you are an internal developer testing against the raw devnet faucet, see
> the "Connect to the devnet" section of the [README](README.md) instead — that
> path requires a privileged faucet token you will not have as a competition
> participant.

The Proof paper-trading competition runs on the **real** exchange — the same
matching engine, margin system, and oracles as mainnet — but with **virtual
funds**. Nothing is deposited, nothing is withdrawable, and no real money is at
risk. You compete on a public PnL leaderboard for a small prize pool and a
**Founding Trader** credential.

## How funding works (read this first)

As a competition participant you do **not** generate your own keypair and you do
**not** call the faucet directly. Both happen **server-side**, gated behind a
**single-use access code**. One redemption gives you a freshly generated,
already-funded private key.

This is deliberate:

- The faucet is only reachable by burning a valid access code — no participant
  holds a faucet token, so the funding endpoint cannot be spammed.
- One account per person is enforced at the access-code level. Multiple accounts
  controlled by one person are grounds for disqualification.
- Your starting balance is fixed and identical for everyone. There are **no
  refills and no resets** — you manage one bankroll for the whole contest.

## Step 1 — Get an access code

Entry is free but **gated** — there is no open sign-up. Access codes are
single-use and admit one participant. Get one through a direct invitation, or
join the **waitlist** on the official contest page. Joining requires confirming
you meet the eligibility terms (age minimum, excluded jurisdictions); the
contest is void where prohibited.

You do **not** need to verify your identity to join or to trade — identity and
eligibility checks happen only at the prize-payout step, for finishers in a
prize position.

## Step 2 — Redeem the code for a funded wallet

Redeem your code against the contest web app (this is **not** the gateway and
**not** the SDK). A single POST returns a funded private key:

```bash
curl -X POST https://<contest-site>/access-code/redeem \
  -H "Content-Type: application/json" \
  -d '{"code": "YOUR-ACCESS-CODE", "contact": {"email": "you@example.com"}}'
```

The `contact` object is optional. On success you get HTTP `200`:

```json
{ "privateKeyHex": "abc123…", "address": "0x…" }
```

The server does everything atomically: reserves the code (single-use), generates
an Ed25519 keypair, funds the derived address through the faucet, and returns the
key. If funding fails, your code is automatically released so you can retry — a
failed drip never burns a code.

Error responses:

| Status | `error`                            | Meaning                                  |
| ------ | ---------------------------------- | ---------------------------------------- |
| `400`  | `bad_code`                         | Code is malformed                        |
| `404`  | `invalid_code`                     | Code is not valid                        |
| `409`  | `code_used`                        | Code has already been redeemed           |
| `502`  | `funding_failed`                   | Faucet error — code released, retry      |
| `503`  | `redeem_disabled`/`funding_failed` | Service not configured / faucet disabled |

## Step 3 — Save your private key

The `privateKeyHex` from Step 2 **is** your wallet. It is paper money and safe to
save. Store it somewhere you control — there are no refills or resets, so this
one key is your entire competition account.

## Step 4 — Trade with the SDK

Your address is already funded by Step 2, so skip key generation and the faucet
entirely. Load your key and trade:

```typescript
import { ExchangeClient, hexToBytes, Side } from "@proof/trading-sdk";

const client = new ExchangeClient({ chainId: "exchange-devnet-1" });
client.setPrivateKey(hexToBytes("abc123…")); // privateKeyHex from Step 2

// Query the book and your account
const book = await client.queryOrderbook(1);
const account = await client.queryAccount("0x…"); // address from Step 2

// Place an order — the wrapper fills `owner` from the loaded key
await client.placeOrder({
  market: 1,
  side: Side.Buy,
  price: 66_750_000_000n, // micro-USDC (6 dp) = $66,750.00
  quantity: 1n, // integer contracts
});
```

A result `code` of `0` means CheckTx passed. Non-zero codes are engine error
codes (e.g. `12` = insufficient margin, `21` = nonce collision).

See the [README](README.md) for the full client API and unit conventions, and
[AGENTS.md](AGENTS.md) for driving the SDK from an AI agent.

## Rules that affect how you trade

- **Programmatic trading is allowed.** Automated, API-driven, and algorithmic
  trading is permitted — Proof is built for it. The line is between automation
  and _gaming_ (wash trading, self-dealing, collusion, multi-account/Sybil
  entries, mark manipulation), not between manual and bot.
- **Low leverage cap.** Maximum leverage is held to a conservative level to keep
  the leaderboard a contest of skill rather than a max-leverage lottery.
- **Activity floor.** To qualify for final standings you must be genuinely
  active — more than a single trade. The principle is published; the exact
  threshold is blind during the contest.
- **Rate limits** exist to protect the infrastructure, not to ban automation.

The starting balance, exact dates, the specific markets, the prize breakdown,
and the binding rules all live on the **official contest page** — that page
governs. Read it before you enter.
