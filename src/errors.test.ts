import { describe, it, expect } from "vitest";
import { decodeExecError, execErrorName } from "./errors.js";

describe("decodeExecError", () => {
  it("returns null for code 0 (success)", () => {
    expect(decodeExecError(0)).toBeNull();
  });

  it("decodes well-known existing codes", () => {
    expect(decodeExecError(12)?.name).toBe("InsufficientMargin");
    expect(decodeExecError(21)?.name).toBe("InvalidNonce");
    expect(decodeExecError(29)?.name).toBe("PositionLimitExceeded");
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
