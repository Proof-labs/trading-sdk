import { Decoder, Encoder } from "@msgpack/msgpack";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  decodeFinancialAudit,
  decodeFinancialAuditArtifact as decodePinnedArtifact,
} from "./index.js";

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

const pins = {
  snapshotSha256: "ab".repeat(32),
  executableSha256: "cd".repeat(32),
  chainId: "audit-test",
  height: 0n,
  timeMs: 1234n,
};
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
// Deliberately malformed synthetic fixtures are re-pinned to exercise structural checks.
const decodeFinancialAuditArtifact = (
  text: string,
  expected: typeof pins,
  selected: typeof selection,
) =>
  decodePinnedArtifact(
    text,
    { ...expected, artifactSha256: digest(text) },
    selected,
  );
const artifact = () => ({
  protocol: "proof-financial-audit/offline-v1",
  trust: "operator-attested-local-snapshot-not-full-state-proof",
  provenance: "operator export record",
  snapshotSha256: pins.snapshotSha256,
  executableSha256: pins.executableSha256,
  chainId: pins.chainId,
  height: "0",
  timeMs: "1234",
  timeSource: "operator-attested-same-height-header",
  markets: "1,2",
  owners: selection.owners[0],
  data: Buffer.from(golden, "hex").toString("base64"),
});

describe("financial audit format2", () => {
  it("rejects output tampering against an independently recorded artifact digest", () => {
    const original = JSON.stringify(artifact());
    expect(() =>
      decodePinnedArtifact(
        original.replace("operator export record", "altered export record"),
        { ...pins, artifactSha256: digest(original) },
        selection,
      ),
    ).toThrow("artifact digest");
  });
  afterEach(() => vi.unstubAllGlobals());
  it("decodes the independent Rust vector offline without any network access", () => {
    const fetcher = vi.fn(() => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", fetcher);
    const { audit: result, trust } = decodeFinancialAuditArtifact(
      JSON.stringify(artifact()),
      pins,
      selection,
    );
    expect(trust).toBe("operator-attested-local-snapshot-not-full-state-proof");
    expect(result.format).toBe(2);
    expect(result.ledger.finalizedTimeMs).toBe(1234n);
    expect(result.markets[0].openInterest).toEqual({
      long: (1n << 64n) - 1n,
      short: 17n,
    });
    expect(result.markets[1].openInterest).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
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
  it("bounds offline binary decoding", () => {
    expect(() =>
      decodeFinancialAuditArtifact(
        JSON.stringify({
          ...artifact(),
          data: encode([2, ["a".repeat(17)], []]),
        }),
        pins,
        selection,
      ),
    ).toThrow("resource limit");
    expect(() =>
      decodeFinancialAuditArtifact(
        "x".repeat(1024 * 1024 + 8193),
        pins,
        selection,
      ),
    ).toThrow("artifact size");
  });
  it.each([
    "protocol",
    "trust",
    "provenance",
    "snapshotSha256",
    "executableSha256",
    "chainId",
    "height",
    "timeMs",
    "timeSource",
    "markets",
    "owners",
    "data",
  ])("rejects mismatched artifact %s", (field) => {
    expect(() =>
      decodeFinancialAuditArtifact(
        JSON.stringify({ ...artifact(), [field]: "" }),
        pins,
        selection,
      ),
    ).toThrow();
  });
  it("rejects unknown fields, noncanonical base64 and inconsistent ledger time", () => {
    expect(() =>
      decodeFinancialAuditArtifact(
        JSON.stringify({ ...artifact(), extra: 1 }),
        pins,
        selection,
      ),
    ).toThrow("wrapper");
    expect(() =>
      decodeFinancialAuditArtifact(
        JSON.stringify({ ...artifact(), data: artifact().data + "=" }),
        pins,
        selection,
      ),
    ).toThrow("base64");
    expect(() =>
      decodeFinancialAuditArtifact(
        JSON.stringify({ ...artifact(), timeMs: "1235" }),
        { ...pins, timeMs: 1235n },
        selection,
      ),
    ).toThrow("ledger height/time");
  });
});
