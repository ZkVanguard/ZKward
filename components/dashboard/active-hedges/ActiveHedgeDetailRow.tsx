import { motion } from 'framer-motion';
import {
  Shield,
  TrendingUp,
  TrendingDown,
  ExternalLink,
  RefreshCw,
  Lock,
  Clock,
  CheckCircle,
} from 'lucide-react';
import type { HedgePosition } from './types';

interface ContractAddresses {
  hedgeExecutor: string;
}

interface ActiveHedgeDetailRowProps {
  hedge: HedgePosition;
  explorerUrl: string;
  contractAddresses: ContractAddresses;
  closingPosition: string | null;
  onClose: (hedge: HedgePosition) => void;
}

/**
 * Full-view expanded row for an active hedge — the AnimatePresence body
 * rendered when the user opens "All Active Positions".
 */
export function ActiveHedgeDetailRow({
  hedge,
  explorerUrl,
  contractAddresses,
  closingPosition,
  onClose,
}: ActiveHedgeDetailRowProps) {
  return (
    <motion.div
      key={hedge.id}
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -100 }}
      className="p-4 bg-[#f5f5f7] rounded-[14px] border border-[#e8e8ed]"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
            hedge.type === 'SHORT' ? 'bg-[#FF3B30]/10' : 'bg-[#34C759]/10'
          }`}>
            {hedge.type === 'SHORT' ? (
              <TrendingDown className="w-5 h-5 text-[#FF3B30]" />
            ) : (
              <TrendingUp className="w-5 h-5 text-[#34C759]" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-[#1d1d1f]">{hedge.type} {hedge.asset}</span>
              <span className="inline-flex items-center px-2 py-0.5 bg-[#007AFF]/10 text-[#007AFF] rounded-[6px] text-[10px] font-bold">
                {hedge.leverage}x
              </span>
              <span className="text-[11px] px-2 py-0.5 bg-[#34C759]/20 text-[#34C759] rounded-full font-medium">
                Active
              </span>
              {hedge.zkVerified && (
                <span className="inline-flex items-center gap-0.5 px-2 py-0.5 bg-[#5856D6]/10 text-[#5856D6] rounded-full text-[10px] font-bold" title="ZK-verified ownership">
                  <Lock className="w-3 h-3" />ZK
                </span>
              )}
              {hedge.onChain && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-[#FF9500]/10 text-[#FF9500] rounded-full text-[10px] font-bold" title="On-chain verified position on Cronos testnet">
                  ⛓ ON-CHAIN
                </span>
              )}
            </div>
            <div className="text-[11px] text-[#86868b] mt-0.5 space-y-0.5">
              <div className="text-[13px] font-medium text-[#1d1d1f]">{hedge.reason}</div>
              {hedge.onChain && hedge.contractAddress && (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-[#FF9500]">CONTRACT:</span>
                  <a
                    href={`${explorerUrl}/address/${hedge.contractAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-0.5 text-[#007AFF] hover:underline"
                    title="View HedgeExecutor on Cronos Explorer"
                  >
                    <span className="font-mono">{hedge.contractAddress.slice(0, 10)}...{hedge.contractAddress.slice(-6)}</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </div>
              )}
              {hedge.onChain && (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider">TRANSACTION:</span>
                  <a
                    href={hedge.txHash ? `${explorerUrl}/tx/${hedge.txHash}` : `${explorerUrl}/address/${hedge.contractAddress || contractAddresses.hedgeExecutor}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-0.5 text-[#007AFF] hover:underline"
                    title={hedge.txHash ? 'View collateral transfer transaction' : 'View HedgeExecutor contract'}
                  >
                    <span className="font-mono">{hedge.txHash ? `${hedge.txHash.slice(0, 10)}...${hedge.txHash.slice(-8)}` : 'View Contract'}</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </div>
              )}
              {hedge.proxyWallet && (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-[#5856D6]">ZK PRIVACY ID:</span>
                  <a
                    href={`${explorerUrl}/address/${hedge.proxyWallet}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-0.5 text-[#007AFF] hover:underline"
                    title="ZK Privacy Address. Identity obfuscation via PDA derivation"
                  >
                    <span className="font-mono">{hedge.proxyWallet.slice(0, 10)}...{hedge.proxyWallet.slice(-6)}</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                  <span className="inline-flex items-center gap-0.5 px-1 py-0.5 bg-[#5856D6]/10 text-[#5856D6] rounded text-[8px] font-bold">
                    <Lock className="w-2 h-2" />ZK ID
                  </span>
                </div>
              )}
              {hedge.commitmentHash && hedge.commitmentHash !== '0x0000000000000000000000000000000000000000000000000000000000000000' && (
                <div className="flex items-center gap-1">
                  <span className="text-[10px] uppercase tracking-wider text-[#5856D6]">ZK COMMITMENT:</span>
                  <span className="font-mono text-[10px] text-[#86868b]">{hedge.commitmentHash.slice(0, 14)}...{hedge.commitmentHash.slice(-8)}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className={`text-[20px] font-bold ${hedge.pnl >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
            {hedge.pnl >= 0 ? '+' : ''}{hedge.pnl.toFixed(2)} USDC
          </div>
          <div className={`text-[13px] font-medium ${hedge.pnlPercent >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}>
            {hedge.pnlPercent >= 0 ? '+' : ''}{hedge.pnlPercent.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Position Details */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 pt-4 border-t border-[#e8e8ed]">
        <div>
          <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-wider">Size</div>
          <div className="text-[15px] font-bold text-[#1d1d1f]">{hedge.size} {hedge.asset.replace('-PERP', '')}</div>
          <div className="text-[11px] font-medium text-[#007AFF]">{hedge.leverage}x leverage</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-wider">Entry</div>
          <div className="text-[15px] font-bold text-[#1d1d1f]">${hedge.entryPrice.toLocaleString()}</div>
          <div className="text-[11px] font-medium text-[#1d1d1f]">Now: ${hedge.currentPrice.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-wider">Target</div>
          <div className="text-[15px] font-bold text-[#34C759]">${hedge.targetPrice.toLocaleString()}</div>
          <div className="text-[11px] font-medium text-[#1d1d1f]">
            {((hedge.currentPrice - hedge.targetPrice) / hedge.targetPrice * 100).toFixed(1)}% away
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold text-[#86868b] uppercase tracking-wider">Stop Loss</div>
          <div className="text-[15px] font-bold text-[#FF3B30]">${hedge.stopLoss.toLocaleString()}</div>
          <div className="text-[11px] text-[#86868b]">
            {((hedge.stopLoss - hedge.currentPrice) / hedge.currentPrice * 100).toFixed(1)}% away
          </div>
        </div>
      </div>

      {/* ZK Privacy & Proxy Wallet Section */}
      {hedge.onChain && hedge.zkVerified && (
        <div className="mt-4 pt-4 border-t border-[#e8e8ed]">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-6 h-6 rounded-lg bg-[#5856D6]/10 flex items-center justify-center">
              <Shield className="w-3.5 h-3.5 text-[#5856D6]" />
            </div>
            <span className="text-[12px] font-semibold text-[#5856D6] uppercase tracking-wider">ZK Privacy Shield</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div className="p-2.5 bg-[#5856D6]/5 rounded-lg border border-[#5856D6]/10">
              <div className="text-[9px] font-bold text-[#5856D6] uppercase tracking-wider mb-1">ZK Privacy Address</div>
              {hedge.proxyWallet ? (
                <a
                  href={`${explorerUrl}/address/${hedge.proxyWallet}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[#007AFF] hover:underline"
                >
                  <span className="font-mono text-[11px]">{hedge.proxyWallet.slice(0, 8)}...{hedge.proxyWallet.slice(-6)}</span>
                  <ExternalLink className="w-2.5 h-2.5" />
                </a>
              ) : (
                <span className="font-mono text-[11px] text-[#86868b]">Deriving...</span>
              )}
              <div className="text-[9px] text-[#86868b] mt-0.5">Privacy ID. Not a fund holder</div>
            </div>
            <div className="p-2.5 bg-[#5856D6]/5 rounded-lg border border-[#5856D6]/10">
              <div className="text-[9px] font-bold text-[#5856D6] uppercase tracking-wider mb-1">ZK Verification</div>
              <div className="flex items-center gap-1">
                <CheckCircle className="w-3.5 h-3.5 text-[#34C759]" />
                <span className="text-[12px] font-semibold text-[#34C759]">Verified</span>
              </div>
              <div className="text-[9px] text-[#86868b] mt-0.5">STARK proof on-chain</div>
            </div>
            <div className="p-2.5 bg-[#5856D6]/5 rounded-lg border border-[#5856D6]/10">
              <div className="text-[9px] font-bold text-[#5856D6] uppercase tracking-wider mb-1">Funds Location</div>
              <a
                href="${explorerUrl}/address/0x090b6221137690EbB37667E4644287487CE462B9"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[#007AFF] hover:underline"
              >
                <span className="font-mono text-[11px]">HedgeExecutor</span>
                <ExternalLink className="w-2.5 h-2.5" />
              </a>
              <div className="text-[9px] text-[#86868b] mt-0.5">
                Withdraw → {hedge.walletAddress ? `${hedge.walletAddress.slice(0, 6)}...${hedge.walletAddress.slice(-4)}` : 'your wallet'}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between mt-4 pt-4 border-t border-[#e8e8ed] text-[11px] text-[#86868b]">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span>{new Date(hedge.openedAt).toLocaleString()}</span>
          </div>
          <div>Capital: ${hedge.capitalUsed?.toLocaleString()} USDC</div>
        </div>
        <div className="flex items-center gap-2">
          {hedge.onChain && (
            <span className="text-[9px] text-[#5856D6] font-medium">
              <Lock className="w-2.5 h-2.5 inline mr-0.5" />Funds return to your wallet on close
            </span>
          )}
          <button
            onClick={() => onClose(hedge)}
            disabled={closingPosition === hedge.id}
            className="px-4 py-1.5 bg-[#FF3B30]/10 hover:bg-[#FF3B30]/20 text-[#FF3B30] rounded-lg text-[11px] font-semibold transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {closingPosition === hedge.id ? (
              <><RefreshCw className="w-3 h-3 animate-spin" />Closing &amp; Withdrawing...</>
            ) : (
              <>{hedge.onChain ? '⚡ Close & Withdraw (Gasless)' : 'Close Position'}</>
            )}
          </button>
        </div>
      </div>
    </motion.div>
  );
}
