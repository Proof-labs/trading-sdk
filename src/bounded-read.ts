import { GatewayHttpError } from "./errors.js";
import { readContext, type ExchangeHttpTransport } from "./http-transport.js";
import { parseSnapshotEnvelope } from "./market-snapshot.js";

/** Deadline covers queueing, headers and the entire bounded response body. */
export interface BoundedReadOptions {
  signal?: AbortSignal;
  /** Default 10 seconds; caller may shorten it or extend up to 60 seconds. */
  timeoutMs?: number;
}
/** Same finalized node view, not a cryptographic proof. Bind node identity,
 * chain and appHash to a committed H+1 header independently before acting. */
export interface FinalizedReadWitness {
  version: 1;
  nodeId: string;
  height: bigint;
  finalizedBlockTimeMs: bigint;
  appHash: string;
}
export function decodeFinalizedReadWitness(
  value: unknown,
  expectedHeight: bigint,
  expectedTimeMs?: bigint,
): FinalizedReadWitness {
  const invalid = (): never => {
    throw new Error("Invalid finalized read witness");
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
    if (n > (1n << 64n) - 1n) invalid();
    return n;
  };
  if (
    w.version !== 1 ||
    typeof w.nodeId !== "string" ||
    !/^[a-f0-9]{40}$/.test(w.nodeId) ||
    /^0+$/.test(w.nodeId) ||
    typeof w.appHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(w.appHash) ||
    /^0+$/.test(w.appHash)
  )
    invalid();
  const height = decimal(w.height);
  const finalizedBlockTimeMs = decimal(w.finalizedBlockTimeMs);
  if (
    height !== expectedHeight ||
    (expectedTimeMs !== undefined && finalizedBlockTimeMs !== expectedTimeMs)
  )
    invalid();
  return {
    version: 1,
    nodeId: w.nodeId as string,
    height,
    finalizedBlockTimeMs,
    appHash: w.appHash as string,
  };
}
const MAX_BYTES = 1024 * 1024;
const MAX_CHUNKS = 4096;

function strictEnvelope(text: string): unknown {
  const parsed = parseSnapshotEnvelope(text);
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
          throw new Error("Duplicate gateway read field");
        frame.keys.add(key);
        frame.keyExpected = false;
      }
    } else if (char === "{" || char === "[") {
      stack.push({
        keys: char === "{" ? new Set() : undefined,
        keyExpected: char === "{",
      });
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
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("Invalid read timeout");
  options.signal?.throwIfAborted();
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const checkDeadline = () => {
    controller.signal.throwIfAborted();
    // A continuously ready stream can starve timers with resolved promises.
    // Check monotonic elapsed time too, independent of wall-clock changes.
    if (performance.now() >= deadline)
      throw new Error("Gateway read deadline exceeded");
  };
  const abort = () => controller.abort(new Error("Gateway read cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Gateway read deadline exceeded")),
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
    if (!response.ok) throw new GatewayHttpError(response.status, response);
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^(0|[1-9][0-9]*)$/.test(length) || BigInt(length) > BigInt(MAX_BYTES))
    )
      throw new Error("Gateway read response exceeds byte limit");
    if (!response.body)
      throw new Error("Gateway read response body is missing");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await Promise.race([reader.read(), cancelled]);
      checkDeadline();
      if (part.done) break;
      if (part.value.length === 0)
        throw new Error("Gateway read returned an empty body chunk");
      if (chunks.length >= MAX_CHUNKS)
        throw new Error("Gateway read exceeds fragmentation limit");
      size += part.value.length;
      if (size > MAX_BYTES)
        throw new Error("Gateway read response exceeds byte limit");
      chunks.push(part.value);
    }
    checkDeadline();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    // Read-specific decoders check every required value below.
    const parsed = strictEnvelope(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
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
