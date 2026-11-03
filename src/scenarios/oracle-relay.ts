// Test-only: prices a market through both F16 relay keys, as production does.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ExchangeClient } from "../client.js";
import { bytesToHex, getPublicKey, hexToBytes } from "../crypto.js";
import type { OraclePermissions } from "../oracle-permissions.js";

const run = promisify(execFile);
const CERTIFY_TIMEOUT_MS = 30_000;

export interface OracleRelayOptions {
  gatewayUrl: string;
  /** Path to the `f16-relay` binary. */
  relayBin: string;
  /** Hex Ed25519 keys of the market policy's two sources. */
  primaryPrivateKey: string;
  fallbackPrivateKey: string;
}

export interface OracleRelay {
  /** Resolves once the chain certifies `price` for `market`. */
  setPrice(market: number, price: bigint): Promise<void>;
}

export function oracleRelay(opts: OracleRelayOptions): OracleRelay {
  const reader = new ExchangeClient({ gatewayUrl: opts.gatewayUrl });
  // f16-relay reads raw 32-byte seed files.
  const dir = mkdtempSync(join(tmpdir(), "sdk-oracle-relay-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const keys = [opts.primaryPrivateKey, opts.fallbackPrivateKey].map(
    (hex, index) => {
      const seed = hexToBytes(hex).subarray(0, 32);
      const path = join(dir, `source-${index}.seed`);
      writeFileSync(path, seed, { mode: 0o600 });
      return { path, authority: bytesToHex(getPublicKey(seed)) };
    },
  );
  let chain: Promise<string> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const chainName = () =>
    (chain ??= fetch(`${opts.gatewayUrl}/v1/status`)
      .then((r) => r.json())
      .then(
        (s) =>
          (s as { result: { node_info: { network: string } } }).result.node_info
            .network,
      ));

  async function send(market: number, price: bigint): Promise<void> {
    const read = await reader.queryOraclePermissions(market);
    const policy = read.policy;
    if (!policy) {
      throw new Error(`market ${market} has no oracle policy on this chain`);
    }
    const sources = keys.map((key) => {
      const source = policy.sources.find((s) => s.authority === key.authority);
      if (!source) {
        throw new Error(
          `market ${market}: key ${key.authority} is not an oracle source of its policy`,
        );
      }
      return { ...key, id: source.id };
    });
    const time = publishTime(read);
    const chainId = await chainName();
    for (const source of sources) {
      await run(opts.relayBin, [
        "observe",
        opts.gatewayUrl,
        chainId,
        source.path,
        String(market),
        String(policy.version),
        String(source.id),
        String(time),
        String(price),
      ]);
    }
    const deadline = Date.now() + CERTIFY_TIMEOUT_MS;
    for (;;) {
      const verdict = (await reader.queryOraclePermissions(market)).verdict;
      if (
        verdict?.certified?.price === price &&
        verdict.certified.providerTime === time
      )
        return;
      if (Date.now() > deadline) {
        throw new Error(
          `market ${market}: price ${price} not certified in ${CERTIFY_TIMEOUT_MS}ms ` +
            `(status ${verdict?.status}, reason ${verdict?.reason})`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  return {
    // Publish times must rise per source, so sends go one at a time.
    setPrice(market, price) {
      const next = queue.then(() => send(market, price));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

/** Newer than both sources' last observation and no older than the chain clock. */
function publishTime(read: OraclePermissions): bigint {
  const verdict = read.verdict;
  let floor = 0n;
  for (const time of verdict?.currentTimes ?? []) {
    if (time !== null && time >= floor) floor = time + 1n;
  }
  const now = verdict?.blockTime ?? BigInt(Date.now());
  return now > floor ? now : floor;
}
