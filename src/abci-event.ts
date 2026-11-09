/**
 * The string attributes of one ABCI event, read with range checks. Every
 * integer attribute is a decimal string; an address is 40 lowercase hex
 * characters. A malformed attribute throws.
 */

import type { TxEvent } from "./types.js";

/** One ABCI event: a `TxEvent`'s attribute list, or the same attributes as
 *  a plain object. */
export interface AbciEventInput {
  type: string;
  attributes: TxEvent["attributes"] | Readonly<Record<string, unknown>>;
}

export const U32_MAX = 0xffff_ffffn;
const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const UNSIGNED = /^(0|[1-9][0-9]*)$/;

/** String attributes of one ABCI event, read with range checks. */
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

  has(key: string): boolean {
    return this.values.has(key);
  }

  text(key: string): string {
    const value = this.values.get(key);
    if (typeof value !== "string") this.fail(key, "is missing");
    return value;
  }

  unsigned(key: string, max: bigint): bigint {
    const text = this.text(key);
    if (!UNSIGNED.test(text)) {
      this.fail(key, "is not a decimal unsigned integer");
    }
    const value = BigInt(text);
    if (value > max) this.fail(key, `exceeds ${max}`);
    return value;
  }

  u64(key: string): bigint {
    return this.unsigned(key, U64_MAX);
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
      this.fail(key, "is not a decimal signed integer");
    }
    const value = BigInt(text);
    if (value < I64_MIN || value > I64_MAX) {
      this.fail(key, "is outside the signed 64-bit range");
    }
    return value;
  }

  oneOf<const T extends readonly string[]>(key: string, values: T): T[number] {
    const text = this.text(key);
    if (!values.includes(text)) this.fail(key, `has unknown value "${text}"`);
    return text;
  }

  /** A non-empty value passed through as written, so a value a later engine
   *  adds still decodes. */
  label(key: string): string {
    const text = this.text(key);
    if (text === "") this.fail(key, "is empty");
    return text;
  }

  owner(key: string): string {
    const text = this.text(key);
    if (!/^[0-9a-f]{40}$/.test(text)) {
      this.fail(key, "is not a 20-byte lowercase hex address");
    }
    return text;
  }
}
