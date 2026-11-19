import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_ADDRESS_ERROR_CODES,
  ExchangeClient,
  GatewayHttpError,
  GatewayReadError,
  isDepositAddressErrorCode,
  type DepositAddress,
} from "./index.js";

interface FixtureCase {
  name: string;
  httpStatus: number;
  headers: Record<string, string>;
  body: string;
}
// The deposit address service's answers, byte for byte.
const fixture = JSON.parse(
  readFileSync(
    new URL("../conformance/deposit-address.json", import.meta.url),
    "utf8",
  ),
) as { account: string; cases: FixtureCase[] };
const fixtureCase = (name: string): FixtureCase => {
  const found = fixture.cases.find((c) => c.name === name);
  if (!found) throw new Error(`fixture case ${name} is missing`);
  return found;
};
const answer = (
  c: Pick<FixtureCase, "httpStatus" | "body"> & Partial<FixtureCase>,
) => new Response(c.body, { status: c.httpStatus, headers: c.headers ?? {} });

const account = fixture.account;
const AUTHORITY = "9DEvTpg7J8BsrESCVrpP9FnBEEKXpC8MauxarCApCAyz";
const TOKEN_ACCOUNT = "8MJF87ivAaBfc7yHkBztbGWyBgaAYTMFPrUdfcFfPQk6";

function clientAnswering(...responses: Response[]) {
  const transport = vi.fn();
  for (const r of responses) transport.mockResolvedValueOnce(r);
  const client = new ExchangeClient({
    gatewayUrl: "https://gateway.test",
    httpTransport: transport,
  });
  return { client, transport };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queryDepositAddress — the service's pinned answers", () => {
  it("decodes the ready answer with the deposit authority as address", async () => {
    const { client, transport } = clientAnswering(answer(fixtureCase("ready")));
    const got: DepositAddress = await client.queryDepositAddress(account);
    expect(got).toEqual({
      status: "ready",
      address: AUTHORITY,
      tokenAccount: TOKEN_ACCOUNT,
      createdAt: 1763520000,
    });
    expect(transport.mock.calls[0][0]).toBe(
      `https://gateway.test/v1/deposit-address/${account}`,
    );
  });

  it("decodes the pending answer (202) as a success, not an error", async () => {
    const { client } = clientAnswering(answer(fixtureCase("pending")));
    await expect(client.queryDepositAddress(account)).resolves.toEqual({
      status: "pending",
      retryAfterMs: 2000,
    });
  });

  it("keeps errorCode SubAccount on a GatewayHttpError", async () => {
    const { client } = clientAnswering(answer(fixtureCase("subAccount")));
    const error = await rejection(client.queryDepositAddress(account));
    expect(error).toBeInstanceOf(GatewayHttpError);
    const e = error as GatewayHttpError;
    expect(e.status).toBe(403);
    expect(e.errorCode).toBe("SubAccount");
    expect(e.retryAfterMs).toBeUndefined();
    expect(e.message).toContain("this is a sub-account");
    // The error keeps an unread copy of the response.
    await expect(e.response.json()).resolves.toMatchObject({
      errorCode: "SubAccount",
    });
  });

  it("keeps errorCode RateLimited and the body's retryAfterMs", async () => {
    const { client } = clientAnswering(answer(fixtureCase("rateLimited")));
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e).toBeInstanceOf(GatewayHttpError);
    expect(e.status).toBe(429);
    expect(e.errorCode).toBe("RateLimited");
    // The body's milliseconds win over the header's rounded-up seconds.
    expect(e.retryAfterMs).toBe(1500);
  });

  it("covers every fixture case", () => {
    expect(fixture.cases.map((c) => c.name)).toEqual([
      "ready",
      "pending",
      "subAccount",
      "rateLimited",
    ]);
  });
});

