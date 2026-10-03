'use client';

/**
 * The phone header's answer to "which network am I on?". The desktop top bar
 * and sidebar already name it; on a phone both live behind the menu, so the
 * network was invisible. Tapping opens the chooser. Renders nothing outside
 * the dashboard (no wallet hub there).
 */

import { Wallet } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CHAIN_INFO, useWalletHubSafe } from '@/contexts/WalletHubContext';
import { ChainLogo } from '@/components/wallet/ChainLogo';

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

export function ActiveChainPill({ className = '' }: { className?: string }) {
  const hub = useWalletHubSafe();
  const t = useTranslations('wallet');
  if (!hub) return null;
  const chain = hub.activeChain;
  const address = hub.active?.address ?? null;
  const label = chain
    ? t('pill.on', { chain: CHAIN_INFO[chain].name, net: t(`net.${CHAIN_INFO[chain].net}`) })
    : t('pill.connect');

  return (
    <button
      type="button"
      onClick={() => hub.openChooser()}
      aria-label={label}
      title={label}
      className={`h-9 inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white pl-1.5 pr-3 text-[13px] font-medium text-label-primary active:scale-[0.97] transition-transform ${className}`}
    >
      {chain ? (
        <>
          <span className="w-6 h-6 rounded-full bg-[#f5f5f7] inline-flex items-center justify-center">
            <ChainLogo chain={chain} size={15} />
          </span>
          <span className="tabular-nums">{address ? short(address) : CHAIN_INFO[chain].name}</span>
          {!address && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden />}
        </>
      ) : (
        <>
          <span className="w-6 h-6 rounded-full bg-ios-blue/10 text-ios-blue inline-flex items-center justify-center">
            <Wallet className="w-3.5 h-3.5" />
          </span>
          {t('pill.connect')}
        </>
      )}
    </button>
  );
}
