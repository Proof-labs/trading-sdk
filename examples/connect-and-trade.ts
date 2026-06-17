#!/usr/bin/env npx tsx
/**
 * Proof Trading SDK — end-to-end example
 *
 * Usage:
 *   npx tsx examples/connect-and-trade.ts          # read-only queries
 *   PROOF_FAUCET_TOKEN=<token> npx tsx examples/connect-and-trade.ts   # full trade cycle
 *
 * Environment variables:
 *   PROOF_GATEWAY_URL   (default: https://api.dev.proof.trade)
 *   PROOF_CHAIN_ID      (default: exchange-devnet-1)
 *   PROOF_FAUCET_URL    (default: https://faucet.dev.proof.trade)
 *   PROOF_FAUCET_TOKEN  (required to fund accounts and place orders)
 */

import {
  ExchangeClient,
  Side,
  generateKeypair,
  pubkeyToOwner,
  ownerToHex,
  bytesToHex,
} from "../src/index.js";

const GATEWAY_URL =
  process.env.PROOF_GATEWAY_URL ?? "https://api.dev.proof.trade";
const CHAIN_ID = process.env.PROOF_CHAIN_ID ?? "exchange-devnet-1";
const FAUCET_URL =
  process.env.PROOF_FAUCET_URL ?? "https://faucet.dev.proof.trade";
const FAUCET_TOKEN = process.env.PROOF_FAUCET_TOKEN;

info("=== Proof Trading SDK — Connect & Trade ===");
info(`Gateway: ${GATEWAY_URL}`);
info(`Chain:   ${CHAIN_ID}`);
info(
  `Mode:    ${FAUCET_TOKEN ? "read-write" : "read-only (set PROOF_FAUCET_TOKEN to trade)"}`,
);
info("");

// Step 1 — Check connectivity
info("--- 1. Health check ---");
const health = await fetchJSON(`${GATEWAY_URL}/health`);
info(`Status: ${health.status}  Height: ${health.height}`);
info("");

// Step 2 — List markets using the SDK
info("--- 2. Available markets ---");
const client = new ExchangeClient({
  rpcUrl: GATEWAY_URL,
  apiUrl: GATEWAY_URL,
  gatewayUrl: GATEWAY_URL,
  chainId: CHAIN_ID,
});
const markets = await client.queryMarkets();
const perpMarkets = markets.filter((m) => m.kind === "Perp" || !m.kind);
info(`  Total markets: ${markets.length} (${perpMarkets.length} perp)`);
for (const m of markets.slice(0, 5)) {
  info(
    `    Market ${m.market}: IM=${m.imBps}bps  MM=${m.mmBps}bps  ticker=${m.ticker ?? "—"}`,
  );
}
if (markets.length > 5) info(`    … and ${markets.length - 5} more`);
info("");

// Step 3 — Generate keys
info("--- 3. Generate keypair ---");
const { publicKey, privateKey } = generateKeypair();
const address = pubkeyToOwner(publicKey);
const addressHex = ownerToHex(address);
info(`Address: 0x${addressHex}`);
info(`Privkey: ${bytesToHex(privateKey)}  (save for future sessions)`);
info("");

