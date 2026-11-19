import { GatewayHttpError, GatewayReadError } from "./errors.js";
import {
  chainPin,
  hash32,
  I64_MAX,
  MAX_ERROR_BODY_WAIT_MS,
  MAX_READ_BYTES,
  MAX_READ_CHUNKS,
  MAX_RETRY_AFTER_MS,
  readDeadline,
  type Hash32Hex,
} from "./read-values.js";
import { chainIdFromString } from "./crypto.js";
import { readContext, type ExchangeHttpTransport } from "./http-transport.js";

/** Deadline covers queueing, headers and the entire bounded response body. */
export interface BoundedReadOptions {
  signal?: AbortSignal;
  /** Default 5 seconds, matching existing reads; explicit maximum 60 seconds. */
  timeoutMs?: number;
}
/** The gateway's assertion of the finalized state a read was served from, NOT
 * validator signatures or a cryptographic event proof. How far a payload is
 * checked against it varies per read: some payloads carry no height or owner
 * to compare, and then the gateway's word is the only binding. verifyWitness
 * binds the height and app hash to a chain-qualified H+1 header, which proves
 * nothing beyond the gateway's word when that header came from the same
 * gateway. This is not freshness, solvency, or authorization to trade. */
export interface FinalizedReadWitness {
  version: 1;
  nodeId: string;
  height: bigint;
  finalizedBlockTimeMs: bigint;
  appHash: Hash32Hex;
}
/** Decode the `witness` object of a gateway answer. Throws a malformed
 * `GatewayReadError` for anything but a version 1 witness with canonical
 * decimal height and block time, a node id and a 32-byte app hash; with
 * `expectedHeight` or `expectedTimeMs`, also for a witness at another height
 * or time. It checks shape only: equal witnesses mean the gateway answered
 * from one finalized state, and `verifyWitness` binds that state to H+1. */
