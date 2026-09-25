import { Wallet } from 'lucide-react';
import { TokenIcon } from './TokenIcon';
import type { Position } from '../positions-types';

interface WalletBalancesListProps {
  positions: Position[];
  totalValue: number;
  hasPortfolios: boolean;
}

export function WalletBalancesList({ positions, totalValue, hasPortfolios }: WalletBalancesListProps) {
  const funded = positions.filter((p) => parseFloat(p.balanceUSD || '0') > 0);
  if (funded.length === 0) return null;

  return (
    <div className="space-y-3">
      {/* Wallet Section Header - Compact */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <Wallet className="w-4 h-4 text-[#FF9500]" />
          <h3 className="text-[15px] font-semibold text-[#1d1d1f]">Wallet Balances</h3>
          <span className="text-[12px] text-[#86868b]">({funded.length})</span>
        </div>
        {/* Contextual hint when no portfolios exist */}
        {!hasPortfolios && (
          <span className="text-[11px] text-[#86868b] bg-[#f5f5f7] px-2 py-1 rounded-full">
            Available to fund portfolios
          </span>
        )}
      </div>

      {/* Token Cards */}
      <div className="bg-white rounded-xl shadow-sm border border-black/5 overflow-hidden">
        {funded.map((position, idx, filteredPositions) => {
          const positionValue = parseFloat(position.balanceUSD || '0');
          const percentOfTotal = totalValue > 0 ? (positionValue / totalValue) * 100 : 0;

          return (
            <div
              key={`${position.symbol}-${idx}`}
              className={`px-3 sm:px-4 py-3 hover:bg-[#f5f5f7]/50 transition-all ${
                idx !== filteredPositions.length - 1 ? 'border-b border-black/5' : ''
              }`}
            >
              <div className="flex items-center gap-3">
                {/* Token Icon */}
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    position.symbol === 'CRO'
                      ? 'bg-[#007AFF]'
                      : position.symbol.includes('USD')
                        ? 'bg-[#34C759]'
                        : 'bg-[#FF9500]'
                  }`}
                >
                  <TokenIcon symbol={position.symbol} />
                </div>

                {/* Token Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] sm:text-[15px] font-semibold text-[#1d1d1f]">
                      {position.symbol}
                    </span>
                    {position.change24h !== 0 && (
                      <span
                        className={`flex items-center gap-0.5 text-[10px] sm:text-[11px] font-semibold ${
                          position.change24h >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'
                        }`}
                      >
                        {position.change24h >= 0 ? '+' : ''}
                        {Math.abs(position.change24h).toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] sm:text-[12px] text-[#86868b]">
                    <span>
                      {parseFloat(position.balance).toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })}
                    </span>
                    <span className="text-[#86868b]/50">
                      @${parseFloat(position.price || '0').toFixed(4)}
                    </span>
                  </div>
                </div>

                {/* Value + Allocation */}
                <div className="text-right flex-shrink-0">
                  <div className="text-[16px] sm:text-[18px] font-bold text-[#1d1d1f]">
                    $
                    {positionValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </div>
                  <div className="text-[10px] font-medium text-[#86868b]">
                    {percentOfTotal.toFixed(1)}%
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
