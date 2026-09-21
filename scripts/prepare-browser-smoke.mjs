#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedOutput = process.argv[2];
if (!requestedOutput) {
  throw new Error("usage: prepare-browser-smoke.mjs OUTPUT_DIR");
}
const outputDir = isAbsolute(requestedOutput)
  ? requestedOutput
  : resolve(root, requestedOutput);
const packDir = mkdtempSync(join(tmpdir(), "proof-sdk-pack-"));

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function filesBelow(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesBelow(path) : [path];
  });
}

try {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(join(outputDir, "src"), { recursive: true });

  // Pack exactly what a registry consumer receives. `--ignore-scripts` avoids
  // rebuilding here: the caller must run the SDK build first, and npm-pack
  // omits anything outside package.json's published `files` allowlist.
  const packOutput = run(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", packDir],
    root,
  );
  const packed = JSON.parse(packOutput);
  if (!Array.isArray(packed) || packed.length !== 1 || !packed[0].filename) {
    throw new Error(`unexpected npm pack output: ${packOutput}`);
  }
  cpSync(join(packDir, packed[0].filename), join(outputDir, "proof-sdk.tgz"));

  writeFileSync(
    join(outputDir, "package.json"),
    JSON.stringify(
      {
        name: "proof-sdk-browser-consumer-smoke",
        private: true,
        type: "module",
        scripts: {
          build: "vite build",
          preview: "vite preview",
        },
        dependencies: {
          "@proof-labs/trading-sdk": "file:./proof-sdk.tgz",
        },
        devDependencies: {
          vite: "8.1.5",
        },
      },
      null,
      2,
    ) + "\n",
  );

  writeFileSync(
    join(outputDir, "index.html"),
    `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Proof SDK browser smoke</title></head>
  <body><main id="result">starting</main><script type="module" src="/src/main.js"></script></body>
</html>
`,
  );

  writeFileSync(
    join(outputDir, "src/main.js"),
    `import {
  Side,
  ExchangeClient,
  GatewayFeed,
  getPublicKey,
  sign,
  decodeTx,
  signAndEncode,
  TimeInForce,
  bytesToHex,
  decodeTriggerMarketConfigInfos,
  decodeTriggerMarketHistoryPage,
  encodePayloadBytes,
  ready,
} from "@proof-labs/trading-sdk";

const expected =
  "9b01dc00140101010101010101010101010101010101010101a3427579640ac0c2c2a3477463c0c0";
const expectedTrigger =
  "9607dc0014cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca5cca50393ce000173184b0b93ce0001adb0320c09";
const result = document.querySelector("#result");

try {
  await ready();
  const payload = encodePayloadBytes({
    type: "PlaceOrder",
    data: {
      market: 1,
      owner: new Uint8Array(20).fill(1),
      side: Side.Buy,
      price: 100n,
      quantity: 10n,
      clientOrderId: null,
      postOnly: false,
      reduceOnly: false,
      timeInForce: TimeInForce.Gtc,
    },
  });
  const payloadHex = bytesToHex(payload);
  if (payloadHex !== expected) {
    throw new Error(\`payload mismatch: got \${payloadHex}, expected \${expected}\`);
  }
  const triggerPayloadHex = bytesToHex(encodePayloadBytes({
    type: "SetPositionTriggers",
    data: {
      market: 7,
      owner: new Uint8Array(20).fill(0xa5),
      expectedPositionEpoch: 3n,
      stopLoss: { triggerPrice: 95000n, maxSlippageBps: 75, clientTriggerId: 11n },
      takeProfit: { triggerPrice: 110000n, maxSlippageBps: 50, clientTriggerId: 12n },
      clientGroupId: 9n,
    },
  }));
  if (triggerPayloadHex !== expectedTrigger) {
    throw new Error(\`trigger payload mismatch: got \${triggerPayloadHex}, expected \${expectedTrigger}\`);
  }
  const history = decodeTriggerMarketHistoryPage(
    { trigger_market_events: [], next_cursor: "" },
    7,
  );
  if (history.nextCursor !== "" || history.triggerMarketEvents.length !== 0) {
    throw new Error("trigger history package export returned malformed empty page");
  }
  const configs = decodeTriggerMarketConfigInfos([
    [7, [[1n, true, 250, 5000n, 1000n, 32n], null]],
  ]);
  if (configs.length !== 1 || configs[0].state.current?.maxTriggerSlippageBps !== 250) {
    throw new Error("trigger market config package export returned malformed policy");
  }
  const client = new ExchangeClient({ gatewayUrl: "", chainId: "exchange-devnet-1" });
  const seed = new Uint8Array(32).fill(13);
  client.setExternalSigner({ publicKey: getPublicKey(seed), signRaw: async message => sign(seed, message) });
  const action = { type: "CancelAllOrders", data: { owner: client.getAddress(), market: 1 } };
  const signed = await client.signTx(action);
  const seq = decodeTx(signed).seq;
  if (bytesToHex(signed) !== bytesToHex(signAndEncode(client.getChainId(), action, seq, seed))) {
    throw new Error("external signer browser byte parity failed");
  }
  const reads = new ExchangeClient({ gatewayUrl: "" }).reads({ fetch: async (url, init) => {
    if (url !== "/info" || JSON.parse(init.body).type !== "events") throw new Error("browser named read contract");
    return new Response(JSON.stringify({ data: "unchanged" }));
  }});
  if ((await (await reads.events()).json()).data !== "unchanged") throw new Error("browser response contract");
  if (!(client.feed() instanceof GatewayFeed)) throw new Error("feed export missing");
  const auth = await client.accountAuth();
  if (typeof auth.timestamp_ms !== "number" || auth.public_key !== bytesToHex(getPublicKey(seed))) throw new Error("browser account auth contract");
  const savedFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({result:{height:"42",tx_result:{info:"browser-omitted-code"}}}));
    const delivered = await client.waitForDelivery({ok:false,outcome:"timeout",code:-1,error:null,hash:"SMOKE"});
    if (delivered.code !== 0 || delivered.info !== "browser-omitted-code") throw new Error("browser delivery parsing contract");
  } finally { globalThis.fetch = savedFetch; }
  client.disconnect();
  globalThis.__proofSdkSmoke = { status: "passed", payloadHex, triggerPayloadHex };
  result.textContent = \`proof-sdk-wasm-ok:\${triggerPayloadHex}\`;
} catch (error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  globalThis.__proofSdkSmoke = { status: "failed", error: message };
  result.textContent = \`proof-sdk-wasm-failed:\${message}\`;
  console.error(error);
}
`,
  );

  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    outputDir,
  );
  run("npm", ["run", "build"], outputDir);

  const emittedWasm = filesBelow(join(outputDir, "dist")).filter((path) =>
    path.endsWith(".wasm"),
  );
  if (emittedWasm.length !== 1) {
    throw new Error(
      `Vite emitted ${emittedWasm.length} WASM assets, expected exactly 1: ${emittedWasm.join(", ")}`,
    );
  }
  console.log(
    `packed consumer build: ok (${emittedWasm[0].slice(outputDir.length + 1)})`,
  );
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
