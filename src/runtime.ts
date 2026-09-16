/** Copy protocol inputs without structuredClone or cross-realm instanceof checks. */
export function cloneSigningInput<T>(value: T): T {
  if (
    ArrayBuffer.isView(value) &&
    Object.prototype.toString.call(value) === "[object Uint8Array]"
  ) {
    const bytes = value as unknown as Uint8Array;
    return new Uint8Array(bytes) as T;
  }
  if (Array.isArray(value)) return value.map(cloneSigningInput) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, cloneSigningInput(v)]),
    ) as T;
  }
  return value;
}

/** Abort interrupts the sleep; callers inspect the signal for their own result policy. */
export function abortableDelay(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Per-read deadline with explicit cleanup, without AbortSignal.any/timeout. */
export function readDeadline(
  ms: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}
