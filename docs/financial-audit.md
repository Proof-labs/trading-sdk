# Offline financial audit evidence

Financial audit format 2 is an offline artifact, not a public gateway endpoint.
Use the reviewed engine `financial-audit` executable against a trusted local
snapshot. Existing `queryFinancialState` behavior is unchanged.

```typescript
import { decodeFinancialAuditArtifact } from "@proof-labs/trading-sdk";

const evidence = decodeFinancialAuditArtifact(
  artifactText,
  {
    artifactSha256: trustedArtifactDigest,
    snapshotSha256: trustedExportDigest,
    executableSha256: trustedBuildDigest,
    chainId: expectedChainId,
    height: expectedHeight,
    timeMs: expectedHeaderTimeMs,
  },
  { markets: [1, 3], owners: selectedOwners },
);
// evidence.audit is the strict ledger + OI/event metadata DTO.
// evidence.provenance and evidence.trust retain the trust boundary.
```

Get pins from the independently trusted export/build record, never copy them
from the artifact being checked. Record SHA-256 of the exact output file after
a successful export in that separate trusted record; the decoder verifies it
before parsing, detecting output tampering but not proving the export's origin.
This decoder performs no network request,
signature operation or state mutation. It bounds JSON/binary decoding, rejects
unknown fields, mismatched pins/selectors and inconsistent ledger height/time.

The decoder checks the artifact's claims against expected pins; it cannot verify
the snapshot digest without the source snapshot, or prove the operator's claims.
The engine snapshot format lacks a full-state commitment. Its block time must be
attested separately from a trusted same-height header. Preserve that provenance;
the result is not a cryptographic state proof, live health verdict, complete
account inventory, funding authorization or liquidation acceptance result.

Raw `decodeFinancialAudit` remains available for already-decoded synthetic test
fixtures. It does not provide provenance checks and must not be substituted for
artifact ingestion.
