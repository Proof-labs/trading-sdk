/** Same-view transport for the existing oracle policy read, not a price selector. */
import { marketId, invalidRead } from "./read-values.js";
import {
  boundedGatewayJson,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";
import { decodeWitnessedRead } from "./finalized-account-reads.js";
import {
  decodeOraclePermissions,
  type OraclePermissions,
} from "./oracle-permissions.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import { ready } from "./wasm-loader.js";

export interface FinalizedOraclePermissions extends OraclePermissions {
  witness: FinalizedReadWitness;
}
/** Requires ready(). Refusals and Legacy remain data, never a healthy fallback. */
export function decodeFinalizedOraclePermissions(
  value: unknown,
  market: number,
): FinalizedOraclePermissions {
  marketId(market);
  const { raw, witness } = decodeWitnessedRead(value);
  const result = decodeOraclePermissions(raw, market);
  if (
    result.finalizedHeight !== witness.height ||
    (result.verdict &&
      result.verdict.blockTime !== witness.finalizedBlockTimeMs)
  ) {
    invalidRead("oracle witness mismatch", "binding");
  }
  return { ...result, witness };
}
export async function readFinalizedOraclePermissions(
  gateway: string,
  market: number,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedOraclePermissions> {
  marketId(market);
  const captured = { ...options };
  captured.signal?.throwIfAborted();
  return decodeFinalizedOraclePermissions(
    await boundedGatewayJson(
      `${gateway.replace(/\/+$/, "")}/v1/oracle/permissions/${market}?witness=1`,
      transport,
      captured,
      { prepare: ready },
    ),
    market,
  );
}
