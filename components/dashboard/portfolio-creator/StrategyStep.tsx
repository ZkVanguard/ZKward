'use client';

import { Target, Shield, Sparkles, CheckCircle } from 'lucide-react';
import type { StrategyConfig, AIPreset } from './types';
import { InfoTooltip } from './InfoTooltip';

export function StrategyStep({ 
  strategy, 
  setStrategy, 
  aiPreset, 
  setAiPreset,
  onNext 
}: {
  strategy: StrategyConfig;
  setStrategy: React.Dispatch<React.SetStateAction<StrategyConfig>>;
  aiPreset: AIPreset;
  setAiPreset: (preset: AIPreset) => void;
  onNext: () => void;
}) {
  return (
    <div className="space-y-5 sm:space-y-6">
      <div>
        <h3 className="text-[15px] sm:text-[17px] font-semibold text-[#1d1d1f] mb-4 flex items-center gap-2">
          <Target className="w-4 h-4 sm:w-5 sm:h-5 text-[#AF52DE]" />
          AI Strategy Configuration
        </h3>

        {/* AI Presets */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-5 sm:mb-6">
          {(['conservative', 'balanced', 'aggressive'] as const).map((preset) => (
            <button
              key={preset}
              onClick={() => setAiPreset(preset)}
              className={`p-3 sm:p-4 rounded-[14px] border-2 transition-all active:scale-[0.98] ${
                aiPreset === preset
                  ? 'border-[#007AFF] bg-[#007AFF]/5'
                  : 'border-black/10 hover:border-[#007AFF]/50 bg-[#f5f5f7]'
              }`}
            >
              <div className="text-[18px] sm:text-[22px] mb-1">
                {preset === 'conservative' && '🛡️'}
                {preset === 'balanced' && '⚖️'}
                {preset === 'aggressive' && '🚀'}
              </div>
              <div className="text-[12px] sm:text-[13px] font-semibold text-[#1d1d1f] capitalize mb-1">{preset}</div>
              <div className="text-[10px] sm:text-[11px] text-[#86868b]">
                {preset === 'conservative' && 'Low risk, stable'}
                {preset === 'balanced' && 'Moderate risk'}
                {preset === 'aggressive' && 'High risk'}
              </div>
              <div className={`text-[10px] sm:text-[11px] mt-1.5 font-medium ${
                preset === 'conservative' ? 'text-[#34C759]' :
                preset === 'balanced' ? 'text-[#007AFF]' :
                'text-[#FF9500]'
              }`}>
                {preset === 'conservative' && '5-8% APY'}
                {preset === 'balanced' && '10-15% APY'}
                {preset === 'aggressive' && '20-30% APY'}
              </div>
            </button>
          ))}
        </div>

        {/* Custom Fields */}
        <div className="space-y-4">
          <div>
            <label className="block text-[12px] sm:text-[13px] font-medium text-[#1d1d1f] mb-2 flex items-center gap-2">
              Portfolio Name
              <InfoTooltip content="Give your strategy a memorable name that describes its purpose" />
            </label>
            <input
              type="text"
              value={strategy.name}
              onChange={(e) => setStrategy({ ...strategy, name: e.target.value })}
              placeholder="e.g., Conservative DeFi Fund"
              className="w-full px-3 sm:px-4 py-2.5 sm:py-3 bg-[#f5f5f7] border border-black/5 rounded-[10px] text-[14px] sm:text-[15px] text-[#1d1d1f] placeholder:text-[#86868b] focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/20 focus:outline-none transition-all"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            <div>
              <label className="block text-[12px] sm:text-[13px] font-medium text-[#1d1d1f] mb-2 flex items-center gap-2">
                Target Yield (% APY)
                <InfoTooltip content={[
                  "Expected annual return - AI optimizes portfolio to hit this target",
                  "💡 Recommended ranges:",
                  "• Conservative: 5-8% APY (stable, low risk)",
                  "• Balanced: 10-15% APY (moderate risk/reward)",
                  "• Aggressive: 20-30% APY (high risk, high returns)"
                ]} />
              </label>
              <input
                type="number"
                value={strategy.targetYield / 100}
                onChange={(e) => setStrategy({ ...strategy, targetYield: Number(e.target.value) * 100 })}
                className="w-full px-3 sm:px-4 py-2.5 sm:py-3 bg-[#f5f5f7] border border-black/5 rounded-[10px] text-[14px] sm:text-[15px] text-[#1d1d1f] focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/20 focus:outline-none transition-all"
              />
            </div>

            <div>
              <label className="block text-[12px] sm:text-[13px] font-medium text-[#1d1d1f] mb-2 flex items-center gap-2">
                Risk Tolerance (0-100)
                <InfoTooltip content={[
                  "How much volatility you're comfortable with - Higher values = more aggressive trades",
                  "🛡️ Safe (0-30): Minimal risk, stable returns",
                  "⚖️ Moderate (30-70): Balanced risk/reward",
                  "🚀 Aggressive (70-100): Maximum growth potential",
                  "",
                  "💡 Impact: Risk Agent uses this threshold to calculate when to automatically trigger protective hedges"
                ]} />
              </label>
              <input
                type="range"
                min="0"
                max="100"
                value={strategy.riskTolerance}
                onChange={(e) => setStrategy({ ...strategy, riskTolerance: Number(e.target.value) })}
                className="w-full accent-[#007AFF]"
              />
              <div className={`text-center text-[13px] sm:text-[14px] font-semibold mt-1 ${
                strategy.riskTolerance < 30 ? 'text-[#34C759]' :
                strategy.riskTolerance < 70 ? 'text-[#FF9500]' :
                'text-[#FF3B30]'
              }`}>
                {strategy.riskTolerance}
              </div>
              <div className="mt-2 flex justify-between text-[10px] sm:text-[11px]">
                <span className="text-[#34C759]">🛡️ Safe</span>
                <span className="text-[#FF9500]">⚖️ Moderate</span>
                <span className="text-[#FF3B30]">🚀 Aggressive</span>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            <div>
              <label className="block text-[12px] sm:text-[13px] font-medium text-[#1d1d1f] mb-2 flex items-center gap-2">
                Max Drawdown (%)
                <InfoTooltip content={[
                  "Maximum portfolio loss before AI automatically opens protective hedges - Your safety net",
                  "",
                  `💡 Example: If set to ${strategy.maxDrawdown}%, and portfolio drops ${strategy.maxDrawdown}% from its peak value, the Hedging Agent immediately opens protective positions to limit further losses`,
                  "",
                  "Recommended: 10-15% (conservative), 20-30% (balanced), 35-50% (aggressive)"
                ]} />
              </label>
              <input
                type="number"
                value={strategy.maxDrawdown}
                onChange={(e) => setStrategy({ ...strategy, maxDrawdown: Number(e.target.value) })}
                className="w-full px-3 sm:px-4 py-2.5 sm:py-3 bg-[#f5f5f7] border border-black/5 rounded-[10px] text-[14px] sm:text-[15px] text-[#1d1d1f] focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/20 focus:outline-none transition-all"
              />
            </div>

            <div>
              <label className="block text-[12px] sm:text-[13px] font-medium text-[#1d1d1f] mb-2 flex items-center gap-2">
                Concentration Limit (%)
                <InfoTooltip content={[
                  "Maximum percentage of portfolio value that can be allocated to a single asset - Prevents over-exposure to any one token",
                  "",
                  `💡 Example: With ${strategy.concentrationLimit}% limit, no single token can exceed ${strategy.concentrationLimit}% of your total portfolio value`,
                  "",
                  "This ensures proper diversification and reduces risk from any single asset failure"
                ]} />
              </label>
              <input
                type="number"
                value={strategy.concentrationLimit}
                onChange={(e) => setStrategy({ ...strategy, concentrationLimit: Number(e.target.value) })}
                className="w-full px-3 sm:px-4 py-2.5 sm:py-3 bg-[#f5f5f7] border border-black/5 rounded-[10px] text-[14px] sm:text-[15px] text-[#1d1d1f] focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/20 focus:outline-none transition-all"
              />
            </div>
          </div>

          <div>
            <label className="block text-[12px] sm:text-[13px] font-medium text-[#1d1d1f] mb-2 flex items-center gap-2">
              Rebalance Frequency
              <InfoTooltip content={[
                "How often AI agents check and adjust your portfolio positions",
                "",
                "• Daily: Active management, best for volatile markets",
                "• Weekly: Balanced approach (recommended)",
                "• Monthly: Long-term strategy, lowest gas costs",
                "",
                "💡 Gas Impact: More frequent rebalancing = better optimization but higher transaction costs (mitigated by x402 gasless protocol)"
              ]} />
            </label>
            <select
              value={strategy.rebalanceFrequency}
              onChange={(e) => setStrategy({ ...strategy, rebalanceFrequency: e.target.value as 'daily' | 'weekly' | 'monthly' })}
              className="w-full px-3 sm:px-4 py-2.5 sm:py-3 bg-[#f5f5f7] border border-black/5 rounded-[10px] text-[14px] sm:text-[15px] text-[#1d1d1f] focus:border-[#007AFF] focus:ring-2 focus:ring-[#007AFF]/20 focus:outline-none transition-all cursor-pointer"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>

          <div className="bg-[#AF52DE]/5 border border-[#AF52DE]/20 rounded-[14px] p-4">
            <label className="flex items-center cursor-pointer group">
              <input
                type="checkbox"
                checked={strategy.hedgingEnabled}
                onChange={(e) => setStrategy({ ...strategy, hedgingEnabled: e.target.checked })}
                className="w-5 h-5 rounded-[6px] border-black/20 text-[#AF52DE] focus:ring-[#AF52DE]/50 flex-shrink-0 accent-[#AF52DE]"
              />
              <div className="ml-3 flex items-center gap-2">
                <Shield className="w-4 h-4 sm:w-5 sm:h-5 text-[#AF52DE]" />
                <span className="text-[13px] sm:text-[14px] font-semibold text-[#1d1d1f]">Enable AI hedging</span>
                <InfoTooltip content={[
                  "🛡️ Automatic Protection: Hedging Agent monitors portfolio 24/7 and opens protective positions when risks are detected",
                  "",
                  "🤖 Smart Execution: routes each hedge to the best available venue",
                  "",
                  "📊 Delphi Integration: Leverages prediction market data to anticipate and hedge against market events before they happen",
                  "",
                  "⚡ Gasless Trades: Powered by x402 protocol - zero gas fees for hedge transactions",
                  "",
                  "⚠️ Recommended: Keep enabled unless you prefer manual risk management"
                ]} />
              </div>
            </label>
          </div>

          {/* Auto-Approval Settings */}
          {strategy.hedgingEnabled && (
            <div className="bg-[#34C759]/5 border border-[#34C759]/20 rounded-[14px] p-4 space-y-4">
              <label className="flex items-center cursor-pointer group">
                <input
                  type="checkbox"
                  checked={strategy.autoApprovalEnabled}
                  onChange={(e) => setStrategy({ ...strategy, autoApprovalEnabled: e.target.checked })}
                  className="w-5 h-5 rounded-[6px] border-black/20 text-[#34C759] focus:ring-[#34C759]/50 flex-shrink-0 accent-[#34C759]"
                />
                <div className="ml-3 flex items-center gap-2">
                  <Sparkles className="w-4 h-4 sm:w-5 sm:h-5 text-[#34C759]" />
                  <span className="text-[13px] sm:text-[14px] font-semibold text-[#1d1d1f]">Enable Auto-Approval for AI Hedges</span>
                  <InfoTooltip content={[
                    "🤖 Autonomous Execution: AI can automatically execute hedges below threshold without waiting for your signature",
                    "",
                    "⚡ Faster Protection: Critical hedges execute instantly during volatile markets",
                    "",
                    "🔐 Still Secure: All transactions use x402 gasless protocol with on-chain verification",
                    "",
                    "📊 Transparency: All auto-approved hedges are logged and can be reviewed in your dashboard",
                    "",
                    "💡 Recommended: Enable for hands-off portfolio management"
                  ]} />
                </div>
              </label>

              {strategy.autoApprovalEnabled && (
                <div className="ml-8 space-y-2">
                  <label className="block text-[12px] sm:text-[13px] font-medium text-[#1d1d1f] flex items-center gap-2">
                    Auto-Approval Threshold (USD)
                    <InfoTooltip content={[
                      "Maximum hedge value that can be executed without your signature",
                      "",
                      "💡 Examples:",
                      `• Current: $${(strategy.autoApprovalThreshold / 1000).toFixed(0)}K - Hedges below this execute instantly`,
                      "",
                      "Recommended by strategy:",
                      "• Conservative: $5K (tight control)",
                      "• Balanced: $10K (standard)",
                      "• Aggressive: $25K (maximum autonomy)",
                      "",
                      "⚠️ Hedges above threshold will still require your signature"
                    ]} />
                  </label>
                  <div className="flex items-center gap-3">
                    <span className="text-[13px] sm:text-[14px] font-semibold text-[#34C759]">
                      ${(strategy.autoApprovalThreshold / 1000).toFixed(0)}K
                    </span>
                    <input
                      type="range"
                      min="1000"
                      max="50000"
                      step="1000"
                      value={strategy.autoApprovalThreshold}
                      onChange={(e) => setStrategy({ ...strategy, autoApprovalThreshold: Number(e.target.value) })}
                      className="flex-1 accent-[#34C759]"
                    />
                    <input
                      type="number"
                      min="1000"
                      max="50000"
                      step="1000"
                      value={strategy.autoApprovalThreshold}
                      onChange={(e) => setStrategy({ ...strategy, autoApprovalThreshold: Number(e.target.value) })}
                      className="w-24 px-3 py-1.5 bg-[#f5f5f7] border border-black/5 rounded-[8px] text-[13px] text-[#1d1d1f] focus:border-[#34C759] focus:ring-2 focus:ring-[#34C759]/20 focus:outline-none transition-all"
                    />
                  </div>
                  <div className="mt-2 flex justify-between text-[10px] sm:text-[11px] font-medium">
                    <span className="text-[#424245]">$1K (Min)</span>
                    <span className="text-[#424245]">$25K (Balanced)</span>
                    <span className="text-[#424245]">$50K (Max)</span>
                  </div>
                  
                  <div className="mt-3 p-3 bg-[#34C759]/10 rounded-[10px] border border-[#34C759]/20">
                    <div className="flex items-start gap-2 text-[11px] sm:text-[12px] text-[#1d1d1f]">
                      <CheckCircle className="w-4 h-4 text-[#34C759] flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-semibold text-[#1d1d1f]">Auto-Approval Active</p>
                        <p className="text-[#424245] mt-1 font-medium">
                          Hedges <strong className="text-[#1d1d1f]">≤ ${(strategy.autoApprovalThreshold / 1000).toFixed(0)}K</strong> execute instantly. 
                          Hedges <strong className="text-[#1d1d1f]">&gt; ${(strategy.autoApprovalThreshold / 1000).toFixed(0)}K</strong> require signature.
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <button
        onClick={onNext}
        disabled={!strategy.name}
        className="w-full px-6 py-3 sm:py-3.5 bg-[#007AFF] hover:bg-[#0051D5] active:scale-[0.98] disabled:bg-[#86868b] disabled:cursor-not-allowed rounded-[12px] font-semibold text-[15px] text-white transition-all"
      >
        Next: Set Filters
      </button>
    </div>
  );
}
