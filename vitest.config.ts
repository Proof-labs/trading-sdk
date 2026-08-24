import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Initialize the WASM core before each test file (the codec + signing now
    // route through it). Run `npm run build:wasm` first, or the codec tests
    // will fail to initialize.
    setupFiles: ["./src/test-setup.ts"],
  },
});
