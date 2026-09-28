import { describe, it, expect } from "vitest";
import {
  ExecErrorCode,
  GatewayHttpError,
  decodeExecError,
  execErrorName,
  isMissingMark,
} from "./errors.js";

describe("decodeExecError", () => {
  it("returns null for code 0 (success)", () => {
    expect(decodeExecError(0)).toBeNull();
  });

  it("decodes well-known existing codes", () => {
    expect(decodeExecError(12)?.name).toBe("InsufficientMargin");
    expect(decodeExecError(21)?.name).toBe("InvalidNonce");
    expect(decodeExecError(29)?.name).toBe("PositionLimitExceeded");
    expect(decodeExecError(47)?.name).toBe("FillOrKillWouldNotFill");
    expect(decodeExecError(48)?.name).toBe("InvalidCancelReplaceTarget");
    expect(decodeExecError(49)?.name).toBe("AmendBelowFilled");
    expect(decodeExecError(255)?.name).toBe("InternalError");
  });

  it("decodes the event cap and the settle-price mismatch (96, 32)", () => {
    const e96 = decodeExecError(96);
    expect(e96?.name).toBe("TooManyActiveEvents");
    expect(e96?.description).toContain("scenario margin engine");

    const e32 = decodeExecError(32);
    expect(e32?.name).toBe("SettlementPriceMismatch");
    expect(e32?.description).toContain("net-delta margin grouping");
  });

  it("decodes the unavailable-mark rejection (97)", () => {
    expect(ExecErrorCode.MarkUnavailable).toBe(97);
    const e97 = decodeExecError(97);
    expect(e97?.name).toBe("MarkUnavailable");
    expect(e97?.description).toContain("no mark price");
    expect(execErrorName(97)).toBe("MarkUnavailable");
  });

  it("decodes the F2 trigger-order incompatibility (98)", () => {
    expect(ExecErrorCode.TriggerOrderIncompatible).toBe(98);
    const e98 = decodeExecError(98);
    expect(e98?.name).toBe("TriggerOrderIncompatible");
    expect(e98?.description).toContain("SL/TP");
    expect(execErrorName(98)).toBe("TriggerOrderIncompatible");
  });

  it("decodes code 51 as open-interest-cap rejection without a log", () => {
    expect(decodeExecError(51)?.name).toBe("OpenInterestLimitExceeded");
    expect(decodeExecError(51, "unrecognized")?.name).toBe(
      "OpenInterestLimitExceeded",
    );
    expect(execErrorName(51)).toBe("OpenInterestLimitExceeded");
  });

  it("decodes the governance codes 52/53", () => {
    expect(decodeExecError(52)?.name).toBe("AdminGovernanceInactive");
    expect(decodeExecError(53)?.name).toBe("NotAdminSigner");
    expect(execErrorName(52)).toBe("AdminGovernanceInactive");
    expect(execErrorName(53)).toBe("NotAdminSigner");
    expect(ExecErrorCode.AdminGovernanceInactive).toBe(52);
    expect(ExecErrorCode.NotAdminSigner).toBe(53);
  });

  it("classifies transitional code 50 only from canonical DeliverTx logs", () => {
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
    expect(execErrorName(96)).toBe("TooManyActiveEvents");
    expect(execErrorName(31)).toBe("UnknownError");
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
    expect(ExecErrorCode.InvalidNonce).toBe(21);
    expect(ExecErrorCode.AmendBelowFilled).toBe(49);
    expect(ExecErrorCode.SlippageExceeded).toBe(50);
    expect(ExecErrorCode.OpenInterestLimitExceeded).toBe(51);
    expect(ExecErrorCode.InternalError).toBe(255);
  });
});

describe("GatewayHttpError", () => {
  it("carries errorCode when provided", () => {
    const res = new Response("", { status: 503 });
    const err = new GatewayHttpError(503, res, "MissingMark");
    expect(err.status).toBe(503);
    expect(err.errorCode).toBe("MissingMark");
    expect(err.message).toBe("Gateway request failed (503): MissingMark");
    expect(err.name).toBe("GatewayHttpError");
    expect(err.response).toBe(res);
  });

  it("omits errorCode from message when absent", () => {
    const res = new Response("", { status: 429 });
    const err = new GatewayHttpError(429, res);
    expect(err.errorCode).toBeUndefined();
    expect(err.message).toBe("Gateway request failed (429)");
  });
});

describe("isMissingMark", () => {
  it("returns true for a 503 GatewayHttpError with errorCode MissingMark", () => {
    const err = new GatewayHttpError(
      503,
      new Response("", { status: 503 }),
      "MissingMark",
    );
    expect(isMissingMark(err)).toBe(true);
  });

  it("returns false for a 503 without errorCode", () => {
    const err = new GatewayHttpError(503, new Response("", { status: 503 }));
    expect(isMissingMark(err)).toBe(false);
  });

  it("returns false for a non-503 with MissingMark errorCode", () => {
    const err = new GatewayHttpError(
      500,
      new Response("", { status: 500 }),
      "MissingMark",
    );
    expect(isMissingMark(err)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isMissingMark(new Error("something"))).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isMissingMark(null)).toBe(false);
    expect(isMissingMark(undefined)).toBe(false);
    expect(isMissingMark("MissingMark")).toBe(false);
  });
});
