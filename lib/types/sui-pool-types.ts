/**
 * SUI Community Pool Types & Config
 *
 * Extracted from SuiCommunityPoolService.ts to reduce file size
 * and allow shared imports without pulling in the full service.
 */

// ============================================
// DEPLOYED CONTRACT ADDRESSES
// ============================================

export const SUI_POOL_CONFIG = {
  testnet: {
    packageId: '0xcb37e4ea0109e5c91096c0733821e4b603a5ef8faa995cfcf6c47aa2e325b70c',
    adminCapId: '0xef6d5702f58c020ff4b04e081ddb13c6e493715156ddb1d8123d502655d0e6e6',
    feeManagerCapId: '0x705d008ef94b9efdb6ed5a5c1e02e93a4e638fffe6714c1924537ac653c97af6',
    moduleName: 'community_pool',
    rpcUrl: process.env.SUI_TESTNET_RPC || 'https://fullnode.testnet.sui.io:443',
    explorerUrl: 'https://suiscan.xyz/testnet',
    poolStateId: '0xb9b9c58c8c023723f631455c95c21ad3d3b00ba0fef91e42a90c9f648fa68f56' as string | null,
  },
  mainnet: {
    packageId: (process.env.NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID || process.env.NEXT_PUBLIC_SUI_PACKAGE_ID || '').trim(),
    adminCapId: (process.env.NEXT_PUBLIC_SUI_MAINNET_ADMIN_CAP || process.env.NEXT_PUBLIC_SUI_ADMIN_CAP || '').trim(),
    feeManagerCapId: (process.env.NEXT_PUBLIC_SUI_MAINNET_FEE_MANAGER_CAP || process.env.NEXT_PUBLIC_SUI_FEE_MANAGER_CAP || '').trim(),
    moduleName: 'community_pool',
    rpcUrl: process.env.SUI_MAINNET_RPC || 'https://fullnode.mainnet.sui.io:443',
    explorerUrl: 'https://suiscan.xyz/mainnet',
    poolStateId: (process.env.NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE || process.env.NEXT_PUBLIC_SUI_COMMUNITY_POOL_STATE || '').trim() || null as string | null,
    treasuryAddress: (process.env.SUI_MSAFE_ADDRESS || '').trim() || null as string | null,
  },
} as const;

// ============================================
// USDC POOL CONFIG (4-asset AI-managed pool)
// ============================================

export const SUI_USDC_COIN_TYPE = {
  mainnet: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  testnet: '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC',
} as const;

export const SUI_USDC_POOL_CONFIG = {
  testnet: {
    packageId: (process.env.NEXT_PUBLIC_SUI_USDC_POOL_PACKAGE_ID || '').trim()
      || '0xcac1e7de082a92ec3db4a4f0766f1a73e9f8c22e50a3dafed6d81dc043bd0ac9',
    moduleName: 'community_pool_usdc',
    rpcUrl: process.env.SUI_TESTNET_RPC || 'https://fullnode.testnet.sui.io:443',
    explorerUrl: 'https://suiscan.xyz/testnet',
    poolStateId: (process.env.NEXT_PUBLIC_SUI_USDC_POOL_STATE_TESTNET || '').trim()
      || '0x9f77819f91d75833f86259025068da493bb1c7215ed84f39d5ad0f5bc1b40971' as string | null,
    usdcCoinType: SUI_USDC_COIN_TYPE.testnet,
    usdcDecimals: 6,
  },
  mainnet: {
    packageId: (process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_PACKAGE_ID || process.env.NEXT_PUBLIC_SUI_USDC_POOL_PACKAGE_ID || '').trim(),
    moduleName: 'community_pool_usdc',
    rpcUrl: process.env.SUI_MAINNET_RPC || 'https://fullnode.mainnet.sui.io:443',
    explorerUrl: 'https://suiscan.xyz/mainnet',
    poolStateId: (process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE || process.env.NEXT_PUBLIC_SUI_USDC_POOL_STATE || '').trim() || null as string | null,
    usdcCoinType: SUI_USDC_COIN_TYPE.mainnet,
    usdcDecimals: 6,
  },
} as const;

