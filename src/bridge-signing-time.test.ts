import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  bridgeMessagePreimage,
  signVotePauseBridge,
  signVoteWithdrawalPaid,
} from "./bridge.js";
import { ready } from "./index.js";

const binding = {
  deploymentId: new Uint8Array(32).fill(0xa1),
  chainId: new Uint8Array(32).fill(0xc7),
  registryEpoch: 2n,
};
const payout = {
  withdrawalId: 7n,
  vault: new Uint8Array(32).fill(0xb2),
  squadsTransactionIndex: 3,
};
const zeroSigner = () => new Uint8Array(64);

/** The big-endian u64 that closes a preimage: its signing time. */
function signedTimeOf(preimage: Uint8Array): bigint {
  return new DataView(preimage.buffer, preimage.byteOffset).getBigUint64(
    preimage.length - 8,
  );
}

describe("bridge message signing time", () => {
  beforeAll(async () => {
    await ready();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("signs the time the caller passes", async () => {
    const signed: Uint8Array[] = [];
    const vote = await signVoteWithdrawalPaid(
      (message) => {
        signed.push(message);
        return new Uint8Array(64);
      },
      payout,
      { ...binding, signedAtMs: 1_700_000_000_123n },
    );
    expect(vote.signedAtMs).toBe(1_700_000_000_123n);
    expect(signedTimeOf(signed[0])).toBe(1_700_000_000_123n);
  });

  it("signs the current time when none is passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_456);
    const signed: Uint8Array[] = [];
    const vote = await signVotePauseBridge((message) => {
      signed.push(message);
      return new Uint8Array(64);
    }, binding);
    expect(vote.signedAtMs).toBe(1_800_000_000_456n);
    expect(signedTimeOf(signed[0])).toBe(1_800_000_000_456n);
  });

  it("the signing time is part of every preimage", async () => {
    const at = (signedAtMs: bigint) =>
      bridgeMessagePreimage({
        kind: "pauseBridge",
        ...binding,
        signedAtMs,
      });
    expect(at(1n)).not.toEqual(at(2n));
    await expect(
      signVotePauseBridge(zeroSigner, { ...binding, signedAtMs: 5n }),
    ).resolves.toMatchObject({ signedAtMs: 5n });
  });
});
