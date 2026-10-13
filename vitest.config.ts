import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Initialize the WASM core before each test file (the codec + signing now
    // route through it). Run `npm run build:wasm` first, or the codec tests
    // will fail to initialize.
    setupFiles: ["./src/test-setup.ts"],
    // Vitest strips types without checking them, and tsconfig.json leaves
    // tests out of `tsc`. The barrel test's type-only imports are its
    // assertions, so tsc must see that file or a dropped export passes.
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.typecheck.json",
      include: ["src/index.exports.test.ts"],
    },
  },
});
