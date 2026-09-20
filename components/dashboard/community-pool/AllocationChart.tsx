'use client';

import React, { memo, useMemo } from 'react';
import { PieChart } from 'lucide-react';
import type { PoolSummary } from './types';
import { ASSET_COLORS, ASSET_ICONS } from './utils';

interface AllocationChartProps {
  allocations: PoolSummary['allocations'];
  assets?: string[];
}

export const AllocationChart = memo(function AllocationChart({ allocations, assets }: AllocationChartProps) {
  const activeAllocations = useMemo(() => {
    if (!allocations) return [];
    return Object.entries(allocations)
      .map(([asset, alloc]) => ({
        asset,
        percent: typeof alloc === 'number' ? alloc : ((alloc as any)?.percentage ?? 0),
      }))
      .filter(({ percent }) => percent > 0);
  }, [allocations]);

  return (
    <div className="p-3 sm:p-4 md:p-5 border-b border-gray-100 dark:border-gray-700 min-w-0">
      <div className="pool-inner-heading flex items-start sm:items-center justify-between gap-3 mb-2">
        <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2 text-sm sm:text-base flex-shrink-0">
          <PieChart className="w-4 h-4" />
          Current Holdings
        </h3>
        <span className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 truncate text-right">
          {assets?.join(' • ') || 'Multi-Asset'}
        </span>
      </div>
      <p className="pool-inner-subheading text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mb-3 leading-relaxed">
        Live on-chain composition. AI target allocation may differ. See AI Insights.
      </p>

      {activeAllocations.length > 0 ? (
        <>
          {/* Allocation Bar — labels hidden on mobile (too cramped) and shown
              only for large slices on wider viewports. Legend below carries
              the full information for every device size. */}
          <div className="h-5 sm:h-6 rounded-full overflow-hidden flex mb-3 bg-gray-200 dark:bg-gray-700">
            {activeAllocations.map(({ asset, percent }) => (
              <div
                key={asset}
                className={`${ASSET_COLORS[asset] || 'bg-gray-500'} hidden sm:flex items-center justify-center text-[11px] sm:text-xs text-white font-semibold transition-all duration-500`}
                style={{ width: `${Math.max(percent, 5)}%` }}
              >
                {percent >= 15 && `${asset} ${Math.round(percent)}%`}
              </div>
            ))}
            {/* Mobile-only bare-segments variant */}
            {activeAllocations.map(({ asset, percent }) => (
              <div
                key={`${asset}-mob`}
                className={`${ASSET_COLORS[asset] || 'bg-gray-500'} sm:hidden transition-all duration-500`}
                style={{ width: `${Math.max(percent, 5)}%` }}
                aria-label={`${asset} ${Math.round(percent)}%`}
              />
            ))}
          </div>

          {/* Legend — grid on mobile so the swatches align vertically, flex on desktop */}
          <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2 sm:gap-4">
            {activeAllocations.map(({ asset, percent }) => (
              <div key={asset} className="flex items-center gap-2 min-w-0">
                <div className={`w-3 h-3 rounded-full flex-shrink-0 ${ASSET_COLORS[asset] || 'bg-gray-500'}`} />
                <span className="text-xs sm:text-sm text-gray-600 dark:text-gray-300 truncate">
                  <span className="font-medium">{ASSET_ICONS[asset] || ''} {asset}</span> {Math.round(percent)}%
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="text-center py-4 text-gray-500 dark:text-gray-400 text-xs sm:text-sm">
          No allocations yet. Deposit to start earning.
        </div>
      )}
    </div>
  );
});
