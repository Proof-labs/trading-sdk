import { readFileSync } from "node:fs";
import { decode, encode } from "@msgpack/msgpack";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExchangeClient, ready } from "./index.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

const owner = "ab".repeat(20);
const fixture = Buffer.from(
  readFileSync(
    new URL("../conformance/account-v2.hex", import.meta.url),
    "utf8",
  ).trim(),
  "hex",
);
const raw = () => decode(fixture, { useBigInt64: true }) as Record<string, any>;
function clientFor(bytes: Uint8Array = fixture, response?: unknown) {
  const transport = vi.fn<ExchangeHttpTransport>(
    async () =>
      new Response(
        JSON.stringify(
          response ?? { data: Buffer.from(bytes).toString("base64") },
        ),
      ),
  );
  return {
    client: new ExchangeClient({
      gatewayUrl: "https://gateway.example",
      httpTransport: transport,
    }),
    transport,
  };
}
const packed = (value: unknown) => encode(value, { useBigInt64: true });
beforeAll(ready);

describe("account v2 valuation", () => {
  it("requests v2 through the gateway and decodes the frozen engine vector", async () => {
    const { client, transport } = clientFor();
    const view = await client.queryAccountV2(owner.toUpperCase());
    expect(view).toMatchObject({
      cashoutEquity: 1_000_090n,
      positions: [
        {
          market: 100,
          side: "buy",
          settlePrice: 55n,
          bookRestricted: true,
          upnlNow: 150n,
        },
      ],
    });
    expect(transport.mock.calls[0][0]).toBe("https://gateway.example/info");
    expect(JSON.parse(transport.mock.calls[0][1]?.body as string)).toEqual({
      type: "clearinghouseState",
      user: owner,
      version: 2,
    });
  });
  it("keeps missing data null and preserves zero, false and full-width integers", async () => {
    const value = raw();
    delete value.positions[0].settle_price;
    delete value.positions[0].book_restricted;
    value.positions[0].upnl_now = null;
    value.margin_ratio_bps = null;
    expect(
      await clientFor(packed(value)).client.queryAccountV2(owner),
    ).toMatchObject({
      marginRatioBps: null,
      positions: [{ settlePrice: null, bookRestricted: null, upnlNow: null }],
    });
    value.positions[0].settle_price = 0n;
    value.positions[0].book_restricted = false;
    expect(
      (await clientFor(packed(value)).client.queryAccountV2(owner))
        ?.positions[0],
    ).toMatchObject({ settlePrice: 0n, bookRestricted: false });
    value.positions[0].settle_price = 18446744073709551615n;
    value.positions[0].pnl_if_dies = -9223372036854775808n;
    value.positions[0].future_field = "ignored";
    expect(
      (await clientFor(packed(value)).client.queryAccountV2(owner))
        ?.positions[0],
    ).toMatchObject({
      settlePrice: 18446744073709551615n,
      pnlIfDies: -9223372036854775808n,
    });
  });
  it("rejects a v1 fallback without retrying", async () => {
    const { client, transport } = clientFor(
      packed([0, [], 0, 0, 0, 0, [], 0, 0]),
    );
    await expect(client.queryAccountV2(owner)).rejects.toThrow(/map/);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { data: 123 }, { error: "unsupported version" }])(
    "rejects invalid envelopes %j",
    async (response) => {
      await expect(
        clientFor(fixture, response).client.queryAccountV2(owner),
      ).rejects.toThrow();
    },
  );
  it.each([
    ["settle_price", -1],
    ["settle_price", "55"],
    ["book_restricted", 0],
  ])("rejects malformed %s", async (field, bad) => {
    const value = raw();
    value.positions[0][field as string] = bad;
    await expect(
      clientFor(packed(value)).client.queryAccountV2(owner),
    ).rejects.toThrow();
  });
  it("leaves the legacy account method versionless", async () => {
    const { client, transport } = clientFor(
      packed([0, [], 0, 0, 0, 0, [], 0, 0]),
    );
    await expect(client.queryAccount(owner)).resolves.toMatchObject({
      balance: 0n,
      positions: [],
    });
    expect(JSON.parse(transport.mock.calls[0][1]?.body as string)).toEqual({
      type: "clearinghouseState",
      user: owner,
    });
  });
  it("handles missing and malformed owners without a network request", async () => {
    const { client, transport } = clientFor();
    expect(await client.queryAccountV2()).toBeNull();
    await expect(client.queryAccountV2("bad")).rejects.toThrow(/owner/);
    expect(transport).not.toHaveBeenCalled();
  });
});
