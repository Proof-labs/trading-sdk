import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeMarketStatsResponse } from "./market-stats.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../conformance/market-stats.json", import.meta.url),
    "utf8",
  ),
);
it("preserves the shared Python/TS market-statistics fixture", () => {
  expect(decodeMarketStatsResponse(fixture)).toEqual(fixture);
});
it.each([
  ["0000-01-01T00:00:00Z", "0000-01-02T00:00:00Z"],
  ["2026-11-08T09:00:00+09:00", "2026-11-09T00:00:00Z"],
])(
  "preserves valid Python/TS window timestamps for %s",
  (window_start, window_end) => {
    const body = { ...fixture, window_start, window_end, as_of: window_end };
    expect(decodeMarketStatsResponse(body).window_start).toBe(window_start);
  },
);
