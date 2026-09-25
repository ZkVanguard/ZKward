import type { PriceRow } from '@/lib/hooks/useLivePrices';
import type { QueryClient } from '@tanstack/react-query';
import { logger } from '@/lib/utils/logger';
import type { HedgePosition, PerformanceStats } from './types';

interface OnChainHedgeRaw {
  orderId: string;
  hedgeId: string;
  side: 'SHORT' | 'LONG';
  asset: string;
  size: number;
  leverage: number;
  entryPrice: number;
  currentPrice: number;
  capitalUsed: number;
  notionalValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  createdAt: string;
  reason: string;
  walletAddress: string;
  txHash: string | null;
  proxyWallet: string;
  proxyVault: string;
  commitmentHash: string;
  zkVerified: boolean;
  onChain: boolean;
}

/**
 * Shape an on-chain hedge row from /api/agents/hedging/onchain into the
 * HedgePosition record the UI renders.
 */
export function mapOnChainHedge(h: OnChainHedgeRaw, hedgeExecutorAddress: string): HedgePosition {
  return {
    id: `onchain-${h.orderId}`,
    type: h.side,
    asset: h.asset,
    size: h.size,
    leverage: h.leverage,
    entryPrice: h.entryPrice,
    currentPrice: h.currentPrice,
    targetPrice: 0,
    stopLoss: 0,
    capitalUsed: h.capitalUsed || h.size,
    pnl: h.unrealizedPnL || 0,
    pnlPercent: h.pnlPercentage || 0,
    status: 'active',
    openedAt: h.createdAt ? new Date(h.createdAt) : new Date(),
    reason: h.reason || `${h.leverage}x ${h.side} ${h.asset} on-chain hedge`,
    walletAddress: h.walletAddress,
    txHash: h.txHash || undefined,
    zkVerified: h.zkVerified,
    walletVerified: true,
    onChain: true,
    chain: 'cronos-testnet',
    hedgeId: h.hedgeId || h.orderId,
    contractAddress: hedgeExecutorAddress,
    proxyWallet: h.proxyWallet,
    proxyVault: h.proxyVault,
    commitmentHash: h.commitmentHash,
  };
}

export const EMPTY_STATS: PerformanceStats = {
  totalHedges: 0,
  activeHedges: 0,
  winRate: 0,
  totalPnL: 0,
  avgHoldTime: '0h',
  bestTrade: 0,
  worstTrade: 0,
};

/**
 * Roll a list of hedges into the perf-summary stats block.
 */
export function computeStats(hedges: HedgePosition[]): PerformanceStats {
  if (hedges.length === 0) return EMPTY_STATS;
  const totalPnL = hedges.reduce((sum, h) => sum + (h.pnl || 0), 0);
  const profitable = hedges.filter((h) => h.pnl > 0).length;
  const winRate = (profitable / hedges.length) * 100;
  const pnlValues = hedges.map((h) => h.pnl || 0);
  const bestTrade = pnlValues.length > 0 ? Math.max(...pnlValues) : 0;
  const worstTrade = pnlValues.length > 0 ? Math.min(...pnlValues) : 0;
  return {
    totalHedges: hedges.length,
    activeHedges: hedges.length,
    winRate: Math.round(winRate),
    totalPnL,
    avgHoldTime: '24h',
    bestTrade,
    worstTrade,
  };
}

/**
 * Resolve a live price for an asset symbol. Reads the useLivePrices React
 * Query cache first (Pool tab pre-warms BTC/ETH/SUI), then falls back to
 * /api/prices. Never throws; returns a fallback price of 1000 if nothing
 * resolves so the caller can proceed. Matches prior inline behavior.
 */
export async function resolveAssetPriceUsd(
  asset: string,
  queryClient: QueryClient
): Promise<number> {
  let currentPrice = 1000;
  try {
    const symbol = asset.toUpperCase();
    const cached = queryClient.getQueriesData<Record<string, PriceRow>>({
      queryKey: ['live-prices'],
    });
    for (const [, data] of cached) {
      const hit = data?.[symbol]?.price;
      if (typeof hit === 'number' && hit > 0) {
        currentPrice = hit;
        break;
      }
    }
    if (currentPrice === 1000) {
      const priceResponse = await fetch(`/api/prices?symbol=${asset}`);
      const priceData = await priceResponse.json();
      if (priceData.success && priceData.data?.price) {
        currentPrice = priceData.data.price;
      }
    }
  } catch {
    logger.warn('Failed to fetch price for collateral calc, using fallback', {
      component: 'ActiveHedges',
    });
  }
  return currentPrice;
}

/**
 * BluefinService pairIndex mapping. Extend as new markets go live.
 */
export const PAIR_INDEX_MAP: Record<string, number> = {
  BTC: 0,
  ETH: 1,
  CRO: 2,
  ATOM: 3,
  DOGE: 4,
  SOL: 5,
};

export function pairIndexOf(asset: string): number {
  return PAIR_INDEX_MAP[asset.toUpperCase()] ?? 0;
}
