/**
 * Strict reads of one ABCI event's string attributes, shared by the typed
 * event decoders. Every integer attribute is a decimal string; a u64 decodes
 * to `bigint`. An address is 40 lowercase hex characters. An optional
 * attribute is the empty string when unset, and absent from events emitted
 * before it existed.
 */

import type { TxEvent } from "./types.js";

/** One ABCI event: a `TxEvent`'s attribute list, or the same attributes as
 *  a plain object. */
export interface AbciEventInput {
  type: string;
  attributes: TxEvent["attributes"] | Readonly<Record<string, unknown>>;
}

const U32_MAX = 0xffff_ffffn;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export class Attributes {
  private readonly values = new Map<string, unknown>();

  constructor(
    private readonly event: string,
    attributes: AbciEventInput["attributes"],
  ) {
    const entries: [string, unknown][] = Array.isArray(attributes)
      ? (attributes as TxEvent["attributes"]).map(({ key, value }) => [
          key,
          value,
        ])
      : Object.entries(attributes);
    for (const [key, value] of entries) {
      if (this.values.has(key)) this.fail(key, "is duplicated");
      this.values.set(key, value);
    }
  }

  fail(key: string, problem: string): never {
    throw new Error(`${this.event} decode: ${key} ${problem}`);
  }

  private unset(key: string): boolean {
    const value = this.values.get(key);
    return value === undefined || value === "";
  }

  text(key: string): string {
    const value = this.values.get(key);
    if (typeof value !== "string") this.fail(key, "is missing");
    return value;
  }

  unsigned(key: string, max: bigint): bigint {
    const text = this.text(key);
    if (!/^(0|[1-9][0-9]*)$/.test(text)) {
      this.fail(key, "is not a decimal unsigned integer");
    }
    const value = BigInt(text);
    if (value > max) this.fail(key, `exceeds ${max}`);
    return value;
  }

  u64(key: string): bigint {
    return this.unsigned(key, U64_MAX);
  }

  /** An optional u64: `null` when unset or absent. */
  optionalU64(key: string): bigint | null {
    return this.unset(key) ? null : this.u64(key);
  }

  /** A u64 where `0` means absent: `null` for `0`. */
  nonZeroU64(key: string): bigint | null {
    const value = this.u64(key);
    return value === 0n ? null : value;
  }

  u32(key: string): number {
    return Number(this.unsigned(key, U32_MAX));
  }

  u8(key: string): number {
    return Number(this.unsigned(key, 0xffn));
  }

  i64(key: string): bigint {
    const text = this.text(key);
    if (!/^(0|-?[1-9][0-9]*)$/.test(text)) {
      this.fail(key, "is not a decimal integer");
    }
    const value = BigInt(text);
    if (value < I64_MIN || value > I64_MAX) this.fail(key, "exceeds i64");
    return value;
  }

  owner(key: string): string {
    const text = this.text(key);
    if (!/^[0-9a-f]{40}$/.test(text)) {
      this.fail(key, "is not a 20-byte lowercase hex address");
    }
    return text;
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const text = this.text(key);
    if (!(values as readonly string[]).includes(text)) {
      this.fail(key, `has unknown value "${text}"`);
    }
    return text as T;
  }

  /** One of `values`, or `null` when unset or absent. */
  optionalOneOf<T extends string>(key: string, values: readonly T[]): T | null {
    return this.unset(key) ? null : this.oneOf(key, values);
  }
}

/** Book sides as the engine renders them. */
export const SIDES = ["buy", "sell"] as const;
export type EventSide = (typeof SIDES)[number];

/** Runs the decoder registered for `event.type`, or returns `null`. */
export function decodeWith<E>(
  decoders: Record<string, (a: Attributes) => E>,
  event: AbciEventInput,
): E | null {
  const decode = Object.hasOwn(decoders, event.type)
    ? decoders[event.type]
    : undefined;
  return decode ? decode(new Attributes(event.type, event.attributes)) : null;
}
