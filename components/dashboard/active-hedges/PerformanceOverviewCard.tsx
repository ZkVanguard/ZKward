import type { HedgePosition, PerformanceStats } from './types';

interface PerformanceOverviewCardProps {
  stats: PerformanceStats;
  activeHedges: HedgePosition[];
}

/**
 * Header card at the top of the full (non-compact) hedges view — active/
 * total pill, on-chain badge, total PnL, and 4-stat grid.
 */
export function PerformanceOverviewCard({ stats, activeHedges }: PerformanceOverviewCardProps) {
  if (stats.totalHedges === 0) return null;
  const onChainCount = activeHedges.filter((h) => h.onChain).length;
  return (
    <div className="bg-white rounded-[16px] sm:rounded-[20px] shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-black/5 p-3 sm:p-5">
      <div className="flex items-center justify-between mb-3 sm:mb-4">
        <div className="flex items-center gap-1.5 sm:gap-2">
          <span className="text-[9px] sm:text-[11px] font-semibold text-[#34C759] uppercase tracking-[0.06em] px-2 sm:px-2.5 py-0.5 sm:py-1 bg-[#34C759]/10 rounded-full">
            {stats.activeHedges} Active
          </span>
          {onChainCount > 0 && (
            <span className="text-[9px] sm:text-[10px] font-bold text-[#FF9500] uppercase tracking-[0.04em] px-2 py-0.5 bg-[#FF9500]/10 rounded-full">
              ⛓ {onChainCount} On-Chain
            </span>
          )}
          <span className="text-[11px] sm:text-[13px] text-[#86868b]">
            of {stats.totalHedges} total
          </span>
        </div>
        <div className={`text-[18px] sm:text-[24px] font-bold leading-none ${stats.totalPnL >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
          {stats.totalPnL >= 0 ? '+' : ''}{stats.totalPnL.toFixed(2)} USDC
        </div>
      </div>

      {/* Compact Stats Grid — 2×2 on ≤ 375px (readable labels), 1×4 on
          sm+ (dense info bar). 8px labels are unreadable on small
          screens; we lift to 11px baseline. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="p-3 bg-[#34C759]/10 rounded-[12px]">
          <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Win Rate</div>
          <div className="text-[18px] sm:text-[20px] font-bold text-[#34C759] leading-none tabular-nums">{stats.winRate.toFixed(0)}%</div>
        </div>
        <div className="p-3 bg-[#f5f5f7] rounded-[12px]">
          <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Total</div>
          <div className="text-[18px] sm:text-[20px] font-bold text-[#1d1d1f] leading-none tabular-nums">{stats.totalHedges}</div>
        </div>
        <div className="p-3 bg-[#34C759]/10 rounded-[12px]">
          <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Best</div>
          <div className="text-[15px] sm:text-[17px] font-bold text-[#34C759] leading-none tabular-nums">+{stats.bestTrade.toFixed(0)}</div>
        </div>
        <div className="p-3 bg-[#007AFF]/10 rounded-[12px]">
          <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-[0.04em] mb-1">Avg</div>
          <div className="text-[15px] sm:text-[17px] font-bold text-[#007AFF] leading-none tabular-nums">{stats.avgHoldTime}</div>
        </div>
      </div>
    </div>
  );
}
