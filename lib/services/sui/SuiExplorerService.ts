/**
 * SUI Explorer Service
 * 
 * On-chain data querying for SUI Network using the JSON-RPC API.
 * Provides transaction history, balance lookups, object inspection,
 * and block/checkpoint data.
 * 
 * @see https://docs.sui.io/references/sui-api
 */

import { logger } from '@/lib/utils/logger';

// ============================================
// CONFIGURATION
// ============================================

const SUI_EXPLORER_CONFIG = {
  testnet: {
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
    explorerUrl: 'https://suiscan.xyz/testnet',
    faucetUrl: 'https://faucet.testnet.sui.io/v1/gas',
  },
  mainnet: {
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
    explorerUrl: 'https://suiscan.xyz/mainnet',
    faucetUrl: '',
  },
} as const;

// ============================================
// TYPES
// ============================================

export interface SuiBalance {
  coinType: string;
  symbol: string;
  totalBalance: bigint;
  coinObjectCount: number;
  balanceFormatted: number;   // Human-readable
}

export interface SuiTransaction {
  digest: string;
  timestampMs: number;
  sender: string;
  status: 'success' | 'failure';
  gasUsed: {
    computationCost: bigint;
    storageCost: bigint;
    storageRebate: bigint;
    total: bigint;
  };
  kind: string;
  effects?: Record<string, unknown>;
  explorerUrl: string;
}

export interface SuiObjectInfo {
  objectId: string;
  version: string;
  digest: string;
  type: string;
  owner: string | { AddressOwner?: string; ObjectOwner?: string; Shared?: unknown };
  content?: Record<string, unknown>;
  explorerUrl: string;
}

export interface SuiCheckpoint {
  sequenceNumber: string;
  digest: string;
  timestampMs: string;
  transactionCount: number;
  networkTotalTransactions: string;
}

export interface SuiCoinMetadata {
  coinType: string;
  name: string;
  symbol: string;
  decimals: number;
  description: string;
  iconUrl: string | null;
}

// ============================================
// SUI RPC RESPONSE TYPES
// ============================================

/** suix_getAllBalances response item */
interface RpcBalanceItem {
  coinType: string;
  totalBalance: string;
  coinObjectCount: number;
}

/** suix_getBalance response */
interface RpcBalance {
  coinType: string;
  totalBalance: string;
  coinObjectCount: number;
}

/** sui_getTransactionBlock: gas used sub-object */
interface RpcGasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

/** sui_getTransactionBlock: effects sub-object */
interface RpcEffects {
  status?: { status: string };
  gasUsed?: RpcGasUsed;
  [key: string]: unknown;
}

/** sui_getTransactionBlock: transaction → data sub-object */
interface RpcTxData {
  sender?: string;
  transaction?: { kind?: string };
}

/** sui_getTransactionBlock response */
interface RpcTransactionBlock {
  digest: string;
  timestampMs?: string;
  effects?: RpcEffects;
  transaction?: { data?: RpcTxData };
}

/** suix_queryTransactionBlocks response */
interface RpcQueryTxResult {
  data: RpcTransactionBlock[];
  nextCursor: string | null;
}

/** sui_getObject → result.data */
interface RpcObjectData {
  objectId: string;
  version: string;
  digest: string;
  type?: string;
  owner?: string | { AddressOwner?: string; ObjectOwner?: string; Shared?: unknown };
  content?: { fields?: Record<string, unknown> };
}

/** sui_getObject response */
interface RpcObjectResult {
  data?: RpcObjectData;
}

/** suix_getOwnedObjects response item */
interface RpcOwnedObjectItem {
  data?: RpcObjectData;
}

/** suix_getOwnedObjects response */
interface RpcOwnedObjectsResult {
  data: RpcOwnedObjectItem[];
}

/** sui_getCheckpoint response */
interface RpcCheckpoint {
  sequenceNumber: string;
  digest: string;
  timestampMs: string;
  transactions: string[];
  networkTotalTransactions: string;
}

/** suix_getCoinMetadata response */
interface RpcCoinMetadata {
  name: string;
  symbol: string;
  decimals: number;
  description: string;
  iconUrl: string | null;
}

