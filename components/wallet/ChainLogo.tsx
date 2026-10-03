'use client';

/**
 * A network's official mark, and whether money on it is real. Every place
 * that names a network (top bar, sidebar, chooser, pool tabs, badges) draws
 * it from here so a visitor recognises the network before reading its name.
 * Files are the networks' own published marks under public/logos/chains/.
 */

import Image from 'next/image';
import { FlaskConical } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CHAIN_INFO, type WalletChain } from '@/contexts/WalletHubContext';

export type LogoChain = WalletChain | 'paper';

export function ChainLogo({ chain, size = 20, className = '', label }: { chain: LogoChain; size?: number; className?: string; label?: string }) {
  if (chain === 'paper') {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-full bg-amber-100 text-amber-800 flex-shrink-0 ${className}`}
        style={{ width: size, height: size }}
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : true}
      >
        <FlaskConical style={{ width: size * 0.6, height: size * 0.6 }} strokeWidth={2.25} />
      </span>
    );
  }
  return (
    <Image
      src={CHAIN_INFO[chain].logo}
      alt={label ?? ''}
      width={size}
      height={size}
      unoptimized
      className={`flex-shrink-0 object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}

/** "Real funds" on mainnet, "Test tokens" elsewhere, "Simulated" for the paper books. */
export function FundsTag({ chain, className = '' }: { chain: LogoChain; className?: string }) {
  const t = useTranslations('wallet.funds');
  const kind = chain === 'paper' ? 'simulated' : CHAIN_INFO[chain].realFunds ? 'real' : 'test';
  const tone =
    kind === 'real'
      ? 'bg-green-700/10 text-green-800'
      : kind === 'test'
        ? 'bg-amber-500/15 text-amber-800'
        : 'bg-label-primary/[0.06] text-label-secondary';
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${tone} ${className}`}>
      {t(kind)}
    </span>
  );
}
