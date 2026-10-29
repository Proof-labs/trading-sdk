import { boundedGatewayJson, type BoundedReadOptions } from "./bounded-read.js";
import type { ExchangeHttpTransport } from "./http-transport.js";

/** Generic account authorization. A current boolean is not same-view evidence,
 * a finality proof or a guarantee that authorization persists until inclusion. */
export async function readAgentAuthorization(
  gatewayUrl: string,
  owner: string,
  agent: string,
  options: BoundedReadOptions,
  transport: ExchangeHttpTransport,
): Promise<boolean> {
  for (const address of [owner, agent]) {
    if (typeof address !== "string" || !/^[0-9a-f]{40}$/.test(address))
      throw new Error("Invalid agent authorization address");
  }
  const result = await boundedGatewayJson(
    `${gatewayUrl.replace(/\/+$/, "")}/v1/account/${owner}/agents/${agent}`,
    transport,
    options,
    { purpose: "account" },
  );
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    typeof (result as Record<string, unknown>).authorized !== "boolean"
  )
    throw new Error("Invalid agent authorization response");
  return (result as { authorized: boolean }).authorized;
}
