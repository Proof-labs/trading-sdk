#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { chromium } from "playwright";

const requestedOutput = process.argv[2];
if (!requestedOutput) {
  throw new Error("usage: browser-smoke.mjs CONSUMER_DIR");
}
const consumerDir = isAbsolute(requestedOutput)
  ? requestedOutput
  : resolve(process.cwd(), requestedOutput);

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not allocate a preview port");
  }
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function waitForServer(url, preview, logs) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error(
        `Vite preview exited early (${preview.exitCode}):\n${logs()}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview socket is not accepting connections yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Vite preview did not become ready:\n${logs()}`);
}

const port = await unusedPort();
const url = `http://127.0.0.1:${port}/`;
const output = [];
// Spawn Vite directly. Going through `npm run preview` leaves Vite as a
// grandchild; killing the npm wrapper can orphan the server with its pipe file
// descriptors still open, which makes an otherwise-passing CI job hang.
const viteBin = resolve(consumerDir, "node_modules", "vite", "bin", "vite.js");
const preview = spawn(
  process.execPath,
  [
    viteBin,
    "preview",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: consumerDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
preview.stdout.on("data", (chunk) => output.push(chunk.toString()));
preview.stderr.on("data", (chunk) => output.push(chunk.toString()));

async function stopPreview() {
  async function waitForExit(timeoutMs) {
    if (preview.exitCode !== null) return;
    await new Promise((resolveExit) => {
      const timer = setTimeout(resolveExit, timeoutMs);
      preview.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  if (preview.exitCode === null) {
    preview.kill("SIGTERM");
    await waitForExit(2_000);
  }
  if (preview.exitCode === null) {
    preview.kill("SIGKILL");
    await waitForExit(2_000);
  }
  preview.stdout.destroy();
  preview.stderr.destroy();
  if (preview.exitCode === null) {
    preview.unref();
    throw new Error("Vite preview did not terminate after SIGKILL");
  }
}

let browser;
try {
  await waitForServer(url, preview, () => output.join("").slice(-4_000));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const browserErrors = [];
  const wasmResponses = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) =>
    browserErrors.push(error.stack || error.message),
  );
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.endsWith(".wasm")) {
      wasmResponses.push({ status: response.status(), url: response.url() });
    }
  });

  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () =>
      globalThis.__proofSdkSmoke?.status === "passed" ||
      globalThis.__proofSdkSmoke?.status === "failed",
    null,
    { timeout: 30_000 },
  );
  const result = await page.evaluate(() => globalThis.__proofSdkSmoke);
  if (result?.status !== "passed") {
    throw new Error(
      `browser codec smoke failed: ${JSON.stringify(result)}\n${browserErrors.join("\n")}`,
    );
  }
  if (
    wasmResponses.length !== 1 ||
    wasmResponses[0].status < 200 ||
    wasmResponses[0].status >= 300
  ) {
    throw new Error(
      `expected one successful WASM response, got ${JSON.stringify(wasmResponses)}`,
    );
  }
  console.log(
    `packaged Vite browser smoke: ok (${wasmResponses[0].status}, ${result.payloadHex})`,
  );
} finally {
  if (browser) await browser.close();
  await stopPreview();
}
