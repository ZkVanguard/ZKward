/**
 * @fileoverview Shared type definitions for blockchain interactions
 * @module shared/types/blockchain
 */

export interface NetworkConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  explorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
}

export interface ContractAddresses {
  rwaManager: string;
  paymentRouter: string;
  zkVerifier: string;
  proofRegistry: string;
  vvsRouter?: string;
  delphiContract?: string;
}

export interface TransactionReceipt {
  transactionHash: string;
  blockNumber: number;
  gasUsed: bigint;
  status: 'success' | 'failed';
  events?: unknown[];
}

export interface GasEstimate {
  gasLimit: bigint;
  gasPrice: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  estimatedCost: bigint;
  estimatedCostUSD?: number;
}

/**
 * Common trading position interface
 */
export interface TradingPosition {
  id: string;
  asset: string;
  size: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  leverage?: number;
  liquidationPrice?: number;
  timestamp: Date;
  status: 'open' | 'closed' | 'liquidated';
}

/**
 * Market order interface
 */
export interface MarketOrder {
  id: string;
  type: 'market' | 'limit' | 'stop';
  side: 'long' | 'short' | 'buy' | 'sell';
  asset: string;
  size: number;
  price?: number;
  leverage?: number;
  status: 'pending' | 'filled' | 'cancelled' | 'rejected';
  timestamp: Date;
}

/**
 * Market data interface
 */
export interface MarketData {
  asset: string;
  price: number;
  volume24h: number;
  change24h: number;
  high24h: number;
  low24h: number;
  timestamp: Date;
}
