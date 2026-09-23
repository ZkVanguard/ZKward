'use client';

import React, { memo } from 'react';
import { Users, RefreshCw, Brain, Globe, Loader2 } from 'lucide-react';
import { POOL_CHAIN_CONFIGS } from '@/lib/contracts/community-pool-config';
import type { ChainKey } from './types';

interface PoolHeaderProps {
  selectedChain: ChainKey;
  onChainSelect: (key: ChainKey) => void;
  onRefresh?: () => void;
  onAIClick?: () => void;
  chainName?: string;
  network?: string;
  poolDeployed?: boolean;
  isLoading?: boolean;
}

// Mobile-first PoolHeader: title stacks above the action row on ≤ 640px so
// nothing overflows on narrow screens. Buttons collapse to icon-only on
// mobile so 3 controls (chain / refresh / AI) fit alongside the title.
export const PoolHeader = memo(function PoolHeader({
  selectedChain,
  onChainSelect,
  onRefresh,
  onAIClick,
  chainName,
  network,
  poolDeployed,
  isLoading,
}: PoolHeaderProps) {
  // Removed the purple→pink gradient banner (a-cross-with-homepage
  // aesthetic). The parent Card already displays "Community Pool" as
  // its title, so this header is now an action row only. Chain
  // selector + refresh + AI insights, sitting on the same white
  // canvas as the rest of the dashboard. Network + chain info moves
  // into a subtle status pill below.
  return (
    <div className="px-3 sm:px-6 py-3 border-b border-black/5 flex flex-wrap items-center justify-between gap-3">
      {/* Left: chain + network status pill */}
      {chainName && network ? (
        <div className="flex items-center gap-2 text-[12px] sm:text-caption-1 text-label-tertiary tabular-nums">
          <Globe className="w-3.5 h-3.5" />
          <span className="truncate">
            {chainName} · {network === 'mainnet' ? 'Mainnet' : 'Testnet'}
          </span>
          {poolDeployed === false && (
            <span className="text-ios-orange font-medium">· Not Deployed</span>
          )}
        </div>
      ) : (
        <div />
      )}

      {/* Right: action row */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Chain selector — SUI (live USDC pool) + Hedera (EVM testnet pool).
            Both share the same CommunityPool contract shape; picker just swaps
            the RPC + address the fetcher hits. */}
        <div className="flex items-center gap-2 bg-system-bg-grouped border border-separator-opaque/30 rounded-full px-2 py-1">
          {(['sui', 'hedera', 'paper'] as const)
            .map((key) => [key, POOL_CHAIN_CONFIGS[key]] as const)
            .filter(([, config]) => config && (config.status === 'live' || config.status === 'testing'))
            .map(([key, config]) => (
              <button
                key={key}
                onClick={() => onChainSelect(key as ChainKey)}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[12px] font-semibold transition-all ${
                  selectedChain === key
                    ? 'bg-white text-label-primary shadow-ios-1'
                    : 'text-label-tertiary hover:text-label-primary'
                }`}
                title={`${config.name} · ${config.status === 'testing' ? 'testnet' : 'mainnet'}`}
              >
                <span>{config.icon}</span>
                <span>{config.shortName}</span>
              </button>
            ))}
        </div>
        {isLoading ? (
          <div className="p-2">
            <Loader2 className="w-4 h-4 text-label-tertiary animate-spin" />
          </div>
        ) : (
          <>
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="p-2 rounded-full hover:bg-system-bg-grouped text-label-tertiary hover:text-label-primary active:scale-[0.96] transition-all"
                title="Refresh"
                aria-label="Refresh"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            )}
            {onAIClick && (
              <button
                onClick={onAIClick}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] sm:text-caption-1 font-semibold text-ios-blue bg-ios-blue/10 hover:bg-ios-blue/15 active:scale-[0.98] transition-all"
                aria-label="AI Insights"
              >
                <Brain className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">AI Insights</span>
                <span className="sm:hidden">AI</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});
