import { Decoder, Encoder } from "@msgpack/msgpack";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { decodeOraclePermissions, ORACLE_FAULT_BITS } from "./index.js";

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
  [
    14,
    1000,
    "Fresh",
    "Fresh",
    [100000000, 900],
    950,
    0,
    2,
    [900, 850],
    [null, null],
    null,
    [100000000, 3600000, 3600000],
  ],
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
  describe("exchange-encoded committed reads", () => {
    interface CommittedCase {
      case: string;
      exchange: string;
      format: 2 | 3;
      hex: string;
      expect: {
        height: number;
        status: string;
        reason: string;
        certified_price: number | null;
        faults: number;
        fault_reasons: string[];
        valid_sources: number;
        selected: string | null;
        diagnostics: number | null;
        diagnostic_flags: string[];
      };
    }
    // Captured from exchange-core `query_oracle_permissions` (rmp_serde) at
    // the `exchange` commit on each row: format 3 from exchange#831, format 2
    // from exchange dev before it.
    const committedCases = readFileSync(
      new URL(
        "../conformance/oracle-permissions-committed.ndjson",
        import.meta.url,
      ),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CommittedCase);
    const bytes = (hex: string) =>
      new Decoder({ useBigInt64: true }).decode(
        Uint8Array.from(Buffer.from(hex, "hex")),
      ) as unknown[];

    it("covers both verdict layouts", () => {
      expect(new Set(committedCases.map((c) => c.format))).toEqual(
        new Set([2, 3]),
      );
    });
    it.each(committedCases.map((c) => [c.case, c] as const))(
      "decodes %s exactly",
      (_, c) => {
        const read = decodeOraclePermissions(bytes(c.hex), 1);
        expect(read.state).toBe("Committed");
        const v = read.verdict!;
        expect(v.format).toBe(c.format);
        expect(v.height).toBe(BigInt(c.expect.height));
        expect(v.status).toBe(c.expect.status);
        expect(v.reason).toBe(c.expect.reason);
        expect(v.certified?.price ?? null).toBe(
          c.expect.certified_price === null
            ? null
            : BigInt(c.expect.certified_price),
        );
        expect(v.faults).toBe(c.expect.faults);
        expect(v.faultReasons).toEqual(c.expect.fault_reasons);
        expect(v.validSources).toBe(c.expect.valid_sources);
        expect(v.selected).toBe(c.expect.selected);
        expect(v.diagnostics).toBe(c.expect.diagnostics);
        expect(v.diagnosticFlags).toEqual(c.expect.diagnostic_flags);
        expect(read.oraclePermission).toBe(
          c.expect.status === "Fresh" ? "Satisfied" : "Unavailable",
        );
      },
    );
    it("prices a fallback certificate from the fallback slot's own record", () => {
      const c = committedCases.find(
        (c) => c.case === "v3/fresh_fallback_primary_refused_divergence",
      )!;
      const v = decodeOraclePermissions(bytes(c.hex), 1).verdict!;
      expect(v.certified?.providerTime).toBe(v.currentTimes[1]);
    });
    it("keeps one fault-bit layout across both formats", () => {
      const byCase = (name: string) =>
        decodeOraclePermissions(
          bytes(committedCases.find((c) => c.case === name)!.hex),
          1,
        ).verdict!;
      const v3 = byCase("v3/unpriceable_warmup_reference_unavailable");
      const v2 = byCase("v2/unpriceable_warmup_reference_unavailable");
      // ReferenceUnavailable stays bit 8 and RecoveryPending bit 14: the
      // retired Disagreement (7) and PairTimeMismatch (13) keep their slots.
      expect(v3.faults).toBe((1 << 8) | (1 << 14));
      expect(v3.faults).toBe(v2.faults);
      expect(v3.faultReasons).toEqual(v2.faultReasons);
      expect(ORACLE_FAULT_BITS[7]).toBe("Disagreement");
      expect(ORACLE_FAULT_BITS[13]).toBe("PairTimeMismatch");
    });

    const v3Fresh = () =>
      bytes(committedCases.find((c) => c.case === "v3/fresh_primary")!.hex);
    it.each([
      ["a thirteen-field verdict", (v: unknown[]) => v.pop()],
      ["a fifteen-field verdict", (v: unknown[]) => v.push(0)],
      ["an unknown selected slot", (v: unknown[]) => (v[12] = "Secondary")],
      ["a selected ordinal", (v: unknown[]) => (v[12] = 0)],
      ["an out-of-range diagnostic bit", (v: unknown[]) => (v[13] = 0x10)],
      ["a diagnostic above u8", (v: unknown[]) => (v[13] = 0x100)],
      [
        "a fresh verdict with no selected slot",
        (v: unknown[]) => (v[12] = null),
      ],
      [
        "the fallback selected while the primary is usable",
        (v: unknown[]) => {
          v[12] = "Fallback";
          v[13] = 1;
        },
      ],
      ["OnFallback on a primary selection", (v: unknown[]) => (v[13] = 1)],
      [
        "DivergenceUnchecked without both slots usable",
        (v: unknown[]) => {
          v[7] = 1;
          v[13] = 0b1100;
        },
      ],
      [
        "FallbackUnusable with a usable fallback",
        (v: unknown[]) => (v[13] = 8),
      ],
      ["a fault word on a fresh verdict", (v: unknown[]) => (v[6] = 1)],
      ["a fault bit past RecoveryPending", (v: unknown[]) => (v[6] = 1 << 15)],
      ["a source mask past slot 1", (v: unknown[]) => (v[7] = 7)],
    ])("rejects %s", (_, change) => {
      const raw = v3Fresh();
      change(raw[8] as unknown[]);
      expect(() => decodeOraclePermissions(raw, 1)).toThrow(
        "oracle permissions decode",
      );
    });
    it("rejects a format-3 non-fresh reason missing from its fault word", () => {
      const c = committedCases.find(
        (c) => c.case === "v3/unpriceable_no_usable_source",
      )!;
      const raw = bytes(c.hex);
      (raw[8] as unknown[])[3] = "ManualHalt";
      expect(() => decodeOraclePermissions(raw, 1)).toThrow(
        "verdict selection",
      );
    });
    it("still accepts the reasons older nodes emit in the format-2 layout", () => {
      for (const reason of [
        "Disagreement",
        "PairTimeMismatch",
        "AnchorUnavailable",
        "ReferenceUnavailable",
      ]) {
        const c = committedCases.find(
          (c) => c.case === "v2/unpriceable_no_usable_source",
        )!;
        const raw = bytes(c.hex);
        (raw[8] as unknown[])[3] = reason;
        expect(decodeOraclePermissions(raw, 1).verdict?.reason).toBe(reason);
      }
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
  it("decodes the twelve-field format-2 verdict with evidence digests and last-good", () => {
    const raw = fresh();
    raw[8] = [
      14,
      1000,
      "Fresh",
      "Fresh",
      [100000000, 900],
      950,
      0,
      2,
      [900, 850],
      [Array(32).fill(7), Array(32).fill(9)],
      [50000000, 800],
      [100000000, 3600000, 7200000],
    ];
    const verdict = decodeOraclePermissions(raw, 1).verdict!;
    expect(verdict.faults).toBe(0);
    expect(verdict.validSources).toBe(2);
    expect(verdict.currentTimes).toEqual([900n, 850n]);
    expect(verdict.evidence).toEqual([
      new Uint8Array(Array(32).fill(7)),
      new Uint8Array(Array(32).fill(9)),
    ]);
    expect(verdict.lastGood).toEqual({ price: 50000000n, providerTime: 800n });
    expect(verdict.anchor).toEqual({
      price: 100000000n,
      coveredMs: 3600000n,
      requiredMs: 7200000n,
    });
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
    raw[8] = [
      14,
      9000,
      "Stale",
      "ExpiredSource",
      null,
      null,
      0,
      2,
      [null, null],
      [null, null],
      null,
      [null, 0, 3600000],
    ];
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
    (r: unknown[]) => {
      (r[8] as unknown[])[10] = [0, 800];
    },
    (r: unknown[]) => {
      (r[8] as unknown[])[10] = [50000000, 2000];
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
