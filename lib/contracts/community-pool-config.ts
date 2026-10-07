/**
 * Multi-Chain Community Pool Configuration
 *
 * Pool addresses and settings per chain: Hedera, SUI, Solana and the
 * simulated book.
 */

import { ChainType, NetworkType } from './addresses';
// ============================================
// TYPES
// ============================================

export interface PoolChainConfig {
  chainId: number | string;
  chainType: ChainType;
  name: string;
  shortName: string;
  icon: string;
  color: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls: {
    testnet: string;
    mainnet: string;
  };
  blockExplorer: {
    testnet: string;
    mainnet: string;
  };
  contracts: {
    testnet: {
      communityPool: `0x${string}`;
      usdt: `0x${string}`;
      pythOracle?: `0x${string}`;
    };
    mainnet: {
      communityPool: `0x${string}`;
      usdt: `0x${string}`;
      pythOracle?: `0x${string}`;
    };
  };
  assets: string[]; // Asset names tracked in this pool (e.g., ['BTC', 'ETH', 'SUI', 'CRO'])
  status: 'live' | 'testing' | 'planned' | 'deprecated';
}

export interface MultiChainPoolConfig {
  chains: Record<string, PoolChainConfig>;
  defaultChain: string;
  defaultNetwork: NetworkType;
}

// ============================================
// CHAIN CONFIGURATIONS
// ============================================

export const POOL_CHAIN_CONFIGS: Record<string, PoolChainConfig> = {
  hedera: {
    chainId: 296,
    chainType: 'evm',
    name: 'Hedera',
    shortName: 'HBAR',
    icon: 'ℏ',
    color: 'bg-purple-500',
    nativeCurrency: {
      name: 'HBAR',
      symbol: 'HBAR',
      decimals: 18,
    },
    rpcUrls: {
      testnet: 'https://testnet.hashio.io/api',
      mainnet: 'https://mainnet.hashio.io/api',
    },
    blockExplorer: {
      testnet: 'https://hashscan.io/testnet',
      mainnet: 'https://hashscan.io/mainnet',
    },
    contracts: {
      testnet: {
        // SimpleUsdcVaultV2 + MockERC20Permit (EIP-2612) deployed
        // 2026-09-08. V2 adds depositWithPermit() so Privy embedded
        // wallets can deposit in a SINGLE popup instead of two.
        // Old V1 (0xe7E6…9A9) + old USDC (0x7043…ae1) remain on-chain
        // but are no longer the primary target.
        communityPool: '0x18a8d89E3674EBCeC678f97A8a8b1D144b330b88',
        usdt: '0xe40AbC51A100Fa19B5CddEea637647008Eb0eA0b', // MockERC20Permit (6 dec, mintable, EIP-2612)
        pythOracle: '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729', // Pyth on Hedera testnet
      },
      mainnet: {
        communityPool: '0x0000000000000000000000000000000000000000', // Not deployed yet
        usdt: '0x0000000000000000000000000000000000000000', // USDT on Hedera mainnet
        pythOracle: '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729', // Pyth on Hedera mainnet
      },
    },
    // Vault accepts test USDC deposits (SimpleUsdcVault contract) — no
    // asset allocation on-chain; keeps USDC 1:1.
    assets: ['USDC'],
    status: 'live',
  },

  sui: {
    chainId: 'sui:mainnet',
    chainType: 'sui',
    name: 'SUI (USDC)',
    shortName: 'SUI',
    icon: '💵',
    color: 'bg-blue-400',
    nativeCurrency: {
      name: 'SUI',
      symbol: 'SUI',
      decimals: 9,
    },
    rpcUrls: {
      testnet: 'https://fullnode.testnet.sui.io:443',
      mainnet: 'https://fullnode.mainnet.sui.io:443',
    },
    blockExplorer: {
      testnet: 'https://suiscan.xyz/testnet',
      mainnet: 'https://suiscan.xyz/mainnet',
    },
    contracts: {
      testnet: {
        communityPool: '0xcb37e4ea0109e5c91096c0733821e4b603a5ef8faa995cfcf6c47aa2e325b70c',
        usdt: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29',
      },
      mainnet: {
        communityPool: '0x9ccbabbdca72c5c0b5d6e01765b578ae37dc33946dd80d6c9b984cd83e598c88',
        usdt: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7',
      },
    },
    // SUI USDC pool - deposits in USDC, AI-managed 3-asset allocation
    assets: ['BTC', 'ETH', 'SUI'],
    status: 'live',
  },

  // Paper pool - shadow trader running the aggregator's signal stack at
  // $100K notional. Not a chain, not deposit-able — it's a virtual pool
  // that lives entirely in cron_state (paper-trader:*) and the hedges
  // table (portfolio_id = -3). Selecting it in the chain picker renders
  // the PaperPoolPanel instead of the on-chain pool UI. Status 'testing'
  // makes PoolHeader's filter show it in the pill row.
  paper: {
    chainId: 'paper:shadow',
    chainType: 'evm',
    name: 'Paper Pool (signal stack)',
    shortName: 'Paper',
    icon: '🧪',
    color: 'bg-purple-400',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 6 },
    rpcUrls: { testnet: '', mainnet: '' },
    blockExplorer: { testnet: '', mainnet: '' },
    contracts: {
      testnet: { communityPool: '0x0000000000000000000000000000000000000000', usdt: '0x0000000000000000000000000000000000000000' },
      mainnet: { communityPool: '0x0000000000000000000000000000000000000000', usdt: '0x0000000000000000000000000000000000000000' },
    },
    assets: ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'],
    status: 'testing',
  },

  // Solana token pool (devnet, portfolio -6) — its own vertical with its
  // own API. Listed here only so the pool picker can offer it; selecting it
  // renders the Solana panel and no EVM/SUI fetcher runs.
  solana: {
    chainId: 'solana:devnet',
    chainType: 'solana',
    name: 'Solana Token Pool',
    shortName: 'Solana',
    icon: '◎',
    color: 'bg-purple-500',
    nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 },
    rpcUrls: { testnet: '', mainnet: '' },
    blockExplorer: { testnet: '', mainnet: '' },
    contracts: {
      testnet: { communityPool: '0x0000000000000000000000000000000000000000', usdt: '0x0000000000000000000000000000000000000000' },
      mainnet: { communityPool: '0x0000000000000000000000000000000000000000', usdt: '0x0000000000000000000000000000000000000000' },
    },
    assets: ['BTC', 'ETH', 'SOL'],
    status: 'testing',
  },
};

