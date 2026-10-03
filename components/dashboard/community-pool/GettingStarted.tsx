'use client';

/**
 * The pool page's answer to "what do I do here?": three steps to a first
 * deposit, with the current one highlighted and one button for it. Step one
 * ticks itself when this pool's network is connected; the guide goes away
 * once the wallet holds shares, or when the visitor hides it (per device).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, X } from 'lucide-react';
import { CHAIN_META, type WalletChain } from '@/lib/wallet/chain-meta';
import { useWalletHubSafe } from '@/contexts/WalletHubContext';
import { ChainLogo } from '@/components/wallet/ChainLogo';

const HIDDEN_KEY = 'zkward.guide.hidden';

export function GettingStarted({ chain, isMember, onShowActions }: { chain: WalletChain; isMember: boolean; onShowActions: () => void }) {
  const t = useTranslations('dashboard.guide');
  const tw = useTranslations('wallet.chains');
  const hub = useWalletHubSafe();
  const [hidden, setHidden] = useState(true);
  useEffect(() => {
    try {
      setHidden(localStorage.getItem(HIDDEN_KEY) === '1');
    } catch {
      setHidden(false);
    }
  }, []);
  if (hidden || isMember) return null;

  const meta = CHAIN_META[chain];
  const connected = !!hub?.isConnected && hub.activeChain === chain;
  const steps = [
    {
      title: t('connect.title', { chain: meta.name }),
      body: tw(`${chain}.how`),
      done: connected,
      action: !connected ? { label: t('connect.action'), run: () => hub?.openChooser({ chain }) } : null,
    },
    {
      title: meta.realFunds ? t('funds.realTitle') : t('funds.testTitle'),
      body: meta.realFunds ? t('funds.realBody') : t('funds.testBody'),
      done: false,
      action: connected ? { label: t('funds.action'), run: onShowActions } : null,
    },
    {
      title: t('deposit.title'),
      body: t('deposit.body'),
      done: false,
      action: connected ? { label: t('deposit.action'), run: onShowActions } : null,
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;

  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDDEN_KEY, '1');
    } catch {
      /* per-device convenience only */
    }
  };

  return (
    <div className="mx-3 sm:mx-6 mt-4 rounded-2xl border border-ios-blue/15 bg-gradient-to-br from-ios-blue/[0.05] via-white to-white p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className="w-10 h-10 rounded-2xl bg-white border border-black/[0.06] shadow-sm flex items-center justify-center flex-shrink-0">
            <ChainLogo chain={chain} size={22} />
          </span>
          <div className="min-w-0">
            <h3 className="text-[16px] font-semibold text-label-primary tracking-[-0.01em]">{t('title')}</h3>
            <p className="text-[13px] text-label-secondary">{t('subtitle')}</p>
          </div>
        </div>
        <button type="button" onClick={hide} aria-label={t('hide')} title={t('hide')} className="p-1.5 -m-1 rounded-full text-label-tertiary hover:bg-black/5">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="mb-4 h-1.5 rounded-full bg-black/[0.06] overflow-hidden" aria-hidden>
        <div className="h-full rounded-full bg-ios-blue transition-all duration-500" style={{ width: `${Math.max(6, (doneCount / steps.length) * 100)}%` }} />
      </div>

      <ol className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        {steps.map((s, i) => {
          const isCurrent = i === current;
          return (
            <li
              key={i}
              className={`rounded-xl p-3.5 border transition-colors ${
                s.done ? 'border-[#34C759]/30 bg-[#34C759]/[0.06]' : isCurrent ? 'border-ios-blue/40 bg-white shadow-[0_6px_18px_-10px_rgba(0,105,217,0.45)]' : 'border-black/[0.06] bg-white/70'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[12px] font-bold flex-shrink-0 ${s.done ? 'bg-[#34C759] text-white' : isCurrent ? 'bg-ios-blue text-white' : 'bg-black/[0.06] text-label-secondary'}`}>
                  {s.done ? <Check className="w-3.5 h-3.5" strokeWidth={3} /> : i + 1}
                </span>
                <span className="text-[14px] font-semibold text-label-primary">{s.title}</span>
              </div>
              <p className="text-[12px] leading-snug text-label-secondary">{s.done ? t('done') : s.body}</p>
              {s.action && !s.done && (
                <button
                  type="button"
                  onClick={s.action.run}
                  className={`mt-3 inline-flex h-9 items-center rounded-xl px-3.5 text-[13px] font-semibold active:scale-[0.98] transition-all ${isCurrent ? 'bg-ios-blue text-white hover:bg-ios-blueHover' : 'bg-ios-blue/10 text-ios-blue hover:bg-ios-blue/15'}`}
                >
                  {s.action.label}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
