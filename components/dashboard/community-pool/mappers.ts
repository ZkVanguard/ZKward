/**
 * Pure API → view-model mappers for the community-pool hook. Extracted from
 * useCommunityPool so the SUI pool/user response shaping has one home and a
 * test net (test/unit/community-pool-mappers.test.ts). No React, no fetch —
 * pure (apiData) → model, behavior-identical to the inline code they replaced.
 */
import type { PoolSummary, UserPosition, PoolAllocation, PoolHedge } from './types';

type ApiData = Record<string, unknown>;

/** parseFloat-with-0-fallback, matching the hook's prior inline coercion. */
const num = (v: unknown): number => parseFloat(String(v)) || 0;

/**
 * Live 4-asset composition (market-value % + USDC bucket). Returns all-zeros
 * when the server didn't compute one. Was silently defaulting to "SUI 100%"
 * regardless of actual holdings (audit 2026-07-31). Consumers can detect
 * `sum(allocations) === 0` and render an "allocation unavailable" state.
 */
export function normalizeAllocations(
  apiAlloc: Record<string, unknown> | undefined,
  _totalValueUSD: number,
): PoolAllocation {
  const a = apiAlloc || {};
  return {
    BTC: Number(a.BTC) || 0,
    ETH: Number(a.ETH) || 0,
    SUI: Number(a.SUI) || 0,
    USDC: Number(a.USDC) || 0,
    CRO: Number(a.CRO) || 0,
  };
}

function mapHedges(raw: unknown): PoolHedge[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((h: Record<string, unknown>) => ({
    id: Number(h.id) || 0,
    market: String(h.market || ''),
    side: (String(h.side || '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
    size: Number(h.size) || 0,
    notionalValue: Number(h.notionalValue) || 0,
    leverage: Number(h.leverage) || 1,
    entryPrice: Number(h.entryPrice) || 0,
    currentPrice: h.currentPrice == null ? null : Number(h.currentPrice),
    currentPnl: Number(h.currentPnl) || 0,
    openedAt: String(h.openedAt || ''),
    source: (h.source === 'on-chain-mirror' ? 'on-chain-mirror' : 'bluefin-perp'),
  }));
}

/** Shape the SUI pool-summary API response into the PoolSummary view model. */
export function mapApiToPoolSummary(data: ApiData): PoolSummary {
  const totalValueUSD = num(data.totalNAVUsd);
  return {
    totalShares: num(data.totalShares),
    totalNAV: num(data.totalNAV),
    totalValueUSD,
    sharePrice: parseFloat(String(data.sharePrice)) || 1.0,
    sharePriceUSD: parseFloat(String(data.sharePriceUsd)) || 1.0,
    memberCount: (data.memberCount as number) || 0,
    allocations: normalizeAllocations(data.allocation as Record<string, unknown>, totalValueUSD),
    aiLastUpdate: null,
    aiReasoning: null,
    allTimeHighNav: parseFloat(String(data.allTimeHighNav)) || undefined,
    totalDeposited: num(data.totalDeposited),
    totalWithdrawn: num(data.totalWithdrawn),
    hedges: mapHedges(data.hedges),
    stale: (data.stale as boolean) || undefined,
    staleAgeSeconds:
      typeof data.staleAgeSeconds === 'number'
        ? (data.staleAgeSeconds as number)
        : undefined,
  };
}

/** Shape the SUI user-position API response into the UserPosition view model. */
export function mapApiToUserPosition(data: ApiData, walletAddress: string | null | undefined): UserPosition {
  return {
    walletAddress: walletAddress || '',
    shares: num(data.shares),
    valueUSD: num(data.valueUsd),
    valueSUI: num(data.valueSui),
    percentage: num(data.percentage),
    isMember: (data.isMember as boolean) || false,
    totalDeposited: num(data.depositedSui),
    totalWithdrawn: num(data.withdrawnSui),
  };
}
