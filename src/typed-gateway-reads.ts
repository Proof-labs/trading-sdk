import {
  readFinalizedOrderbook,
  type FinalizedOrderbook,
  type FinalizedOrderbookOptions,
} from "./finalized-orderbook.js";
import {
  readFinalizedOraclePermissions,
  type FinalizedOraclePermissions,
} from "./finalized-oracle-read.js";
import {
  readFinalizedAccount,
  type FinalizedAccountInfo,
  readFinalizedAccountState,
  readFinalizedAgentAuthorization,
  readFinalizedRecentNonces,
  readFinalizedOpenOrders,
  type FinalizedAccountState,
  type FinalizedAgentAuthorization,
  type FinalizedRecentNonces,
  type FinalizedOpenOrders,
  type FinalizedOpenOrdersOptions,
} from "./finalized-account-reads.js";
import type { BoundedReadOptions } from "./bounded-read.js";
import {
  readBlockHeader,
  readFinalizedMarketsSnapshot,
  readFinalizedFinancialState,
  type FinalizedMarketsSnapshot,
  type FinalizedFinancialState,
} from "./finalized-state-reads.js";
import type { BlockEvidenceHeader } from "./block-results-window.js";
import {
  readTransactionEvidence,
  type TransactionEvidence,
  type TransactionEvidenceSelection,
} from "./committed-transaction.js";
import {
  readBlockResultsWindow,
  type BlockResultsWindow,
  type BlockResultsWindowSelection,
} from "./block-results-window.js";
import {
  readTradeHistoryPage,
  type TradeHistoryOptions,
  type TradeHistoryPage,
} from "./trade-history.js";
import { GatewayReads } from "./gateway-reads.js";
import {
  gatewayReadContext,
  type ExchangeHttpTransport,
} from "./http-transport.js";
import { GatewayReadError } from "./errors.js";
import type { FinancialStateSelection } from "./financial-state.js";

class ReadClient {
  constructor(
    protected readonly gatewayUrl: string,
    protected readonly httpTransport: ExchangeHttpTransport,
    protected readonly inventoryChainId?: Uint8Array,
  ) {}
  protected requirePinnedChain(purpose: string): Uint8Array {
    if (!this.inventoryChainId)
      throw new GatewayReadError(
        "configuration",
        "chainId",
        `${purpose} requires an explicit pinned chainId`,
      );
    return Uint8Array.from(this.inventoryChainId);
  }
}
/** Same-view facts. See FinalizedReadWitness for the trust and binding boundary. */
export class FinalizedReads extends ReadClient {
  async account(
    owner: string,
    options: BoundedReadOptions = {},
  ): Promise<FinalizedAccountInfo> {
    return readFinalizedAccount(
      this.gatewayUrl,
      owner,
      options,
      this.httpTransport,
    );
  }
  async accountState(
    owner: string,
    options: BoundedReadOptions = {},
  ): Promise<FinalizedAccountState> {
    return readFinalizedAccountState(
      this.gatewayUrl,
      owner,
      options,
      this.httpTransport,
    );
  }
  async agentAuthorization(
    owner: string,
    agent: string,
    options: BoundedReadOptions = {},
  ): Promise<FinalizedAgentAuthorization> {
    return readFinalizedAgentAuthorization(
      this.gatewayUrl,
      owner,
      agent,
      options,
      this.httpTransport,
    );
  }
  async recentNonces(
    signer: string,
    options: BoundedReadOptions = {},
  ): Promise<FinalizedRecentNonces> {
    return readFinalizedRecentNonces(
      this.gatewayUrl,
      signer,
      options,
      this.httpTransport,
    );
  }
  async openOrders(
    owner: string,
    options: FinalizedOpenOrdersOptions = {},
  ): Promise<FinalizedOpenOrders> {
    return readFinalizedOpenOrders(
      this.gatewayUrl,
      owner,
      options,
      this.httpTransport,
    );
  }
  async financialState(
    selection: FinancialStateSelection,
    options: BoundedReadOptions = {},
  ): Promise<FinalizedFinancialState> {
    return readFinalizedFinancialState(
      this.gatewayUrl,
      selection,
      options,
      this.httpTransport,
    );
  }
  async marketsSnapshot(
    options: BoundedReadOptions = {},
  ): Promise<FinalizedMarketsSnapshot> {
    return readFinalizedMarketsSnapshot(
      this.gatewayUrl,
      this.requirePinnedChain("marketsSnapshot"),
      options,
      this.httpTransport,
    );
  }
  async orderbook(
    market: number,
    options: FinalizedOrderbookOptions = {},
  ): Promise<FinalizedOrderbook> {
    return readFinalizedOrderbook(
      this.gatewayUrl,
      market,
      options,
      this.httpTransport,
    );
  }
  async oraclePermissions(
    market: number,
    options: BoundedReadOptions = {},
  ): Promise<FinalizedOraclePermissions> {
    return readFinalizedOraclePermissions(
      this.gatewayUrl,
      market,
      options,
      this.httpTransport,
    );
  }
}
/** Bounded chain evidence. A replay rejection never proves earlier non-admission. */
export class EvidenceReads extends ReadClient {
  async transaction(
    selection: TransactionEvidenceSelection,
    options: BoundedReadOptions = {},
  ): Promise<TransactionEvidence> {
    return readTransactionEvidence(
      this.gatewayUrl,
      this.requirePinnedChain("transaction"),
      selection,
      options,
      this.httpTransport,
    );
  }
  async blockResultsWindow(
    selection: BlockResultsWindowSelection,
    options: BoundedReadOptions = {},
  ): Promise<BlockResultsWindow> {
    return readBlockResultsWindow(
      this.gatewayUrl,
      this.requirePinnedChain("blockResultsWindow"),
      selection,
      options,
      this.httpTransport,
    );
  }
  async blockHeader(
    height: bigint,
    options: BoundedReadOptions = {},
  ): Promise<BlockEvidenceHeader> {
    return readBlockHeader(
      this.gatewayUrl,
      this.requirePinnedChain("blockHeader"),
      height,
      options,
      this.httpTransport,
    );
  }
}
/** Typed opt-in extension of reads(); always gateway-only, like existing reads(). */
export class TypedGatewayReads extends GatewayReads {
  readonly finalized: FinalizedReads;
  readonly evidence: EvidenceReads;
  constructor(
    private readonly gatewayUrl: string,
    private readonly httpTransport: ExchangeHttpTransport,
    chain?: Uint8Array,
  ) {
    super(gatewayUrl, (url, init) =>
      httpTransport(url, init, gatewayReadContext(url, init)),
    );
    const pin = chain ? Uint8Array.from(chain) : undefined;
    this.finalized = new FinalizedReads(gatewayUrl, httpTransport, pin);
    this.evidence = new EvidenceReads(gatewayUrl, httpTransport, pin);
  }
  async tradeHistoryPage(
    market: number,
    options: TradeHistoryOptions,
  ): Promise<TradeHistoryPage> {
    return readTradeHistoryPage(
      this.gatewayUrl,
      market,
      options,
      this.httpTransport,
    );
  }
}
