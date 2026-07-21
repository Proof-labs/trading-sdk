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
          "@proof/trading-sdk": "file:./proof-sdk.tgz",
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
  TimeInForce,
  bytesToHex,
  encodePayloadBytes,
  ready,
} from "@proof/trading-sdk";

const expected =
  "9901dc00140101010101010101010101010101010101010101a3427579640ac0c2c2a3477463";
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
  globalThis.__proofSdkSmoke = { status: "passed", payloadHex };
  result.textContent = \`proof-sdk-wasm-ok:\${payloadHex}\`;
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
