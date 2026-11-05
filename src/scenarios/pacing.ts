// Test-only: keeps one scenario process under the gateway's per-IP rate limit.
import type { ExchangeHttpTransport } from "../http-transport.js";

// Under the default 50 rps per-client budget.
const MIN_GAP_MS = 25;
let nextSlot = 0;

export const pacedTransport: ExchangeHttpTransport = async (input, init) => {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_GAP_MS;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
  return fetch(input, init);
};