export function decodeFinalizedReadWitness(
  value: unknown,
  expectedHeight?: bigint,
  expectedTimeMs?: bigint,
): FinalizedReadWitness {
  const invalid = (): never => {
    throw new GatewayReadError(
      "malformed",
      "witness",
      "Invalid finalized read witness",
    );
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const w = value as Record<string, unknown>;
  const decimal = (value: unknown): bigint => {
    if (
      typeof value !== "string" ||
      value.length > 20 ||
      !/^[1-9][0-9]*$/.test(value)
    )
      invalid();
    const n = BigInt(value as string);
    if (n > I64_MAX) invalid();
    return n;
  };
  if (
    w.version !== 1 ||
    typeof w.nodeId !== "string" ||
    !/^[a-f0-9]{40}$/.test(w.nodeId) ||
    /^0+$/.test(w.nodeId) ||
    typeof w.appHash !== "string" ||
    !/^[a-fA-F0-9]{64}$/.test(w.appHash) ||
    /^0+$/.test(w.appHash)
  )
    invalid();
  const height = decimal(w.height);
  const finalizedBlockTimeMs = decimal(w.finalizedBlockTimeMs);
  if (
    (expectedHeight !== undefined && height !== expectedHeight) ||
    (expectedTimeMs !== undefined && finalizedBlockTimeMs !== expectedTimeMs)
  )
    throw new GatewayReadError(
      "binding",
      "witness",
      "Finalized witness height/time mismatch",
    );
  return {
    version: 1,
    nodeId: w.nodeId as string,
    height,
    finalizedBlockTimeMs,
    appHash: hash32(w.appHash),
  };
}
/** Run a decoder that throws plain `Error`s, re-throwing them as a malformed
 * `GatewayReadError` with the same message so callers can branch on `kind`. */
export function asReadError<T>(field: string, decode: () => T): T {
  try {
    return decode();
  } catch (error) {
    if (error instanceof GatewayReadError) throw error;
    throw new GatewayReadError(
      "malformed",
      field,
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
/** Compare a witness with an H+1 header. The check is only as strong as the
 * header's source: `reads().evidence.blockHeader` asks the same gateway that
 * served the witness and does not check validator signatures, so pairing the
 * two shows the gateway is self-consistent, not that the state is authentic.
 * H+1's timestamp is NOT H's timestamp, so it is deliberately not compared. */
export function verifyWitness(
  witness: FinalizedReadWitness,
  nextHeader: { height: bigint; chainId: string; appHash: string | null },
  chainId: string | Uint8Array,
): void {
  // The caller's pin is configuration; everything about the header is binding.
  if (
    typeof chainId === "string"
      ? !chainId || chainId.length > 128
      : !(chainId instanceof Uint8Array) || chainId.length !== 32
  ) {
    throw new GatewayReadError(
      "configuration",
      "chainId",
      "Witness verification requires an explicit chain pin",
    );
  }
  const expected = chainPin(
    typeof chainId === "string" ? chainIdFromString(chainId) : chainId,
  );
  const bindingFault = (): never => {
    throw new GatewayReadError(
      "binding",
      "witness",
      "Finalized witness/header/chain mismatch",
    );
  };
  if (
    typeof nextHeader.chainId !== "string" ||
    !nextHeader.chainId ||
    nextHeader.chainId.length > 128 ||
    (nextHeader.appHash !== null &&
      (typeof nextHeader.appHash !== "string" ||
        !/^[a-fA-F0-9]{64}$/.test(nextHeader.appHash)))
  )
    bindingFault();
  const actual = chainIdFromString(nextHeader.chainId);
  if (
    actual.some((byte, i) => byte !== expected[i]) ||
    witness.height < 1n ||
    witness.height >= I64_MAX ||
    nextHeader.height !== witness.height + 1n ||
    nextHeader.appHash === null ||
    hash32(witness.appHash) !== hash32(nextHeader.appHash)
  )
    bindingFault();
}

export function parseBoundedJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new GatewayReadError("malformed", "envelope");
  // The shared parser checks top-level duplicates. Nested trade rows and
  // witnesses must not acquire a second interpretation through repeated keys.
  const stack: { keys?: Set<string>; keyExpected: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const frame = stack.at(-1);
    if (char === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      if (frame?.keys && frame.keyExpected) {
        const key: string = JSON.parse(text.slice(start, i + 1));
        if (frame.keys.has(key))
          throw new GatewayReadError(
            "malformed",
            key,
            "Duplicate gateway read field",
          );
        frame.keys.add(key);
        frame.keyExpected = false;
      }
    } else if (char === "{" || char === "[") {
      stack.push({
        keys: char === "{" ? new Set() : undefined,
        keyExpected: char === "{",
      });
      if (stack.length > 32) throw new GatewayReadError("limit", "JSON depth");
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === "," && frame?.keys) frame.keyExpected = true;
  }
  return parsed;
}

/** Transport lane, plus setup that must finish inside the same deadline. */
export interface BoundedReadRequest {
  /** Owner-scoped reads take the account lane, like the unwitnessed reads. */
  purpose?: "account" | "query";
  /** Awaited after the deadline and cancellation are armed, e.g. `ready()`. */
  prepare?: () => Promise<void>;
  /** Success-body byte cap; defaults to `MAX_READ_BYTES` (1 MiB). A larger
   * cap raises the chunk limit in proportion. Error bodies keep 1 MiB. */
  maxBytes?: number;
  /** Decode the gateway's `errorCode`, `error` and retry time from a non-2xx
   * answer, as `gatewayHttpErrorFrom` does; by default the error carries the
   * status alone. */
  decodeRefusal?: boolean;
}
function concat(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
/** Retain a bounded, readable error body after cancelling the upstream. */
function boundedCopy(
  response: Response,
  bytes: Uint8Array<ArrayBuffer>,
): Response {
  const body = bytes.length ? bytes : null;
  let copy: Response;
  try {
    copy = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    // A custom transport can report a status (e.g. 304 with a body) that the
    // Response constructor refuses; the real status stays on the error.
    copy = new Response(body, { headers: response.headers });
  }
  return copy;
}
/** At most `MAX_READ_BYTES` of a refused answer's body. The status is the
 * diagnosis: a body that is oversized, fragmented, empty-chunked or slower
 * than `MAX_ERROR_BODY_WAIT_MS` is truncated to what arrived in bounds; it
 * never replaces the HTTP status or holds the caller for the whole deadline.
 * Caller cancellation (`cancelled`, `signal`) wins. Cancels the body after. */
async function readErrorBody(
  response: Response,
  read: {
    deadline?: number;
    cancelled?: Promise<never>;
    signal?: AbortSignal;
  } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) return concat(chunks, size);
  const reader = response.body.getReader();
  const bodyDeadline = Math.min(
    read.deadline ?? Infinity,
    performance.now() + MAX_ERROR_BODY_WAIT_MS,
  );
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  const budgetSpent = new Promise<"budget">((resolve) => {
    budgetTimer = setTimeout(
      () => resolve("budget"),
      Math.max(0, bodyDeadline - performance.now()),
    );
  });
  const racers = read.cancelled ? [budgetSpent, read.cancelled] : [budgetSpent];
  try {
    while (chunks.length < MAX_READ_CHUNKS && size < MAX_READ_BYTES) {
      const part = await Promise.race([reader.read(), ...racers]);
      if (part === "budget" || part.done || part.value.length === 0) break;
      const kept = part.value.subarray(0, MAX_READ_BYTES - size);
      chunks.push(kept);
      size += kept.length;
      if (performance.now() >= bodyDeadline) break;
    }
  } catch (error) {
    if (read.signal?.aborted) throw error;
  } finally {
    clearTimeout(budgetTimer);
    // Do not wait on an uncooperative custom stream's cancellation hook.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return concat(chunks, size);
}
const isWholeNumber = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const clampRetry = (ms: number): number => Math.min(ms, MAX_RETRY_AFTER_MS);
/** When to try again, in milliseconds from now, clamped to
 * `0..MAX_RETRY_AFTER_MS`. The body's `retryAfterMs` is exact and wins; else
 * the `Retry-After` header (RFC 9110 section 10.2.3), either whole seconds or
 * an HTTP-date, which counts from the local clock and is 0 once past. */
export function retryAfterMs(
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
/** Read a non-2xx gateway answer into a `GatewayHttpError` that keeps the
 * gateway's `errorCode`, `error` text and retry time (the body's
 * `retryAfterMs`, else the `Retry-After` header), with an unread copy of the
 * body bounded like every bounded read's error body (1 MiB, 250 ms). The
 * `/info` reads do not use it: they read their error bodies in full. */
export async function gatewayHttpErrorFrom(
  response: Response,
  read: Parameters<typeof readErrorBody>[1] = {},
): Promise<GatewayHttpError> {
  const bytes = await readErrorBody(response, read);
  let fields: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed !== null && typeof parsed === "object")
      fields = parsed as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy's HTML page, say): the status alone is the answer.
  }
  return new GatewayHttpError(
    response.status,
    boundedCopy(response, bytes),
    typeof fields.errorCode === "string" ? fields.errorCode : undefined,
    typeof fields.error === "string" ? fields.error : undefined,
    {
      retryAfterMs: retryAfterMs(
        fields.retryAfterMs,
        response.headers.get("retry-after"),
      ),
    },
  );
}
/** Internal one-shot SDK read. No retry, alternate endpoint or cached fallback. */
export async function boundedGatewayJson(
  url: string,
  transport: ExchangeHttpTransport,
  options: BoundedReadOptions,
  request: BoundedReadRequest = {},
): Promise<unknown> {
  return (await boundedGatewayRead(url, transport, options, request)).body;
}
/** `boundedGatewayJson`, also returning the 2xx status the body came with. */
export async function boundedGatewayRead(
  url: string,
  transport: ExchangeHttpTransport,
  options: BoundedReadOptions,
  request: BoundedReadRequest = {},
): Promise<{ status: number; body: unknown }> {
  const { timeoutMs } = readDeadline(options);
  const maxBytes = request.maxBytes ?? MAX_READ_BYTES;
  const maxChunks =
    MAX_READ_CHUNKS * Math.max(1, Math.ceil(maxBytes / MAX_READ_BYTES));
  options.signal?.throwIfAborted();
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const checkDeadline = () => {
    controller.signal.throwIfAborted();
    // A continuously ready stream can starve timers with resolved promises.
    // Check monotonic elapsed time too, independent of wall-clock changes.
    if (performance.now() >= deadline)
      throw new GatewayReadError(
        "deadline",
        "timeout",
        "Gateway read deadline exceeded",
      );
  };
  const abort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new GatewayReadError(
          "deadline",
          "timeout",
          "Gateway read deadline exceeded",
        ),
      ),
    timeoutMs,
  );
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    if (request.prepare) {
      await Promise.race([request.prepare(), cancelled]);
      checkDeadline();
    }
    const pending = transport(
      url,
      {
        method: "GET",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      },
      readContext(url, request.purpose ?? "query"),
    );
    // A custom transport may ignore abort. Do not leak a response arriving late.
    void pending.then(
      (res) => {
        if (controller.signal.aborted) void res.body?.cancel().catch(() => {});
      },
      () => {},
    );
    response = await Promise.race([pending, cancelled]);
    checkDeadline();
    if (!response.ok) {
      const read = { deadline, cancelled, signal: options.signal };
      if (request.decodeRefusal)
        throw await gatewayHttpErrorFrom(response, read);
      const bytes = await readErrorBody(response, read);
      throw new GatewayHttpError(response.status, boundedCopy(response, bytes));
    }
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(maxBytes))
    )
      throw new GatewayReadError(
        "limit",
        "responseBytes",
        "Gateway read response exceeds byte limit",
      );
    if (!response.body)
      throw new GatewayReadError(
        "malformed",
        "body",
        "Gateway read response body is missing",
      );
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), cancelled]);
      checkDeadline();
      if (part.done) break;
      if (part.value.length === 0)
        throw new GatewayReadError(
          "malformed",
          "body",
          "Gateway read returned an empty body chunk",
        );
      if (chunks.length >= maxChunks)
        throw new GatewayReadError(
          "limit",
          "chunks",
          "Gateway read exceeds fragmentation limit",
        );
      size += part.value.length;
      if (size > maxBytes)
        throw new GatewayReadError(
          "limit",
          "responseBytes",
          "Gateway read response exceeds byte limit",
        );
      chunks.push(part.value);
    }
    checkDeadline();
    const bytes = concat(chunks, size);
    let parsed: unknown;
    try {
      parsed = parseBoundedJson(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      if (error instanceof GatewayReadError) throw error;
      throw new GatewayReadError(
        "malformed",
        "json",
        "Invalid gateway read JSON",
        { cause: error },
      );
    }
    checkDeadline();
    return { status: response.status, body: parsed };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    if (reader) {
      // Do not wait on an uncooperative custom stream's cancellation hook.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else {
      void response?.body?.cancel().catch(() => {});
    }
  }
}
