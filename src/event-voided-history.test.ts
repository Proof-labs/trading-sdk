import { describe, expect, it, vi } from "vitest";
import { queryEventVoided } from "./event-voided-history.js";

const voided = (eventId: string, yesPrice: string) => ({
  event_id: 9,
  block_height: 100,
  block_time: "2026-11-18T00:00:00Z",
  tx_hash: "ab",
  event_type: "event_voided",
  signer: "",
  payload: {
    event_id: eventId,
    yes_price: yesPrice,
    timestamp_ms: "1794960000000",
    proposal_id: "3",
  },
});

const transportFor = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("queryEventVoided", () => {
  it("returns the decoded record for the event", async () => {
    const transport = transportFor({
      admin_events: [voided("12", "x"), voided("43", "400000")],
      next_cursor: "",
    });
    const result = await queryEventVoided("https://gateway.test/", 43, {
      fetch: transport,
    });
    expect(result).toEqual({
      type: "EventVoided",
      eventId: 43,
      yesPrice: 400000n,
      timestampMs: 1794960000000n,
      proposalId: 3n,
    });
    const [input, init] = transport.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const url = new URL(input);
    expect(url.origin + url.pathname).toBe(
      "https://gateway.test/v1/history/admin-events",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      event_type: "event_voided",
      limit: "1000",
    });
    expect(init.method).toBe("GET");
  });

  it("returns null when the event was not voided", async () => {
    const transport = transportFor({ admin_events: [], next_cursor: "" });
    await expect(
      queryEventVoided("https://gateway.test", 43, { fetch: transport }),
    ).resolves.toBeNull();
  });

  it("throws on an HTTP error, a malformed page or a bad event id", async () => {
    await expect(
      queryEventVoided("https://gateway.test", 43, {
        fetch: transportFor({ error: "x" }, 502),
      }),
    ).rejects.toThrow();
    await expect(
      queryEventVoided("https://gateway.test", 43, {
        fetch: transportFor({ nope: [] }),
      }),
    ).rejects.toThrow("Invalid admin-events page");
    await expect(queryEventVoided("https://gateway.test", -1)).rejects.toThrow(
      "Invalid event id",
    );
  });
});
