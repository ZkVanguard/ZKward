'use client';

/**
 * The top of every dashboard page: a greeting, the page, one plain line on
 * what it is for, the network you are on, and the market pulse. Behind it a
 * soft glow in the active network's colours, so the dashboard looks like the
 * network you chose rather than a generic grey canvas.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CHAIN_META } from '@/lib/wallet/chain-meta';
import { useWalletHubSafe } from '@/contexts/WalletHubContext';
import { ChainLogo, FundsTag } from '@/components/wallet/ChainLogo';
import { MarketPulse } from './MarketPulse';

export type DashDest = 'pool' | 'portfolio' | 'signals' | 'platform' | 'account';

// Glow colours per network: SUI blue, Solana's purple-to-green, Hedera slate.
const AMBIENT: Record<'sui' | 'solana' | 'hedera' | 'none', [string, string]> = {
  sui: ['rgba(77,162,255,0.22)', 'rgba(41,141,255,0.10)'],
  solana: ['rgba(153,69,255,0.18)', 'rgba(20,241,149,0.12)'],
  hedera: ['rgba(71,85,105,0.16)', 'rgba(0,167,159,0.08)'],
  none: ['rgba(0,105,217,0.12)', 'rgba(90,200,250,0.08)'],
};

/** The glow layer; the parent must be `relative`. */
export function ChainAmbient() {
  const hub = useWalletHubSafe();
  const [a, b] = AMBIENT[hub?.activeChain ?? 'none'];
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[420px] transition-[background] duration-700"
      style={{
        background: `radial-gradient(60% 70% at 12% 0%, ${a} 0%, transparent 70%), radial-gradient(50% 60% at 88% 0%, ${b} 0%, transparent 70%)`,
      }}
    />
  );
}

function greetingKey(h: number) {
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

export function DashboardHeader({ dest, onOpenSignals }: { dest: DashDest; onOpenSignals: () => void }) {
  const t = useTranslations('dashboard');
  const hub = useWalletHubSafe();
  // Set after mount: the server does not know the visitor's clock.
  const [greeting, setGreeting] = useState<string | null>(null);
  useEffect(() => setGreeting(greetingKey(new Date().getHours())), []);
  const chain = hub?.isConnected ? hub.activeChain : null;

  return (
    <div className="relative mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <p className="h-5 text-[13px] font-medium text-label-tertiary">
          {greeting ? t(`shell.greeting.${greeting}`) : ''}
        </p>
        <h1 className="text-large-title font-display text-label-primary tracking-[-0.03em]">{t(`nav.${dest}`)}</h1>
        <p className="mt-1 text-[15px] text-label-secondary">{t(`shell.subtitle.${dest}`)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {chain && (
          <button
            type="button"
            onClick={() => hub?.openChooser()}
            className="inline-flex h-10 items-center gap-2 rounded-full bg-white/80 backdrop-blur border border-black/[0.06] pl-1.5 pr-3 shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-ios-blue/30 transition-colors"
            title={t('shell.switchNetwork')}
          >
            <span className="w-7 h-7 rounded-full bg-[#f5f5f7] inline-flex items-center justify-center">
              <ChainLogo chain={chain} size={16} />
            </span>
            <span className="text-[13px] font-semibold text-label-primary">{CHAIN_META[chain].name}</span>
            <FundsTag chain={chain} />
          </button>
        )}
        {/* Signals shows the full market board; the pulse would repeat it. */}
        {dest !== 'signals' && <MarketPulse onOpen={onOpenSignals} />}
      </div>
    </div>
  );
}
