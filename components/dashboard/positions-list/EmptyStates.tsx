import { Wallet, Sparkles, Plus, Target, Shield, Zap, BarChart2 } from 'lucide-react';
import { ConnectPromptButton } from '@/components/ui/ConnectPromptButton';
import { AdvancedPortfolioCreator } from '../AdvancedPortfolioCreator';

export function NotConnectedState() {
  return (
    <div className="bg-white rounded-[20px] shadow-sm border border-black/5 p-12 text-center">
      <div className="w-20 h-20 bg-[#f5f5f7] rounded-[22px] flex items-center justify-center mx-auto mb-5">
        <Wallet className="w-10 h-10 text-[#86868b]" />
      </div>
      <h3 className="text-[22px] font-semibold text-[#1d1d1f] mb-2 tracking-[-0.02em]">
        Connect Your Wallet
      </h3>
      <p className="text-[15px] text-[#86868b] max-w-[280px] mx-auto mb-6">
        Connect your wallet to view your token positions and portfolio strategies
      </p>

      <ConnectPromptButton />

      {/* AI Assistant CTA - available even without wallet */}
      <div className="mt-6 pt-6 border-t border-[#e8e8ed]">
        <div className="flex items-center justify-center gap-2 text-[#007AFF] mb-3">
          <Sparkles className="w-5 h-5" />
          <span className="text-[15px] font-semibold">AI Portfolio Assistant Available</span>
        </div>
        <p className="text-[13px] text-[#86868b] max-w-[320px] mx-auto">
          While you connect, feel free to chat with our AI assistant to learn about portfolio
          strategies and DeFi concepts
        </p>
      </div>
    </div>
  );
}

interface NoPortfoliosEmptyStateProps {
  positionsCount: number;
  totalValue: number;
}

export function NoPortfoliosEmptyState({ positionsCount, totalValue }: NoPortfoliosEmptyStateProps) {
  return (
    <div className="bg-gradient-to-br from-white to-[#f5f5f7] rounded-2xl shadow-sm border border-black/5 p-6 sm:p-8">
      <div className="max-w-lg mx-auto text-center">
        {/* Icon */}
        <div className="w-16 h-16 bg-gradient-to-br from-[#007AFF] to-[#AF52DE] rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg">
          <Plus className="w-8 h-8 text-white" />
        </div>

        {/* Title */}
        <h3 className="text-[22px] font-bold text-[#1d1d1f] mb-2 tracking-[-0.02em]">
          Create Your First Portfolio
        </h3>

        {/* Description - Context-aware */}
        <p className="text-[15px] text-[#86868b] mb-6 leading-relaxed">
          {positionsCount > 0 && totalValue > 0
            ? `You have $${totalValue.toFixed(2)} in wallet balances. Create an AI-managed portfolio to optimize your holdings with automated hedging and yield strategies.`
            : 'Start building your AI-managed portfolio with custom risk settings, automated hedging, and ZK-protected strategies.'}
        </p>

        {/* Features Grid */}
        <div className="grid grid-cols-2 gap-3 mb-6 text-left">
          <div className="flex items-start gap-3 p-3 bg-white rounded-xl border border-black/5">
            <Target className="w-5 h-5 text-[#007AFF] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[13px] font-semibold text-[#1d1d1f]">AI Strategy</p>
              <p className="text-[11px] text-[#86868b]">Optimized allocation</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-white rounded-xl border border-black/5">
            <Shield className="w-5 h-5 text-[#34C759] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[13px] font-semibold text-[#1d1d1f]">Auto Hedging</p>
              <p className="text-[11px] text-[#86868b]">Risk protection</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-white rounded-xl border border-black/5">
            <Zap className="w-5 h-5 text-[#FF9500] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[13px] font-semibold text-[#1d1d1f]">Yield Farming</p>
              <p className="text-[11px] text-[#86868b]">Maximize returns</p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 bg-white rounded-xl border border-black/5">
            <BarChart2 className="w-5 h-5 text-[#AF52DE] flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-[13px] font-semibold text-[#1d1d1f]">Analytics</p>
              <p className="text-[11px] text-[#86868b]">Real-time insights</p>
            </div>
          </div>
        </div>

        {/* CTA - Create Portfolio Button */}
        <div className="flex flex-col items-center gap-3">
          <AdvancedPortfolioCreator />
          <p className="text-[12px] text-[#86868b]">
            Or ask the AI Assistant for help getting started
          </p>
        </div>
      </div>
    </div>
  );
}
