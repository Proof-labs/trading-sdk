// Test-only: oracle settings and prices through the F16 tools, as production does.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ExchangeClient } from "../client.js";
import { pacedTransport } from "./pacing.js";
import { bytesToHex, getPublicKey, hexToBytes } from "../crypto.js";
import { ExecErrorCode } from "../errors.js";
import type { OraclePermissions } from "../oracle-permissions.js";
import { ProposalFailed } from "./governance.js";

const run = promisify(execFile);
const CERTIFY_TIMEOUT_MS = 30_000;
const POLICY_VERSION = 1;
/** Blocks between proposing settings and their first use; a lapsed one retries longer. */
const ACTIVATION_RUNWAYS = [15n, 100n];
// proof-integration's test settings: always open, no recovery wait.
const SETTINGS = `
[policy]
max_age_ms = 86400000
future_skew_ms = 5000
pair_time_ms = 86400000
divergence_bps = 100
max_updates_per_block = 128

[anchor]
bucket_ms = 100
completed_buckets = 1

[recovery]
duration_ms = 1
distinct_blocks = 1

[calendar]
kind = "always_open"
lifetime_ms = 7776000000
interval_capacity = 64
provenance_statement = "proof.integration.calendar.always-open.v1"
reopen = "GovernedResetOnly"
manual_halt = false

[slots.primary]
source_id = 1
provider = "Binance"
relay = "primary"
raw_quote = "USDC"
confidence_required = false
max_confidence_bps = 50

[slots.fallback]
source_id = 2
provider = "Pyth"
relay = "fallback"
raw_quote = "USD"
confidence_required = false
max_confidence_bps = 50
`;

export interface OracleRelayOptions {
  gatewayUrl: string;
  /** Path to the `f16-relay` binary. */
  relayBin: string;
  /** Path to `f16-policy-bundle`; defaults to the one beside `relayBin`. */
  bundleBin?: string;
  /** Hex Ed25519 keys of the market policy's two sources. */
  primaryPrivateKey: string;
  fallbackPrivateKey: string;
}

export interface OracleRelay {
  /**
   * Generates `market`'s oracle settings, hands them to `propose` with an
   * effective height, and resolves once the policy is active.
   */
  installSettings(
    market: number,
    base: string,
    propose: (effectiveHeight: bigint, bundle: Uint8Array) => Promise<void>,
  ): Promise<void>;
  /** Resolves once the chain certifies `price` for `market`. */
  setPrice(market: number, price: bigint): Promise<void>;
}

