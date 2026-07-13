import { describe, it, expect } from "vitest";
import { ExecErrorCode, decodeExecError, execErrorName } from "./errors.js";

describe("decodeExecError", () => {
  it("returns null for code 0 (success)", () => {
    expect(decodeExecError(0)).toBeNull();
  });

  it("decodes well-known existing codes", () => {
    expect(decodeExecError(12)?.name).toBe("InsufficientMargin");
    expect(decodeExecError(21)?.name).toBe("TimestampNonceRejected");
    expect(decodeExecError(29)?.name).toBe("PositionLimitExceeded");
    expect(decodeExecError(47)?.name).toBe("FillOrKillWouldNotFill");
    expect(decodeExecError(48)?.name).toBe("InvalidCancelReplaceTarget");
    expect(decodeExecError(49)?.name).toBe("AmendBelowFilled");
    expect(decodeExecError(255)?.name).toBe("InternalError");
  });

  it("decodes the new variants added in the audit batch (31, 32)", () => {
    const e31 = decodeExecError(31);
    expect(e31?.name).toBe("TooManyActiveImpactMarkets");
    expect(e31?.description).toContain("scenario margin engine");

    const e32 = decodeExecError(32);
    expect(e32?.name).toBe("SettlementPriceMismatch");
    expect(e32?.description).toContain("net-delta margin grouping");
  });

  it("disambiguates shared code 50 only from canonical DeliverTx logs", () => {
    const oiLog = "open interest limit exceeded on market 7: would be 4, cap 3";
    const slippageLog =
      "atomic basket aggregate slippage 51 bps exceeds budget 50 bps";

    expect(decodeExecError(50, oiLog)?.name).toBe("OpenInterestLimitExceeded");
    expect(execErrorName(50, oiLog)).toBe("OpenInterestLimitExceeded");
    expect(decodeExecError(50, slippageLog)?.name).toBe("SlippageExceeded");
    expect(execErrorName(50, slippageLog)).toBe("SlippageExceeded");

    for (const log of [undefined, "", "unknown code 50 diagnostic"]) {
      expect(decodeExecError(50, log)?.name).toBe("AmbiguousCode50");
      expect(execErrorName(50, log)).toBe("AmbiguousCode50");
    }
  });

  it("returns null for unknown codes", () => {
    expect(decodeExecError(999)).toBeNull();
    expect(decodeExecError(-1)).toBeNull();
  });
});

describe("execErrorName", () => {
  it("returns 'Ok' for code 0", () => {
    expect(execErrorName(0)).toBe("Ok");
  });

  it("returns variant name for known codes", () => {
    expect(execErrorName(12)).toBe("InsufficientMargin");
    expect(execErrorName(31)).toBe("TooManyActiveImpactMarkets");
    expect(execErrorName(32)).toBe("SettlementPriceMismatch");
  });

  it("returns 'UnknownError' for codes not in the table", () => {
    expect(execErrorName(999)).toBe("UnknownError");
  });
});

describe("ExecErrorCode enum", () => {
  const numericEntries = Object.entries(ExecErrorCode).filter(
    ([, v]) => typeof v === "number",
  ) as [string, number][];

  it("every enum member resolves in the decode table with a matching name", () => {
    for (const [name, code] of numericEntries) {
      if (code === 50) continue;
      expect(execErrorName(code)).toBe(name);
      expect(decodeExecError(code)?.name).toBe(name);
    }
  });

  it("exposes the documented well-known codes", () => {
    expect(ExecErrorCode.InsufficientMargin).toBe(12);
    expect(ExecErrorCode.TimestampNonceRejected).toBe(21);
    expect(ExecErrorCode.AmendBelowFilled).toBe(49);
    expect(ExecErrorCode.OpenInterestLimitExceeded).toBe(50);
    expect(ExecErrorCode.InternalError).toBe(255);
  });
});