describe("queryDepositAddress — other answers", () => {
  it("accepts a null createdAt", async () => {
    const body = JSON.stringify({
      status: "ready",
      address: AUTHORITY,
      tokenAccount: TOKEN_ACCOUNT,
      createdAt: null,
    });
    const { client } = clientAnswering(answer({ httpStatus: 200, body }));
    await expect(client.queryDepositAddress(account)).resolves.toMatchObject({
      createdAt: null,
    });
  });

  it.each([
    [
      400,
      "InvalidAccount",
      '{"status":"error","error":"account must be 0x followed by 40 hex digits","errorCode":"InvalidAccount"}',
    ],
    [
      503,
      "Unavailable",
      '{"status":"error","error":"deposit addresses are unavailable, try again later","errorCode":"Unavailable"}',
    ],
  ])("keeps errorCode on %i %s", async (httpStatus, code, body) => {
    const { client } = clientAnswering(answer({ httpStatus, body }));
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e).toBeInstanceOf(GatewayHttpError);
    expect(e.status).toBe(httpStatus);
    expect(e.errorCode).toBe(code);
    expect(isDepositAddressErrorCode(e.errorCode)).toBe(true);
  });

  it("falls back to the Retry-After header when the body has no retryAfterMs", async () => {
    const { client } = clientAnswering(
      answer({
        httpStatus: 429,
        headers: { "retry-after": "2" },
        body: '{"status":"error","error":"rate limited","errorCode":"RateLimited"}',
      }),
    );
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e.retryAfterMs).toBe(2000);
  });

  it("raises a GatewayHttpError without errorCode for a non-JSON error body", async () => {
    const { client } = clientAnswering(
      answer({ httpStatus: 502, body: "<html>bad gateway</html>" }),
    );
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e).toBeInstanceOf(GatewayHttpError);
    expect(e.status).toBe(502);
    expect(e.errorCode).toBeUndefined();
    await expect(e.response.text()).resolves.toBe("<html>bad gateway</html>");
  });

  it("keeps a gateway errorCode outside the four as a plain string", async () => {
    const { client } = clientAnswering(
      answer({
        httpStatus: 404,
        body: '{"status":"error","error":"not found","errorCode":"NotFound"}',
      }),
    );
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e.errorCode).toBe("NotFound");
    expect(isDepositAddressErrorCode(e.errorCode)).toBe(false);
  });

  it.each([
    ["ready on 202", 202, fixtureCase("ready").body, "status"],
    ["pending on 200", 200, fixtureCase("pending").body, "status"],
    [
      "missing address",
      200,
      `{"status":"ready","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":null}`,
      "address",
    ],
    [
      "non-base58 address",
      200,
      `{"status":"ready","address":"0OIl${AUTHORITY.slice(4)}","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":null}`,
      "address",
    ],
    [
      "address decoding to 33 bytes",
      200,
      `{"status":"ready","address":"${"z".repeat(44)}","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":null}`,
      "address",
    ],
    [
      "tokenAccount decoding to 23 bytes",
      200,
      `{"status":"ready","address":"${AUTHORITY}","tokenAccount":"${"2".repeat(32)}","createdAt":null}`,
      "tokenAccount",
    ],
    [
      "missing tokenAccount",
      200,
      `{"status":"ready","address":"${AUTHORITY}","createdAt":null}`,
      "tokenAccount",
    ],
    [
      "tokenAccount equal to address",
      200,
      `{"status":"ready","address":"${AUTHORITY}","tokenAccount":"${AUTHORITY}","createdAt":null}`,
      "tokenAccount",
    ],
    [
      "missing createdAt",
      200,
      `{"status":"ready","address":"${AUTHORITY}","tokenAccount":"${TOKEN_ACCOUNT}"}`,
      "createdAt",
    ],
    [
      "string createdAt",
      200,
      `{"status":"ready","address":"${AUTHORITY}","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":"1763520000"}`,
      "createdAt",
    ],
    [
      "fractional retryAfterMs",
      202,
      '{"status":"pending","retryAfterMs":1.5}',
      "retryAfterMs",
    ],
    [
      "negative retryAfterMs",
      202,
      '{"status":"pending","retryAfterMs":-1}',
      "retryAfterMs",
    ],
    ["unknown status", 200, '{"status":"done"}', "status"],
    ["JSON null", 200, "null", "envelope"],
    ["not JSON", 200, "ready", "json"],
    ["other 2xx", 204, "", "body"],
  ])(
    "refuses a malformed success answer: %s",
    async (_name, httpStatus, body, field) => {
      const { client } = clientAnswering(
        new Response(httpStatus === 204 ? null : body, { status: httpStatus }),
      );
      const error = await rejection(client.queryDepositAddress(account));
      expect(error).toBeInstanceOf(GatewayReadError);
      expect(error).toMatchObject({ kind: "malformed", field });
    },
  );

  it.each([
    ["0", 0, 0],
    ["huge", Number.MAX_SAFE_INTEGER, 300_000],
  ])("clamps a %s retryAfterMs to 0..300000", async (_name, sent, expected) => {
    const { client } = clientAnswering(
      answer({
        httpStatus: 202,
        body: `{"status":"pending","retryAfterMs":${sent}}`,
      }),
      answer({
        httpStatus: 429,
        body: `{"status":"error","error":"rate limited","errorCode":"RateLimited","retryAfterMs":${sent}}`,
      }),
    );
    await expect(client.queryDepositAddress(account)).resolves.toEqual({
      status: "pending",
      retryAfterMs: expected,
    });
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e.retryAfterMs).toBe(expected);
  });

  it("clamps a huge Retry-After header", async () => {
    const { client } = clientAnswering(
      answer({
        httpStatus: 503,
        headers: { "retry-after": "99999999999999999999" },
        body: '{"status":"error","error":"down","errorCode":"Unavailable"}',
      }),
    );
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e.retryAfterMs).toBe(300_000);
  });

  describe("an HTTP-date Retry-After", () => {
    const NOW = Date.parse("2026-11-19T04:00:00Z");
    const refused = (retryAfter: string, body = "") =>
      answer({
        httpStatus: 503,
        headers: { "retry-after": retryAfter },
        body: `{"status":"error","error":"down","errorCode":"Unavailable"${body}}`,
      });
    async function retryAfterFor(res: Response) {
      vi.spyOn(Date, "now").mockReturnValue(NOW);
      const { client } = clientAnswering(res);
      const e = (await rejection(
        client.queryDepositAddress(account),
      )) as GatewayHttpError;
      expect(e.errorCode).toBe("Unavailable");
      return e.retryAfterMs;
    }

    it("counts down to a future date", async () => {
      await expect(
        retryAfterFor(refused("Thu, 19 Nov 2026 04:02:00 GMT")),
      ).resolves.toBe(120_000);
    });
    it("reads the obsolete RFC 850 and asctime forms as GMT", async () => {
      await expect(
        retryAfterFor(refused("Thursday, 19-Nov-26 04:00:30 GMT")),
      ).resolves.toBe(30_000);
      await expect(
        retryAfterFor(refused("Thu Nov 19 04:00:45 2026")),
      ).resolves.toBe(45_000);
    });
    it("is 0 for a past date", async () => {
      await expect(
        retryAfterFor(refused("Thu, 19 Nov 2026 03:00:00 GMT")),
      ).resolves.toBe(0);
    });
    it.each([
      "soon",
      "Thu, 99 Nov 2026 04:02:00 GMT",
      "1.5",
      "-3",
      "2026-11-19",
    ])("ignores an invalid value: %s", async (header) => {
      await expect(retryAfterFor(refused(header))).resolves.toBeUndefined();
    });
    it("loses to the body's retryAfterMs", async () => {
      await expect(
        retryAfterFor(
          refused("Thu, 19 Nov 2026 04:02:00 GMT", ',"retryAfterMs":700'),
        ),
      ).resolves.toBe(700);
    });
  });

  it("reads from the gateway even on the internal direct-node path", async () => {
    const transport = vi.fn().mockResolvedValue(answer(fixtureCase("pending")));
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.test",
      useGateway: false,
      httpTransport: transport,
    });
    await client.queryDepositAddress(account);
    expect(transport.mock.calls[0][0]).toBe(
      `https://gateway.test/v1/deposit-address/${account}`,
    );
  });

  it.each([
    "../markets?x=1",
    "0x",
    "0xdbb6311de00a522f6569087d6e6b5fd674018d",
    "0xzbb6311de00a522f6569087d6e6b5fd674018d32",
    "",
  ])("refuses account %j before any request", async (bad) => {
    const { client, transport } = clientAnswering(
      answer(fixtureCase("pending")),
    );
    const error = await rejection(client.queryDepositAddress(bad));
    expect(error).toBeInstanceOf(GatewayReadError);
    expect(error).toMatchObject({ kind: "configuration", field: "account" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "0xDBB6311DE00A522F6569087D6E6B5FD674018D32",
    "0XdBb6311de00a522f6569087d6e6b5fd674018d32",
    "dbb6311de00a522f6569087d6e6b5fd674018d32",
  ])("sends %s as 0x and lowercase", async (given) => {
    const { client, transport } = clientAnswering(
      answer(fixtureCase("pending")),
    );
    await client.queryDepositAddress(given);
    expect(transport.mock.calls[0][0]).toBe(
      `https://gateway.test/v1/deposit-address/${account}`,
    );
  });

  it("labels the read as owner-scoped and passes on the caller's abort", async () => {
    const { client, transport } = clientAnswering(
      answer(fixtureCase("pending")),
    );
    const controller = new AbortController();
    await client.queryDepositAddress(account, { signal: controller.signal });
    const [, init, context] = transport.mock.calls[0];
    expect(context).toMatchObject({ purpose: "account", priority: "urgent" });
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects with the caller's reason when aborted before the request", async () => {
    const { client, transport } = clientAnswering(
      answer(fixtureCase("pending")),
    );
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(
      client.queryDepositAddress(account, { signal: controller.signal }),
    );
    expect(error).toMatchObject({ name: "AbortError" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("re-throws an abort that ends the body instead of calling it malformed", async () => {
    const aborted = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"status":"pen'));
      },
      pull(c) {
        c.error(aborted);
      },
    });
    const { client } = clientAnswering(new Response(body, { status: 202 }));
    const error = await rejection(client.queryDepositAddress(account));
    expect(error).toBe(aborted);
  });

  it("rejects with the caller's reason when aborted mid-body", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"status":"pen'));
      },
      pull() {
        controller.abort();
        return new Promise(() => {});
      },
    });
    const { client } = clientAnswering(new Response(body, { status: 202 }));
    const error = await rejection(
      client.queryDepositAddress(account, { signal: controller.signal }),
    );
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(GatewayReadError);
  });

  it("times out after timeoutMs with a deadline GatewayReadError", async () => {
    const transport = vi.fn(() => new Promise<Response>(() => {}));
    const client = new ExchangeClient({
      gatewayUrl: "https://gateway.test",
      httpTransport: transport,
    });
    const error = await rejection(
      client.queryDepositAddress(account, { timeoutMs: 20 }),
    );
    expect(error).toBeInstanceOf(GatewayReadError);
    expect(error).toMatchObject({ kind: "deadline" });
  });

  it("refuses a success body over 1 MiB", async () => {
    const { client } = clientAnswering(
      answer({
        httpStatus: 202,
        body: `{"status":"pending","retryAfterMs":1,"pad":"${"x".repeat(1024 * 1024)}"}`,
      }),
    );
    const error = await rejection(client.queryDepositAddress(account));
    expect(error).toMatchObject({ kind: "limit", field: "responseBytes" });
  });
});

describe("deposit address error codes", () => {
  it("names exactly the four codes the service answers with", () => {
    expect([...DEPOSIT_ADDRESS_ERROR_CODES]).toEqual([
      "InvalidAccount",
      "SubAccount",
      "RateLimited",
      "Unavailable",
    ]);
    expect(isDepositAddressErrorCode("SubAccount")).toBe(true);
    expect(isDepositAddressErrorCode("subaccount")).toBe(false);
    expect(isDepositAddressErrorCode(undefined)).toBe(false);
  });
});
