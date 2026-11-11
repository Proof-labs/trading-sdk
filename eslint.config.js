// Minimal bug-catching lint gate.
//
// `tsc` type-checks but does NOT flag several real defects — a duplicate
// `switch` case, a redeclared interface, unreachable code, a duplicate object
// key — so before this config a dead `case "CancelAllOrdersForAccount"` reached
// dev (#136), visible only as a non-fatal esbuild warning downstream.
// `eslint:recommended` catches that class (no-duplicate-case, no-redeclare,
// no-unreachable, no-fallthrough, no-dupe-keys, no-loss-of-precision, …) and
// nothing else — no style opinions (prettier owns formatting), no
// TypeScript-specific rules — so it is a guard, not a rewrite.
import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist/**", "src/wasm/**", "coverage/**", "**/*.d.ts"] },
  js.configs.recommended,
  {
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
    },
    rules: {
      // Owned elsewhere: tsc flags undefined identifiers and unused locals in
      // typed code, and the base rules misfire on TS types and on the Node
      // globals the .mjs scripts use. Leave them off so this stays a pure
      // logic-bug gate.
      "no-unused-vars": "off",
      "no-undef": "off",
    },
  },
];
