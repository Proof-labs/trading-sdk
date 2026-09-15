import { Decoder, Encoder } from "@msgpack/msgpack";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { decodeOraclePermissions } from "./index.js";

const hash = (byte: number) => Array(32).fill(byte);
const policy = () => [
  1,
  hash(1),
  hash(2),
  hash(3),
  100,
  10000,
  10000,
  [
    [1, hash(4), hash(6), 6],
    [2, hash(5), hash(6), 6],
  ],
];
const fresh = (): unknown[] => [
  1,
  14,
  10,
  true,
  "Committed",
  "Satisfied",
  policy(),
  null,
  [14, 1000, "Fresh", "Fresh", [100000000, 900], 950],
];
const encode = (data: unknown) =>
  Buffer.from(new Encoder({ useBigInt64: true }).encode(data)).toString(
    "base64",
  );

describe("committed oracle permissions", () => {
  it("decodes the engine-pinned legacy query bytes", () => {
    const fixture = readFileSync(
      new URL("../conformance/oracle-permissions-legacy.hex", import.meta.url),
      "utf8",
    ).trim();
    const bytes = Uint8Array.from(Buffer.from(fixture, "hex"));
    expect(
      decodeOraclePermissions(new Decoder({ useBigInt64: true }).decode(bytes)),
    ).toMatchObject({
      market: 1,
      finalizedHeight: 9n,
      activationHeight: 10n,
      oracleActive: false,
      state: "Legacy",
      oraclePermission: null,
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("preserves exact finalized data and large u64 values", () => {
    const raw = fresh();
    raw[1] = 9007199254740993n;
    (raw[8] as unknown[])[0] = raw[1];
    const decoded = decodeOraclePermissions(raw, 1);
    expect(decoded.finalizedHeight).toBe(9007199254740993n);
    expect(decoded.policy?.calendarHash).toBe("02".repeat(32));
    expect(decoded.policy?.sources[1].authority).toBe("05".repeat(32));
    expect(decoded.verdict?.certified?.price).toBe(100000000n);
  });
  it("does not invent a permission for legacy or an absent policy", () => {
    expect(
      decodeOraclePermissions([
        1,
        9,
        null,
        false,
        "Legacy",
        null,
        null,
        null,
        null,
      ]).oraclePermission,
    ).toBeNull();
    const unavailable = decodeOraclePermissions([
      1,
      10,
      10,
      true,
      "Unavailable",
      "Unavailable",
      null,
      [12, policy()],
      null,
    ]);
    expect(unavailable.pending?.effectiveHeight).toBe(12n);
    expect(unavailable.verdict).toBeNull();
  });
  it("retains stale reason without authorizing a last-good price", () => {
    const raw = fresh();
    raw[5] = "Unavailable";
    raw[8] = [14, 9000, "Stale", "ExpiredSource", null, null];
    expect(decodeOraclePermissions(raw).verdict).toMatchObject({
      status: "Stale",
      reason: "ExpiredSource",
      certified: null,
    });
  });
  it.each([
    (r: unknown[]) => {
      r[0] = 2;
    },
    (r: unknown[]) => {
      r[1] = Number.MAX_SAFE_INTEGER + 1;
    },
    (r: unknown[]) => {
      r[2] = null;
    },
    (r: unknown[]) => {
      r[3] = false;
    },
    (r: unknown[]) => {
      r[4] = "Legacy";
    },
    (r: unknown[]) => {
      r[5] = "Unavailable";
    },
    (r: unknown[]) => {
      r[6] = null;
    },
    (r: unknown[]) => {
      r[7] = [14, policy()];
    },
    (r: unknown[]) => {
      (r[8] as unknown[])[0] = 13;
    },
    (r: unknown[]) => {
      (r[8] as unknown[])[3] = "MissingSource";
    },
    (r: unknown[]) => {
      (r[8] as unknown[])[4] = null;
    },
    (r: unknown[]) => {
      (r[8] as unknown[])[4] = [0, 900];
    },
    (r: unknown[]) => {
      (r[8] as unknown[])[5] = 1001;
    },
  ])("rejects malformed or falsely permissive state", (change) => {
    const raw = fresh();
    change(raw);
    expect(() => decodeOraclePermissions(raw, 1)).toThrow(
      "oracle permissions decode",
    );
  });
  it("uses gateway by default and never reads provider health", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: encode(fresh()) })),
      );
    vi.stubGlobal("fetch", fetch);
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      apiUrl: "http://internal-node",
      chainId: "test",
    });
    expect((await client.queryOraclePermissions(1)).oraclePermission).toBe(
      "Satisfied",
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "http://gateway/v1/oracle/permissions/1",
    );
  });
  it("preserves upstream errors and refuses malformed markets before transport", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: "committed oracle permission unavailable" }),
          { status: 503 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      chainId: "test",
    });
    await expect(client.queryOraclePermissions(1)).rejects.toThrow(
      "committed oracle permission unavailable",
    );
    await expect(client.queryOraclePermissions(-1)).rejects.toThrow(
      "positive uint32",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
