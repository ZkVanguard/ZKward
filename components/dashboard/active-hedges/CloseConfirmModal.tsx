'use client';

import { memo } from 'react';
import { XCircle, AlertTriangle, Lock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { HedgePosition } from './types';

interface CloseConfirmModalProps {
  isOpen: boolean;
  hedge: HedgePosition | null;
  onClose: () => void;
  onConfirm: () => void;
}

export const CloseConfirmModal = memo(function CloseConfirmModal({
  isOpen,
  hedge,
  onClose,
  onConfirm,
}: CloseConfirmModalProps) {
  return (
    <AnimatePresence>
      {isOpen && hedge && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.95, opacity: 0 }}
            className="bg-white rounded-2xl p-6 max-w-md w-full shadow-2xl border border-[#e8e8ed]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 bg-[#FF3B30]/10 rounded-xl flex items-center justify-center">
                <XCircle className="w-6 h-6 text-[#FF3B30]" />
              </div>
              <div>
                <h3 className="text-[17px] font-semibold text-[#1d1d1f]">Close Position</h3>
                <p className="text-[13px] text-[#86868b]">Finalize hedge with current P/L</p>
              </div>
            </div>

            <div className="space-y-4 mb-6">
              <div className="p-4 bg-[#f5f5f7] rounded-xl">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px] text-[#86868b]">Position</span>
                  <span className="text-[15px] font-semibold text-[#1d1d1f]">{hedge.type} {hedge.asset}</span>
                </div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px] text-[#86868b]">Current P/L</span>
                  <span className={`text-[17px] font-bold ${hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                    {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)} USDC
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#86868b]">Return</span>
                  <span className={`text-[15px] font-semibold ${hedge.pnlPercent >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                    {hedge.pnlPercent >= 0 ? '+' : ''}{hedge.pnlPercent.toFixed(1)}%
                  </span>
                </div>
              </div>

              <div className="p-3 bg-[#FF9500]/10 rounded-xl flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-[#FF9500] mt-0.5 flex-shrink-0" />
                <p className="text-[11px] text-[#1d1d1f]">
                  Closing this position will lock in the current P/L. This action cannot be undone.
                </p>
              </div>

              {hedge.onChain && (
                <div className="p-3 bg-[#AF52DE]/10 rounded-xl space-y-2">
                  <div className="flex items-center gap-2">
                    <Lock className="w-4 h-4 text-[#AF52DE]" />
                    <span className="text-[12px] font-semibold text-[#AF52DE]">⚡ Gasless close &amp; withdraw</span>
                  </div>
                  <p className="text-[11px] text-[#1d1d1f]">
                    This will execute <code className="text-[10px] bg-[#AF52DE]/10 px-1 py-0.5 rounded">closeHedge()</code> through the gasless relay. 
                    Your collateral {hedge.pnl >= 0 ? '+ profit' : '- loss'} will be transferred directly back to your wallet — <strong>zero gas fees</strong>.
                  </p>
                  <div className="flex items-center gap-1 text-[10px] text-[#86868b]">
                    <span>Contract:</span>
                    <span className="font-mono">0x090b...62B9</span>
                    <span>→</span>
                    <span className="font-semibold text-[#1d1d1f]">Your original wallet</span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[#86868b]">Estimated return</span>
                    <span className="font-semibold text-[#1d1d1f]">
                      {(isNaN(Number(hedge.capitalUsed)) || isNaN(Number(hedge.pnl))) ? '—' : Math.max(0, (Number(hedge.capitalUsed) || 0) + (Number(hedge.pnl) || 0)).toLocaleString()} USDC
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-[#86868b]">Gas cost to you</span>
                    <span className="font-semibold text-[#34C759]">$0.00 ✅</span>
                  </div>
                  
                  <div className="mt-2 p-2 bg-[#007AFF]/10 rounded-lg border border-[#007AFF]/20">
                    <p className="text-[10px] text-[#007AFF] font-medium">
                      📝 MetaMask will ask you to <strong>sign a message</strong> to verify ownership. 
                      Click <strong>&quot;Sign&quot;</strong> in the popup to proceed.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-3 bg-[#f5f5f7] hover:bg-[#e8e8ed] text-[#1d1d1f] rounded-xl text-[15px] font-semibold transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                className="flex-1 px-4 py-3 bg-[#FF3B30] hover:bg-[#FF3B30]/90 text-white rounded-xl text-[15px] font-semibold transition-colors"
              >
                {hedge.onChain ? '⚡ Close & Withdraw (Gasless)' : 'Close Position'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
