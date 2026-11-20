import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEPOSIT_ADDRESS_ERROR_CODES,
  ExchangeClient,
  GatewayHttpError,
  GatewayReadError,
  DEPOSIT_ADDRESS_TIMEOUT_MS,
  isDepositAddressErrorCode,
  type DepositAddressReady,
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
    const got: DepositAddressReady = await client.queryDepositAddress(account);
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

  it("keeps errorCode SubAccount on a GatewayHttpError", async () => {
    const { client } = clientAnswering(answer(fixtureCase("subAccount")));
    const error = await rejection(client.queryDepositAddress(account));
    expect(error).toBeInstanceOf(GatewayHttpError);
    const e = error as GatewayHttpError;
    expect(e.status).toBe(403);
    expect(e.errorCode).toBe("SubAccount");
    expect(e.message).toContain("this is a sub-account");
    // The error keeps an unread copy of the response.
    await expect(e.response.json()).resolves.toMatchObject({
      errorCode: "SubAccount",
    });
  });

  it("keeps errorCode RateLimited and the body's retryAfterMs in the body", async () => {
    const { client } = clientAnswering(answer(fixtureCase("rateLimited")));
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e).toBeInstanceOf(GatewayHttpError);
    expect(e.status).toBe(429);
    expect(e.errorCode).toBe("RateLimited");
    // As on the submission path, the retry time is the body's own field;
    // the Retry-After header is not read.
    expect("retryAfterMs" in e).toBe(false);
    await expect(e.response.json()).resolves.toMatchObject({
      retryAfterMs: 1500,
    });
  });

  it.each([
    ["paused", "Paused", "deposits are paused"],
    ["unavailable", "Unavailable", "deposit addresses are unavailable"],
  ])(
    "keeps the %s answer's errorCode on a 503 GatewayHttpError",
    async (name, code, text) => {
      const { client } = clientAnswering(answer(fixtureCase(name)));
      const e = (await rejection(
        client.queryDepositAddress(account),
      )) as GatewayHttpError;
      expect(e).toBeInstanceOf(GatewayHttpError);
      expect(e.status).toBe(503);
      expect(e.errorCode).toBe(code);
      expect(isDepositAddressErrorCode(e.errorCode)).toBe(true);
      expect(e.message).toContain(text);
    },
  );

  it("covers every fixture case", () => {
    expect(fixture.cases.map((c) => c.name)).toEqual([
      "ready",
      "subAccount",
      "rateLimited",
      "paused",
      "unavailable",
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

  it("keeps errorCode on 400 InvalidAccount", async () => {
    const { client } = clientAnswering(
      answer({
        httpStatus: 400,
        body: '{"status":"error","error":"account must be 0x followed by 40 hex digits","errorCode":"InvalidAccount"}',
      }),
    );
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e).toBeInstanceOf(GatewayHttpError);
    expect(e.status).toBe(400);
    expect(e.errorCode).toBe("InvalidAccount");
    expect(isDepositAddressErrorCode(e.errorCode)).toBe(true);
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

  it("leaves errorCode unset for a code outside the five", async () => {
    const { client } = clientAnswering(
      answer({
        httpStatus: 404,
        body: '{"status":"error","error":"not found","errorCode":"NotFound"}',
      }),
    );
    const e = (await rejection(
      client.queryDepositAddress(account),
    )) as GatewayHttpError;
    expect(e.status).toBe(404);
    expect(e.errorCode).toBeUndefined();
    expect(e.message).toContain("not found");
  });

  it.each([
    // The gateway answers only once the address exists, so a 202 is malformed.
    ["ready on 202", 202, fixtureCase("ready").body, "status"],
    ["ready on 201", 201, fixtureCase("ready").body, "status"],
    ["refusal body on 200", 200, fixtureCase("paused").body, "status"],
    [
      "numeric address",
      200,
      `{"status":"ready","address":1,"tokenAccount":"${TOKEN_ACCOUNT}","createdAt":null}`,
      "address",
    ],
    [
      "pending on 202",
      202,
      '{"status":"pending","retryAfterMs":2000}',
      "status",
    ],
    [
      "pending on 200",
      200,
      '{"status":"pending","retryAfterMs":2000}',
      "status",
    ],
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
      "all-zero address (the System Program id)",
      200,
      `{"status":"ready","address":"${"1".repeat(32)}","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":null}`,
      "address",
    ],
    [
      "all-zero tokenAccount (the System Program id)",
      200,
      `{"status":"ready","address":"${AUTHORITY}","tokenAccount":"${"1".repeat(32)}","createdAt":null}`,
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

  it("reads from the gateway even on the internal direct-node path", async () => {
    const transport = vi.fn().mockResolvedValue(answer(fixtureCase("ready")));
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
    const { client, transport } = clientAnswering(answer(fixtureCase("ready")));
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
    const { client, transport } = clientAnswering(answer(fixtureCase("ready")));
    await client.queryDepositAddress(given);
    expect(transport.mock.calls[0][0]).toBe(
      `https://gateway.test/v1/deposit-address/${account}`,
    );
  });

  it("labels the read as owner-scoped and passes on the caller's abort", async () => {
    const { client, transport } = clientAnswering(answer(fixtureCase("ready")));
    const controller = new AbortController();
    await client.queryDepositAddress(account, { signal: controller.signal });
    const [, init, context] = transport.mock.calls[0];
    expect(context).toMatchObject({ purpose: "account", priority: "urgent" });
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects with the caller's reason when aborted before the request", async () => {
    const { client, transport } = clientAnswering(answer(fixtureCase("ready")));
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
        c.enqueue(new TextEncoder().encode('{"status":"rea'));
      },
      pull(c) {
        c.error(aborted);
      },
    });
    const { client } = clientAnswering(new Response(body, { status: 200 }));
    const error = await rejection(client.queryDepositAddress(account));
    expect(error).toBe(aborted);
  });

  it("rejects with the caller's reason when aborted mid-body", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"status":"rea'));
      },
      pull() {
        controller.abort();
        return new Promise(() => {});
      },
    });
    const { client } = clientAnswering(new Response(body, { status: 200 }));
    const error = await rejection(
      client.queryDepositAddress(account, { signal: controller.signal }),
    );
    expect(error).toMatchObject({ name: "AbortError" });
    expect(error).not.toBeInstanceOf(GatewayReadError);
  });

  it("waits 20 seconds by default, past the gateway's 15-second limit", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn(() => new Promise<Response>(() => {}));
      const client = new ExchangeClient({
        gatewayUrl: "https://gateway.test",
        httpTransport: transport,
      });
      let settled: unknown = "waiting";
      const read = client.queryDepositAddress(account).then(
        () => (settled = "resolved"),
        (error: unknown) => (settled = error),
      );
      await vi.advanceTimersByTimeAsync(DEPOSIT_ADDRESS_TIMEOUT_MS - 1);
      expect(settled).toBe("waiting");
      await vi.advanceTimersByTimeAsync(1);
      await read;
      expect(settled).toBeInstanceOf(GatewayReadError);
      expect(settled).toMatchObject({ kind: "deadline" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits past 20 seconds when timeoutMs raises the deadline", async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn(() => new Promise<Response>(() => {}));
      const client = new ExchangeClient({
        gatewayUrl: "https://gateway.test",
        httpTransport: transport,
      });
      let settled: unknown = "waiting";
      const read = client
        .queryDepositAddress(account, { timeoutMs: 30_000 })
        .then(
          () => (settled = "resolved"),
          (error: unknown) => (settled = error),
        );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe("waiting");
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe("waiting");
      await vi.advanceTimersByTimeAsync(1);
      await read;
      expect(settled).toMatchObject({ kind: "deadline" });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("a refusal whose body is slow near the deadline", () => {
    // Headers 100 ms before the deadline, the Paused body `bodyAfterMs` later.
    const slowRefusal = (bodyAfterMs: number) => {
      const paused = fixtureCase("paused");
      const transport = vi.fn(
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(() => {
              const body = new ReadableStream<Uint8Array>({
                start(c) {
                  setTimeout(() => {
                    c.enqueue(new TextEncoder().encode(paused.body));
                    c.close();
                  }, bodyAfterMs);
                },
              });
              resolve(
                new Response(body, {
                  status: paused.httpStatus,
                  headers: paused.headers,
                }),
              );
            }, 900),
          ),
      );
      const client = new ExchangeClient({
        gatewayUrl: "https://gateway.test",
        httpTransport: transport,
      });
      let settled: unknown = "waiting";
      const read = client
        .queryDepositAddress(account, { timeoutMs: 1_000 })
        .then(
          () => (settled = "resolved"),
          (error: unknown) => (settled = error),
        );
      return { read, settled: () => settled };
    };

    it("keeps errorCode Paused when the body lands before the deadline", async () => {
      vi.useFakeTimers();
      try {
        const { read, settled } = slowRefusal(50);
        await vi.advanceTimersByTimeAsync(1_000);
        await read;
        expect(settled()).toBeInstanceOf(GatewayHttpError);
        expect(settled()).toMatchObject({ status: 503, errorCode: "Paused" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("throws the status, not a deadline error, when the body misses it", async () => {
      vi.useFakeTimers();
      try {
        const { read, settled } = slowRefusal(500);
        await vi.advanceTimersByTimeAsync(1_000);
        await read;
        const error = settled() as GatewayHttpError;
        expect(error).toBeInstanceOf(GatewayHttpError);
        expect(error.status).toBe(503);
        expect(error.errorCode).toBeUndefined();
        expect(await error.response.text()).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });
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
        httpStatus: 200,
        body: `{"status":"ready","address":"${AUTHORITY}","tokenAccount":"${TOKEN_ACCOUNT}","createdAt":null,"pad":"${"x".repeat(1024 * 1024)}"}`,
      }),
    );
    const error = await rejection(client.queryDepositAddress(account));
    expect(error).toMatchObject({ kind: "limit", field: "responseBytes" });
  });
});

describe("deposit address error codes", () => {
  it("names exactly the five codes the service answers with", () => {
    expect([...DEPOSIT_ADDRESS_ERROR_CODES]).toEqual([
      "InvalidAccount",
      "SubAccount",
      "RateLimited",
      "Paused",
      "Unavailable",
    ]);
    expect(isDepositAddressErrorCode("SubAccount")).toBe(true);
    expect(isDepositAddressErrorCode("subaccount")).toBe(false);
    expect(isDepositAddressErrorCode(undefined)).toBe(false);
  });
});
