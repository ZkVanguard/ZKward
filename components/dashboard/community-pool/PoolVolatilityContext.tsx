'use client';

import { memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { suiPoolVolatilityQuery } from './queries';
import { Activity, TrendingUp, TrendingDown } from 'lucide-react';

interface PoolVolatilityContextProps {
  selectedChain: string;
  network: 'mainnet' | 'testnet';
  currentSharePrice?: number;
}

/**
 * Honest-volatility strip: shows the pool's 24h share-price range and
 * the % change vs. 30 days ago. Sits under PoolStats so users see that
 * a modest daily pullback is normal within a much bigger positive trend,
 * rather than anchoring to ATH and misreading routine noise as loss.
 *
 * Silently absent (renders nothing) on non-SUI chains and when the
 * volatility endpoint has no data (fresh pool). Never blocks anything.
 */
export const PoolVolatilityContext = memo(function PoolVolatilityContext({
  selectedChain,
  network,
  currentSharePrice,
}: PoolVolatilityContextProps) {
  // Shared with the pool card's verified-ATH patch: one request for both.
  const { data, isError } = useQuery({ ...suiPoolVolatilityQuery(network), enabled: selectedChain === 'sui' });

  if (selectedChain !== 'sui' || isError || !data) return null;

  const range = data.range24h;
  const since30d = data.since30d;
  const latest = data.latest;

  // Compute deltas only when the source values are truthy. Otherwise
  // suppress the display cell for that half rather than showing "NaN".
  const referenceSp = currentSharePrice ?? latest?.sharePrice ?? 0;
  const delta30d = since30d && since30d.sharePrice > 0 && referenceSp > 0
    ? ((referenceSp - since30d.sharePrice) / since30d.sharePrice) * 100
    : null;

  // If nothing useful to show, render nothing (never take up space with
  // "—" placeholders on a mobile card).
  if (!range && delta30d === null) return null;

  const deltaColor = delta30d !== null
    ? (delta30d >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400')
    : 'text-gray-500';
  const DeltaIcon = delta30d !== null && delta30d < 0 ? TrendingDown : TrendingUp;

  return (
    <div className="px-3 sm:px-4 md:px-5 py-2.5 border-b border-gray-100 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/40 min-w-0">
      <div className="flex items-center justify-between gap-3 flex-wrap min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <Activity className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          <span className="text-[10px] sm:text-[11px] font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
            Context
          </span>
        </div>
        <div className="flex items-center gap-4 sm:gap-5 flex-wrap tabular-nums min-w-0">
          {range && range.minSharePrice > 0 && range.maxSharePrice > 0 && (
            <div className="text-[11px] sm:text-xs min-w-0">
              <span className="text-gray-500 dark:text-gray-400 mr-1">24h range</span>
              <span className="text-gray-900 dark:text-white font-medium">
                ${range.minSharePrice.toFixed(3)} – ${range.maxSharePrice.toFixed(3)}
              </span>
            </div>
          )}
          {delta30d !== null && (
            <div className={`text-[11px] sm:text-xs flex items-center gap-1 min-w-0 ${deltaColor}`}>
              <DeltaIcon className="w-3 h-3 flex-shrink-0" />
              <span className="font-medium">
                {delta30d >= 0 ? '+' : ''}{delta30d.toFixed(1)}%
              </span>
              <span className="text-gray-500 dark:text-gray-400 font-normal">30d</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
