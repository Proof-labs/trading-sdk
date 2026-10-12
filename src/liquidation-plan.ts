import { Decoder } from "@msgpack/msgpack";

export type LiquidationDisposition =
  "Retry" | "NoProgressExpired" | "AbsoluteExpired";
export interface LiquidationPlanState {
  format: 1;
  finalizedHeight: bigint;
  finalizedTimeMs: bigint;
  owner: string;
  active: null | {
    planId: bigint;
    policyRevision: bigint;
    checkpointHash: Uint8Array;
    windowGeneration: bigint;
    executionWindowHeight: bigint;
    absoluteExpiryHeight: bigint;
    lastProgressHeight: bigint;
    noProgressBlocks: bigint;
    disposition: LiquidationDisposition;
    complete: boolean;
    originalAdmissionHeight: bigint;
    lastFillId: bigint | null;
  };
}

function invalid(field: string): never {
  throw new Error(`liquidation plan: invalid ${field}`);
}
function tuple(raw: unknown, size: number): unknown[] {
  if (!Array.isArray(raw) || raw.length !== size) return invalid("tuple");
  return raw;
}
function u64(raw: unknown): bigint {
  if (typeof raw === "number" && Number.isSafeInteger(raw)) raw = BigInt(raw);
  if (typeof raw !== "bigint" || raw < 0n || raw >= 1n << 64n)
    return invalid("u64");
  return raw;
}
function bytes(raw: unknown, size: number): Uint8Array {
  const a = raw instanceof Uint8Array ? Array.from(raw) : tuple(raw, size);
  if (
    a.length !== size ||
    a.some(
      (v) => typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 255,
    )
  )
    return invalid("bytes");
  return Uint8Array.from(a as number[]);
}
export function canonicalLiquidationOwner(owner: string): string {
  if (typeof owner !== "string" || !/^[0-9a-fA-F]{40}$/.test(owner))
    return invalid("owner");
  return owner.toLowerCase();
}

/** One finalized checkpoint's evidence; never authorization to resume/release. */
export function decodeLiquidationPlan(
  raw: unknown,
  requestedOwner: string,
): LiquidationPlanState {
  const expected = canonicalLiquidationOwner(requestedOwner);
  const r = tuple(raw, 5);
  if (u64(r[0]) !== 1n) return invalid("version");
  const finalizedHeight = u64(r[1]),
    finalizedTimeMs = u64(r[2]);
  if (finalizedHeight > 0n && finalizedTimeMs === 0n) return invalid("time");
  const owner = Array.from(bytes(r[3], 20), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  if (owner !== expected) return invalid("owner binding");
  let active: LiquidationPlanState["active"] = null;
  if (r[4] !== null) {
    const p = tuple(r[4], 12);
    if (
      p[8] !== "Retry" &&
      p[8] !== "NoProgressExpired" &&
      p[8] !== "AbsoluteExpired"
    )
      return invalid("disposition");
    if (typeof p[9] !== "boolean") return invalid("completion");
    active = {
      planId: u64(p[0]),
      policyRevision: u64(p[1]),
      checkpointHash: bytes(p[2], 32),
      windowGeneration: u64(p[3]),
      executionWindowHeight: u64(p[4]),
      absoluteExpiryHeight: u64(p[5]),
      lastProgressHeight: u64(p[6]),
      noProgressBlocks: u64(p[7]),
      disposition: p[8],
      complete: p[9],
      originalAdmissionHeight: u64(p[10]),
      lastFillId: p[11] === null ? null : u64(p[11]),
    };
    if (
      active.planId === 0n ||
      active.policyRevision === 0n ||
      active.originalAdmissionHeight > active.executionWindowHeight ||
      active.executionWindowHeight > active.lastProgressHeight ||
      active.lastProgressHeight > finalizedHeight ||
      active.absoluteExpiryHeight <= active.executionWindowHeight ||
      active.noProgressBlocks === 0n
    )
      return invalid("window");
  }
  return { format: 1, finalizedHeight, finalizedTimeMs, owner, active };
}

/** Gateway-only bounded public read; no fallback, write or automatic restart. */
export async function fetchLiquidationPlan(
  gatewayUrl: string,
  owner: string,
): Promise<LiquidationPlanState> {
  const expected = canonicalLiquidationOwner(owner);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(
      `${gatewayUrl}/v1/liquidation/plan?owner=${expected}`,
      { signal: controller.signal, redirect: "error" },
    );
    if (!response.ok)
      throw new Error(`liquidation plan HTTP ${response.status}`);
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 4096))
      return invalid("response size");
    reader = response.body?.getReader();
    if (!reader) return invalid("response body");
    const utf8 = new TextDecoder("utf-8", { fatal: true });
    let text = "",
      size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 4096) return invalid("response size");
      text += utf8.decode(part.value, { stream: true });
    }
    text += utf8.decode();
    const json: unknown = JSON.parse(text);
    if (
      !json ||
      typeof json !== "object" ||
      Array.isArray(json) ||
      Object.keys(json).length !== 1 ||
      !("data" in json) ||
      typeof json.data !== "string"
    )
      return invalid("envelope");
    const data = json.data;
    if (
      data.length === 0 ||
      data.length > 2048 ||
      data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
    )
      return invalid("base64");
    const binary = atob(data);
    if (btoa(binary) !== data) return invalid("canonical base64");
    const payload = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const raw = new Decoder({
      useBigInt64: true,
      maxArrayLength: 32,
      maxMapLength: 0,
      maxStrLength: 32,
      maxBinLength: 32,
      maxExtLength: 0,
    }).decode(payload);
    return decodeLiquidationPlan(raw, expected);
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}
