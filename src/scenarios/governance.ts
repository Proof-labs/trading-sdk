// Test-only: runs an admin action through the two-member multisig.
import { ExchangeClient } from "../client.js";
import { pacedTransport } from "./pacing.js";
import { decodeExecError } from "../errors.js";
import type { AdminAction, ProposalDisplayInfo, TxResult } from "../types.js";

export interface Governance {
  /** admin1 proposes, admin2 approves; resolves once the action executed. */
  execute(action: AdminAction, label: string): Promise<void>;
}

export function governance(
  gatewayUrl: string,
  adminPrivateKeys: readonly [Uint8Array, Uint8Array],
): Governance {
  const [admin1, admin2] = adminPrivateKeys.map((key) => {
    const client = new ExchangeClient({
      gatewayUrl,
      httpTransport: pacedTransport,
    });
    client.setPrivateKey(key);
    client.setUnsafeFastSubmit(true);
    return { client, address: client.getAddress()! };
  }) as [Member, Member];
  const reader = new ExchangeClient({
    gatewayUrl,
    httpTransport: pacedTransport,
  });

  async function find(id: bigint): Promise<ProposalDisplayInfo> {
    let cursor: bigint | undefined;
    for (;;) {
      const page = await reader.queryProposals({ cursor });
      const hit = page.proposals.find((p) => p.proposalId === id);
      if (hit) return hit;
      if (page.nextCursor === null) throw new Error(`proposal ${id} not found`);
      cursor = page.nextCursor;
    }
  }

  return {
    async execute(action, label) {
      const registry = await reader.queryAdminSignerRegistry();
      if (!registry) throw new Error(`${label}: chain has no admin registry`);
      const proposed = await admin1.client.submitTxCommit({
        type: "ProposeAdminAction",
        data: {
          proposer: admin1.address,
          registryVersion: registry.version,
          action,
        },
      });
      refused(proposed, `${label}: propose`);
      const id = proposalId(proposed, label);
      const stored = await find(id);
      if (!stored.action) throw new Error(`${label}: undecodable proposal`);
      const approved = await admin2.client.submitTxCommit({
        type: "ApproveAdminAction",
        data: {
          approver: admin2.address,
          proposalId: stored.proposalId,
          registryVersion: stored.registryVersion,
          threshold: stored.threshold,
          proposer: stored.proposer,
          createdHeight: stored.createdHeight,
          createdMs: stored.createdMs,
          expiryMs: stored.expiryMs,
          action: stored.action,
          contentHash: stored.contentHash,
        },
      });
      refused(approved, `${label}: approve`);
      const status = (await find(id)).statusEffective;
      if (status.kind === "Executed") return;
      const failed =
        status.kind === "Failed"
          ? ` with code ${status.code} (${decodeExecError(status.code)?.name ?? "unknown"})`
          : "";
      throw new Error(`${label}: proposal ${id} is ${status.kind}${failed}`);
    },
  };
}

interface Member {
  client: ExchangeClient;
  address: Uint8Array;
}

function refused(r: TxResult, label: string): void {
  if (r.code !== 0) {
    throw new Error(
      `${label} refused: code=${r.code} (${r.error?.name ?? "unknown"}) log=${r.log ?? ""}`,
    );
  }
}

function proposalId(r: TxResult, label: string): bigint {
  const created = r.events?.find((e) => e.type === "proposal_created");
  const id = created?.attributes.find((a) => a.key === "proposal_id")?.value;
  if (!id) throw new Error(`${label}: propose emitted no proposal id`);
  return BigInt(id);
}