// ============================================
// SUI EXPLORER SERVICE
// ============================================

export class SuiExplorerService {
  private network: keyof typeof SUI_EXPLORER_CONFIG;
  private config: (typeof SUI_EXPLORER_CONFIG)[keyof typeof SUI_EXPLORER_CONFIG];

  constructor(network: keyof typeof SUI_EXPLORER_CONFIG = 'mainnet') {
    this.network = network;
    this.config = SUI_EXPLORER_CONFIG[network];
    logger.info('[SuiExplorer] Initialized', { network });
  }

  // ============================================
  // BALANCE QUERIES
  // ============================================

  /**
   * Get all coin balances for an address
   */
  async getAllBalances(address: string): Promise<SuiBalance[]> {
    try {
      const result = await this.rpc<RpcBalanceItem[]>('suix_getAllBalances', [address]);

      return (result || []).map((b) => {
        const coinType = String(b.coinType || '');
        const totalBalance = BigInt(String(b.totalBalance || '0'));
        const decimals = coinType.includes('::sui::SUI') ? 9 : 6;

        return {
          coinType,
          symbol: this.coinTypeToSymbol(coinType),
          totalBalance,
          coinObjectCount: Number(b.coinObjectCount || 0),
          balanceFormatted: Number(totalBalance) / Math.pow(10, decimals),
        } as SuiBalance;
      });
    } catch (e) {
      logger.error('[SuiExplorer] getAllBalances error', { address, error: e });
      return [];
    }
  }

  /**
   * Get SUI (native) balance for an address
   */
  async getSuiBalance(address: string): Promise<SuiBalance> {
    try {
      const result = await this.rpc<RpcBalance>('suix_getBalance', [address, '0x2::sui::SUI']);
      return {
        coinType: '0x2::sui::SUI',
        symbol: 'SUI',
        totalBalance: BigInt(result?.totalBalance || '0'),
        coinObjectCount: Number(result?.coinObjectCount || 0),
        balanceFormatted: Number(BigInt(result?.totalBalance || '0')) / 1e9,
      };
    } catch (e) {
      logger.error('[SuiExplorer] getSuiBalance error', { address, error: e });
      return {
        coinType: '0x2::sui::SUI',
        symbol: 'SUI',
        totalBalance: 0n,
        coinObjectCount: 0,
        balanceFormatted: 0,
      };
    }
  }

  // ============================================
  // TRANSACTION QUERIES
  // ============================================

  /**
   * Get transaction details by digest
   */
  async getTransaction(digest: string): Promise<SuiTransaction | null> {
    try {
      const result = await this.rpc<RpcTransactionBlock>('sui_getTransactionBlock', [
        digest,
        { showEffects: true, showInput: true, showEvents: true },
      ]);

      if (!result) return null;

      const effects = result.effects || {} as RpcEffects;
      const gasUsed = effects.gasUsed || {} as RpcGasUsed;

      return {
        digest: result.digest,
        timestampMs: Number(result.timestampMs || 0),
        sender: result.transaction?.data?.sender || '',
        status: effects.status?.status === 'success' ? 'success' : 'failure',
        gasUsed: {
          computationCost: BigInt(String(gasUsed.computationCost || '0')),
          storageCost: BigInt(String(gasUsed.storageCost || '0')),
          storageRebate: BigInt(String(gasUsed.storageRebate || '0')),
          total: BigInt(String(gasUsed.computationCost || '0')) +
                 BigInt(String(gasUsed.storageCost || '0')) -
                 BigInt(String(gasUsed.storageRebate || '0')),
        },
        kind: result.transaction?.data?.transaction?.kind || 'Unknown',
        effects: effects as Record<string, unknown>,
        explorerUrl: `${this.config.explorerUrl}/tx/${digest}`,
      };
    } catch (e) {
      logger.error('[SuiExplorer] getTransaction error', { digest, error: e });
      return null;
    }
  }

