# Contributing to the Proof Trading SDK

Thanks for your interest in [`@proof/trading-sdk`](https://github.com/Proof-labs/trading-sdk) —
the developer kit for signing, encoding, querying, and submitting actions on the Proof
Exchange. Contributions of all kinds are welcome: bug reports, fixes, tests, docs, and
features.

## Repository layout

This is a multi-language SDK. Build and run the test suite for the surface you touch
before opening a PR.

| Surface                                            | Path                | Build / test                                                 |
| -------------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| **TypeScript** (published as `@proof/trading-sdk`) | repo root → `dist/` | `npm install && npm run build`, then `npm run test` (vitest) |
| **Rust core**                                      | `crates/`           | standard `cargo build` / `cargo test` workflow               |
| **Python bindings**                                | `python/` (PyO3)    | see `python/pyproject.toml`                                  |

## Reporting bugs & requesting features

Open a [GitHub issue](https://github.com/Proof-labs/trading-sdk/issues) with a minimal
reproduction: the SDK version, your runtime, a short code snippet, and expected vs. actual
behaviour.

For **security vulnerabilities, do not open a public issue** — report them privately
through the repository's **Security** tab (Report a vulnerability). See the security policy
for details.

## Pull Request Rules

Each PR does exactly **one logical thing**. If you can't describe it in a single sentence
without using "and," split it into separate PRs. (Distilled from
[Google's Engineering Practices](https://google.github.io/eng-practices/).)

- **Never combine a feature and a bugfix** — open separate PRs.
- **Never mix behaviour changes with structural ones** (refactors, renames, reformatting,
  lint fixes). Structural changes get their own PR.
- **Keep PRs small and reviewable;** prefer a stack of small PRs over one large one.
- **Apply the revert test:** _"If this broke production, could it be reverted cleanly
  without removing unrelated work?"_ If not, split it.
- **Title every PR with one Conventional Commits prefix** — `feat`, `fix`, `refactor`,
  `style`, `chore`, `docs`, `test`, `perf`. Exactly one type per PR; if two apply, it's
  two PRs.
- **Add a test with every behaviour change.** A change to the public API needs a test
  exercising the new shape.

## Opening a pull request

1. Fork the repository and create a branch from `main` (`<type>/<short-description>`).
2. Make your change with tests, and run the relevant build + test suite.
3. Keep the public API stable where you can; call out any breaking change clearly in the
   PR description.
4. Open a PR against `main` with a short summary of **what** changed and **why**.

## Public API & versioning

`@proof/trading-sdk` follows [semantic versioning](https://semver.org/). Breaking changes
to exported types or behaviour must be called out explicitly in the PR description. The
published package surface is the TypeScript `dist/` build (see `exports` in
`package.json`).

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE), the same license that covers this project.
