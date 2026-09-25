import { TrendingUp, TrendingDown, ExternalLink, Lock, Wallet } from 'lucide-react';
import type { HedgePosition } from './types';

interface ContractAddresses {
  hedgeExecutor: string;
}

interface ActivePositionCardProps {
  hedge: HedgePosition;
  explorerUrl: string;
  contractAddresses: ContractAddresses;
  closingPosition: string | null;
  onOpenDetail: (hedge: HedgePosition) => void;
  onClose: (hedge: HedgePosition) => void;
}

/**
 * Horizontal-scroll compact preview card for an active hedge — the Apple-Music
 * style card row shown when "All Active Positions" is collapsed.
 */
export function ActivePositionCard({
  hedge,
  explorerUrl,
  contractAddresses,
  closingPosition,
  onOpenDetail,
  onClose,
}: ActivePositionCardProps) {
  return (
    <div
      className="flex-shrink-0 w-[240px] sm:w-[280px] p-3 sm:p-4 bg-[#f5f5f7] rounded-[12px] sm:rounded-[14px] border border-[#e8e8ed] cursor-pointer hover:border-[#007AFF]/30 hover:shadow-md transition-all"
      onClick={() => onOpenDetail(hedge)}
    >
      <div className="flex items-center gap-2 mb-2 sm:mb-3">
        <div className={`w-7 h-7 sm:w-8 sm:h-8 rounded-[8px] sm:rounded-[10px] flex items-center justify-center ${
          hedge.type === 'SHORT' ? 'bg-[#FF3B30]/10' : 'bg-[#34C759]/10'
        }`}>
          {hedge.type === 'SHORT' ? (
            <TrendingDown className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#FF3B30]" strokeWidth={2.5} />
          ) : (
            <TrendingUp className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#34C759]" strokeWidth={2.5} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="text-[13px] sm:text-[15px] font-semibold text-[#1d1d1f] tracking-[-0.01em] truncate">
              {hedge.type} {hedge.asset}
            </div>
            <span className="inline-flex items-center px-1.5 py-0.5 bg-[#007AFF]/10 text-[#007AFF] rounded-[4px] text-[9px] sm:text-[10px] font-bold">
              {hedge.leverage}x
            </span>
            {hedge.zkVerified && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#5856D6]/10 text-[#5856D6] rounded-[4px] text-[9px] font-bold" title="ZK-verified ownership">
                <Lock className="w-2.5 h-2.5" />ZK
              </span>
            )}
            {hedge.walletVerified && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#5856D6]/10 text-[#5856D6] rounded-[4px] text-[9px] font-bold" title="Wallet ownership verified">
                <Wallet className="w-2.5 h-2.5" />
                <span>✓</span>
              </span>
            )}
            {hedge.onChain && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#FF9500]/10 text-[#FF9500] rounded-[4px] text-[9px] font-bold" title="On-chain verified position">
                ⛓ ON-CHAIN
              </span>
            )}
          </div>
          {/* Reason text hidden - not needed for display */}
          {hedge.onChain && (
            <div className="text-[9px] sm:text-[11px] space-y-0.5">
            <div className="flex items-center gap-1">
              <span className="text-[9px] sm:text-[10px] uppercase tracking-wider text-[#86868b]">TX:</span>
              <a
                href={hedge.txHash ? `${explorerUrl}/tx/${hedge.txHash}` : `${explorerUrl}/address/${hedge.contractAddress || contractAddresses.hedgeExecutor}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-0.5 text-[#007AFF] hover:underline"
                title={hedge.txHash ? 'View transaction on Cronos Explorer' : 'View contract on Cronos Explorer'}
                onClick={(e) => e.stopPropagation()}
              >
                <span className="font-mono text-[9px] sm:text-[10px]">{hedge.txHash ? `${hedge.txHash.slice(0, 8)}...${hedge.txHash.slice(-6)}` : 'View on Explorer'}</span>
                <ExternalLink className="w-2 h-2 sm:w-2.5 sm:h-2.5" />
              </a>
            </div>
          </div>
          )}
        </div>
      </div>

      <div className="text-right mb-2 sm:mb-3">
        <div className={`text-[18px] sm:text-[22px] font-bold leading-none mb-0.5 sm:mb-1 ${
          hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'
        }`}>
          {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)}
        </div>
        <div className={`text-[11px] sm:text-[13px] font-medium ${
          hedge.pnlPercent >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'
        }`}>
          {hedge.pnlPercent >= 0 ? '+' : ''}{hedge.pnlPercent.toFixed(1)}%
        </div>
      </div>

      <div className="pt-2 sm:pt-3 border-t border-[#e8e8ed] space-y-1.5 sm:space-y-2">
        <div className="flex justify-between text-[10px] sm:text-[11px]">
          <span className="text-[#86868b] font-medium">Entry</span>
          <span className="text-[#1d1d1f] font-semibold">${hedge.entryPrice.toLocaleString()}</span>
        </div>
        <div className="flex justify-between text-[10px] sm:text-[11px]">
          <span className="text-[#86868b] font-medium">Current</span>
          <span className="text-[#1d1d1f] font-semibold">${hedge.currentPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>
        </div>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onClose(hedge); }}
        disabled={closingPosition === hedge.id}
        className="w-full mt-2 sm:mt-3 px-2.5 sm:px-3 py-1.5 sm:py-2 bg-[#FF3B30]/10 hover:bg-[#FF3B30]/20 text-[#FF3B30] rounded-[8px] sm:rounded-[10px] text-[11px] sm:text-[13px] font-semibold transition-colors disabled:opacity-50 active:scale-[0.98]"
      >
        {closingPosition === hedge.id ? 'Closing...' : 'Close'}
      </button>
    </div>
  );
}