// Step 4 — Fund via faucet
if (FAUCET_TOKEN) {
  info("--- 4. Fund account via faucet ---");
  const body = JSON.stringify({ address: `0x${addressHex}` });
  const res = await fetch(`${FAUCET_URL}/drip`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FAUCET_TOKEN}`,
    },
    body,
  });
  const drip = await res.json().catch(() => ({}));
  if (res.ok) {
    info("  Funded with ~10,000 USDC");
    // Wait for the deposit tx to land
    info("  Waiting for chain to credit account...");
    await new Promise((r) => setTimeout(r, 3000));
  } else {
    info(`  Faucet error: ${drip.error ?? res.statusText}`);
    if (res.status === 429) info("  (rate limited — try again later)");
    info("");
    process.exit(1);
  }
  info("");
} else {
  info("--- 4. Fund account ---");
  info(`  POST ${FAUCET_URL}/drip  body: {"address": "0x${addressHex}"}`);
  info("  (requires PROOF_FAUCET_TOKEN)");
  info("");
}

// Step 5 — Load key and query account
info("--- 5. Check account ---");
client.setPrivateKey(privateKey);
const account = await client.queryAccount(addressHex);
if (account) {
  info(`  Balance: $${fmt(account.balance)}  Equity: $${fmt(account.equity)}`);
  info(
    `  Positions: ${account.positions.length}  Margin ratio: ${account.marginRatioBps}bps`,
  );
} else {
  info("  Account not found (no deposit recorded on chain yet)");
}
info("");

// Step 6 — Place a limit order
if (FAUCET_TOKEN && account && account.balance > 0n) {
  info("--- 6. Place a limit order ---");
  const orderPrice = 50_000_00n; // $50,000.00 in cents
  info(
    `  Placing bid: market=1  side=Buy  price=$${fmt(orderPrice, 2)}  qty=1`,
  );

  const result = await client.submitTxCommit({
    type: "PlaceOrder",
    data: {
      market: 1,
      owner: address,
      side: Side.Buy,
      price: orderPrice,
      quantity: 1n,
    },
  });
  info(
    `  Result: code=${result.code}  height=${result.height ?? "?"}  hash=${result.hash}`,
  );
  if (result.code === 0) {
    info("  Order landed on chain ✓");
  } else {
    info(`  Rejected: ${result.log}`);
  }
  info("");

  // Step 7 — Check orderbook
  info("--- 7. Orderbook after placement ---");
  const book = await client.queryOrderbook(1);
  info(`  Bids: ${book.bids.length} levels  Asks: ${book.asks.length} levels`);
  if (book.bids.length > 0) {
    const top = book.bids[0];
    info(
      `  Best bid: $${fmt(top.price)}  qty=${top.totalQty}  orders=${top.orderCount}`,
    );
  }
  info("");

  // Step 8 — Cancel all orders
  info("--- 8. Cancel all orders on market 1 ---");
  const cancel = await client.submitTxCommit({
    type: "CancelAllOrders",
    data: { owner: address, market: 1 },
  });
  info(`  Result: code=${cancel.code}  height=${cancel.height ?? "?"}`);
  if (cancel.code === 0) info("  Orders cancelled ✓");
  info("");

  // Re-check account after cancel
  const account2 = await client.queryAccount(addressHex);
  if (account2) {
    info(`  Balance after: $${fmt(account2.balance)}`);
  }
} else if (!FAUCET_TOKEN) {
  info("--- 6. Place order ---");
  info("  (skipped — set PROOF_FAUCET_TOKEN to trade)");
  info("");
} else if (account && account.balance === 0n) {
  info("--- 6. Place order ---");
  info("  (skipped — no funds)");
  info("");
}

// Step 9 — WebSocket events (conceptual)
info("--- 9. Real-time events ---");
info("  Subscribe via the SDK:");
info(`    client.subscribeBlocks((event) => { ... })`);
info("  Or connect to the multiplexed WebSocket feed:");
info(`    wss://${new URL(GATEWAY_URL).host}/ws`);
info("");

info("=== Done ===");
client.disconnect();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function info(msg: string) {
  console.log(msg);
}

async function fetchJSON(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  return res.json();
}

/** Format micro-USDC or cents as a dollar string. */
function fmt(n: bigint | number, decimals = 6): string {
  const s = n.toString();
  const neg = s.startsWith("-");
  const abs = neg ? s.slice(1) : s;
  const padded = abs.padStart(decimals + 1, "0");
  const dotAt = padded.length - decimals;
  return (neg ? "-" : "") + padded.slice(0, dotAt) + "." + padded.slice(dotAt);
}
