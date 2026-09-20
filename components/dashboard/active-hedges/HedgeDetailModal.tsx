'use client';

import { memo } from 'react';
import { TrendingUp, TrendingDown, CheckCircle, XCircle, Clock, ExternalLink, Lock } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { HedgePosition } from './types';

interface HedgeDetailModalProps {
  hedge: HedgePosition | null;
  onClose: () => void;
  onClosePosition: (hedge: HedgePosition) => void;
  closingPosition: string | null;
  explorerUrl: string;
  chainId: number;
  contractAddresses: { usdtToken: string };
}

export const HedgeDetailModal = memo(function HedgeDetailModal({
  hedge,
  onClose,
  onClosePosition,
  closingPosition,
  explorerUrl,
  chainId,
  contractAddresses,
}: HedgeDetailModalProps) {
  const CHAIN_IDS_CRONOS_MAINNET = 25;

  return (
    <AnimatePresence>
      {hedge && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: 20 }}
            className="bg-white rounded-2xl max-w-lg w-full shadow-2xl border border-[#e8e8ed] overflow-hidden max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`p-5 ${hedge.type === 'LONG' ? 'bg-gradient-to-r from-[#34C759]/10 to-[#007AFF]/5' : 'bg-gradient-to-r from-[#FF3B30]/10 to-[#FF9500]/5'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                    hedge.type === 'SHORT' ? 'bg-[#FF3B30]/20' : 'bg-[#34C759]/20'
                  }`}>
                    {hedge.type === 'SHORT' ? (
                      <TrendingDown className="w-6 h-6 text-[#FF3B30]" strokeWidth={2.5} />
                    ) : (
                      <TrendingUp className="w-6 h-6 text-[#34C759]" strokeWidth={2.5} />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-[18px] font-bold text-[#1d1d1f]">{hedge.type} {hedge.asset}</h3>
                      <span className="px-2 py-0.5 bg-[#007AFF]/10 text-[#007AFF] rounded-[6px] text-[11px] font-bold">
                        {hedge.leverage}x
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className="px-1.5 py-0.5 bg-[#34C759] text-white text-[9px] font-bold rounded uppercase">{hedge.status}</span>
                      {hedge.zkVerified && (
                        <span className="px-1.5 py-0.5 bg-[#5856D6] text-white text-[9px] font-bold rounded flex items-center gap-0.5">
                          <Lock className="w-2.5 h-2.5" />ZK
                        </span>
                      )}
                      {hedge.onChain && (
                        <span className="px-1.5 py-0.5 bg-[#FF9500]/10 text-[#FF9500] text-[9px] font-bold rounded">⛓ ON-CHAIN</span>
                      )}
                    </div>
                  </div>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-black/5 rounded-lg transition-colors">
                  <XCircle className="w-5 h-5 text-[#86868b]" />
                </button>
              </div>
            </div>

            <div className="p-5 space-y-4">
              {/* P&L */}
              <div className="text-center p-4 bg-[#f5f5f7] rounded-xl">
                <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-wider mb-1">Unrealized P/L</div>
                <div className={`text-[28px] font-bold ${hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                  {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)} USDC
                </div>
                <div className={`text-[14px] font-medium ${hedge.pnlPercent >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                  {hedge.pnlPercent >= 0 ? '+' : ''}{hedge.pnlPercent.toFixed(2)}%
                </div>
              </div>

              {/* Position Details */}
              <div className="space-y-2.5">
                <div className="text-[11px] font-bold text-[#86868b] uppercase tracking-wider">Position Details</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-[#f5f5f7] rounded-xl">
                    <div className="text-[10px] font-semibold text-[#86868b] uppercase">Entry Price</div>
                    <div className="text-[15px] font-bold text-[#1d1d1f]">${hedge.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
                  </div>
                  <div className="p-3 bg-[#f5f5f7] rounded-xl">
                    <div className="text-[10px] font-semibold text-[#86868b] uppercase">Current Price</div>
                    <div className="text-[15px] font-bold text-[#1d1d1f]">${hedge.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
                  </div>
                  <div className="p-3 bg-[#f5f5f7] rounded-xl">
                    <div className="text-[10px] font-semibold text-[#86868b] uppercase">Collateral</div>
                    <div className="text-[15px] font-bold text-[#1d1d1f]">{hedge.capitalUsed?.toLocaleString()} USDC</div>
                  </div>
                  <div className="p-3 bg-[#f5f5f7] rounded-xl">
                    <div className="text-[10px] font-semibold text-[#86868b] uppercase">Notional Value</div>
                    <div className="text-[15px] font-bold text-[#1d1d1f]">{((hedge.capitalUsed || 0) * hedge.leverage).toLocaleString()} USDC</div>
                  </div>
                </div>
              </div>

              {/* Amount Held */}
              {hedge.onChain && (
                <div className="space-y-2.5">
                  <div className="text-[11px] font-bold text-[#86868b] uppercase tracking-wider">Funds Held in Contract</div>
                  <div className="p-4 bg-gradient-to-r from-[#34C759]/5 to-[#007AFF]/5 rounded-xl border border-[#34C759]/20 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] text-[#86868b]">Collateral Locked</span>
                      <span className="text-[15px] font-bold text-[#1d1d1f]">{hedge.capitalUsed?.toLocaleString()} USDC</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] text-[#86868b]">Unrealized P/L</span>
                      <span className={`text-[15px] font-bold ${hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                        {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)} USDC
                      </span>
                    </div>
                    <div className="h-px bg-[#e8e8ed]" />
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-[#1d1d1f]">Estimated Return</span>
                      <span className={`text-[17px] font-bold ${((Number(hedge.capitalUsed) || 0) + (Number(hedge.pnl) || 0)) >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
                        {(isNaN(Number(hedge.capitalUsed)) || isNaN(Number(hedge.pnl))) ? '—' : Math.max(0, (Number(hedge.capitalUsed) || 0) + (Number(hedge.pnl) || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-[#86868b]">
                      <Lock className="w-3 h-3 text-[#5856D6]" />
                      <span>Funds held in HedgeExecutor contract. Returned to your wallet on close</span>
                    </div>
                  </div>
                </div>
              )}

              {/* On-Chain Info */}
              {hedge.onChain && (
                <div className="space-y-2.5">
                  <div className="text-[11px] font-bold text-[#86868b] uppercase tracking-wider">On-Chain Details</div>
                  <div className="p-3 bg-[#f5f5f7] rounded-xl space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-[#86868b]">Chain</span>
                      <span className="text-[12px] font-semibold text-[#1d1d1f]">{chainId === CHAIN_IDS_CRONOS_MAINNET ? 'Cronos Mainnet (25)' : 'Cronos Testnet (338)'}</span>
                    </div>
                    {hedge.hedgeId && (
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <span className="text-[11px] text-[#86868b] flex-shrink-0">Hedge ID</span>
                        <span className="text-[11px] font-mono text-[#1d1d1f] truncate min-w-0">{hedge.hedgeId.slice(0, 10)}...{hedge.hedgeId.slice(-8)}</span>
                      </div>
                    )}
                    {hedge.contractAddress && (
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <span className="text-[11px] text-[#86868b] flex-shrink-0">Contract</span>
                        <a
                          href={`${explorerUrl}/address/${hedge.contractAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[#007AFF] hover:underline text-[11px] min-w-0"
                        >
                          <span className="font-mono truncate min-w-0">{hedge.contractAddress.slice(0, 8)}...{hedge.contractAddress.slice(-6)}</span>
                          <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
                        </a>
                      </div>
                    )}
                    {hedge.txHash && (
                      <div className="flex items-center justify-between gap-2 min-w-0">
                        <span className="text-[11px] text-[#86868b] flex-shrink-0">Transaction</span>
                        <a
                          href={`${explorerUrl}/tx/${hedge.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[#007AFF] hover:underline text-[11px] min-w-0"
                        >
                          <span className="font-mono truncate min-w-0">{hedge.txHash.slice(0, 10)}...{hedge.txHash.slice(-8)}</span>
                          <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
                        </a>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-[#86868b]">Collateral (USDT)</span>
                      <a
                        href={`${explorerUrl}/address/${contractAddresses.usdtToken}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[#007AFF] hover:underline text-[11px]"
                      >
                        <span className="font-mono">View USDT Contract</span>
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    </div>
                    {hedge.walletAddress && (
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[#86868b]">Trader Wallet</span>
                        <a
                          href={`${explorerUrl}/address/${hedge.walletAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[#007AFF] hover:underline text-[11px]"
                        >
                          <span className="font-mono">{hedge.walletAddress.slice(0, 8)}...{hedge.walletAddress.slice(-6)}</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ZK Privacy */}
              {hedge.zkVerified && (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-[#5856D6]" />
                    <span className="text-[11px] font-bold text-[#5856D6] uppercase tracking-wider">ZK Privacy Shield</span>
                  </div>
                  <div className="p-3 bg-[#5856D6]/5 rounded-xl border border-[#5856D6]/10 space-y-2.5">
                    {hedge.proxyWallet && (
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[#86868b]">ZK Privacy Address</span>
                        <a
                          href={`${explorerUrl}/address/${hedge.proxyWallet}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-[#007AFF] hover:underline text-[11px]"
                        >
                          <span className="font-mono">{hedge.proxyWallet.slice(0, 8)}...{hedge.proxyWallet.slice(-6)}</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </div>
                    )}
                    {hedge.commitmentHash && hedge.commitmentHash !== '0x0000000000000000000000000000000000000000000000000000000000000000' && (
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-[#86868b]">Commitment Hash</span>
                        <span className="font-mono text-[10px] text-[#1d1d1f]">{hedge.commitmentHash.slice(0, 14)}...{hedge.commitmentHash.slice(-8)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-[#86868b]">Verification</span>
                      <div className="flex items-center gap-1">
                        <CheckCircle className="w-3.5 h-3.5 text-[#34C759]" />
                        <span className="text-[12px] font-semibold text-[#34C759]">STARK proof verified</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Timing */}
              <div className="flex items-center gap-2 text-[11px] text-[#86868b]">
                <Clock className="w-3.5 h-3.5" />
                <span>Opened {new Date(hedge.openedAt).toLocaleString()}</span>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-2">
                {hedge.onChain && (
                  <a
                    href={hedge.txHash
                      ? `${explorerUrl}/tx/${hedge.txHash}`
                      : `${explorerUrl}/address/${hedge.contractAddress}`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 px-4 py-3 bg-[#007AFF]/10 hover:bg-[#007AFF]/20 text-[#007AFF] rounded-xl text-[13px] font-semibold transition-colors flex items-center justify-center gap-2"
                  >
                    <ExternalLink className="w-4 h-4" />
                    {hedge.txHash ? 'View Transaction' : 'View Contract'}
                  </a>
                )}
                {hedge.status === 'active' && (
                  <button
                    onClick={() => { onClose(); onClosePosition(hedge); }}
                    disabled={closingPosition === hedge.id}
                    className="flex-1 px-4 py-3 bg-[#FF3B30] hover:bg-[#FF3B30]/90 text-white rounded-xl text-[13px] font-semibold transition-colors disabled:opacity-50"
                  >
                    {hedge.onChain ? '⚡ Close & Withdraw' : 'Close Position'}
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
