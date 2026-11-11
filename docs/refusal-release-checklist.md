# Gateway refusal release checklist

Track completion in [#342](https://github.com/Proof-labs/trading-sdk/issues/342).
This checklist does not authorize merging, tagging or publication.

## Artifacts

| Artifact                     | Prepared version | Rationale                                                                              | Tag           |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------- | ------------- |
| `@proof-labs/trading-sdk`    | `12.0.0`         | Required open-order fields and stricter read failures are breaking TypeScript changes. | `npm-v12.0.0` |
| `proof-trading-sdk` (Python) | `5.0.0`          | Public refusal exceptions change; the package uses proof-wire 11.0.0.                  | `py-v5.0.0`   |

Rust crate versions are unchanged. Each distribution publishes independently.
Reclassify against the complete release diff if more changes land before tagging.
Do not reuse an occupied registry version or move a published tag.

## Migration

- TypeScript callers must supply the added fields when constructing `OpenOrder`.
  Failed or malformed open-order reads throw instead of returning an empty list.
  See the [open-order migration guide](../README.md#open-order-migration).
- TypeScript callers can inspect `TxResult.errorCode` on a validated refusal.
  The `transport` outcome's numeric code is not an engine execution code.
- Python callers must catch `PreAdmissionRefusal` for validated admission
  refusals and internal `EncodingError` refusals.
- A refusal describes only that HTTP attempt.
  Reconcile an earlier ambiguous attempt by its retained transaction hash.
- Source-built Python consumers must review every MAJOR changelog entry since
  their build, including the `InvalidPlpConfig` code move and F16 changes.
  The package retains the released proof-wire dependency on the base branch.

## Release gates

1. Rebase onto current `dev` and classify every package against the full diff.
   Keep the npm manifest and lockfile aligned.
2. Run full TypeScript, Python and Rust CI, formatting and security gates.
   Build the npm tarball and Python wheel and sdist from the release checkout.
   Exercise the packaged browser artifact.
   Until [#391](https://github.com/Proof-labs/trading-sdk/issues/391) is fixed,
   run `smoke:browser:prepare` with npm 11.
3. Promote `dev` to `main` with a merge commit before publishing, following
   [DEC-25](https://github.com/Proof-labs/ProofOfBrain/blob/dev/delivery/decision-register.md).
   A previous promotion does not qualify changes merged after it.
4. Set the release heading's date to the tag date when cutting the release.
   Record the compatible engine from the pinned wire dependency.
   Require successful CI on the exact commit selected for each tag.
   Confirm that each tag matches its distribution manifest.

## Publishing gates

### npm

- A maintainer must authorize the tag separately.
- Keep `npm stage publish` and the `npm-publish` trusted-publishing environment.
- A maintainer inspects and approves the staged package on npm with 2FA.
- Verify that the exact version is public and installable.

### Python

- Resolve [#404](https://github.com/Proof-labs/trading-sdk/issues/404) before
  tagging: `maturin publish` rejects `--sdist` and already includes an sdist
  by default.
- Verify project ownership, first-publication access and `MATURIN_PYPI_TOKEN`.
- A maintainer must authorize the Python tag separately.
- Verify that the Linux ABI3 wheel and sdist support the intended installations.
  The workflow does not provide macOS or Windows wheels.
- Verify that the exact version is public and installable.

## Gateway and closure

- Confirm that a gateway promotion contains
  [#306](https://github.com/Proof-labs/api-gateway/pull/306) and
  [#310](https://github.com/Proof-labs/api-gateway/pull/310).
- Require CI on the selected gateway commit before authorizing an image tag.
- Verify that the deployed image serves the corrected refusal envelopes.
  An image build alone does not qualify a deployment.
- Keep #342 open until both SDK artifacts containing the fix are public and
  gateway compatibility is recorded there.
