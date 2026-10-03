'use client';

/**
 * Portfolio without a wallet: one welcome with one action, instead of three
 * cards that each asked to connect. A Solana wallet is pointed at the Pool
 * page, where its position lives (Portfolio covers SUI and Hedera).
 */

import { useTranslations } from 'next-intl';
import { ArrowRight, Wallet } from 'lucide-react';
import { useWalletHubSafe } from '@/contexts/WalletHubContext';
import { ChainLogo } from '@/components/wallet/ChainLogo';

export function ConnectHero({ onGoPool, onGoSignals }: { onGoPool: () => void; onGoSignals: () => void }) {
  const t = useTranslations('dashboard.connectHero');
  const hub = useWalletHubSafe();
  const onSolana = hub?.isConnected && hub.activeChain === 'solana';

  return (
    <section className="relative overflow-hidden rounded-3xl border border-black/[0.06] bg-white px-6 py-10 sm:px-12 sm:py-14 text-center shadow-[0_1px_2px_rgba(15,23,42,0.04),0_18px_40px_-24px_rgba(15,23,42,0.18)]">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(50% 60% at 50% 0%, rgba(0,105,217,0.08) 0%, transparent 70%)' }}
      />
      <div className="relative">
        <div className="mx-auto mb-6 flex w-fit items-center">
          {(onSolana ? (['solana'] as const) : (['sui', 'hedera', 'solana'] as const)).map((c, i) => (
            <span
              key={c}
              className={`flex h-14 w-14 items-center justify-center rounded-2xl bg-white border border-black/[0.06] shadow-[0_6px_16px_-8px_rgba(15,23,42,0.25)] ${i > 0 ? '-ml-3' : ''}`}
              style={{ transform: `rotate(${(i - 1) * 6}deg)` }}
            >
              <ChainLogo chain={c} size={28} />
            </span>
          ))}
        </div>
        <h2 className="text-[26px] sm:text-[32px] font-display font-semibold tracking-[-0.03em] text-label-primary">
          {onSolana ? t('solanaTitle') : t('title')}
        </h2>
        <p className="mx-auto mt-2 max-w-[440px] text-[15px] text-label-secondary">{onSolana ? t('solanaBody') : t('body')}</p>
        <div className="mt-7 flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            type="button"
            onClick={onSolana ? onGoPool : () => hub?.openChooser()}
            className="inline-flex h-12 w-full sm:w-auto items-center justify-center gap-2 rounded-2xl bg-ios-blue px-6 text-[15px] font-semibold text-white shadow-[0_8px_20px_-8px_rgba(0,105,217,0.55)] hover:bg-ios-blueHover active:scale-[0.98] transition-all"
          >
            {onSolana ? <ArrowRight className="w-4 h-4" /> : <Wallet className="w-4 h-4" />}
            {onSolana ? t('openPool') : t('cta')}
          </button>
          {!onSolana && (
            <div className="flex items-center gap-4 text-[14px] font-medium">
              <button type="button" onClick={onGoPool} className="text-ios-blue hover:underline">{t('pools')}</button>
              <span className="h-4 w-px bg-black/10" />
              <button type="button" onClick={onGoSignals} className="text-ios-blue hover:underline">{t('signals')}</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
