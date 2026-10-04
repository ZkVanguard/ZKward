'use client';

/**
 * A live read of the market in one chip, on every dashboard page: which way
 * the signal stack leans overall, and a small arrow per coin. Tapping it
 * opens Signals. Same query key as the market board and the homepage strip,
 * so it costs no extra request. Hidden if the read fails; never a made-up lean.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { fetchPerAssetSignals } from '@/lib/api/market-signals';

export function MarketPulse({ onOpen, compact = false }: { onOpen: () => void; compact?: boolean }) {
  const t = useTranslations('dashboard');
  const { data, isPending, isError } = useQuery({
    queryKey: ['per-asset-signals'],
    queryFn: () => fetchPerAssetSignals(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  // A failed refresh keeps the last good read; hide only when nothing ever loaded.
  if (isError && !data) return null;
  if (isPending || !data) {
    return <span className={`inline-block rounded-full bg-white/70 border border-black/5 animate-pulse ${compact ? 'h-8 w-24' : 'h-10 w-64'}`} aria-hidden />;
  }

  const entries = Object.entries(data);
  const ups = entries.filter(([, s]) => s.direction === 'UP').length;
  const downs = entries.filter(([, s]) => s.direction === 'DOWN').length;
  const lean = ups > downs ? 'up' : downs > ups ? 'down' : 'mixed';
  const label = t(`marketBoard.overall.${lean}`);
  const tone = lean === 'up' ? 'text-green-700' : lean === 'down' ? 'text-red-700' : 'text-label-secondary';
  const dot = lean === 'up' ? 'bg-green-600' : lean === 'down' ? 'bg-red-600' : 'bg-label-tertiary';

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('pulse.aria', { lean: label })}
      className={`group inline-flex items-center gap-2.5 rounded-full bg-white/80 backdrop-blur border border-black/[0.06] shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-ios-blue/30 hover:shadow-[0_4px_14px_-6px_rgba(0,105,217,0.25)] transition-all ${compact ? 'h-8 pl-2.5 pr-3' : 'h-10 pl-3.5 pr-2'}`}
    >
      <span className="relative flex h-2 w-2 flex-shrink-0">
        <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping ${dot}`} />
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      <span className={`text-[13px] font-semibold whitespace-nowrap ${tone}`}>{label}</span>
      {!compact && (
        <span className="hidden md:flex items-center gap-1 pl-2 border-l border-black/[0.06]">
          {entries.map(([coin, s]) => {
            const Icon = s.direction === 'UP' ? ArrowUpRight : s.direction === 'DOWN' ? ArrowDownRight : Minus;
            const c = s.direction === 'UP' ? 'text-green-700 bg-green-700/10' : s.direction === 'DOWN' ? 'text-red-700 bg-red-700/10' : 'text-label-tertiary bg-label-primary/[0.05]';
            return (
              <span key={coin} className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${c}`} title={`${coin} ${s.confidence}%`}>
                {coin}
                <Icon className="w-3 h-3" strokeWidth={2.5} />
              </span>
            );
          })}
        </span>
      )}
    </button>
  );
}
