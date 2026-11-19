// `GET /v1/deposit-address/{account}`: the Solana address an account's USDC
// deposits go to. api-gateway passes the deposit address service's answer
// through unchanged; Proof-labs/deposit-address-service `tests/routes.rs`
// pins every body, and `conformance/deposit-address.json` (frozen example F2)
// is the shared copy.

import { DepositAddressError } from "./errors.js";

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
 * `retryAfterMs` milliseconds. The gateway answers this with HTTP 202.
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

// A Solana public key in base58: 32 bytes encode to 32-44 characters.
const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const isWholeNumber = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;

/**
 * Read a deposit address answer. 200 must be `ready` and 202 `pending`; any
 * other success is malformed and throws a plain `Error`. A non-2xx answer
 * throws `DepositAddressError` (a `GatewayHttpError`) with the gateway's
 * `errorCode` and an unread copy of the response.
 */
export async function readDepositAddressAnswer(
  res: Response,
): Promise<DepositAddress> {
  if (!res.ok) throw await depositAddressError(res);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Deposit address answer (${res.status}) is not JSON`);
  }
  const fields =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  if (res.status === 200 && fields.status === "ready") {
    const { address, tokenAccount, createdAt } = fields;
    if (
      typeof address === "string" &&
      BASE58_PUBKEY.test(address) &&
      typeof tokenAccount === "string" &&
      BASE58_PUBKEY.test(tokenAccount) &&
      (createdAt === null || isWholeNumber(createdAt))
    ) {
      return { status: "ready", address, tokenAccount, createdAt };
    }
  } else if (
    res.status === 202 &&
    fields.status === "pending" &&
    isWholeNumber(fields.retryAfterMs)
  ) {
    return { status: "pending", retryAfterMs: fields.retryAfterMs };
  }
  throw new Error(`Deposit address answer (${res.status}) is malformed`);
}

async function depositAddressError(
  res: Response,
): Promise<DepositAddressError> {
  // The error keeps an unread copy, so callers can still read the body.
  const unread = res.clone();
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed !== null && typeof parsed === "object")
      fields = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy's HTML page, say): the status alone is the answer.
  }
  const errorCode =
    typeof fields.errorCode === "string" ? fields.errorCode : undefined;
  const detail = typeof fields.error === "string" ? fields.error : undefined;
  return new DepositAddressError(
    res.status,
    unread,
    errorCode,
    detail,
    retryAfterMs(fields.retryAfterMs, res.headers.get("retry-after")),
  );
}

// The body's milliseconds are exact; the header is whole seconds, rounded up.
function retryAfterMs(
  bodyValue: unknown,
  header: string | null,
): number | undefined {
  if (isWholeNumber(bodyValue)) return bodyValue;
  if (header !== null && /^\d+$/.test(header.trim())) {
    const ms = Number(header.trim()) * 1000;
    if (Number.isSafeInteger(ms)) return ms;
  }
  return undefined;
}
