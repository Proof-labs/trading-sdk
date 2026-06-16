# Security Policy

`@proof/trading-sdk` signs and encodes value-bearing transactions for the Proof
Exchange. It handles Ed25519 key material and produces signatures over the wire
envelope. We take vulnerabilities in this code seriously and appreciate reports
made through the process below.

## Supported versions

The SDK follows [semantic versioning](https://semver.org/). Security fixes are
released against the latest published `0.x` minor line. Until a `1.0.0` release,
only the most recent published version is supported — please upgrade before
reporting an issue you can only reproduce on an older release.

| Version | Supported |
| ------- | --------- |
| latest `0.x` | ✅ |
| older `0.x` | ❌ (upgrade first) |

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security
vulnerability.** Public disclosure before a fix is available puts users at risk.

Report privately through GitHub's **Report a vulnerability** flow:

1. Go to the repository's **[Security tab](https://github.com/Proof-labs/trading-sdk/security)**.
2. Click **Report a vulnerability** (GitHub Private Vulnerability Reporting).
3. Describe the issue with enough detail for us to reproduce it.

This routes the report to the maintainers privately — no email address is
required.

Please include, where applicable:

- The SDK version, language surface (TypeScript / Rust core / Python bindings),
  and runtime.
- A minimal reproduction or proof of concept.
- The impact you believe the issue has (e.g. key disclosure, signature forgery,
  malformed-input handling, replay).

**Never include live private keys, seeds, or signatures over real funds in a
report.** Use throwaway test key material to demonstrate an issue.

## What is in scope

Security-critical paths in this SDK include:

- **Key handling** — keypair generation, owner derivation, and any code path
  that touches private keys or seeds.
- **Signing** — the Ed25519 signing domain, `chain_id` binding, and replay
  protections (`seq` timestamp-nonce window).
- **Codec** — MessagePack encode/decode and signed-envelope assembly, including
  handling of malformed or adversarial input.

Issues in the upstream exchange engine, gateway, or CometBFT belong to those
projects, not this SDK. If you are unsure where a problem lives, report it here
and we will route it.

## Our commitment

- We will acknowledge a valid report and work with you on a fix and a
  coordinated disclosure timeline.
- We ask that you give us a reasonable window to release a fix before any public
  disclosure.
- Credit will be given to reporters who wish to be named, once a fix ships.