// ============================================
// TYPES
// ============================================

export interface SuiPoolAllocation {
  BTC: number;
  ETH: number;
  SUI: number;
  CRO: number;
  /** USDC bucket — pool balance + idle admin USDC + BlueFin collateral. Optional for back-compat. */
  USDC?: number;
}

export interface SuiPoolStats {
  totalNAV: number;
  totalNAVUsd: number;
  totalShares: number;
  sharePrice: number;
  sharePriceUsd: number;
  memberCount: number;
  managementFeeBps: number;
  performanceFeeBps: number;
  paused: boolean;
  allTimeHighNav: number;
  /** Lifetime cumulative deposits in USDC (on-chain total_deposited, /1e6). */
  totalDeposited?: number;
  /** Lifetime cumulative withdrawals in USDC (on-chain total_withdrawn, /1e6). */
  totalWithdrawn?: number;
  createdAt: number;
  poolStateId: string | null;
}

/**
 * The parts of NAV as read together in one pass, for the on-chain attestation.
 * Absent on fallback stats, which must never be attested.
 */
export interface SuiNavBasis {
  /** USDC in the pool object at the time of the read. */
  poolBalanceUsdc: number;
  /** Everything outside the pool object: admin wallet holdings plus the venue account. */
  externalUsdc: number;
  /** False when the admin wallet could not be read and a recorded cost basis was substituted. */
  adminRead: boolean;
  /** Where the venue figure came from; only 'live' is fresh. */
  venueSource: 'live' | 'cache' | 'unknown';
}

export interface SuiUsdcPoolStats extends SuiPoolStats {
  navBasis?: SuiNavBasis;
  totalNAVUsdc: number;
  sharePriceUsdc: number;
  allocation: SuiPoolAllocation;
  isUsdcPool: boolean;
}

export interface SuiMemberPosition {
  address: string;
  shares: number;
  depositedSui: number;
  withdrawnSui: number;
  joinedAt: number;
  lastDepositAt: number;
  highWaterMark: number;
  valueSui: number;
  valueUsd: number;
  percentage: number;
  isMember: boolean;
}

export interface SuiAllocation {
  assetType: string;
  amount: bigint;
  percentage: number;
}

export interface SuiDepositParams {
  amountSui: number;
}

export interface SuiWithdrawParams {
  shares: number;
}

export interface SuiTransactionResult {
  success: boolean;
  txDigest?: string;
  sharesReceived?: number;
  amountSui?: number;
  sharePrice?: number;
  error?: string;
  explorerUrl?: string;
}

export interface SuiTreasuryInfo {
  treasuryAddress: string;
  accumulatedManagementFees: number;
  accumulatedPerformanceFees: number;
  totalPendingFees: number;
  lastFeeCollection: number;
  managementFeeBps: number;
  performanceFeeBps: number;
  msafeConfigured: boolean;
  msafeAddress: string | null;
}

// ============================================
// INTERNAL CONSTANTS & UTILITIES
// ============================================

export type SuiNetworkType = 'testnet' | 'mainnet';

export const SUI_DECIMALS = 9;
export const SHARE_DECIMALS = 9;
export const CLOCK_OBJECT_ID = '0x6';

/**
 * Safely convert a raw on-chain integer string to a decimal number.
 * Uses BigInt arithmetic to avoid precision loss for values > Number.MAX_SAFE_INTEGER (2^53).
 */
export function safeRawToDecimal(raw: string | number | bigint, decimals: number): number {
  const value = BigInt(raw || 0);
  const divisor = BigInt(10 ** decimals);
  const wholePart = value / divisor;
  const fractionalPart = value % divisor;
  return Number(wholePart) + Number(fractionalPart) / Number(divisor);
}

/**
 * Safely convert a decimal amount to raw integer (BigInt) using string math.
 * Avoids floating-point multiplication errors (e.g. 1.1 * 1e9 !== 1100000000).
 */
export function safeDecimalToRaw(amount: number, decimals: number): bigint {
  const str = amount.toFixed(decimals);
  const [whole, frac = ''] = str.split('.');
  const padded = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + padded);
}
