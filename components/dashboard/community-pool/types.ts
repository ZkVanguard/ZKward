/**
 * Community Pool Types
 * Centralized type definitions for the CommunityPool component family
 */

export interface PoolAllocation {
  BTC: number;
  ETH: number;
  SUI: number;
  CRO: number;
  /** USDC bucket — pool balance + idle admin USDC + BlueFin collateral. */
  USDC?: number;
}

export interface PoolHedge {
  id: number;
  market: string;          // e.g. "ETH-PERP", "SUI-PERP"
  side: 'LONG' | 'SHORT';
  size: number;
  notionalValue: number;   // USDC
  leverage: number;
  entryPrice: number;
  currentPrice: number | null;
  currentPnl: number;      // USDC
  openedAt: string;
  source: 'bluefin-perp' | 'on-chain-mirror';
}

export interface PoolSummary {
  totalValueUSD: number;
  totalShares: number;
  sharePrice: number;  // USD per share. SUI USDC pool: tracks the v0.2.0 external-NAV oracle (1.0 only at inception, grows with NAV).
  sharePriceUSD?: number; // Legacy: converted to USD
  totalNAV?: number;  // Legacy: native asset NAV
  memberCount: number;
  allocations: PoolAllocation;
  aiLastUpdate: string | null;
  aiReasoning: string | null;
  /** ATH share price (USDC). Used to show drawdown-from-peak. */
  allTimeHighNav?: number;
  /** Lifetime cumulative deposits (USDC). For pool-level $ profit = NAV − (deposits − withdrawals). */
  totalDeposited?: number;
  /** Lifetime cumulative withdrawals (USDC). */
  totalWithdrawn?: number;
  /** Active BlueFin perp hedges (SUI pool only; undefined elsewhere). */
  hedges?: PoolHedge[];
  /**
   * NAV was served from the DB fallback because the live SUI RPC returned
   * $0 (typical during a public-fullnode JSON-RPC deprecation window).
   * When true, `staleAgeSeconds` says how old the served snapshot is —
   * dashboard should annotate but not scare the user (the pool isn't
   * actually at $0).
   */
  stale?: boolean;
  /** Seconds since the fallback snapshot was recorded. */
  staleAgeSeconds?: number;
}

export interface UserPosition {
  walletAddress: string;
  shares: number;
  valueUSD: number;
  valueSUI?: number;  // Legacy: kept for compatibility
  percentage: number;
  isMember: boolean;
  joinedAt?: string;
  totalDeposited?: number;
  totalWithdrawn?: number;
  depositCount?: number;
  withdrawalCount?: number;
}

export interface AIRecommendation {
  allocations: PoolAllocation;
  reasoning: string;
  confidence: number;
  changes: AIChange[];
}

export interface AIChange {
  asset: string;
  currentPercent: number;
  proposedPercent: number;
  change: number;
}

export interface LeaderboardEntry {
  walletAddress: string;
  shares: number;
  percentage: number;
  valueUSD?: number;
  /** Display name from wallet_profiles table (null if not set). */
  displayName?: string | null;
}

export interface CommunityPoolProps {
  address?: string;
  compact?: boolean;
}

export type TxStatus = 'idle' | 'resetting_approval' | 'signing_permit' | 'approving' | 'approved' | 'depositing' | 'withdrawing' | 'complete';

export type ChainKey = 'ethereum' | 'cronos' | 'hedera' | 'sepolia' | 'sui' | 'paper';

export interface CommunityPoolState {
  poolData: PoolSummary | null;
  userPosition: UserPosition | null;
  aiRecommendation: AIRecommendation | null;
  leaderboard: LeaderboardEntry[];
  loading: boolean;
  error: string | null;
  successMessage: string | null;
  selectedChain: ChainKey;
  suiPoolStateId: string | null;
}

export interface TransactionState {
  txStatus: TxStatus;
  actionLoading: boolean;
  showDeposit: boolean;
  showWithdraw: boolean;
  depositAmount: string;
  withdrawShares: string;
  suiDepositAmount: string;
  suiWithdrawShares: string;
  lastTxHash: string | null;
}
