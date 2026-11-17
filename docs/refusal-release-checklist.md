# SDK release and refusal-compatibility checklist

This reusable checklist does not authorize merging, tagging or publication.
Record exact versions, commits, checks and registry results in the release
tracking issue rather than treating this document as completed release evidence.

## Select artifacts independently

- Classify every package against its last published version and the full diff.
  npm, Python, Rust core and helper crates have independent versions.
- Record the compatible exchange release and exact canonical wire commit.
- Keep npm's manifest and lockfile aligned, the Python distribution and binding
  crate aligned, and all Rust core dependency requirements on the selected major.
- Rust core is git-only, not published to crates.io. Breaking source APIs and
  re-exported wire enums still require a major bump.
- Never reuse an occupied registry version or move a published tag.

## Migration

- Rebuild governance proposals and obtain new signatures whenever canonical
  action bytes or proposal hashes change.
- TypeScript open-order callers must handle required fields and read failures,
  not interpret errors as an empty list.
- A validated refusal describes only that HTTP attempt. Reconcile earlier
  ambiguous attempts by retained transaction hash.
- Python callers must handle public refusal exceptions, including
  `PreAdmissionRefusal`, and review every major change since their source build.
- Rust consumers must review receipt fields and non-exhaustive error enums when
  moving to a new core major, even when consuming by git revision.

## Before promotion

1. Refresh from dev and classify the complete diff. Set the release heading and
   planned tag date in the release PR into dev.
2. Run TypeScript, Python and Rust CI, formatting and security checks. Build the
   npm tarball and Python wheel/sdist; exercise the packaged browser artifact.
   Use the npm version supported by the packaging scripts.
3. Obtain independent review and merge release preparation into dev.
4. An authorized maintainer promotes dev to main using a merge commit, following
   [DEC-25](https://github.com/Proof-labs/ProofOfBrain/blob/dev/delivery/decision-register.md).
   A previous promotion does not qualify later commits. If the date changes,
   correct it through dev and promote again; never edit main directly.
5. Verify CI, manifests, dated changelog and compatibility on the exact tag
   commit. Tags and publication require separate authorization.

## Publication gates

- npm: verify the current workflow matches the reviewed publishing procedure.
  With staged publishing, retain the trusted-publishing environment and require
  a maintainer to inspect and approve the staged package using 2FA.
- Python: verify every maturin option. `maturin publish` already includes an
  sdist and rejects `--sdist`; do not tag while that invalid argument remains.
  Verify project ownership, first-publication access and the configured
  credential without exposing it. Check Linux ABI3 wheel and source installs;
  do not imply macOS or Windows wheels were produced.
- Verify each exact version is public and cleanly installable. Python and npm
  publication are independent gates.
- Confirm deployed gateway reads and refusal envelopes are compatible. An image
  build or desired deployment pin alone is not deployment evidence.
- Keep release tracking open until requested artifacts are public and deployed
  compatibility is recorded.
