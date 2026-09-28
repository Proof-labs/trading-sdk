import { Decoder, Encoder } from "@msgpack/msgpack";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFinancialAudit, ExchangeClient } from "./index.js";

// Generated and asserted by exchange query::financial::tests::
// audit_preserves_v1_bytes_absence_and_exact_open_interest_without_writes.
const golden =
  "9302980100cd04d29196dc00140404040404040404040404040404040404040404c0c0c0c090929c010000020390cdea6064c0c0c0c09c020700020390cdea6064c0c0c0c0c0929200c09207c0c0929701a450657270c0c0c0c092cfffffffffffffffff119702a450657270c0c0c0c0c0";
const selection = { markets: [1, 2], owners: ["04".repeat(20)] };
const raw = (): unknown[] =>
  new Decoder({ useBigInt64: true }).decode(
    Buffer.from(golden, "hex"),
  ) as unknown[];
const encode = (value: unknown) =>
  Buffer.from(new Encoder({ useBigInt64: true }).encode(value)).toString(
    "base64",
  );

describe("financial audit format2", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("decodes the independent Rust vector through the gateway even in node mode", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: Buffer.from(golden, "hex").toString("base64"),
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      apiUrl: "http://node",
      useGateway: false,
      chainId: "test",
    });
    const result = await client.queryFinancialAudit(selection);
    expect(result.format).toBe(2);
    expect(result.ledger.finalizedTimeMs).toBe(1234n);
    expect(result.markets[0].openInterest).toEqual({
      long: (1n << 64n) - 1n,
      short: 17n,
    });
    expect(result.markets[1].openInterest).toBeNull();
    expect(fetcher.mock.calls[0][0]).toBe(
      `http://gateway/v1/financial/audit?markets=1,2&owners=${selection.owners[0]}`,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("decodes conditional and binary metadata without coercing event phases", () => {
    const r = raw();
    r[2] = [
      [1, "Conditional", 9, "Yes", 3, "PreResolution", [4, 4]],
      [2, "Binary", 9, "No", null, "Trading", null],
    ];
    const result = decodeFinancialAudit(r, selection);
    expect(result.markets[0]).toMatchObject({
      event: 9,
      underlying: 3,
      phase: "PreResolution",
      kind: "Conditional",
    });
    expect(result.markets[1].branch).toBe("No");
  });
  const corruptions: [string, (r: unknown[]) => void][] = [
    [
      "format",
      (r) => {
        r[0] = 1;
      },
    ],
    [
      "coverage",
      (r) => {
        r[2] = [];
      },
    ],
    [
      "order",
      (r) => {
        (r[2] as unknown[][]).reverse();
      },
    ],
    [
      "kind",
      (r) => {
        (r[2] as unknown[][])[0][1] = "Unknown";
      },
    ],
    [
      "perp metadata",
      (r) => {
        (r[2] as unknown[][])[0][2] = 9;
      },
    ],
    [
      "conditional metadata",
      (r) => {
        (r[2] as unknown[][])[0][1] = "Conditional";
      },
    ],
    [
      "negative OI",
      (r) => {
        (r[2] as unknown[][])[0][6] = [-1, 0];
      },
    ],
    [
      "unsafe OI",
      (r) => {
        (r[2] as unknown[][])[0][6] = [Number.MAX_SAFE_INTEGER + 1, 0];
      },
    ],
    [
      "extra fields",
      (r) => {
        (r[2] as unknown[][])[0].push(0);
      },
    ],
    [
      "void phase",
      (r) => {
        (r[2] as unknown[][])[0][5] = "Void";
      },
    ],
  ];
  it.each(corruptions)("rejects %s", (_label, corrupt) => {
    const r = raw();
    corrupt(r);
    expect(() => decodeFinancialAudit(r, selection)).toThrow("financial audit");
  });
  it("does not accept an out-of-selection account position", () => {
    const r = raw();
    const ledger = r[1] as unknown[];
    const accounts = ledger[3] as unknown[][];
    accounts[0][5] = [[Array(20).fill(4), 3, "Buy", 100, 1, 0]];
    expect(() => decodeFinancialAudit(r, selection)).toThrow(
      "unselected position",
    );
  });
  it("bounds audit transport and never retries unsupported endpoints", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "http://gateway",
      chainId: "test",
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(client.queryFinancialAudit(selection)).rejects.toThrow("503");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ data: encode([2, ["a".repeat(17)], []]) })),
    );
    await expect(client.queryFinancialAudit(selection)).rejects.toThrow(
      "resource limit",
    );
  });
});
