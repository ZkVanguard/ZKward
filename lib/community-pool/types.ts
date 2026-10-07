/**
 * Shared types for community pool modules
 */

export type NetworkType = 'testnet' | 'mainnet';
export type ChainKey = 'hedera' | 'sui';

export interface ChainConfig {
  rpcUrl: string;
  poolAddress: string;
  chainKey: ChainKey;
  network: NetworkType;
  assets: string[]; // Chain-specific assets
}

export interface PoolDataCache {
  totalValueUSD: number;
  totalShares: number;
  sharePrice: number;
  totalMembers: number;
  allocations: Record<string, { percentage: number }>;
  onChain: boolean;
  depositAsset?: string;
  actualHoldings?: Record<string, { percentage: number }>;
}

export interface UserPositionCache {
  walletAddress: string;
  shares: number;
  valueUSD: number;
  percentage: number;
  isMember: boolean;
  onChain: boolean;
}
