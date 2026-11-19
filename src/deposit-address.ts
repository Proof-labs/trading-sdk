// `GET /v1/deposit-address/{account}`: the Solana address an account's USDC
// deposits go to. api-gateway passes the deposit address service's answer
// through unchanged; Proof-labs/deposit-address-service `tests/routes.rs`
// pins every body, and `conformance/deposit-address.json` is the shared copy
// of those answers (ready, pending, sub-account and rate-limited).

import { boundedGatewayRead, type BoundedReadOptions } from "./bounded-read.js";
import type { ExchangeHttpTransport } from "./http-transport.js";
import {
  invalidRead,
  MAX_RETRY_AFTER_MS,
  type HexAddress,
} from "./read-values.js";

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
  /** 429: too many requests; see `GatewayHttpError.retryAfterMs`. */
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
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** True when `value` is base58 that decodes to exactly 32 bytes. */
function isSolanaPublicKey(value: unknown): value is string {
  if (typeof value !== "string" || !BASE58_PUBKEY.test(value)) return false;
  let n = 0n;
  for (const char of value) n = n * 58n + BigInt(BASE58_ALPHABET.indexOf(char));
  // Each leading "1" is one zero byte; the rest is the number's bytes.
  const zeros = /^1*/.exec(value)![0].length;
  const bytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
  return zeros + bytes === 32;
}

const isWholeNumber = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;

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
 * `GatewayHttpError` with the gateway's `errorCode`, `retryAfterMs` and an
 * unread copy of the response.
 */
export async function queryDepositAddressAnswer(
  url: string,
  transport: ExchangeHttpTransport,
  options: BoundedReadOptions,
): Promise<DepositAddress> {
  const { status, body } = await boundedGatewayRead(url, transport, options, {
    purpose: "account",
    decodeRefusal: true,
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
    if (!isSolanaPublicKey(address)) invalidRead("address");
    if (!isSolanaPublicKey(tokenAccount) || tokenAccount === address)
      invalidRead("tokenAccount");
    if (createdAt !== null && !isWholeNumber(createdAt))
      invalidRead("createdAt");
    return { status: "ready", address, tokenAccount, createdAt };
  }
  if (status === 202 && fields.status === "pending") {
    if (!isWholeNumber(fields.retryAfterMs)) invalidRead("retryAfterMs");
    return {
      status: "pending",
      retryAfterMs: Math.min(fields.retryAfterMs, MAX_RETRY_AFTER_MS),
    };
  }
  return invalidRead("status");
}
