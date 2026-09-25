import { Sparkles } from 'lucide-react';
import type { AgentRecommendation, OnChainPortfolio } from '../positions-types';
import type { PredictionMarket } from '@/lib/services/market-data/DelphiMarketService';

interface AgentRecommendationModalProps {
  recommendation: AgentRecommendation;
  analyzedPortfolio: OnChainPortfolio | null;
  onClose: () => void;
  onDeposit: (portfolio: OnChainPortfolio) => void;
  onWithdraw: (portfolio: OnChainPortfolio) => void;
  onOpenHedge?: (prediction: PredictionMarket) => void;
}

export function AgentRecommendationModal({
  recommendation,
  analyzedPortfolio,
  onClose,
  onDeposit,
  onWithdraw,
  onOpenHedge,
}: AgentRecommendationModalProps) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-[20px] max-w-2xl w-full border border-black/5 shadow-2xl">
        <div className="p-6 border-b border-black/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-[#AF52DE] rounded-[12px] flex items-center justify-center">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <h3 className="text-[20px] font-bold text-[#1d1d1f]">AI Analysis</h3>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 flex items-center justify-center bg-[#f5f5f7] hover:bg-[#e8e8ed] rounded-full transition-colors"
            >
              <svg
                className="w-4 h-4 text-[#86868b]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          {/* Action Recommendation */}
          <div
            className={`p-4 rounded-lg border-2 ${
              recommendation.action === 'WITHDRAW'
                ? 'bg-red-500/10 border-red-500/50'
                : recommendation.action === 'HEDGE'
                  ? 'bg-orange-500/10 border-orange-500/50'
                  : recommendation.action === 'ADD_FUNDS'
                    ? 'bg-green-500/10 border-green-500/50'
                    : 'bg-blue-500/10 border-blue-500/50'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="text-2xl font-bold text-[#1d1d1f]">
                {recommendation.action === 'WITHDRAW' && '🚨 WITHDRAW'}
                {recommendation.action === 'HEDGE' && '🛡️ HEDGE'}
                {recommendation.action === 'ADD_FUNDS' && '✅ ADD FUNDS'}
                {recommendation.action === 'HOLD' && '📊 HOLD'}
              </div>
              <div className="text-sm text-[#86868b]">
                Confidence:{' '}
                <span className="font-semibold text-[#1d1d1f]">
                  {(recommendation.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>

          {/* Multi-Agent Reasoning */}
          <div>
            <div className="text-sm font-semibold text-[#AF52DE] mb-3">Agent Reasoning:</div>
            <div className="space-y-2">
              {recommendation.reasoning.map((reason: string, idx: number) => (
                <div key={idx} className="flex items-start gap-2 text-sm text-[#1d1d1f]">
                  <span className="text-[#AF52DE] mt-1">•</span>
                  <span className="text-[#86868b]">{reason}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Risk Score */}
          <div className="bg-[#f5f5f7] rounded-lg p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-[#86868b]">Portfolio Risk Score</span>
              <span
                className={`text-lg font-bold ${
                  recommendation.riskScore > 70
                    ? 'text-[#FF3B30]'
                    : recommendation.riskScore > 40
                      ? 'text-[#FF9500]'
                      : 'text-[#34C759]'
                }`}
              >
                {recommendation.riskScore}/100
              </span>
            </div>
            <div className="w-full bg-[#e8e8ed] rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all ${
                  recommendation.riskScore > 70
                    ? 'bg-[#FF3B30]'
                    : recommendation.riskScore > 40
                      ? 'bg-[#FF9500]'
                      : 'bg-[#34C759]'
                }`}
                style={{ width: `${recommendation.riskScore}%` }}
              />
            </div>
          </div>

          {/* Agent Analysis Details */}
          <div>
            <div className="text-sm font-semibold text-[#AF52DE] mb-3">
              Multi-Agent Analysis:
            </div>
            <div className="space-y-2">
              <div className="bg-[#f5f5f7] rounded-lg p-3">
                <div className="text-xs text-[#86868b] mb-1">Risk Agent</div>
                <div className="text-sm text-[#1d1d1f]">
                  {recommendation.agentAnalysis.riskAgent}
                </div>
              </div>
              <div className="bg-[#f5f5f7] rounded-lg p-3">
                <div className="text-xs text-[#86868b] mb-1">Hedging Agent</div>
                <div className="text-sm text-[#1d1d1f]">
                  {recommendation.agentAnalysis.hedgingAgent}
                </div>
              </div>
              <div className="bg-[#f5f5f7] rounded-lg p-3">
                <div className="text-xs text-[#86868b] mb-1">Lead Agent</div>
                <div className="text-sm text-[#1d1d1f]">
                  {recommendation.agentAnalysis.leadAgent}
                </div>
              </div>
            </div>
          </div>

          {/* Recommendations */}
          {recommendation.recommendations.length > 0 && (
            <div>
              <div className="text-sm font-semibold text-[#AF52DE] mb-3">
                Additional Recommendations:
              </div>
              <div className="space-y-1">
                {recommendation.recommendations.map((rec: string, idx: number) => (
                  <div key={idx} className="text-sm text-[#86868b]">
                    • {rec}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-black/5 flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-[#f5f5f7] hover:bg-[#e8e8ed] text-[#1d1d1f] rounded-[12px] text-sm font-semibold transition-colors"
          >
            Close
          </button>
          <button
            onClick={() => {
              onClose();
              // Act on recommendation
              if (recommendation.action === 'ADD_FUNDS' && analyzedPortfolio) {
                onDeposit(analyzedPortfolio);
              } else if (recommendation.action === 'WITHDRAW' && analyzedPortfolio) {
                onWithdraw(analyzedPortfolio);
              } else if (
                recommendation.action === 'HEDGE' &&
                onOpenHedge &&
                analyzedPortfolio?.predictions?.[0]
              ) {
                // Call the hedge handler with the portfolio's prediction
                onOpenHedge(analyzedPortfolio.predictions[0]);
              }
              // HOLD just closes (user is informed)
            }}
            className={`flex-1 px-4 py-2 rounded-[12px] text-sm font-semibold text-white transition-colors ${
              recommendation.action === 'WITHDRAW'
                ? 'bg-[#FF3B30] hover:bg-[#FF3B30]/90'
                : recommendation.action === 'ADD_FUNDS'
                  ? 'bg-[#34C759] hover:bg-[#34C759]/90'
                  : recommendation.action === 'HEDGE'
                    ? 'bg-[#FF9500] hover:bg-[#FF9500]/90'
                    : 'bg-[#007AFF] hover:bg-[#007AFF]/90'
            }`}
          >
            {recommendation.action === 'WITHDRAW' && '🚨 Withdraw Funds'}
            {recommendation.action === 'ADD_FUNDS' && '✅ Add More Funds'}
            {recommendation.action === 'HEDGE' && '🛡️ Open Hedge Position'}
            {recommendation.action === 'HOLD' && '📊 Continue Holding'}
          </button>
        </div>
      </div>
    </div>
  );
}
