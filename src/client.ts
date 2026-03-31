import { encodeTx } from "./codec.js";
import type { Action, TxResult } from "./types.js";

export interface ExchangeClientOptions {
  /** CometBFT RPC endpoint. Default: http://localhost:26657 */
  rpcUrl?: string;
  /** WebSocket URL. Derived from rpcUrl by default. */
  wsUrl?: string;
}

export class ExchangeClient {
  private rpcUrl: string;
  private wsUrl: string;
  private seq = 0n;
  private ws: WebSocket | null = null;
  private eventListeners: Array<(event: Record<string, unknown>) => void> = [];

  constructor(opts: ExchangeClientOptions = {}) {
    this.rpcUrl = opts.rpcUrl ?? "http://localhost:26657";
    this.wsUrl = opts.wsUrl ?? this.rpcUrl.replace(/^http/, "ws") + "/websocket";
  }

  /** Submit a transaction and wait for mempool acceptance (CheckTx). */
  async submitTx(action: Action): Promise<TxResult> {
    const seq = ++this.seq;
    const txBytes = encodeTx(action, BigInt(seq));
    const b64 = btoa(String.fromCharCode(...txBytes));

    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "broadcast_tx_sync",
        params: { tx: b64 },
      }),
    });

    const json = await res.json();
    if (json.error) {
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    }

    const r = json.result;
    return {
      code: r.code,
      hash: r.hash,
      log: r.log,
    };
  }

  /** Submit and wait for block inclusion (slower, but confirms execution). */
  async submitTxCommit(action: Action): Promise<TxResult> {
    const seq = ++this.seq;
    const txBytes = encodeTx(action, BigInt(seq));
    const b64 = btoa(String.fromCharCode(...txBytes));

    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "broadcast_tx_commit",
        params: { tx: b64 },
      }),
    });

    const json = await res.json();
    if (json.error) {
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    }

    const r = json.result;
    return {
      code: r.tx_result?.code ?? r.check_tx?.code ?? 0,
      hash: r.hash,
      height: r.height ? Number(r.height) : undefined,
      log: r.tx_result?.log ?? r.check_tx?.log,
    };
  }

  /** Query latest block height and app hash. */
  async status(): Promise<{ latestHeight: number; latestAppHash: string }> {
    const res = await fetch(`${this.rpcUrl}/status`);
    const json = await res.json();
    const info = json.result.sync_info;
    return {
      latestHeight: Number(info.latest_block_height),
      latestAppHash: info.latest_app_hash,
    };
  }

  /** Fetch a block by height (null = latest). */
  async getBlock(height?: number): Promise<Record<string, unknown>> {
    const params = height != null ? `?height=${height}` : "";
    const res = await fetch(`${this.rpcUrl}/block${params}`);
    const json = await res.json();
    if (json.error) {
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    }
    return json.result;
  }

  /** Fetch block results (tx results + events) by height. */
  async getBlockResults(height: number): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.rpcUrl}/block_results?height=${height}`);
    const json = await res.json();
    if (json.error) {
      throw new Error(json.error.message ?? JSON.stringify(json.error));
    }
    return json.result;
  }

  /** Fetch node's consensus params. */
  async getConsensusParams(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.rpcUrl}/consensus_params`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  /** Fetch genesis document. */
  async getGenesis(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.rpcUrl}/genesis`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  /** Fetch node net_info (peers, listeners). */
  async getNetInfo(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.rpcUrl}/net_info`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  /** Fetch full node status. */
  async getStatus(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.rpcUrl}/status`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message ?? JSON.stringify(json.error));
    return json.result;
  }

  /** Subscribe to new block events via WebSocket. */
  subscribeBlocks(
    onEvent: (event: Record<string, unknown>) => void,
  ): () => void {
    this.eventListeners.push(onEvent);
    this.ensureWebSocket();

    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== onEvent);
    };
  }

  private ensureWebSocket() {
    if (this.ws) return;

    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      this.ws!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "subscribe",
          id: 1,
          params: { query: "tm.event='NewBlock'" },
        }),
      );
      this.ws!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "subscribe",
          id: 2,
          params: { query: "tm.event='Tx'" },
        }),
      );
    };

    this.ws.onmessage = (msg) => {
      try {
        const json = JSON.parse(msg.data);
        if (json.result?.data) {
          for (const listener of this.eventListeners) {
            listener(json.result.data);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
    };
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
