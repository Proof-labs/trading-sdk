import { Encoder } from "@msgpack/msgpack";
import { describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";

const encoder = new Encoder({ useBigInt64: true });
// A DevNet `/v1/events` row (2026-11-12): event 4, resolved No, with a
// `MarketOracle` source on market 1 and one attached conditional.
const row = (): unknown[] => [
  4,
  400,
  "Will BTC be above $83,438.785 at resolution?",
  1_791_889_200_000n,
  3_600_000,
  { Resolved: "No" },
  1_791_804_127_366n,
  1_791_889_201_046n,
  { MarketOracle: [1, 83_438_785_000n, "GreaterThan"] },
  [[3, 402, 403]],
];

function clientFor(payload: unknown) {
  const body =
    payload === undefined
      ? {}
      : { data: Buffer.from(encoder.encode(payload)).toString("base64") };
  const transport = vi.fn(
    async () => new Response(JSON.stringify(body), { status: 200 }),
  );
  return {
    client: new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    }),
    transport,
  };
}

describe("events listing decoded row by row", () => {
  it("decodes as queryEvents does", async () => {
    const { client, transport } = clientFor([row()]);
    const listing = await client.queryEventListing();
    expect(listing.refusedRows).toEqual([]);
    expect(listing.events).toEqual(
      await clientFor([row()]).client.queryEvents(),
    );
    expect(listing.events[0]).toMatchObject({ eventId: 4, ebyMarket: 400 });
    expect(transport.mock.calls[0][0]).toBe(
      "https://gateway.example/v1/events",
    );
  });

  it("reports an event it cannot decode and keeps the others", async () => {
    const unknownOracle = row();
    unknownOracle[0] = 7;
    unknownOracle[8] = { FutureOracle: [1] };
    const listing = await clientFor([
      unknownOracle,
      row(),
    ]).client.queryEventListing();
    expect(listing.events.map((event) => event.eventId)).toEqual([4]);
    expect(
      listing.refusedRows.map(({ index, eventId, fieldCount }) => ({
        index,
        eventId,
        fieldCount,
      })),
    ).toStrictEqual([{ index: 0, eventId: 7, fieldCount: 10 }]);
    expect(listing.refusedRows[0].error).toContain("FutureOracle");
    await expect(
      clientFor([unknownOracle, row()]).client.queryEvents(),
    ).rejects.toThrow();
  });

  it("refuses the whole listing for a row it cannot tie to an event of its own", async () => {
    const pausedAs = (eventId: unknown): unknown[] => {
      const paused = row();
      paused[0] = eventId;
      paused[5] = "Paused";
      return paused;
    };
    for (const refused of ["x", pausedAs(0), pausedAs(4)]) {
      await expect(
        clientFor([row(), refused]).client.queryEventListing(),
      ).rejects.toThrow("Events decode: events listing row 1");
    }
  });

  it("words a missing envelope the same in queryEvents and queryEventListing", async () => {
    for (const read of [
      () => clientFor(undefined).client.queryEvents(),
      () => clientFor(undefined).client.queryEventListing(),
    ]) {
      await expect(read()).rejects.toThrow(
        "API error: /v1/events response is missing encoded data",
      );
    }
  });

  it("refuses a missing envelope and a payload that is not a list", async () => {
    await expect(
      clientFor(undefined).client.queryEventListing(),
    ).rejects.toThrow();
    await expect(clientFor(5).client.queryEventListing()).rejects.toThrow(
      "Events decode",
    );
  });
});