export function oracleRelay(opts: OracleRelayOptions): OracleRelay {
  const reader = new ExchangeClient({
    gatewayUrl: opts.gatewayUrl,
    httpTransport: pacedTransport,
  });
  const dir = mkdtempSync(join(tmpdir(), "sdk-oracle-relay-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const keys = [opts.primaryPrivateKey, opts.fallbackPrivateKey].map(
    (hex, index) => {
      const key = hexToBytes(hex);
      // A 32-byte seed, or the 64-byte seed-plus-public-key form.
      if (key.length !== 32 && key.length !== 64) {
        throw new Error(
          `oracle source ${index}: key is ${key.length} bytes, want 32 or 64`,
        );
      }
      const seed = key.subarray(0, 32);
      return { index, seed, authority: bytesToHex(getPublicKey(seed)) };
    },
  );
  let chain: Promise<string> | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const chainName = () =>
    (chain ??= (async () => {
      const res = await pacedTransport(
        `${opts.gatewayUrl}/v1/status`,
        undefined,
        {
          purpose: "chain_id",
          priority: "critical",
          surface: "status_chain_id",
        },
      );
      if (!res.ok) throw new Error(`/v1/status returned HTTP ${res.status}`);
      const status = (await res.json()) as {
        result?: { node_info?: { network?: string } };
      };
      const network = status.result?.node_info?.network;
      if (!network) throw new Error("/v1/status has no node_info.network");
      return network;
    })());

  /** Runs f16-relay with a source's seed file present only for the call. */
  async function observe(
    key: (typeof keys)[number],
    args: (seedPath: string) => string[],
  ): Promise<void> {
    const path = join(dir, `source-${key.index}.seed`);
    writeFileSync(path, key.seed, { mode: 0o600 });
    try {
      await run(opts.relayBin, args(path));
    } finally {
      rmSync(path, { force: true });
    }
  }

  const bundleBin =
    opts.bundleBin ??
    (opts.relayBin.includes("/")
      ? join(dirname(opts.relayBin), "f16-policy-bundle")
      : "f16-policy-bundle");

  async function bundle(market: number, base: string): Promise<Uint8Array> {
    const contract = {
      format: 2,
      base_asset: base,
      instrument_basis: "spot",
      pyth_source_id: 2,
      binance_source_id: 1,
      pyth_usd_feed: "0".repeat(63) + "1",
      binance_usdc_symbol: `${base}USDC`,
      mapping_evidence_sha256: Array.from({ length: 32 }, () => 1),
    };
    const file = join(dir, `contract-${market}.json`);
    writeFileSync(file, JSON.stringify(contract));
    const params = join(dir, `settings-${market}.toml`);
    writeFileSync(
      params,
      `format = 1\nchain_id = "${await chainName()}"\npolicy_version = ${POLICY_VERSION}\n\n` +
        `[generation]\ninputs = ["effective_height", "calendar_start_ms", "primary_authority", "fallback_authority"]\n` +
        SETTINGS +
        `\n[[markets]]\nmarket = ${market}\nbase = "${base}"\ncontract = "${file}"\n` +
        `movement_bps = 10000\nmax_price_micro = 1000000000000000\n`,
    );
    const { stdout } = await run(bundleBin, [
      params,
      "--calendar-start-ms",
      String(Date.now() - 60_000),
      "--primary-authority",
      keys[0]!.authority,
      "--fallback-authority",
      keys[1]!.authority,
    ]);
    const generated = JSON.parse(stdout) as {
      markets: { market: number; bundle_hex: string }[];
    };
    const hex = generated.markets.find((m) => m.market === market)?.bundle_hex;
    if (!hex)
      throw new Error(`f16-policy-bundle wrote no bundle for ${market}`);
    return hexToBytes(hex);
  }

  async function installSettings(
    market: number,
    base: string,
    propose: (effectiveHeight: bigint, bundle: Uint8Array) => Promise<void>,
  ): Promise<void> {
    const settings = await bundle(market, base);
    let effectiveHeight = 0n;
    for (const runway of ACTIVATION_RUNWAYS) {
      const { finalizedHeight } = await reader.queryOraclePermissions(market);
      effectiveHeight = finalizedHeight + runway;
      try {
        await propose(effectiveHeight, settings);
        break;
      } catch (error) {
        if (runway === ACTIVATION_RUNWAYS.at(-1)) throw error;
        if (!(await lapsed(market, effectiveHeight, error))) throw error;
        console.warn(
          `market ${market}: retrying oracle settings with a longer runway after`,
          error,
        );
      }
    }
    // The timeout counts from the effective height, not from the proposal.
    let deadline = Date.now() + CERTIFY_TIMEOUT_MS;
    for (;;) {
      const read = await reader.queryOraclePermissions(market);
      if (read.policy) return;
      if (read.finalizedHeight < effectiveHeight) {
        deadline = Date.now() + CERTIFY_TIMEOUT_MS;
      } else if (Date.now() > deadline) {
        throw new Error(
          `market ${market}: oracle settings for height ${effectiveHeight} never became active`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Whether the engine refused the settings because the chain passed their effective height. */
  async function lapsed(
    market: number,
    effectiveHeight: bigint,
    error: unknown,
  ): Promise<boolean> {
    if (
      !(error instanceof ProposalFailed) ||
      error.code !== ExecErrorCode.InvalidMarketConfig
    ) {
      return false;
    }
    const { finalizedHeight } = await reader.queryOraclePermissions(market);
    return finalizedHeight >= effectiveHeight;
  }

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
      await observe(source, (seedPath) => [
        "observe",
        opts.gatewayUrl,
        chainId,
        seedPath,
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
    installSettings,
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
