# Gateway refusal release checklist

Release preparation only: no merge, tag, staging or publication is authorized
by this document. Track completion in [#342](https://github.com/Proof-labs/trading-sdk/issues/342).

## Artifacts

| Artifact                     | Prepared version | Rationale                                                                                 | Tag           |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------- | ------------- |
| `@proof-labs/trading-sdk`    | `10.2.0`         | Adds refusal reason metadata; retains the existing outcome union.                         | `npm-v10.2.0` |
| `proof-trading-sdk` (Python) | `5.0.0`          | Changes public exception handling and includes the shared core's F16 action/wire changes. | `py-v5.0.0`   |

Rust crates are not part of this release set. Each artifact publishes
independently; approval or publication of one does not release the other.

## Migration

- TypeScript callers can read `TxResult.errorCode` on a validated refusal.
  `outcome` remains `transport`; the numeric `code` is not an engine code.
- Python callers must catch `PreAdmissionRefusal` for admission refusals and
  internal `EncodingError` refusals. Its `error_code`, `message` and
  `status_code` preserve the gateway reason.
- Malformed or contradictory refusals retain the local transaction hash.
  Python raises `SubmissionPending`; TypeScript returns a `timeout` outcome.
  Reconcile the existing bytes rather than creating a replacement transaction.
- A valid refusal describes only that HTTP attempt. It does not settle the
  outcome of an earlier ambiguous attempt. Any later retry depends on the
  refusal reason, not the HTTP status alone.
- Python includes the previously documented F16 changes: migrate the removed
  oracle update actions to the certified oracle flow under the market's policy,
  remove `EnableSubAccounts`, and provide `CreateMarket.tick_size` and
  `CreateMarket.lot_size`. Review the full breaking-change list in the
  changelog's 10.0.0 section before upgrading a source-built older Python SDK.

## Merge and verification gates

1. Review and merge [#345](https://github.com/Proof-labs/trading-sdk/pull/345)
   into `dev` before its stacked release-preparation PR.
2. Rebase the release preparation onto the resulting `dev` tip and resolve any
   version collision before merge. Keep the npm manifest and lockfile aligned;
   keep Python's distribution version independent of the Rust crate versions.
3. Run full TypeScript, Python and Rust CI, formatting and security gates.
   Build the npm artifact and Python wheel/sdist from the release checkout.
   Exercise the packed npm browser artifact before staging it.
   Until [#391](https://github.com/Proof-labs/trading-sdk/issues/391) is fixed,
   run `smoke:browser:prepare` under npm 11; its pack-output parser rejects
   npm 12's JSON shape. The publishing workflow still uses npm 12 for staging.
4. Promote `dev` into `main` using a **merge commit**, never squash or rebase.
5. Require successful `ci.yml` on the exact commit selected for each release
   tag. Confirm each tag matches its package manifest. Do not move a published
   tag or reuse an occupied registry version.

## Publishing gates

### npm

- A maintainer must authorize the release tag separately.
- The tag-triggered workflow stages the package through the configured
  `npm-publish` trusted-publishing environment.
- Staging is not publication. A maintainer must inspect the staged package and
  approve it on npm with 2FA.
- Verify the exact version is public and installable before marking npm done.

### Python

- Provision the release credential required by the existing workflow:
  `MATURIN_PYPI_TOKEN`. Verify project ownership and first-publication access
  before authorizing the tag.
- A maintainer must authorize the Python tag separately.
- The current workflow builds a Linux ABI3 wheel and an sdist; it does not
  produce a macOS/Windows wheel matrix. Check these artifacts match the
  intended supported installations.
- Verify the exact version is public and installable before marking Python done.

## Gateway and closure

- [Gateway #306](https://github.com/Proof-labs/api-gateway/pull/306) corrects the
  noncanonical/proposer-only admission envelopes. It is independent of the SDK
  release stack.
- Include that fix in the existing
  [gateway promotion #305](https://github.com/Proof-labs/api-gateway/pull/305)
  after it reaches `dev`; do not create a duplicate promotion.
- Require CI on the selected gateway commit before authorizing an image tag.
  Check the deployed image actually serves the corrected admission envelopes;
  an image build alone is not deployment qualification.
- Keep #342 open until both SDK artifacts containing the fix are public and
  the gateway compatibility condition is recorded there.
