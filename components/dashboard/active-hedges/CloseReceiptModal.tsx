'use client';

import { memo } from 'react';
import { CheckCircle, XCircle, ExternalLink, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { CloseReceipt } from './types';

interface CloseReceiptModalProps {
  receipt: CloseReceipt | null;
  onDismiss: () => void;
}

export const CloseReceiptModal = memo(function CloseReceiptModal({
  receipt,
  onDismiss,
}: CloseReceiptModalProps) {
  return (
    <AnimatePresence>
      {receipt && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
          onClick={onDismiss}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`p-5 ${receipt.success ? 'bg-gradient-to-r from-[#34C759]/10 to-[#007AFF]/10' : 'bg-[#FF3B30]/10'}`}>
              <div className="flex items-center gap-3">
                <div className={`w-12 h-12 rounded-full flex items-center justify-center ${receipt.success ? 'bg-[#34C759]/20' : 'bg-[#FF3B30]/20'}`}>
                  {receipt.success ? (
                    <CheckCircle className="w-7 h-7 text-[#34C759]" />
                  ) : (
                    <XCircle className="w-7 h-7 text-[#FF3B30]" />
                  )}
                </div>
                <div>
                  <h3 className="text-[18px] font-bold text-[#1d1d1f]">
                    {receipt.success ? 'Position Closed' : 'Close Failed'}
                  </h3>
                  <p className="text-[12px] text-[#86868b]">
                    {receipt.success
                      ? `${receipt.asset} ${receipt.side} x${receipt.leverage} — ${receipt.finalStatus}`
                      : receipt.error}
                  </p>
                </div>
              </div>
            </div>

            {receipt.success && (
              <div className="p-5 space-y-4">
                {/* Fund Flow Visualization */}
                <div className="p-4 bg-[#f5f5f7] rounded-xl space-y-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-[#86868b]">Fund Flow</div>
                  
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#007AFF]/10 flex items-center justify-center text-[10px] font-bold text-[#007AFF]">1</div>
                    <div className="flex-1">
                      <div className="text-[11px] font-medium text-[#1d1d1f]">HedgeExecutor closes trade on DEX</div>
                      <div className="text-[9px] text-[#86868b] font-mono">0x090b...62B9 → closeHedge()</div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#007AFF]/10 flex items-center justify-center text-[10px] font-bold text-[#007AFF]">2</div>
                    <div className="flex-1">
                      <div className="text-[11px] font-medium text-[#1d1d1f]">DEX returns collateral {receipt.realizedPnl >= 0 ? '+ profit' : '- loss'}</div>
                      <div className="text-[9px] text-[#86868b]">Hedge venue → HedgeExecutor</div>
                    </div>
                  </div>
                  
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-[#34C759]/10 flex items-center justify-center text-[10px] font-bold text-[#34C759]">3</div>
                    <div className="flex-1">
                      <div className="text-[11px] font-medium text-[#1d1d1f]">USDC sent to your wallet</div>
                      <div className="text-[9px] text-[#86868b] font-mono">→ {receipt.trader.slice(0, 8)}...{receipt.trader.slice(-6)}</div>
                    </div>
                  </div>
                </div>

                {/* Financial Summary */}
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-[#86868b]">Collateral</span>
                    <span className="text-[13px] font-semibold text-[#1d1d1f]">{receipt.collateral.toLocaleString()} USDC</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-[#86868b]">Realized P/L</span>
                    <span className={`text-[13px] font-bold ${receipt.realizedPnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                      {receipt.realizedPnl >= 0 ? '+' : ''}{receipt.realizedPnl.toLocaleString()} USDC
                    </span>
                  </div>
                  <div className="h-px bg-[#e8e8ed]" />
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-[#1d1d1f]">Returned to Wallet</span>
                    <span className={`text-[15px] font-bold ${receipt.fundsReturned > 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                      {receipt.fundsReturned > 0 ? receipt.fundsReturned.toLocaleString() : '0'} USDC
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[#86868b]">Balance before</span>
                    <span className="font-mono text-[#86868b]">{receipt.balanceBefore.toLocaleString()} USDC</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[#86868b]">Balance after</span>
                    <span className="font-mono font-semibold text-[#1d1d1f]">{receipt.balanceAfter.toLocaleString()} USDC</span>
                  </div>
                </div>

                {/* Gas Savings */}
                {receipt.gasless && receipt.gasSavings && (
                  <div className="p-3 bg-[#AF52DE]/5 rounded-xl border border-[#AF52DE]/10">
                    <div className="flex items-center gap-1.5 mb-2">
                      <Zap className="w-3.5 h-3.5 text-[#AF52DE]" />
                      <span className="text-[11px] font-semibold text-[#AF52DE]">Gasless</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[#86868b]">Your gas cost</span>
                      <span className="font-semibold text-[#34C759]">{receipt.gasSavings.userGasCost}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-[#86868b]">Gas sponsored by relayer</span>
                      <span className="font-mono text-[#86868b]">{receipt.gasSavings.relayerGasCost}</span>
                    </div>
                    <div className="flex items-center justify-between text-[11px] mt-1">
                      <span className="text-[#86868b]">You saved</span>
                      <span className="font-bold text-[#34C759]">{receipt.gasSavings.totalSaved}</span>
                    </div>
                  </div>
                )}

                {/* Transaction Link */}
                {receipt.txHash && (
                  <a
                    href={receipt.explorerLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 p-3 bg-[#007AFF]/5 rounded-xl text-[#007AFF] hover:bg-[#007AFF]/10 transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span className="text-[12px] font-semibold">View on Cronos Explorer</span>
                    <span className="text-[10px] font-mono text-[#86868b]">{receipt.txHash.slice(0, 10)}...{receipt.txHash.slice(-8)}</span>
                  </a>
                )}

                {receipt.elapsed && (
                  <div className="text-center text-[10px] text-[#86868b]">
                    Transaction completed in {receipt.elapsed}
                  </div>
                )}
              </div>
            )}

            {/* Dismiss Button */}
            <div className="p-5 pt-0">
              <button
                onClick={onDismiss}
                className={`w-full px-4 py-3 rounded-xl text-[15px] font-semibold transition-colors ${
                  receipt.success
                    ? 'bg-[#34C759] hover:bg-[#34C759]/90 text-white'
                    : 'bg-[#FF3B30] hover:bg-[#FF3B30]/90 text-white'
                }`}
              >
                {receipt.success ? 'Done' : 'Dismiss'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
