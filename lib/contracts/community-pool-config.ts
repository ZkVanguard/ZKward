/**
 * Multi-Chain Community Pool Configuration
 *
 * Manages CommunityPool contract addresses and configurations across:
 * - Ethereum Mainnet - Production with USDT (via Tether WDK)
 * - Sepolia Testnet - WDK USDT integration testing
 * - Cronos - Live on testnet, mainnet ready
 * - Hedera - Live on testnet
 * - SUI - Testing
 */

import { ChainType, NetworkType } from './addresses';
import { getRpcUrl } from '../rpc-urls'; // ============================================
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
  // Ethereum Mainnet - PRODUCTION deployment with official Tether USDT
  ethereum: {
    chainId: 1,
    chainType: 'evm',
    name: 'Ethereum',
    shortName: 'ETH',
    icon: '⟠',
    color: 'bg-indigo-600',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      testnet: getRpcUrl('sepolia'), // Sepolia for testnet
      mainnet: getRpcUrl('ethereum'),
    },
    blockExplorer: {
      testnet: 'https://sepolia.etherscan.io',
      mainnet: 'https://etherscan.io',
    },
    contracts: {
      testnet: {
        // Use Sepolia deployment for testnet
        communityPool: '0x07d68C2828F35327d12a7Ba796cCF3f12F8A1086',
        usdt: '0xd077a400968890eacc75cdc901f0356c943e4fdb', // WDK USDT Sepolia
        pythOracle: '0xDd24F84d36BF92C65F92307595335bdFab5Bbd21',
      },
      mainnet: {
        communityPool: '0x0000000000000000000000000000000000000000', // Deploy pending
        usdt: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // Official Tether USDT on Ethereum
        pythOracle: '0x4305FB66699C3B2702D4d05CF36551390A4c69C6',
      },
    },
    assets: ['BTC', 'ETH', 'USDT'],
    status: 'planned', // Mainnet planned, testnet uses sepolia config
  },

  cronos: {
    chainId: 338,
    chainType: 'evm',
    name: 'Cronos',
    shortName: 'CRO',
    icon: '🔷',
    color: 'bg-blue-600',
    nativeCurrency: {
      name: 'Cronos',
      symbol: 'CRO',
      decimals: 18,
    },
    rpcUrls: {
      testnet: 'https://evm-t3.cronos.org/',
      mainnet: 'https://evm.cronos.org/',
    },
    blockExplorer: {
      testnet: 'https://explorer.cronos.org/testnet',
      mainnet: 'https://explorer.cronos.org',
    },
    contracts: {
      testnet: {
        // CommunityPool V3 Proxy (upgraded 2026-03-12)
        // WARNING: Pool data corrupted by mock token rebalance - use Sepolia instead!
        communityPool: '0xC25A8D76DDf946C376c9004F5192C7b2c27D5d30',
        usdt: '0x28217DAddC55e3C4831b4A48A00Ce04880786967', // Testnet USDT
        pythOracle: '0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320',
      },
      mainnet: {
        communityPool: '0x0000000000000000000000000000000000000000', // Not deployed yet
        usdt: '0x66e428c3f67a68878562e79A0234c1F83c208770', // Official Tether USDT on Cronos
        pythOracle: '0xE0d0e68297772Dd5a1f1D99897c581E2082dbA5B',
      },
    },
    // Pool accepts USDT deposits, hedges into BTC/ETH/SUI/CRO
    // DEPRECATED: Pool data corrupted - use Sepolia with WDK USDT instead
    assets: ['BTC', 'ETH', 'SUI', 'CRO'],
    status: 'deprecated',
  },

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

  // ============================================
  // SEPOLIA - PRIMARY CHAIN FOR TETHER WDK HACKATHON
  // Has OFFICIAL WDK USDT token
  // ============================================
  sepolia: {
    chainId: 11155111,
    chainType: 'evm',
    name: 'Sepolia (WDK)',
    shortName: 'WDK',
    icon: '💎',
    color: 'bg-emerald-500',
    nativeCurrency: {
      name: 'Ethereum',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      testnet: getRpcUrl('sepolia'),
      mainnet: getRpcUrl('sepolia'), // Sepolia is testnet-only
    },
    blockExplorer: {
      testnet: 'https://sepolia.etherscan.io',
      mainnet: 'https://sepolia.etherscan.io',
    },
    contracts: {
      testnet: {
        // CommunityPool deployed via hardhat (2026-03-18)
        // OFFICIAL WDK USDT - use this for USDT support.
        communityPool: '0x07d68C2828F35327d12a7Ba796cCF3f12F8A1086',
        usdt: '0xd077a400968890eacc75cdc901f0356c943e4fdb', // OFFICIAL Tether WDK USDT
        pythOracle: '0xDd24F84d36BF92C65F92307595335bdFab5Bbd21',
      },
      mainnet: {
        communityPool: '0x0000000000000000000000000000000000000000',
        usdt: '0xd077a400968890eacc75cdc901f0356c943e4fdb', // OFFICIAL WDK USDT
        pythOracle: '0x0000000000000000000000000000000000000000',
      },
    },
    // Pool accepts USDT deposits, manages diversified portfolio of 4 assets
    // On-chain allocations: 25% BTC, 25% ETH, 25% SUI, 25% CRO
    // PRIMARY for Tether WDK - has official USDT
    assets: ['BTC', 'ETH', 'SUI', 'CRO'],
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
};

// ============================================
// MULTI-CHAIN POOL CONFIGURATION
// ============================================

export const MULTI_CHAIN_POOL_CONFIG: MultiChainPoolConfig = {
  chains: POOL_CHAIN_CONFIGS,
  defaultChain: 'sepolia',
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
 * Get deposit token symbol based on chain and network
 * - EVM chains: USDT (via Tether WDK)
 * - SUI: USDC
 */
export function getDepositTokenSymbol(chainKey: string, _network: NetworkType = 'testnet'): string {
  // SUI uses USDC across all networks
  if (chainKey === 'sui') return 'USDC';
  // EVM chains: USDT on both mainnet and testnet (WDK integration)
  return 'USDT';
}

/**
 * Get full deposit token info
 * Uses Tether WDK USDT for EVM chains, USDC for SUI
 */
export function getDepositTokenInfo(
  chainKey: string,
  _network: NetworkType = 'testnet'
): { symbol: string; name: string; decimals: number; logo?: string } {
  // SUI and Hedera both use USDC (Hedera via SimpleUsdcVault deployed
  // 2026-09-06 — see contracts/core/SimpleUsdcVault.sol).
  if (chainKey === 'sui' || chainKey === 'hedera') {
    return {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      logo: 'https://cryptologos.cc/logos/usd-coin-usdc-logo.svg',
    };
  }

  // Other EVM chains (Sepolia, Cronos) use USDT via Tether WDK.
  return {
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    logo: 'https://cryptologos.cc/logos/tether-usdt-logo.svg',
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