  /**
   * Get recent transactions for an address
   */
  async getTransactionHistory(
    address: string,
    limit: number = 20,
    cursor?: string,
  ): Promise<{ transactions: SuiTransaction[]; nextCursor: string | null }> {
    try {
      const result = await this.rpc<RpcQueryTxResult>('suix_queryTransactionBlocks', [
        {
          filter: { FromAddress: address },
          options: { showEffects: true, showInput: true },
        },
        cursor || null,
        limit,
        true, // descending
      ]);

      const transactions = (result?.data || []).map((tx) =>
        this.parseTxBlock(tx)
      );

      return {
        transactions,
        nextCursor: result?.nextCursor || null,
      };
    } catch (e) {
      logger.error('[SuiExplorer] getTransactionHistory error', { address, error: e });
      return { transactions: [], nextCursor: null };
    }
  }

  // ============================================
  // OBJECT QUERIES
  // ============================================

  /**
   * Get object details by ID
   */
  async getObject(objectId: string): Promise<SuiObjectInfo | null> {
    try {
      const result = await this.rpc<RpcObjectResult>('sui_getObject', [
        objectId,
        { showContent: true, showType: true, showOwner: true },
      ]);

      if (!result?.data) return null;
      const d = result.data;

      return {
        objectId: d.objectId,
        version: d.version,
        digest: d.digest,
        type: d.type || '',
        owner: d.owner || '',
        content: d.content?.fields || {},
        explorerUrl: `${this.config.explorerUrl}/object/${d.objectId}`,
      };
    } catch (e) {
      logger.error('[SuiExplorer] getObject error', { objectId, error: e });
      return null;
    }
  }

  /**
   * Get all objects owned by an address (with optional type filter)
   */
  async getOwnedObjects(
    address: string,
    structType?: string,
    limit: number = 50,
  ): Promise<SuiObjectInfo[]> {
    try {
      const filter: Record<string, unknown> = structType
        ? { StructType: structType }
        : { MatchAll: [] };

      const result = await this.rpc<RpcOwnedObjectsResult>('suix_getOwnedObjects', [
        address,
        { filter, options: { showContent: true, showType: true, showOwner: true } },
        null,
        limit,
      ]);

      return (result?.data || []).map((obj) => {
        const d = obj.data || {} as RpcObjectData;
        return {
          objectId: d.objectId || '',
          version: d.version || '',
          digest: d.digest || '',
          type: d.type || '',
          owner: d.owner || '',
          content: d.content?.fields || {},
          explorerUrl: `${this.config.explorerUrl}/object/${d.objectId}`,
        } as SuiObjectInfo;
      });
    } catch (e) {
      logger.error('[SuiExplorer] getOwnedObjects error', { address, error: e });
      return [];
    }
  }

  // ============================================
  // CHECKPOINT / NETWORK QUERIES
  // ============================================

  /**
   * Get latest checkpoint
   */
  async getLatestCheckpoint(): Promise<SuiCheckpoint | null> {
    try {
      const seqNum = await this.rpc<string>('sui_getLatestCheckpointSequenceNumber', []);
      if (!seqNum) return null;

      const checkpoint = await this.rpc<RpcCheckpoint>('sui_getCheckpoint', [seqNum.toString()]);
      if (!checkpoint) return null;

      return {
        sequenceNumber: checkpoint.sequenceNumber,
        digest: checkpoint.digest,
        timestampMs: checkpoint.timestampMs,
        transactionCount: (checkpoint.transactions || []).length,
        networkTotalTransactions: checkpoint.networkTotalTransactions || '0',
      };
    } catch (e) {
      logger.error('[SuiExplorer] getLatestCheckpoint error', { error: e });
      return null;
    }
  }

  /**
   * Get total transaction count on the network
   */
  async getTotalTransactionCount(): Promise<bigint> {
    try {
      const result = await this.rpc<string>('sui_getTotalTransactionBlocks', []);
      return BigInt(result || '0');
    } catch {
      return 0n;
    }
  }

  // ============================================
  // COIN METADATA
  // ============================================

