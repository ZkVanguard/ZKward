import { Wallet, Sparkles } from 'lucide-react';
import { ConnectPromptButton } from '@/components/ui/ConnectPromptButton';
import { ChainSupportNote } from '@/components/wallet/ChainBadge';

export function NotConnectedState() {
  return (
    <div className="bg-white rounded-[20px] shadow-sm border border-black/5 p-12 text-center">
      <div className="w-20 h-20 bg-[#f5f5f7] rounded-[22px] flex items-center justify-center mx-auto mb-5">
        <Wallet className="w-10 h-10 text-[#86868b]" />
      </div>
      <h3 className="text-[22px] font-semibold text-[#1d1d1f] mb-2 tracking-[-0.02em]">
        Connect a wallet
      </h3>
      <p className="text-[15px] text-[#86868b] max-w-[280px] mx-auto mb-6">
        Your token positions and strategies appear once a wallet is connected
      </p>

<ChainSupportNote supports={['hedera', 'sui']} className="mb-4" />
      <ConnectPromptButton reason="Sign in on Hedera or connect a SUI wallet to see your positions." />

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
