/**
 * Live portfolio state + positions list.
 *
 * Extracted from simulator/page.tsx 2026-09-18. Pure display of
 * portfolio state — parent computes pnlPercent + pnlValue and passes in.
 */
import { Activity, TrendingUp, TrendingDown } from 'lucide-react';
import type { PortfolioState } from '@/app/[locale]/simulator/types';

interface Props {
  portfolio: PortfolioState;
  pnlPercent: number;
  pnlValue: number;
}

export function PortfolioPanel({ portfolio, pnlPercent, pnlValue }: Props) {
  const riskColor =
    portfolio.riskScore < 40
      ? 'text-[#34C759]'
      : portfolio.riskScore < 70
        ? 'text-[#FF9500]'
        : 'text-[#FF3B30]';

  return (
    <div className="bg-white rounded-[16px] sm:rounded-[20px] border border-black/5 p-4 sm:p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[17px] sm:text-[20px] font-semibold text-[#1d1d1f] flex items-center gap-2">
          <div className="w-8 h-8 bg-[#007AFF]/10 rounded-[8px] flex items-center justify-center">
            <Activity className="w-4 h-4 text-[#007AFF]" />
          </div>
          Live Portfolio State
        </h2>
        <div
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] sm:text-[14px] font-semibold ${
            pnlPercent >= 0
              ? 'bg-[#34C759]/10 text-[#34C759]'
              : 'bg-[#FF3B30]/10 text-[#FF3B30]'
          }`}
        >
          {pnlPercent >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
          {pnlPercent >= 0 ? '+' : ''}
          {pnlPercent.toFixed(2)}%
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <div className="bg-[#f5f5f7] rounded-[12px] p-3 sm:p-4">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-1">Total Value</div>
          <div className="text-[20px] sm:text-[24px] font-bold text-[#1d1d1f]">
            ${(portfolio.totalValue / 1000000).toFixed(2)}M
          </div>
        </div>
        <div className="bg-[#f5f5f7] rounded-[12px] p-3 sm:p-4">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-1">P&L</div>
          <div
            className={`text-[20px] sm:text-[24px] font-bold ${pnlValue >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}
          >
            {pnlValue >= 0 ? '+' : ''}${(pnlValue / 1000).toFixed(0)}K
          </div>
        </div>
        <div className="bg-[#f5f5f7] rounded-[12px] p-3 sm:p-4">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-1">Risk Score</div>
          <div className={`text-[20px] sm:text-[24px] font-bold ${riskColor}`}>
            {portfolio.riskScore.toFixed(0)}/100
          </div>
        </div>
        <div className="bg-[#f5f5f7] rounded-[12px] p-3 sm:p-4">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-1">Volatility</div>
          <div className="text-[20px] sm:text-[24px] font-bold text-[#007AFF]">
            {(portfolio.volatility * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {portfolio.positions.map((pos) => (
          <div
            key={pos.symbol}
            className="flex items-center justify-between bg-[#f5f5f7] rounded-[12px] px-4 py-3"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-gradient-to-br from-[#007AFF] to-[#5856D6] flex items-center justify-center font-bold text-[11px] sm:text-[12px] text-white">
                {pos.symbol.slice(0, 2)}
              </div>
              <div>
                <div className="text-[14px] sm:text-[15px] font-semibold text-[#1d1d1f]">
                  {pos.symbol}
                </div>
                <div className="text-[11px] sm:text-[12px] text-[#86868b]">
                  {pos.amount.toLocaleString()} units
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-[14px] sm:text-[15px] font-semibold text-[#1d1d1f]">
                ${(pos.value / 1000000).toFixed(2)}M
              </div>
              <div
                className={`text-[11px] sm:text-[12px] font-medium ${pos.pnlPercent >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}
              >
                {pos.pnlPercent >= 0 ? '+' : ''}
                {pos.pnlPercent.toFixed(2)}%
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
