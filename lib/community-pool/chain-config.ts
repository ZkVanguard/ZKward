/**
 * Chain configuration for the EVM community pool
 */

import { POOL_CHAIN_CONFIGS } from '@/lib/contracts/community-pool-config';
import type { ChainConfig, ChainKey, NetworkType } from './types';

// Minimal ABI for reading pool stats
export const POOL_ABI = [
  'function getPoolStats() view returns (uint256 _totalShares, uint256 _totalNAV, uint256 _memberCount, uint256 _sharePrice, uint256[4] _allocations)',
  'function getMemberPosition(address member) view returns (uint256 shares, uint256 valueUSD, uint256 percentage)',
  'function calculateTotalNAV() view returns (uint256)',
  'function totalShares() view returns (uint256)',
  'function getMemberCount() view returns (uint256)',
  'function memberList(uint256) view returns (address)',
  'function members(address) view returns (uint256 shares, uint256 depositedUSD, uint256 withdrawnUSD, uint256 joinTime)',
];

export const isKnownPoolChain = (chain: string): chain is ChainKey =>
  chain === 'hedera' || chain === 'sui';

/**
 * RPC URL and pool address for a chain and network. A missing chain means
 * Hedera, the one EVM pool. An unknown chain throws: answering with another
 * chain's data would present it as fact.
 */
export function getChainConfig(chain?: string | null, network?: string | null): ChainConfig {
  const chainKey = chain || 'hedera';
  if (!isKnownPoolChain(chainKey)) throw new Error(`Unknown pool chain: ${chainKey}`);
  const networkType: NetworkType = network === 'mainnet' ? 'mainnet' : 'testnet';
  const config = POOL_CHAIN_CONFIGS[chainKey];
  return {
    rpcUrl: config.rpcUrls[networkType],
    poolAddress: config.contracts[networkType].communityPool,
    chainKey,
    network: networkType,
    assets: config.assets,
  };
}
