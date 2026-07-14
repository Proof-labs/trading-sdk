import { describe, it, expect } from "vitest";
import {
  txEngineError,
  txFromEngineCode,
  txOk,
  txTimeout,
  txTransportError,
} from "./tx-result.js";

describe("tx-result builders", () => {
  it("txOk marks success and carries body fields", () => {
    const r = txOk({ hash: "AB", height: 7, events: [] });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("ok");
    expect(r.code).toBe(0);
    expect(r.error).toBeNull();
    expect(r.hash).toBe("AB");
    expect(r.height).toBe(7);
  });

  it("txOk defaults hash to empty string", () => {
    expect(txOk().hash).toBe("");
  });

  it("txEngineError tags 'engine' and auto-decodes a known code", () => {
    const r = txEngineError(12, { log: "nope" });
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("engine");
    expect(r.code).toBe(12);
    expect(r.error?.name).toBe("InsufficientMargin");
    expect(r.log).toBe("nope");
  });

  it("txEngineError leaves error null for an unknown code", () => {
    const r = txEngineError(9999);
    expect(r.outcome).toBe("engine");
    expect(r.error).toBeNull();
  });

  it("txTransportError tags 'transport' with null error and preserves code", () => {
    const r = txTransportError(429, "rate limited");
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("transport");
    expect(r.code).toBe(429);
    expect(r.error).toBeNull();
    expect(r.log).toBe("rate limited");
    expect(r.hash).toBe("");
  });

  it("transport code 1 is distinguishable from engine DecodeError(1) via outcome", () => {
    const transport = txTransportError(1, "<html>bad</html>");
    const engine = txEngineError(1, { log: "decode failed" });
    expect(transport.code).toBe(engine.code); // same integer …
    expect(transport.outcome).not.toBe(engine.outcome); // … different meaning
    expect(transport.error).toBeNull();
    expect(engine.error?.name).toBe("DecodeError");
  });

  it("txTimeout tags 'timeout' with code -1", () => {
    const r = txTimeout("CD", "timed out");
    expect(r.ok).toBe(false);
    expect(r.outcome).toBe("timeout");
    expect(r.code).toBe(-1);
    expect(r.error).toBeNull();
    expect(r.hash).toBe("CD");
  });

  it("txFromEngineCode classifies 0 as success and non-zero as engine", () => {
    expect(txFromEngineCode(0, { hash: "X" }).outcome).toBe("ok");
    const err = txFromEngineCode(21, { hash: "Y" });
    expect(err.outcome).toBe("engine");
    expect(err.error?.name).toBe("TimestampNonceRejected");
    expect(err.hash).toBe("Y");
  });
});
