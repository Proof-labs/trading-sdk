<!--
Thanks for contributing to @proof/trading-sdk!
Please keep each PR to one logical change (see CONTRIBUTING.md).
-->

## What & why

<!-- What does this change do, and why? One logical change per PR. -->

## Type of change

<!-- Pick one — see CONTRIBUTING.md. If two apply, it's two PRs. -->

- [ ] `feat` — new functionality
- [ ] `fix` — bug fix
- [ ] `refactor` / `style` — structural change, no behaviour change
- [ ] `docs` — documentation only
- [ ] `test` — tests only
- [ ] `chore` / `perf` — tooling, deps, performance

## Surface(s) touched

- [ ] TypeScript (`src/` → `dist/`)
- [ ] Rust core (`crates/`)
- [ ] Python bindings (`python/`)

## Checklist

- [ ] Builds and the relevant test suite passes locally (see CONTRIBUTING.md).
- [ ] Behaviour changes include a test exercising the new shape.
- [ ] Public API stays stable, **or** the breaking change is called out below.
- [ ] No private keys, seeds, or signatures are logged or added to fixtures.

## Wire-format / spec impact

<!--
The accepted wire shapes must not drift from the gateway spec.
If this changes types.ts / codec.ts or the envelope/signing layout, describe it.
If nothing changed, say "none".
-->

none

## Breaking changes

<!-- Describe any breaking change to exported types or behaviour, or "none". -->

none

<!--
Security issues: do NOT open a PR or public issue. Report privately via the
repository Security tab (Report a vulnerability). See SECURITY.md.
-->
