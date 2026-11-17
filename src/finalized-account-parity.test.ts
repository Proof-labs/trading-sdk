import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFinalizedAccountState } from "./finalized-account-reads.js";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../conformance/finalized-account-state.json", import.meta.url),
    "utf8",
  ),
);

describe("Python/TS finalized account-state fixtures", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const { witness, ...state } = decodeFinalizedAccountState(
        fixture.envelope,
        fixture.owner,
      );
      const exact = JSON.parse(
        JSON.stringify(state, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      );
      expect(exact).toEqual(fixture.expected);
      expect(witness.height.toString()).toBe(fixture.envelope.witness.height);
    });
  }
});
