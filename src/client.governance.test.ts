// Governance reads (W30-11): `queryAdminSignerRegistry` + `queryProposals`
// against the gateway proxies (api-gateway#97). Kept out of client.test.ts —
// that file is large; governance read coverage lives here.
//
// Same strategy as the routing tests there: stub global fetch, answer with
// base64(msgpack) bodies, assert the URL and the decoded shape.

import { describe, it, expect, afterEach, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { ExchangeClient } from "./client.js";

describe("ExchangeClient governance reads (W30-11)", () => {
  const originalFetch = globalThis.fetch;
  const encoder = new Encoder({ useBigInt64: true });
  let calls: string[] = [];

  function toB64(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  function stubFetch(data: string | undefined): void {
    calls = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(url.toString());
      return new Response(JSON.stringify(data === undefined ? {} : { data }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
  }

  function makeClient(): ExchangeClient {
    return new ExchangeClient({
      gatewayUrl: "http://test-gateway",
      chainId: "test-chain",
    });
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("queryAdminSignerRegistry routes through the gateway and unwraps a present registry", async () => {
    // Proxy shape: msgpack `[registry|nil]`. serde encodes `[u8; 20]` as a
    // msgpack ARRAY, so members arrive as number[][] — passed through opaque
    // (typed decoder lands with the release-B seed).
    const member = Array.from({ length: 20 }, (_, i) => i + 1);
    const registry = [3n, 2, [member]];
    stubFetch(toB64(encoder.encode([registry]) as Uint8Array));

    const got = await makeClient().queryAdminSignerRegistry();
    expect(calls).toEqual(["http://test-gateway/v1/admin/signer-registry"]);
    expect(got).toEqual(registry);
  });

  it("queryAdminSignerRegistry returns null for a nil registry (governance inactive)", async () => {
    // `[nil]` means no registry seeded — multisig INACTIVE (fail-closed),
    // deliberately distinct from an empty roster.
    stubFetch(toB64(encoder.encode([null]) as Uint8Array));
    expect(await makeClient().queryAdminSignerRegistry()).toBeNull();
  });

  it("queryProposals forwards status/cursor/limit and decodes the page", async () => {
    const proposals = [
      [42n, "open"],
      [43n, "open"],
    ];
    // Cursor 99 encodes as a msgpack fixint — the decoder yields a `number`,
    // which the client must normalize to honor the declared bigint type.
    stubFetch(toB64(encoder.encode([proposals, 99]) as Uint8Array));

    const page = await makeClient().queryProposals({
      status: "open",
      cursor: 7n,
      limit: 10,
    });
    expect(calls).toEqual([
      "http://test-gateway/v1/proposals?status=open&cursor=7&limit=10",
    ]);
    expect(page.proposals).toEqual(proposals);
    expect(page.nextCursor).toBe(99n);
  });

  it("queryProposals decodes a nil cursor as null and omits empty query params", async () => {
    stubFetch(toB64(encoder.encode([[], null]) as Uint8Array));
    const page = await makeClient().queryProposals();
    expect(calls).toEqual(["http://test-gateway/v1/proposals"]);
    expect(page).toEqual({ proposals: [], nextCursor: null });
  });

  it("queryProposals treats a missing data field as an empty page", async () => {
    stubFetch(undefined);
    const page = await makeClient().queryProposals();
    expect(page).toEqual({ proposals: [], nextCursor: null });
  });
});
