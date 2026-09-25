import { Shield } from 'lucide-react';

interface EmptyHedgesStateProps {
  onCreateHedge?: () => void;
  onOpenChat?: () => void;
}

export function EmptyHedgesState({ onCreateHedge, onOpenChat }: EmptyHedgesStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-6">
      <div className="w-12 h-12 sm:w-14 sm:h-14 bg-[#f5f5f7] rounded-[14px] sm:rounded-[16px] flex items-center justify-center mb-3 sm:mb-4">
        <Shield className="w-6 h-6 sm:w-7 sm:h-7 text-[#007AFF]" strokeWidth={2} />
      </div>
      <h3 className="text-[15px] sm:text-[17px] font-semibold text-[#1d1d1f] mb-1.5 sm:mb-2 tracking-[-0.01em]">
        No Active Hedges
      </h3>
      <p className="text-[13px] sm:text-[14px] text-[#86868b] leading-[1.4] max-w-[240px] mb-3 sm:mb-4">
        Create manual hedges or wait for AI recommendations to protect your portfolio
      </p>
      <button
        onClick={() => onCreateHedge?.()}
        className="mb-3 px-4 py-2 bg-[#007AFF] text-white rounded-[12px] text-[13px] sm:text-[14px] font-semibold hover:opacity-90 active:scale-[0.98] transition-all flex items-center gap-2"
      >
        <Shield className="w-4 h-4" />
        Create Manual Hedge
      </button>
      <div className="flex items-center gap-2 text-[12px] sm:text-[13px] text-[#86868b]">
        <button
          onClick={() => onOpenChat?.()}
          className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 bg-[#007AFF]/10 hover:bg-[#007AFF]/20 rounded-full transition-colors cursor-pointer"
        >
          <span>💬</span>
          <span className="font-medium text-[#007AFF]">Chat with AI</span>
        </button>
        <span className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 bg-[#34C759]/10 rounded-full">
          <Shield className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-[#34C759]" />
          <span className="font-medium text-[#34C759]">Auto-protect</span>
        </span>
      </div>
    </div>
  );
}
