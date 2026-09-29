import { describe, expect, it } from 'vitest'
import { adminActionToWasm } from './codec-adapter'
import { ACTION_TAG_BY_KIND, decodeAdminAction } from './governance-query'

/**
 * The CU-06 withdrawal limit (inner tag 19) and the operator receipt
 * registry rotation (inner tag 20, W28-20/DEC-112) governance arms.
 *
 * These pins are TS-side only: the tag table (the compile-error guard over
 * the closed union) and the wasm translation shape. The WASM core encodes
 * the actual bytes against its pinned proof-wire — the wire release
 * carrying tags 19/20 is cut from exchange dev after exchange#836 and
 * exchange#866 merge, and the wasm crate's pin bumps in the same trading-sdk
 * PR that flips these arms end-to-end (the #344/#346 sequencing precedent).
 */
describe('withdrawal-limit + receipt-registry governance arms', () => {
  it('carries the engine tags for both new kinds', () => {
    expect(ACTION_TAG_BY_KIND.SetWithdrawalLimit).toBe(19)
    expect(ACTION_TAG_BY_KIND.SetOperatorReceiptRegistry).toBe(20)
  })

  it('translates the withdrawal limit to the snake_case wasm shape', () => {
    const wasm = adminActionToWasm({
      kind: 'SetWithdrawalLimit',
      value: { perAccountCapMicroUsdc: 30_000_000n, windowSecs: 86_400 },
    }) as Record<string, Record<string, unknown>>
    expect(wasm).toEqual({
      SetWithdrawalLimit: {
        per_account_cap_micro_usdc: 30_000_000n,
        window_secs: 86_400,
      },
    })
  })

  it('translates the registry rotation with byte-array fields passed through', () => {
    const deployment = new Uint8Array(32).fill(0x11)
    const key = new Uint8Array(32).fill(0x22)
    const wasm = adminActionToWasm({
      kind: 'SetOperatorReceiptRegistry',
      value: {
        deploymentId: deployment,
        epoch: 2n,
        threshold: 1,
        operatorKeys: [key],
      },
    }) as Record<string, Record<string, unknown>>
    expect(wasm).toEqual({
      SetOperatorReceiptRegistry: {
        deployment_id: deployment,
        epoch: 2n,
        threshold: 1,
        operator_keys: [key],
      },
    })
  })
})


describe('decode side of the two arms', () => {
  // The payload arrives msgpack-decoded as a positional tuple (encoding
  // fact: struct fields in declaration order). A proposal an approver must
  // render — and a rotation they must verify — fails closed on any field
  // that does not match the engine's layout.
  it('renders a withdrawal-limit proposal from its wire tuple', () => {
    const decoded = decodeAdminAction({
      SetWithdrawalLimit: [30_000_000n, 86_400],
    })
    expect(decoded).toEqual({
      kind: 'SetWithdrawalLimit',
      value: { perAccountCapMicroUsdc: 30_000_000n, windowSecs: 86_400 },
    })
  })

  it('renders a registry-rotation proposal from its wire tuple', () => {
    const decoded = decodeAdminAction({
      SetOperatorReceiptRegistry: [
        Array(32).fill(0x11),
        2n,
        1,
        [Array(32).fill(0x01)],
      ],
    })
    expect(decoded).toEqual({
      kind: 'SetOperatorReceiptRegistry',
      value: {
        deploymentId: new Uint8Array(32).fill(0x11),
        epoch: 2n,
        threshold: 1,
        operatorKeys: [new Uint8Array(32).fill(0x01)],
      },
    })
  })

  it('fails closed on a malformed rotation tuple', () => {
    expect(() =>
      decodeAdminAction({
        SetOperatorReceiptRegistry: [Array(32).fill(0x11), 2n],
      }),
    ).toThrow()
  })
})