  /**
   * Get metadata for a coin type
   */
  async getCoinMetadata(coinType: string): Promise<SuiCoinMetadata | null> {
    try {
      const result = await this.rpc<RpcCoinMetadata>('suix_getCoinMetadata', [coinType]);
      if (!result) return null;

      return {
        coinType,
        name: result.name || '',
        symbol: result.symbol || '',
        decimals: result.decimals || 0,
        description: result.description || '',
        iconUrl: result.iconUrl || null,
      };
    } catch (e) {
      logger.error('[SuiExplorer] getCoinMetadata error', { coinType, error: e });
      return null;
    }
  }

  // ============================================
  // URL GENERATORS
  // ============================================

  getTransactionUrl(digest: string): string {
    return `${this.config.explorerUrl}/tx/${digest}`;
  }

  getAddressUrl(address: string): string {
    return `${this.config.explorerUrl}/account/${address}`;
  }

  getObjectUrl(objectId: string): string {
    return `${this.config.explorerUrl}/object/${objectId}`;
  }

  getPackageUrl(packageId: string): string {
    return `${this.config.explorerUrl}/object/${packageId}`;
  }

  // ============================================
  // HELPERS
  // ============================================

  /**
   * Generic SUI JSON-RPC call with timeout and retry
   */
  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    let lastError: unknown;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(this.config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        const data = await response.json() as { result?: T; error?: { message?: string } };
        if (data.error) {
          logger.error('[SuiExplorer] RPC error', { method, error: data.error });
          throw new Error(`SUI RPC: ${data.error.message || JSON.stringify(data.error)}`);
        }
        return data.result as T;
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 4000);
          logger.warn(`[SuiExplorer] RPC attempt ${attempt + 1} failed, retrying in ${delay}ms`, {
            method,
            error: error instanceof Error ? error.message : String(error),
          });
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }

  /**
   * Convert coin type string to friendly symbol
   */
  private coinTypeToSymbol(coinType: string): string {
    if (coinType.includes('::sui::SUI')) return 'SUI';
    if (coinType.includes('::usdc::USDC')) return 'USDC';
    if (coinType.includes('::usdt::USDT')) return 'USDT';
    if (coinType.includes('::weth::WETH')) return 'WETH';
    if (coinType.includes('::wbtc::WBTC')) return 'WBTC';
    if (coinType.includes('::cetus::CETUS')) return 'CETUS';
    if (coinType.includes('::deep::DEEP')) return 'DEEP';
    if (coinType.includes('::navx::NAVX')) return 'NAVX';
    // Extract last segment
    const parts = coinType.split('::');
    return parts[parts.length - 1] || coinType;
  }

  /**
   * Parse a raw transaction block into our SuiTransaction type
   */
  private parseTxBlock(tx: RpcTransactionBlock): SuiTransaction {
    const effects = tx.effects || {} as RpcEffects;
    const gasUsed = effects.gasUsed || {} as RpcGasUsed;
    const txData = tx.transaction?.data || {} as RpcTxData;

    return {
      digest: tx.digest || '',
      timestampMs: Number(tx.timestampMs || 0),
      sender: txData.sender || '',
      status: effects.status?.status === 'success' ? 'success' : 'failure',
      gasUsed: {
        computationCost: BigInt(gasUsed.computationCost || '0'),
        storageCost: BigInt(gasUsed.storageCost || '0'),
        storageRebate: BigInt(gasUsed.storageRebate || '0'),
        total: BigInt(gasUsed.computationCost || '0') +
               BigInt(gasUsed.storageCost || '0') -
               BigInt(gasUsed.storageRebate || '0'),
      },
      kind: txData.transaction?.kind || 'Unknown',
      effects: effects as Record<string, unknown>,
      explorerUrl: `${this.config.explorerUrl}/tx/${tx.digest}`,
    };
  }
}

// ============================================
// SINGLETON
// ============================================

let suiExplorerInstance: SuiExplorerService | null = null;

export function getSuiExplorerService(
  network: keyof typeof SUI_EXPLORER_CONFIG = 'mainnet'
): SuiExplorerService {
  if (!suiExplorerInstance || suiExplorerInstance['network'] !== network) {
    suiExplorerInstance = new SuiExplorerService(network);
  }
  return suiExplorerInstance;
}
