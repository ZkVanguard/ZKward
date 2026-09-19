/**
 * Simulation results panel — Before/After comparison + AI insights +
 * ZK proof + Traditional-vs-ZkWard table + compliance blurb.
 *
 * Extracted from simulator/page.tsx 2026-09-18. All state lives in the
 * parent; component is pure display.
 */
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, Shield, Zap } from 'lucide-react';
import { initialPortfolio } from '@/app/[locale]/simulator/constants';
import type { ZKProofData } from '@/components/ZKVerificationBadge';

interface AIAnalysis {
  model: string;
  response: string;
}

interface Props {
  show: boolean;
  unhedgedLoss: number;
  pnlValue: number;
  pnlPercent: number;
  marketVarianceApplied: number;
  hedgeSavings: number;
  simulationSeed: number | string;
  onChainTx: string | null;
  aiAnalysis: AIAnalysis | null;
  zkProofData: ZKProofData | null;
}

export function ComparisonPanel({
  show,
  unhedgedLoss,
  pnlValue,
  pnlPercent,
  marketVarianceApplied,
  hedgeSavings,
  simulationSeed,
  onChainTx,
  aiAnalysis,
  zkProofData,
}: Props) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-[16px] sm:rounded-[20px] border-2 border-[#34C759]/30 p-4 sm:p-5 shadow-sm space-y-5"
        >
          <h3 className="text-[17px] sm:text-[20px] font-semibold text-[#1d1d1f] flex items-center gap-2">
            <div className="w-8 h-8 bg-[#34C759]/10 rounded-[8px] flex items-center justify-center">
              <CheckCircle className="w-4 h-4 text-[#34C759]" />
            </div>
            Simulation Results: Before vs After
          </h3>

          {/* Before vs After */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <div className="bg-[#f5f5f7] rounded-[12px] p-4 border-2 border-[#FF3B30]/20">
              <div className="text-[12px] sm:text-[13px] text-[#86868b] mb-2">Without Hedging</div>
              <div className="text-[22px] sm:text-[26px] font-bold text-[#FF3B30]">
                -${(unhedgedLoss / 1000000).toFixed(2)}M
              </div>
              <div className="text-[11px] sm:text-[12px] text-[#86868b]">
                {((unhedgedLoss / initialPortfolio.totalValue) * 100).toFixed(1)}% total portfolio loss
                {marketVarianceApplied !== 0 && (
                  <span className="ml-1 text-[#007AFF]">
                    ({marketVarianceApplied > 0 ? '+' : ''}
                    {(marketVarianceApplied * 100).toFixed(1)}% variance)
                  </span>
                )}
              </div>
            </div>
            <div className="bg-[#f5f5f7] rounded-[12px] p-4 border-2 border-[#34C759]/30">
              <div className="text-[12px] sm:text-[13px] text-[#86868b] mb-2">With ZkWard Hedging</div>
              <div className="text-[22px] sm:text-[26px] font-bold text-[#34C759]">
                {pnlValue >= 0 ? '+' : '-'}${Math.abs(pnlValue / 1000000).toFixed(2)}M
              </div>
              <div className="text-[11px] sm:text-[12px] text-[#34C759]">
                {Math.abs(pnlPercent).toFixed(1)}% {pnlPercent >= 0 ? 'gain' : 'loss'} (hedged)
              </div>
            </div>
          </div>

          {/* AI protection savings */}
          <div className="p-3 sm:p-4 bg-[#AF52DE]/5 rounded-[12px] border border-[#AF52DE]/20">
            <div className="flex items-center gap-2 text-[#AF52DE]">
              <Shield className="w-4 h-4" />
              <span className="font-semibold text-[14px] sm:text-[15px]">
                AI Protection Saved: $
                {hedgeSavings > 0
                  ? hedgeSavings.toLocaleString(undefined, { maximumFractionDigits: 0 })
                  : (unhedgedLoss - Math.abs(pnlValue)).toLocaleString(undefined, {
                      maximumFractionDigits: 0,
                    })}
              </span>
              <span className="text-[10px] text-[#86868b] ml-2">(Seed: {simulationSeed})</span>
            </div>
          </div>

          {/* On-chain tx hash */}
          {onChainTx && (
            <div className="p-3 sm:p-4 bg-[#007AFF]/5 rounded-[12px] border border-[#007AFF]/20">
              <div className="flex items-center gap-2 text-[#007AFF]">
                <Zap className="w-4 h-4" />
                <span className="font-semibold text-[14px] sm:text-[15px]">On-Chain Hedge Executed</span>
                <a
                  href={`https://cronos.org/explorer/testnet3/tx/${onChainTx}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline text-[#5856D6] ml-2 text-[13px]"
                >
                  View on Cronos Explorer
                </a>
              </div>
              <div className="text-[11px] sm:text-[12px] text-[#86868b] mt-1">
                Tx Hash: <span className="font-mono text-[#007AFF]">{onChainTx}</span>
              </div>
            </div>
          )}

          {/* AI Analysis (Ollama/Qwen) */}
          {aiAnalysis && (
            <div className="p-3 sm:p-4 bg-gradient-to-br from-[#5856D6]/5 to-[#AF52DE]/5 rounded-[12px] border border-[#5856D6]/30">
              <div className="flex items-center gap-2 text-[#5856D6] mb-2">
                <span className="text-lg">🤖</span>
                <span className="font-semibold text-[14px] sm:text-[15px]">AI Analysis (Local Ollama)</span>
                <span className="ml-auto text-[10px] px-2 py-0.5 bg-[#5856D6]/10 rounded-full">
                  {aiAnalysis.model}
                </span>
              </div>
              <div className="text-[12px] sm:text-[13px] text-[#1d1d1f] leading-relaxed">
                {aiAnalysis.response}
              </div>
              <div className="text-[10px] text-[#86868b] mt-2 flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-[#34C759] rounded-full animate-pulse"></span>
                Running locally via Ollama - no data leaves your machine
              </div>
            </div>
          )}

          {/* ZK Proof */}
          {zkProofData && (
            <div className="p-3 sm:p-4 bg-[#AF52DE]/5 rounded-[12px] border border-[#AF52DE]/20">
              <div className="flex items-center gap-2 text-[#AF52DE] mb-2">
                <Shield className="w-4 h-4" />
                <span className="font-semibold text-[14px] sm:text-[15px]">ZK Proof of Policy Compliance</span>
              </div>
              <div className="text-[11px] sm:text-[12px] text-[#86868b] mb-2 space-y-0.5">
                <div className="font-mono text-[#AF52DE]">Proof Hash: {zkProofData.proofHash}</div>
                <div className="font-mono text-[#AF52DE]">Merkle Root: {zkProofData.merkleRoot}</div>
                <div>
                  Protocol: {zkProofData.protocol} ({zkProofData.securityLevel}-bit)
                </div>
                <div>Generated in {zkProofData.generationTime} ms</div>
              </div>
              <div className="text-sm text-[#1d1d1f] mb-2">
                <b>What this proves:</b>
                <br />
                <span className="text-[#1d1d1f]">- Risk calculation was performed correctly</span>
                <br />
                <span className="text-[#1d1d1f]">
                  - Policy compliance (max drawdown, VaR, allowed instruments) was enforced
                </span>
                <br />
                <span className="text-[#1d1d1f]">- No position or trade details leaked</span>
                <br />
              </div>
              <div className="text-lg font-bold text-emerald-400 mt-2">
                You don't trust our AI. You verify it.
              </div>
            </div>
          )}

          {/* Traditional vs ZkWard table */}
          <div>
            <h4 className="text-[14px] sm:text-[15px] font-semibold mb-3 text-[#1d1d1f]">
              Traditional vs ZkWard
            </h4>
            <div className="overflow-x-auto">
              <table className="min-w-full text-[13px] sm:text-[14px] border border-black/5 rounded-[12px] overflow-hidden">
                <thead>
                  <tr className="bg-[#f5f5f7] text-[#86868b]">
                    <th className="px-4 py-2.5 text-left font-medium">Traditional</th>
                    <th className="px-4 py-2.5 text-left font-medium">ZkWard</th>
                  </tr>
                </thead>
                <tbody className="text-[#1d1d1f]">
                  <tr className="border-t border-black/5">
                    <td className="px-4 py-2.5">Manual checks</td>
                    <td className="px-4 py-2.5">Automatic</td>
                  </tr>
                  <tr className="border-t border-black/5">
                    <td className="px-4 py-2.5">Trust required</td>
                    <td className="px-4 py-2.5">Verifiable</td>
                  </tr>
                  <tr className="border-t border-black/5">
                    <td className="px-4 py-2.5">Slow</td>
                    <td className="px-4 py-2.5">Deterministic</td>
                  </tr>
                  <tr className="border-t border-black/5">
                    <td className="px-4 py-2.5">Opaque</td>
                    <td className="px-4 py-2.5">Auditable</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Compliance blurb */}
          <div className="p-3 sm:p-4 bg-[#34C759]/5 rounded-[12px] border border-[#34C759]/20 text-[#1d1d1f] text-center text-[13px] sm:text-[14px]">
            This same proof can be shared with compliance, governance, or regulators —{' '}
            <b>without revealing positions</b>.
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
