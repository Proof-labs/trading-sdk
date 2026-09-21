import { describe, it, expect, vi } from "vitest";
import { ExchangeClient } from "./client.js";
import { generateKeypair, pubkeyToOwner } from "./crypto.js";
import { Side, type Action, type TxResult } from "./types.js";

function clientWithKey() {
  const { privateKey, publicKey } = generateKeypair();
  const client = new ExchangeClient({
    gatewayUrl: "http://gw",
    chainId: "test-chain",
  });
  client.setPrivateKey(privateKey);
  return { client, owner: pubkeyToOwner(publicKey) };
}

/** Spy on submitTx so we can inspect the Action a builder constructs. */
function captureSubmit(client: ExchangeClient) {
  const ok: TxResult = { code: 0, hash: "" } as TxResult;
  return vi
    .spyOn(
      client as unknown as { submitTx: (a: Action) => Promise<TxResult> },
      "submitTx",
    )
    .mockResolvedValue(ok);
}

describe("convenience action builders", () => {
  it("placeOrder fills owner from the loaded key and maps to PlaceOrder", async () => {
    const { client, owner } = clientWithKey();
    const spy = captureSubmit(client);

    await client.placeOrder({
      market: 1,
      side: Side.Buy,
      price: 100_000n,
      quantity: 2n,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const action = spy.mock.calls[0][0];
    expect(action.type).toBe("PlaceOrder");
    expect(action.data).toMatchObject({
      market: 1,
      side: Side.Buy,
      quantity: 2n,
    });
    expect(action.data.owner).toEqual(owner);
  });

  it("marketOrder maps to MarketOrder with owner", async () => {
    const { client, owner } = clientWithKey();
    const spy = captureSubmit(client);
    await client.marketOrder({ market: 3, side: Side.Sell, quantity: 5n });
    const action = spy.mock.calls[0][0];
    expect(action.type).toBe("MarketOrder");
    expect(action.data).toMatchObject({
      market: 3,
      side: Side.Sell,
      quantity: 5n,
    });
    expect(action.data.owner).toEqual(owner);
  });

  it("cancelOrder maps orderId + owner", async () => {
    const { client, owner } = clientWithKey();
    const spy = captureSubmit(client);
    await client.cancelOrder(42n);
    expect(spy.mock.calls[0][0]).toEqual({
      type: "CancelOrder",
      data: { orderId: 42n, owner },
    });
  });

  it("cancelClientOrder maps clientOrderId + owner", async () => {
    const { client, owner } = clientWithKey();
    const spy = captureSubmit(client);
    await client.cancelClientOrder(7n);
    expect(spy.mock.calls[0][0]).toEqual({
      type: "CancelClientOrder",
      data: { clientOrderId: 7n, owner },
    });
  });

  it("cancelAllOrders defaults market to null and passes a given market", async () => {
    const { client, owner } = clientWithKey();
    const spy = captureSubmit(client);
    await client.cancelAllOrders();
    expect(spy.mock.calls[0][0]).toEqual({
      type: "CancelAllOrders",
      data: { owner, market: null },
    });
    await client.cancelAllOrders(2);
    expect(spy.mock.calls[1][0]).toEqual({
      type: "CancelAllOrders",
      data: { owner, market: 2 },
    });
  });

  it("closePosition maps market + owner", async () => {
    const { client, owner } = clientWithKey();
    const spy = captureSubmit(client);
    await client.closePosition(9);
    expect(spy.mock.calls[0][0]).toEqual({
      type: "ClosePosition",
      data: { market: 9, owner },
    });
  });

  it("throws a clear error when no signer key is loaded", async () => {
    const client = new ExchangeClient({
      gatewayUrl: "http://gw",
      chainId: "test-chain",
    });
    await expect(
      client.placeOrder({ market: 1, side: Side.Buy, price: 1n, quantity: 1n }),
    ).rejects.toThrow(/No signer key loaded/);
  });
});

describe("pre-fill SL/TP limbs on order builders", () => {
  it("placeOrder passes valid limbs through to the action", async () => {
    const { client } = clientWithKey();
    const spy = captureSubmit(client);

    await client.placeOrder({
      market: 1,
      side: Side.Buy,
      price: 100_000n,
      quantity: 2n,
      stopLoss: {
        triggerPrice: 90_000n,
        maxSlippageBps: 50,
        clientTriggerId: 1n,
      },
      takeProfit: {
        triggerPrice: 120_000n,
        maxSlippageBps: 50,
        clientTriggerId: 2n,
      },
    });

    const action = spy.mock.calls[0][0];
    expect(action.data).toMatchObject({
      stopLoss: { triggerPrice: 90_000n },
      takeProfit: { triggerPrice: 120_000n },
    });
  });

  it("marketOrder passes a single limb through to the action", async () => {
    const { client } = clientWithKey();
    const spy = captureSubmit(client);

    await client.marketOrder({
      market: 1,
      side: Side.Sell,
      quantity: 2n,
      stopLoss: { triggerPrice: 90_000n, maxSlippageBps: 50 },
    });

    const action = spy.mock.calls[0][0];
    expect(action.type).toBe("MarketOrder");
    expect(action.data).toMatchObject({
      stopLoss: { triggerPrice: 90_000n, maxSlippageBps: 50 },
    });
  });

  it("placeOrder rejects invalid limbs before any submission", async () => {
    const { client } = clientWithKey();
    const spy = captureSubmit(client);

    await expect(
      client.placeOrder({
        market: 1,
        side: Side.Buy,
        price: 100_000n,
        quantity: 2n,
        stopLoss: { triggerPrice: 0n, maxSlippageBps: 50 },
      }),
    ).rejects.toThrow(/stopLoss\.triggerPrice must be non-zero/);
    await expect(
      client.placeOrder({
        market: 1,
        side: Side.Buy,
        price: 100_000n,
        quantity: 2n,
        stopLoss: { triggerPrice: 90_000n, maxSlippageBps: 50 },
        reduceOnly: true,
      }),
    ).rejects.toThrow(/TriggerOrderIncompatible, code 98/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("marketOrder rejects invalid limbs before any submission", async () => {
    const { client } = clientWithKey();
    const spy = captureSubmit(client);

    await expect(
      client.marketOrder({
        market: 1,
        side: Side.Sell,
        quantity: 2n,
        stopLoss: { triggerPrice: 90_000n, maxSlippageBps: 0 },
      }),
    ).rejects.toThrow(/maxSlippageBps must be in 1..=9999/);
    expect(spy).not.toHaveBeenCalled();
  });
});
