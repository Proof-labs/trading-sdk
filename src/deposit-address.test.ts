import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_ADDRESS_ERROR_CODES,
  DepositAddressError,
  ExchangeClient,
  GatewayHttpError,
  isDepositAddressErrorCode,
  type DepositAddress,
} from "./index.js";

interface FixtureCase {
  name: string;
  httpStatus: number;
  headers: Record<string, string>;
  body: string;
}
// Frozen example F2: the deposit address service's answers, byte for byte.
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

describe("queryDepositAddress — frozen example F2", () => {
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
    expect(error).toBeInstanceOf(DepositAddressError);
    const e = error as DepositAddressError;
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
    )) as DepositAddressError;
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
      client.queryDepositAddress("0xnot-an-account"),
    )) as DepositAddressError;
    expect(e).toBeInstanceOf(DepositAddressError);
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
    )) as DepositAddressError;
    expect(e.retryAfterMs).toBe(2000);
  });

  it("raises a GatewayHttpError without errorCode for a non-JSON error body", async () => {
    const { client } = clientAnswering(
      answer({ httpStatus: 502, body: "<html>bad gateway</html>" }),
    );
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as DepositAddressError;
    expect(e).toBeInstanceOf(DepositAddressError);
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
    )) as DepositAddressError;
    expect(e.errorCode).toBe("NotFound");
    expect(isDepositAddressErrorCode(e.errorCode)).toBe(false);
  });

  it.each([
    ["ready on 202", 202, fixtureCase("ready").body],
    ["pending on 200", 200, fixtureCase("pending").body],
    [
      "missing address",
      200,
      `{"status":"ready","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":null}`,
    ],
    [
      "non-base58 address",
      200,
      `{"status":"ready","address":"0OIl${AUTHORITY.slice(4)}","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":null}`,
    ],
    [
      "missing createdAt",
      200,
      `{"status":"ready","address":"${AUTHORITY}","tokenAccount":"${TOKEN_ACCOUNT}"}`,
    ],
    [
      "string createdAt",
      200,
      `{"status":"ready","address":"${AUTHORITY}","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":"1763520000"}`,
    ],
    ["fractional retryAfterMs", 202, '{"status":"pending","retryAfterMs":1.5}'],
    ["negative retryAfterMs", 202, '{"status":"pending","retryAfterMs":-1}'],
    ["unknown status", 200, '{"status":"done"}'],
    ["JSON null", 200, "null"],
    ["not JSON", 200, "ready"],
    ["other 2xx", 204, ""],
  ])(
    "refuses a malformed success answer: %s",
    async (_name, httpStatus, body) => {
      const { client } = clientAnswering(
        new Response(httpStatus === 204 ? null : body, { status: httpStatus }),
      );
      const error = await rejection(client.queryDepositAddress(account));
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(GatewayHttpError);
    },
  );

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

  it("encodes the account as one path segment", async () => {
    const { client, transport } = clientAnswering(
      answer({
        httpStatus: 400,
        body: '{"status":"error","error":"bad","errorCode":"InvalidAccount"}',
      }),
    );
    await rejection(client.queryDepositAddress("../markets?x=1"));
    expect(transport.mock.calls[0][0]).toBe(
      "https://gateway.test/v1/deposit-address/..%2Fmarkets%3Fx%3D1",
    );
  });

  it("passes the abort signal and labels the read as owner-scoped", async () => {
    const { client, transport } = clientAnswering(
      answer(fixtureCase("pending")),
    );
    const controller = new AbortController();
    await client.queryDepositAddress(account, { signal: controller.signal });
    const [, init, context] = transport.mock.calls[0];
    expect(init.signal).toBe(controller.signal);
    expect(context).toMatchObject({ purpose: "account", priority: "urgent" });
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
