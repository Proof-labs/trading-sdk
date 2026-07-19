import { decodeExecError } from "./errors.js";
import type { TxEvent, TxResult } from "./types.js";

/**
 * Constructors for {@link TxResult}. Centralising them keeps the `ok` /
 * `outcome` / `error` tags consistent across every submission path (gateway,
 * CometBFT, inclusion polling) and makes the classification unit-testable
 * without a live node — see `tx-result.test.ts`.
 *
 * The numeric `code` values are deliberately unchanged from the pre-tag SDK
 * (0 success; engine `ExecError` 1..48/255; synthesized HTTP 401/429/413/500/1;
 * `-1` timeout). The new `outcome` tag is what lets callers tell an engine
 * rejection apart from a transport failure that happens to reuse a small
 * integer `code`.
 */

/** Optional fields shared by success and post-execution error results. */
export interface TxResultBody {
  /** Transaction hash (hex). Defaults to `""` when the tx never got one. */
  hash?: string;
  /** Block height at inclusion, when known. */
  height?: number;
  /** Human-readable log line. */
  log?: string;
  /** ABCI events emitted by the tx. */
  events?: TxEvent[];
}

/** CheckTx accepted the transaction (`code === 0`). */
export function txOk(body: TxResultBody = {}): TxResult {
  return {
    ok: true,
    outcome: "ok",
    code: 0,
    error: null,
    hash: body.hash ?? "",
    height: body.height,
    log: body.log,
    events: body.events,
  };
}

/**
 * The engine rejected the transaction with an `ExecError` `code`. The decoded
 * `{ name, description }` is attached automatically so callers do not have to
 * call `decodeExecError` themselves; it is `null` for codes not in the table.
 */
export function txEngineError(code: number, body: TxResultBody = {}): TxResult {
  return {
    ok: false,
    outcome: "engine",
    code,
    error: decodeExecError(code, body.log),
    hash: body.hash ?? "",
    height: body.height,
    log: body.log,
    events: body.events,
  };
}

/**
 * A gateway / HTTP-level failure (auth, rate-limit, oversized body, 5xx,
 * non-JSON body). `code` is the synthesized HTTP status — NOT an engine code,
 * which is exactly why `outcome` is `"transport"`: callers must not read `code`
 * as an `ExecError` here.
 */
export function txTransportError(
  code: number,
  log: string,
  hash = "",
): TxResult {
  return { ok: false, outcome: "transport", code, error: null, hash, log };
}

/**
 * No final chain verdict is available yet (`code === -1`). This covers both a
 * hash-only ambiguous gateway response and inclusion polling that expired; the
 * transaction may still commit and should be reconciled by `hash`.
 */
export function txTimeout(hash: string, log: string): TxResult {
  return { ok: false, outcome: "timeout", code: -1, error: null, hash, log };
}

/**
 * Classify a raw status code that came from an *executed* transaction (a
 * CheckTx result or a `/v1/tx` poll): `0` → success, anything else → engine
 * error. Do NOT use this for transport failures — their HTTP status must be
 * tagged with {@link txTransportError} so it is not mistaken for an engine code.
 */
export function txFromEngineCode(
  code: number,
  body: TxResultBody = {},
): TxResult {
  return code === 0 ? txOk(body) : txEngineError(code, body);
}
