/**
 * PositionsList loading skeleton — shown while positions data is pending.
 * Extracted from PositionsList.tsx 2026-09-19. Zero state coupling.
 */
import { RefreshCw, Wallet } from 'lucide-react';

interface Props {
  /** Expected token symbols to reserve skeleton rows for. Prevents layout
   *  shift once data lands (CLS win). */
  expectedTokens?: string[];
}

export function PositionsLoadingSkeleton({ expectedTokens = ['CRO', 'devUSDC', 'WCRO'] }: Props) {
  return (
    <div className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-4">
      <div className="bg-white rounded-2xl shadow-sm border border-black/5 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-3 w-20 bg-[#f5f5f7] rounded animate-pulse" />
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-[#007AFF]/10 rounded-full">
                <RefreshCw className="w-2.5 h-2.5 text-[#007AFF] animate-spin" />
                <span className="text-[9px] font-bold text-[#007AFF]">SYNCING</span>
              </span>
            </div>
            <div className="h-9 w-40 bg-[#f5f5f7] rounded animate-pulse mb-2" />
            <div className="h-3 w-32 bg-[#f5f5f7] rounded animate-pulse" />
          </div>
          <div className="w-10 h-10 bg-[#f5f5f7] rounded-xl animate-pulse" />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2 px-1">
          <Wallet className="w-4 h-4 text-[#86868b]" />
          <span className="text-[14px] font-medium text-[#86868b]">Loading positions...</span>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-black/5 overflow-hidden">
          {expectedTokens.map((token, index) => (
            <div
              key={token}
              className={`px-3 sm:px-4 py-3 ${index !== expectedTokens.length - 1 ? 'border-b border-black/5' : ''}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-[#f5f5f7] rounded-lg animate-pulse" />
                <div className="flex-1">
                  <div className="h-4 w-16 bg-[#f5f5f7] rounded animate-pulse mb-1" />
                  <div className="h-3 w-24 bg-[#f5f5f7] rounded animate-pulse" />
                </div>
                <div className="text-right">
                  <div className="h-5 w-20 bg-[#f5f5f7] rounded animate-pulse mb-1" />
                  <div className="h-3 w-12 bg-[#f5f5f7] rounded animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
