import {
  asReadError,
  boundedGatewayJson,
  decodeFinalizedReadWitness,
  type BoundedReadOptions,
  type FinalizedReadWitness,
} from "./bounded-read.js";
import {
  canonicalBase64,
  hexAddress,
  invalidRead,
  readObject,
  type HexAddress,
} from "./read-values.js";
import { authorizedAgentsFromWasm } from "./codec-adapter.js";
import { getWasm, ready } from "./wasm-loader.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

/** `AUTHORIZED_AGENTS_LIMIT` in proof-wire's `query_v2`. */
const AUTHORIZED_AGENTS_LIMIT = 100;

/** Current explicit grants, not owner-key or inherited master authority. */
export interface FinalizedAuthorizedAgents {
  owner: HexAddress;
  agents: HexAddress[];
  /** False when more than 100 grants exist; never treat that result as exhaustive. */
  complete: boolean;
  witness: FinalizedReadWitness;
}

/** Representation returned by the canonical wire decoder's naming adapter. */
export interface AuthorizedAgentsView {
  owner: string;
  finalizedHeight: bigint;
  agents: string[];
  complete: boolean;
}

export function decodeFinalizedAuthorizedAgents(
  value: unknown,
  owner: string,
): FinalizedAuthorizedAgents {
  const boundOwner = hexAddress(owner);
  const envelope = readObject(value, "authorized agents envelope");
  if (
    Object.keys(envelope).length !== 2 ||
    !("data" in envelope) ||
    !("witness" in envelope)
  )
    invalidRead("authorized agents envelope");
  const witness = decodeFinalizedReadWitness(envelope.witness);
  const bytes = canonicalBase64(
    envelope.data,
    "authorized agents data",
    16 * 1024,
  );
  const wasm = getWasm();
  const view = asReadError("authorized agents", () =>
    authorizedAgentsFromWasm(
      wasm.decode_read(wasm.ReadKind.AuthorizedAgents, bytes),
    ),
  );
  if (view.owner !== boundOwner || view.finalizedHeight !== witness.height)
    invalidRead("authorized agents owner or height mismatch", "binding");
  if (
    view.agents.length > AUTHORIZED_AGENTS_LIMIT ||
    (!view.complete && view.agents.length !== AUTHORIZED_AGENTS_LIMIT)
  )
    invalidRead("authorized agents completeness");
  let previous = "";
  const agents = view.agents.map((raw) => {
    const agent = hexAddress(raw);
    if (agent <= previous) invalidRead("authorized agents ordering");
    previous = agent;
    return agent;
  });
  return { owner: boundOwner, agents, complete: view.complete, witness };
}

export async function readFinalizedAuthorizedAgents(
  gateway: string,
  owner: string,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<FinalizedAuthorizedAgents> {
  const boundOwner = hexAddress(owner);
  const captured = { ...options };
  captured.signal?.throwIfAborted();
  return decodeFinalizedAuthorizedAgents(
    await boundedGatewayJson(
      `${gateway.replace(/\/+$/, "")}/v2/account/${boundOwner}/agents?witness=1`,
      transport,
      captured,
      { purpose: "account", prepare: ready, maxBytes: 32 * 1024 },
    ),
    boundOwner,
  );
}
