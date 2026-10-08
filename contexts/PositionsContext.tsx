'use client';

import React, { createContext, useContext, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWallet } from '@/lib/hooks/useWallet';
import { positionsQuery, unifiedPortfolioQuery, type WalletPositions } from '@/lib/hooks/portfolio-queries';

type PositionsData = WalletPositions;

// Derived/computed data to avoid recalculation
interface DerivedData {
  topAssets: Array<{ symbol: string; value: number; percentage: number }>;
  totalChange24h: number;
  weightedVolatility: number;
  sharpeRatio: number;
  healthScore: number;
  riskScore: number;
  activeHedgesCount: number;
  /** Unrealized P&L across every product the wallet holds (from /api/portfolio/unified). */
  pnl: {
    total: number;
    totalPercentage: number;
  };
}

interface PositionsContextType {
  positionsData: PositionsData | null;
  derived: DerivedData | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  isPending: boolean; // True during transition updates
}

const PositionsContext = createContext<PositionsContextType | undefined>(undefined);

export function PositionsProvider({ children }: { children: React.ReactNode }) {
  const { portfolioAddress: address } = useWallet();
  // Both reads start together; the P&L read shares its cache entry with the
  // hedges panel, so a view showing both makes one request.
  const positions = useQuery(positionsQuery(address));
  const unified = useQuery(unifiedPortfolioQuery(address));

  const positionsData = address ? positions.data ?? null : null;
  const totals = address ? unified.data?.totals : undefined;
  const activeHedgesCount = Number(totals?.activeHedgeCount) || 0;
  const pnlMetrics = useMemo(
    () => (typeof totals?.unrealizedPnl === 'number' ? { total: totals.unrealizedPnl, totalPercentage: Number(totals.unrealizedPnlPct) || 0 } : null),
    [totals?.unrealizedPnl, totals?.unrealizedPnlPct],
  );
  const refetchPositions = positions.refetch;
  const refetchUnified = unified.refetch;
  const refetch = useCallback(async () => {
    await Promise.all([refetchPositions(), refetchUnified()]);
  }, [refetchPositions, refetchUnified]);

  // Memoized derived data - calculated once when positions change
  const derived = useMemo<DerivedData | null>(() => {
    if (!positionsData || positionsData.positions.length === 0) return null;

    const { positions, totalValue } = positionsData;

    // Top 5 assets by value
    const topAssets = positions
      .map(p => ({
        symbol: p.symbol,
        value: parseFloat(p.balanceUSD || '0'),
        percentage: totalValue > 0 ? (parseFloat(p.balanceUSD || '0') / totalValue) * 100 : 0,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    // Weighted 24h change
    const totalChange24h = totalValue > 0
      ? positions.reduce((acc, pos) => {
          const posValue = parseFloat(pos.balanceUSD || '0');
          const weight = posValue / totalValue;
          return acc + (pos.change24h * weight);
        }, 0)
      : 0;

    // Fallback volatility estimates (only used if real data unavailable)
    // WARNING: These are CONSERVATIVE ESTIMATES for display purposes only.
    // Real volatility should come from pos.volatility via market data APIs.
    // Values represent approximate 30-day annualized volatility (as decimal).
    const fallbackVolatilityMap: Record<string, number> = {
      'BTC': 0.45, 'WBTC': 0.45,
      'ETH': 0.50, 'WETH': 0.50,
      'CRO': 0.55, 'WCRO': 0.55,
      'SUI': 0.60,
      'USDC': 0.01, 'USDT': 0.01, 'DAI': 0.01,
    };

    // Weighted portfolio volatility - USE REAL DATA when available
    const weightedVolatility = totalValue > 0
      ? positions.reduce((acc, pos) => {
          const weight = parseFloat(pos.balanceUSD || '0') / totalValue;
          // Use real volatility from market data, fallback to estimates
          const vol = pos.volatility ?? fallbackVolatilityMap[pos.symbol] ?? 0.30;
          return acc + (vol * weight);
        }, 0)
      : 0;

    // Sharpe ratio approximation (using 24h return and volatility)
    const riskFreeRate = 0.05 / 365; // ~5% annual / 365 days
    const dailyReturn = totalChange24h / 100;
    const sharpeRatio = weightedVolatility > 0
      ? (dailyReturn - riskFreeRate) / (weightedVolatility / Math.sqrt(365))
      : 0;

    // Calculate concentration (top asset percentage)
    const concentration = topAssets[0]?.percentage || 0;

    // Risk Score: (volatility × 50) + (concentration × 50)
    const riskScore = Math.round((weightedVolatility * 50) + (concentration / 2));

    // Health Score calculation
    let healthScore = 80; // Base healthy score
    
    // Adjust based on diversification (more assets = healthier)
    if (topAssets.length >= 5) healthScore += 10;
    else if (topAssets.length >= 3) healthScore += 5;
    
    // Adjust based on concentration (less concentration = healthier)
    if (concentration < 40) healthScore += 5;
    else if (concentration > 70) healthScore -= 10;
    
    // Adjust based on volatility (lower = healthier)
    if (weightedVolatility < 0.2) healthScore += 5;
    else if (weightedVolatility > 0.5) healthScore -= 5;
    
    // Adjust based on active hedges (protection = healthier)
    if (activeHedgesCount > 0) healthScore += 5;
    
    // Adjust based on Sharpe ratio (better risk-adjusted returns = healthier)
    if (sharpeRatio > 1.5) healthScore += 5;
    else if (sharpeRatio < 0) healthScore -= 5;
    
    healthScore = Math.max(0, Math.min(100, healthScore));

    const pnl = pnlMetrics ?? { total: 0, totalPercentage: 0 };

    return {
      topAssets,
      totalChange24h,
      weightedVolatility,
      sharpeRatio,
      healthScore,
      riskScore,
      activeHedgesCount,
      pnl,
    };
  }, [positionsData, activeHedgesCount, pnlMetrics]);

  const value: PositionsContextType = {
    positionsData,
    derived,
    loading: positions.isLoading,
    error: positions.error ? positions.error.message : null,
    refetch,
    // A refresh behind data already on screen.
    isPending: positions.isFetching && !!positions.data,
  };

  return (
    <PositionsContext.Provider value={value}>
      {children}
    </PositionsContext.Provider>
  );
}

export function usePositions() {
  const context = useContext(PositionsContext);
  if (context === undefined) {
    throw new Error('usePositions must be used within a PositionsProvider');
  }
  return context;
}
