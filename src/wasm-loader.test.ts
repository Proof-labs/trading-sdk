import { describe, expect, it, vi } from "vitest";

describe("wasm-loader ready() failure handling", () => {
  it("retries instantiation after a failed init instead of caching the rejection", async () => {
    // A fresh module registry gives this test its own wasm-loader instance
    // (the shared one is already initialized by test-setup.ts) and lets the
    // generated-WASM import be mocked to fail once.
    vi.resetModules();
    let attempts = 0;
    vi.doMock("./wasm/proof_trading_sdk_wasm.js", () => ({
      // Fail the first instantiation (the same path a transient .wasm fetch
      // error takes in a browser), succeed afterwards.
      default: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient fetch failure");
        }
        return {};
      },
    }));
    try {
      const loader = await import("./wasm-loader.js");
      await expect(loader.ready()).rejects.toThrow("transient fetch failure");
      // The failed attempt must not stay cached: the next call re-imports.
      await expect(loader.ready()).resolves.toBeUndefined();
      expect(attempts).toBe(2);
      // And a successful init stays cached — no third instantiation.
      await loader.ready();
      expect(attempts).toBe(2);
    } finally {
      vi.doUnmock("./wasm/proof_trading_sdk_wasm.js");
      vi.resetModules();
    }
  });
});
