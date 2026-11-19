// `GET /v1/deposit-address/{account}`: the Solana address an account's USDC
// deposits go to. api-gateway passes the deposit address service's answer
// through unchanged; Proof-labs/deposit-address-service `tests/routes.rs`
// pins every body, and `conformance/deposit-address.json` (frozen example F2)
// is the shared copy.

import { DepositAddressError } from "./errors.js";
import { boundedGatewayRead, type BoundedReadOptions } from "./bounded-read.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import { invalidRead, type HexAddress } from "./read-values.js";

/** The account's deposit address exists on Solana. */
export interface DepositAddressReady {
  status: "ready";
  /**
   * The deposit authority (base58): the address a wallet sends USDC to.
   * It is not the token account; a wallet derives that itself.
   */
  address: string;
  /** The USDC token account the deposit authority owns (base58). */
  tokenAccount: string;
  /** When the address was created, in Unix seconds; `null` when unknown. */
  createdAt: number | null;
}

/**
 * The service is still creating the deposit address. Ask again after
 * `retryAfterMs` milliseconds (0 to `MAX_RETRY_AFTER_MS`, five minutes). The
 * gateway answers this with HTTP 202.
 */
export interface DepositAddressPending {
  status: "pending";
  retryAfterMs: number;
}

/** The answer to `ExchangeClient.queryDepositAddress`. */
export type DepositAddress = DepositAddressReady | DepositAddressPending;

/** The error codes the deposit address service answers with. */
export const DEPOSIT_ADDRESS_ERROR_CODES = [
  /** 400: the account is not `0x` followed by 40 hex digits. */
  "InvalidAccount",
  /** 403: the account is a sub-account; deposits go to its main account. */
  "SubAccount",
  /** 429: too many requests; see `DepositAddressError.retryAfterMs`. */
  "RateLimited",
  /** 503: deposit addresses are unavailable; try again later. */
  "Unavailable",
] as const;

export type DepositAddressErrorCode =
  (typeof DEPOSIT_ADDRESS_ERROR_CODES)[number];

/** True when `code` is one of the deposit address service's error codes. */
export function isDepositAddressErrorCode(
  code: unknown,
): code is DepositAddressErrorCode {
  return (
    typeof code === "string" &&
    (DEPOSIT_ADDRESS_ERROR_CODES as readonly string[]).includes(code)
  );
}

/** Longest wait the SDK reports, so a huge value cannot overflow a timer. */
export const MAX_RETRY_AFTER_MS = 300_000;

// A Solana public key in base58: 32 bytes encode to 32-44 characters.
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const isWholeNumber = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;

const clampRetry = (ms: number): number => Math.min(ms, MAX_RETRY_AFTER_MS);

/** The account as the gateway takes it, `0x` and 40 lowercase hex digits.
 * Accepts the hex with or without `0x`/`0X`, in either case; anything else
 * throws `GatewayReadError` with kind `"configuration"` and field `account`. */
export function depositAccount(account: unknown): HexAddress {
  const hex =
    typeof account === "string" ? account.replace(/^0x/i, "") : undefined;
  if (hex === undefined || !/^[0-9a-fA-F]{40}$/.test(hex))
    invalidRead("account", "configuration");
  return `0x${hex.toLowerCase()}` as HexAddress;
}

/**
 * Read `GET /v1/deposit-address/{account}` within one deadline
 * (`options.timeoutMs`, default 5 seconds) and a 1 MiB body cap. 200 must be
 * `ready` and 202 `pending`; any other success throws `GatewayReadError`
 * with kind `"malformed"` and the offending field. A non-2xx answer throws
 * `DepositAddressError` (a `GatewayHttpError`) with the gateway's
 * `errorCode`, `retryAfterMs` and an unread copy of the response.
 */
export async function queryDepositAddressAnswer(
  url: string,
  transport: ExchangeHttpTransport,
  options: BoundedReadOptions,
): Promise<DepositAddress> {
  const { status, body } = await boundedGatewayRead(url, transport, options, {
    purpose: "account",
    refusal: depositAddressError,
  });
  const answer = decodeDepositAddress(status, body);
  options.signal?.throwIfAborted();
  return answer;
}

function decodeDepositAddress(status: number, body: unknown): DepositAddress {
  // boundedGatewayRead only returns JSON objects.
  const fields = body as Record<string, unknown>;
  if (status === 200 && fields.status === "ready") {
    const { address, tokenAccount, createdAt } = fields;
    if (typeof address !== "string" || !BASE58_PUBKEY.test(address))
      invalidRead("address");
    if (
      typeof tokenAccount !== "string" ||
      !BASE58_PUBKEY.test(tokenAccount) ||
      tokenAccount === address
    )
      invalidRead("tokenAccount");
    if (createdAt !== null && !isWholeNumber(createdAt))
      invalidRead("createdAt");
    return { status: "ready", address, tokenAccount, createdAt };
  }
  if (status === 202 && fields.status === "pending") {
    if (!isWholeNumber(fields.retryAfterMs)) invalidRead("retryAfterMs");
    return { status: "pending", retryAfterMs: clampRetry(fields.retryAfterMs) };
  }
  return invalidRead("status");
}

async function depositAddressError(
  status: number,
  copy: Response,
): Promise<DepositAddressError> {
  // The error keeps an unread copy, so callers can still read the body.
  const unread = copy.clone();
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = await copy.json();
    if (parsed !== null && typeof parsed === "object")
      fields = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy's HTML page, say): the status alone is the answer.
  }
  const errorCode =
    typeof fields.errorCode === "string" ? fields.errorCode : undefined;
  const detail = typeof fields.error === "string" ? fields.error : undefined;
  return new DepositAddressError(
    status,
    unread,
    errorCode,
    detail,
    retryAfterMs(fields.retryAfterMs, copy.headers.get("retry-after")),
  );
}

/**
 * When to try again, in milliseconds from now, clamped to
 * `0..MAX_RETRY_AFTER_MS`. The body's `retryAfterMs` is exact and wins; else
 * the `Retry-After` header (RFC 9110 section 10.2.3), either whole seconds or
 * an HTTP-date, which counts from the local clock and is 0 once past.
 */
function retryAfterMs(
  bodyValue: unknown,
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  if (isWholeNumber(bodyValue)) return clampRetry(bodyValue);
  const value = header?.trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return clampRetry(Number(value) * 1000);
  // An HTTP-date starts with the day name, which keeps Date.parse from
  // reading other text as a date. All three forms are GMT; the obsolete
  // asctime form does not say so, so say it for Date.parse.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? /.test(value)) return undefined;
  const at = Date.parse(/GMT$/.test(value) ? value : `${value} GMT`);
  if (!Number.isFinite(at)) return undefined;
  return clampRetry(Math.max(0, Math.ceil(at - now)));
}
