import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeMarketStatsResponse } from "./market-stats.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../conformance/market-stats.json", import.meta.url),
    "utf8",
  ),
);

// Current TypeScript-only behavior: Date.parse normalizes these inputs for
// window validation, while Python rejects them. An intentional change to TS
// calendar validation should update these expectations; they are not parity.
it.each([
  ["2026-04-30T24:00:00.0000Z", "2026-05-02T00:00:00Z"],
  ["2026-02-30T00:00:00Z", "2026-03-03T00:00:00Z"],
])(
  "records current TypeScript date normalization for %s",
  (window_start, window_end) => {
    const body = { ...fixture, window_start, window_end, as_of: window_end };
    expect(decodeMarketStatsResponse(body).window_start).toBe(window_start);
  },
);