// ============================================
// MULTI-CHAIN POOL CONFIGURATION
// ============================================

export const MULTI_CHAIN_POOL_CONFIG: MultiChainPoolConfig = {
  chains: POOL_CHAIN_CONFIGS,
  defaultChain: 'hedera',
  defaultNetwork: 'testnet',
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get pool configuration for a specific chain
 */
export function getPoolChainConfig(chainKey: string): PoolChainConfig | undefined {
  return POOL_CHAIN_CONFIGS[chainKey];
}

/**
 * Get community pool address for a specific chain and network
 */
export function getCommunityPoolAddress(
  chainKey: string,
  network: NetworkType = 'testnet'
): `0x${string}` {
  const config = POOL_CHAIN_CONFIGS[chainKey];
  if (!config) {
    return '0x0000000000000000000000000000000000000000';
  }
  return config.contracts[network === 'mainnet' ? 'mainnet' : 'testnet']
    .communityPool as `0x${string}`;
}

/**
 * Get USDT token address for a specific chain and network
 */
export function getUsdtAddress(chainKey: string, network: NetworkType = 'testnet'): `0x${string}` {
  const config = POOL_CHAIN_CONFIGS[chainKey];
  if (!config) {
    return '0x0000000000000000000000000000000000000000';
  }
  return config.contracts[network === 'mainnet' ? 'mainnet' : 'testnet'].usdt as `0x${string}`;
}

/**
 * Deposit token info. Every pool takes USDC (Hedera through
 * SimpleUsdcVault, see contracts/core/SimpleUsdcVault.sol).
 */
export function getDepositTokenInfo(
  _chainKey: string,
  _network: NetworkType = 'testnet'
): { symbol: string; name: string; decimals: number; logo?: string } {
  return {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    logo: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.svg',
  };
}

/**
 * Get all active chains (live or testing)
 */
export function getActiveChains(): PoolChainConfig[] {
  return Object.values(POOL_CHAIN_CONFIGS).filter(
    (c) => c.status === 'live' || c.status === 'testing'
  );
}

/**
 * Get chain config by chainId (supports both number and string)
 */
export function getPoolChainByChainId(chainId: number | string): PoolChainConfig | undefined {
  return Object.values(POOL_CHAIN_CONFIGS).find((c) => c.chainId === chainId);
}

/**
 * Get explorer URL for a transaction or address
 */
export function getPoolExplorerUrl(
  chainKey: string,
  type: 'tx' | 'address',
  value: string,
  network: NetworkType = 'testnet'
): string {
  const config = POOL_CHAIN_CONFIGS[chainKey];
  if (!config) return '';

  const baseUrl = config.blockExplorer[network === 'mainnet' ? 'mainnet' : 'testnet'];
  return `${baseUrl}/${type}/${value}`;
}

/**
 * Check if a chain's pool is deployed (address != zero)
 */
export function isPoolDeployed(chainKey: string, network: NetworkType = 'testnet'): boolean {
  const address = getCommunityPoolAddress(chainKey, network);
  return address !== '0x0000000000000000000000000000000000000000';
}

/**
 * Get all deployed pools
 */
export function getDeployedPools(network: NetworkType = 'testnet'): string[] {
  return Object.keys(POOL_CHAIN_CONFIGS).filter((key) => isPoolDeployed(key, network));
}

// ============================================
// COMMUNITY POOL ABI (shared across chains)
// ============================================

export const COMMUNITY_POOL_ABI = [
  {
    name: 'deposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'depositWithPermit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
  },
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'minAmountOut', type: 'uint256' },
    ],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    name: 'depositToken',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'getPoolStats',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: '_totalShares', type: 'uint256' },
      { name: '_totalNAV', type: 'uint256' },
      { name: '_memberCount', type: 'uint256' },
      { name: '_allocations', type: 'uint256[4]' },
    ],
  },
  {
    name: 'members',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'member', type: 'address' }],
    outputs: [
      { name: 'shares', type: 'uint256' },
      { name: 'depositedUSD', type: 'uint256' },
      { name: 'withdrawnUSD', type: 'uint256' },
      { name: 'joinedAt', type: 'uint256' },
      { name: 'lastDepositAt', type: 'uint256' },
      { name: 'highWaterMark', type: 'uint256' },
    ],
  },
  {
    name: 'totalShares',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'calculateNAV',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ERC20 ABI subset for approvals
export const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
