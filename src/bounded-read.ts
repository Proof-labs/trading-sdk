import { GatewayHttpError, GatewayReadError } from "./errors.js";
import {
  hash32,
  I64_MAX,
  MAX_READ_BYTES,
  MAX_READ_CHUNKS,
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
/** Same-view facts from a trusted gateway, NOT validator signatures or a
 * cryptographic event proof. verifyWitness binds the height and app hash to a
 * chain-qualified H+1 header; authenticate the node/header source separately.
 * This is not freshness, solvency, or authorization to trade. */
export interface FinalizedReadWitness {
  version: 1;
  nodeId: string;
  height: bigint;
  finalizedBlockTimeMs: bigint;
  appHash: Hash32Hex;
}
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
    invalid();
  return {
    version: 1,
    nodeId: w.nodeId as string,
    height,
    finalizedBlockTimeMs,
    appHash: hash32(w.appHash),
  };
}
/** Compare a witness with an independently obtained, trusted H+1 header.
 * H+1's timestamp is NOT H's timestamp, so it is deliberately not compared. */
export function verifyWitness(
  witness: FinalizedReadWitness,
  nextHeader: { height: bigint; chainId: string; appHash: string | null },
  chainId: string | Uint8Array,
): void {
  if (
    (typeof chainId === "string" && (!chainId || chainId.length > 128)) ||
    typeof nextHeader.chainId !== "string" ||
    !nextHeader.chainId ||
    nextHeader.chainId.length > 128
  ) {
    throw new GatewayReadError(
      "configuration",
      "chainId",
      "Witness verification requires an explicit chain pin",
    );
  }
  const expected =
    typeof chainId === "string" ? chainIdFromString(chainId) : chainId;
  const actual = chainIdFromString(nextHeader.chainId);
  if (
    !(expected instanceof Uint8Array) ||
    expected.length !== 32 ||
    actual.some((byte, i) => byte !== expected[i]) ||
    witness.height < 1n ||
    witness.height >= I64_MAX ||
    nextHeader.height !== witness.height + 1n ||
    nextHeader.appHash === null ||
    hash32(witness.appHash) !== hash32(nextHeader.appHash)
  ) {
    throw new GatewayReadError(
      "binding",
      "witness",
      "Finalized witness/header/chain mismatch",
    );
  }
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
}
/** Internal one-shot SDK read. No retry, alternate endpoint or cached fallback. */
export async function boundedGatewayJson(
  url: string,
  transport: ExchangeHttpTransport,
  options: BoundedReadOptions,
  request: BoundedReadRequest = {},
): Promise<unknown> {
  const { timeoutMs } = readDeadline(options);
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
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(length) ||
        BigInt(length) > BigInt(MAX_READ_BYTES))
    )
      throw new GatewayReadError(
        "limit",
        "responseBytes",
        "Gateway read response exceeds byte limit",
      );
    if (!response.body && !response.ok)
      throw new GatewayHttpError(
        response.status,
        new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        }),
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
      if (chunks.length >= MAX_READ_CHUNKS)
        throw new GatewayReadError(
          "limit",
          "chunks",
          "Gateway read exceeds fragmentation limit",
        );
      size += part.value.length;
      if (size > MAX_READ_BYTES)
        throw new GatewayReadError(
          "limit",
          "responseBytes",
          "Gateway read response exceeds byte limit",
        );
      chunks.push(part.value);
    }
    checkDeadline();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    if (!response.ok) {
      // Retain a bounded, readable error body after cancelling the upstream.
      const copy = new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
      throw new GatewayHttpError(response.status, copy);
    }
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
    return parsed;
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
