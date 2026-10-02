'use client';

import { useEffect } from 'react';
import { DollarSign, RefreshCw, ChevronRight } from 'lucide-react';
import { usePositions } from '@/contexts/PositionsContext';
import { logger } from '@/lib/utils/logger';
import { ConnectPromptButton } from '@/components/ui/ConnectPromptButton';

interface PortfolioOverviewProps {
  address?: string;
  onNavigateToPositions?: () => void;
  onNavigateToHedges?: () => void;
}

export function PortfolioOverview({ address, onNavigateToPositions, onNavigateToHedges }: PortfolioOverviewProps) {
  // Get ALL data from centralized context - zero redundant fetching!
  // isPending provides smooth visual feedback during background data transitions
  const { positionsData, derived, loading, refetch, isPending } = usePositions();

  useEffect(() => {
    // OPTIMIZATION: Removed redundant AI analysis fetch
    // AI recommendations are already available via AIDecisionsContext
    // This prevents duplicate API calls to /api/agents/hedging/recommend

    // Listen for hedge updates to refresh
    const handleHedgeUpdate = () => {
      logger.debug('[PortfolioOverview] Hedge updated, refreshing');
      refetch();
    };

    window.addEventListener('hedgeAdded', handleHedgeUpdate);
    
    return () => {
      window.removeEventListener('hedgeAdded', handleHedgeUpdate);
    };
  }, [refetch]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-8 h-8 border-2 border-[#007AFF] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!address) {
    return (
      <div className="bg-white rounded-[20px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-black/5 p-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-14 h-14 bg-[#f5f5f7] rounded-[18px] flex items-center justify-center flex-shrink-0">
              <DollarSign className="w-7 h-7 text-[#86868b]" strokeWidth={2} />
            </div>
            <div className="min-w-0">
              <h1 className="text-[22px] sm:text-[28px] font-semibold text-[#1d1d1f] mb-1 tracking-[-0.02em]">Dashboard</h1>
              <p className="text-[15px] text-[#86868b] leading-[1.4]">Connect a wallet to see your balances and P&amp;L</p>
            </div>
          </div>
          <ConnectPromptButton reason="Sign in on Hedera or connect a SUI wallet to see your portfolio." />
        </div>
      </div>
    );
  }

  // Get health status label
  const getHealthLabel = (score: number) => {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Good';
    if (score >= 40) return 'Fair';
    return 'At Risk';
  };

  return (
    <div className={`bg-white rounded-[16px] sm:rounded-[24px] shadow-sm border border-black/5 transition-opacity duration-200 ${isPending ? 'opacity-70' : 'opacity-100'}`}>
      {/* Main Content - Single Card Layout */}
      <div className="p-4 sm:p-6">
        {/* Header Row - Stack on mobile */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-5">
          <div className="flex items-center justify-between sm:justify-start gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-[#007AFF] rounded-[12px] sm:rounded-[14px] flex items-center justify-center shadow-[0_4px_12px_rgba(0,122,255,0.25)]">
                <DollarSign className="w-5 h-5 sm:w-6 sm:h-6 text-white" strokeWidth={2.5} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] sm:text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.06em]">Portfolio</span>
                  {derived && derived.portfolioCount > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-[#34C759]/10 rounded-full">
                      <span className="w-1.5 h-1.5 bg-[#34C759] rounded-full animate-pulse" />
                      <span className="text-[9px] font-bold text-[#34C759]">LIVE</span>
                    </span>
                  )}
                </div>
                <div className="text-[28px] sm:text-[32px] md:text-[40px] font-bold text-[#1d1d1f] leading-tight tracking-[-0.02em]">
                  {positionsData && positionsData.totalValue >= 1000000 
                    ? `$${(positionsData.totalValue / 1000000).toFixed(2)}M`
                    : positionsData && positionsData.totalValue >= 1000 
                      ? `$${(positionsData.totalValue / 1000).toFixed(2)}K`
                      : `$${positionsData?.totalValue.toFixed(2) || '0.00'}`
                  }
                </div>
                {/* PnL Display */}
                {derived && derived.pnl.total !== 0 && (
                  <div className={`flex items-center gap-1 mt-1 ${derived.pnl.total >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    <span className="text-[12px] sm:text-[13px] font-semibold tabular-nums">
                      {derived.pnl.total >= 0 ? '+' : '−'}${Math.abs(derived.pnl.total).toFixed(2)}
                      {' '}({derived.pnl.totalPercentage >= 0 ? '+' : ''}{derived.pnl.totalPercentage.toFixed(2)}%)
                    </span>
                    <span className="text-[10px] sm:text-[11px] opacity-70">unrealized</span>
                  </div>
                )}
              </div>
            </div>
            <button
              onClick={() => refetch()}
              className="sm:hidden w-9 h-9 flex items-center justify-center bg-[#f5f5f7] active:bg-[#e8e8ed] rounded-full transition-all active:scale-95"
              aria-label="Refresh portfolio data"
              disabled={isPending}
            >
              <RefreshCw className={`w-4 h-4 text-[#86868b] ${isPending ? 'animate-spin' : ''}`} strokeWidth={2} />
            </button>
          </div>
          <button
            onClick={() => refetch()}
            className="hidden sm:flex w-10 h-10 items-center justify-center bg-[#f5f5f7] hover:bg-[#e8e8ed] rounded-full transition-all active:scale-95"
            aria-label="Refresh portfolio data"
            disabled={isPending}
          >
            <RefreshCw className={`w-[18px] h-[18px] text-[#86868b] ${isPending ? 'animate-spin' : ''}`} strokeWidth={2} />
          </button>
        </div>

        {/* Stats Row - Responsive Grid */}
        <div className="grid grid-cols-2 sm:flex gap-2 sm:gap-3">
          {/* Portfolios */}
          <button
            onClick={onNavigateToPositions}
            className="flex-1 group flex items-center justify-between p-3 sm:p-4 bg-[#f5f5f7] active:bg-[#e8e8ed] sm:hover:bg-[#e8e8ed] rounded-[14px] sm:rounded-[16px] transition-all active:scale-[0.98]"
          >
            <div>
              <div className="text-[9px] sm:text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Portfolios</div>
              <div className="text-[22px] sm:text-[28px] font-bold text-[#1d1d1f] leading-none">{derived?.portfolioCount || 0}</div>
            </div>
            <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5 text-[#c7c7cc] group-hover:text-[#007AFF] transition-colors" strokeWidth={2} />
          </button>

          {/* Hedges */}
          <button
            onClick={onNavigateToHedges}
            className="flex-1 group flex items-center justify-between p-3 sm:p-4 bg-[#f5f5f7] active:bg-[#e8e8ed] sm:hover:bg-[#e8e8ed] rounded-[14px] sm:rounded-[16px] transition-all active:scale-[0.98] relative"
          >
            {derived && derived.activeHedgesCount > 0 && (
              <span className="absolute -top-1 -right-1 w-4 h-4 sm:w-5 sm:h-5 bg-[#34C759] rounded-full flex items-center justify-center text-[9px] sm:text-[10px] font-bold text-white shadow-sm">
                {derived.activeHedgesCount}
              </span>
            )}
            <div>
              <div className="text-[9px] sm:text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Hedges</div>
              <div className="text-[22px] sm:text-[28px] font-bold text-[#34C759] leading-none">{derived?.activeHedgesCount || 0}</div>
            </div>
            <ChevronRight className="w-4 h-4 sm:w-5 sm:h-5 text-[#c7c7cc] group-hover:text-[#34C759] transition-colors" strokeWidth={2} />
          </button>

          {/* Health */}
          {derived && derived.healthScore && (
            <div className="col-span-2 sm:col-span-1 flex-1 p-3 sm:p-4 bg-gradient-to-br from-[#34C759]/10 to-[#34C759]/5 rounded-[14px] sm:rounded-[16px] border border-[#34C759]/10">
              <div className="text-[9px] sm:text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Health</div>
              <div className="flex items-baseline gap-2">
                <span className="text-[22px] sm:text-[28px] font-bold text-[#34C759] leading-none">{derived.healthScore.toFixed(0)}%</span>
                <span className="text-[12px] sm:text-[13px] font-medium text-[#34C759]/70">{getHealthLabel(derived.healthScore)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Holdings Section - Inline within same card */}
      {derived && derived.topAssets && derived.topAssets.length > 0 && (
        <div className="px-4 sm:px-6 pb-4 sm:pb-6 pt-2">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[12px] sm:text-[13px] font-semibold text-[#86868b]">Holdings</span>
            <span className="text-[12px] sm:text-[13px] font-medium text-[#86868b]">{derived.topAssets.length} assets</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
            {derived.topAssets.map((asset, idx) => {
              const displayValue = asset.value >= 1000 
                ? `$${(asset.value / 1000).toFixed(1)}K` 
                : `$${asset.value.toFixed(2)}`;
              
              return (
                <div 
                  key={idx} 
                  className="flex-shrink-0 flex items-center gap-2.5 px-3 py-2.5 bg-[#f5f5f7] rounded-[10px] min-w-[140px] sm:min-w-[160px]"
                >
                  <div className="w-7 h-7 sm:w-8 sm:h-8 bg-[#007AFF] rounded-[8px] flex items-center justify-center">
                    <span className="text-white text-[11px] sm:text-[12px] font-bold">{asset.symbol.slice(0, 2)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[14px] sm:text-[15px] font-semibold text-[#1d1d1f] truncate">{asset.symbol}</div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] sm:text-[13px] text-[#86868b]">{displayValue}</span>
                      <span className="text-[10px] sm:text-[11px] font-medium text-[#007AFF]">{asset.percentage.toFixed(1)}%</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
