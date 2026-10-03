'use client';

import React, { memo } from 'react';
import { RefreshCw, Brain, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { POOL_CHAIN_CONFIGS } from '@/lib/contracts/community-pool-config';
import { CHAIN_INFO, useWalletHubSafe, type WalletChain } from '@/contexts/WalletHubContext';
import { ChainLogo, FundsTag, type LogoChain } from '@/components/wallet/ChainLogo';
import type { ChainKey } from './types';

// The four pools the selector offers, in order. Each is a network with its
// own mark; Paper is the simulated book.
const POOL_TABS = ['sui', 'hedera', 'solana', 'paper'] as const satisfies readonly LogoChain[];
const isWalletChain = (k: string): k is WalletChain => k === 'sui' || k === 'hedera' || k === 'solana';

interface PoolHeaderProps {
  selectedChain: ChainKey;
  onChainSelect: (key: ChainKey) => void;
  onRefresh?: () => void;
  onAIClick?: () => void;
  chainName?: string;
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
  poolDeployed,
  isLoading,
}: PoolHeaderProps) {
  // Removed the purple→pink gradient banner (a-cross-with-homepage
  // aesthetic). The parent Card already displays "Community Pool" as
  // its title, so this header is now an action row only. Chain
  // selector + refresh + AI insights, sitting on the same white
  // canvas as the rest of the dashboard. Network + chain info moves
  // into a subtle status pill below.
  const t = useTranslations('wallet');
  const hub = useWalletHubSafe();
  const tab: LogoChain | null = (POOL_TABS as readonly string[]).includes(selectedChain) ? (selectedChain as LogoChain) : null;
  // The tier comes from the network itself: Solana's pool is on devnet and Paper is simulated, neither is "testnet".
  // Paper's tag already says Simulated; a second label would repeat it.
  const netLabel = tab && tab !== 'paper' ? t(`net.${CHAIN_INFO[tab].net}`) : null;
  // Viewing one network's pool while connected to another: say so, with the switch one tap away.
  const elsewhere = hub?.isConnected && hub.activeChain && tab && isWalletChain(tab) && tab !== hub.activeChain ? tab : null;
  return (
    <div className="border-b border-black/5">
    <div className="px-3 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
      {/* Left: the pool's network, its tier and whether its money is real */}
      {chainName && tab ? (
        <div className="flex items-center gap-2 text-[12px] sm:text-caption-1 text-label-tertiary tabular-nums min-w-0">
          <ChainLogo chain={tab} size={16} />
          <span className="truncate text-label-secondary font-medium">
            {netLabel ? `${chainName} · ${netLabel}` : chainName}
          </span>
          <FundsTag chain={tab} />
          {poolDeployed === false && (
            <span className="text-ios-orange font-medium">· Not Deployed</span>
          )}
        </div>
      ) : (
        <div />
      )}

      {/* Right: action row */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Pool selector — SUI (live USDC pool) + Hedera (EVM testnet pool)
            share the CommunityPool contract shape; Solana (token pool) and
            Paper (shadow book) are virtual entries CommunityPool renders
            with their own panels. */}
        <div className="flex items-center gap-2 bg-system-bg-grouped border border-separator-opaque/30 rounded-full px-2 py-1">
          {POOL_TABS
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
                title={`${config.name} · ${key === 'paper' ? t('net.simulated') : t(`net.${CHAIN_INFO[key].net}`)}`}
              >
                {/* The mark from sm up: four pills + refresh + AI must fit a 390px row. */}
                <ChainLogo chain={key} size={14} className="hidden sm:inline-block" />
                <span>{key === 'paper' ? t('paper') : CHAIN_INFO[key].name}</span>
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
    {elsewhere && hub?.activeChain && (
      <div className="mx-3 sm:mx-6 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-[12px] text-amber-900">
        <ChainLogo chain={hub.activeChain} size={14} />
        <span className="flex-1 min-w-[180px]">
          {t('elsewhere', { active: CHAIN_INFO[hub.activeChain].name, pool: CHAIN_INFO[elsewhere].name })}
        </span>
        <button
          type="button"
          onClick={() => hub.openChooser({ chain: elsewhere })}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-1 font-semibold text-label-primary shadow-sm active:scale-[0.98]"
        >
          <ChainLogo chain={elsewhere} size={14} />
          {t('chooser.switchTo', { chain: CHAIN_INFO[elsewhere].name })}
        </button>
      </div>
    )}
    </div>
  );
});
