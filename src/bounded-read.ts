import { GatewayHttpError, GatewayReadError } from "./errors.js";
import {
  MAX_READ_BYTES,
  MAX_READ_CHUNKS,
  readDeadline,
} from "./read-values.js";
import { readContext, type ExchangeHttpTransport } from "./http-transport.js";

/** Deadline covers queueing, headers and the entire bounded response body. */
export interface BoundedReadOptions {
  signal?: AbortSignal;
  /** Default 5 seconds, matching existing reads; explicit maximum 60 seconds. */
  timeoutMs?: number;
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
