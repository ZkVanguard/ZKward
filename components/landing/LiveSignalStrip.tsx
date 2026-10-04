'use client';

/**
 * The hero's live element: where each coin leans right now, straight from
 * the signal stack (/api/predictions/per-asset, cached at the CDN). An arrow
 * and a number say it without a sentence; each chip opens the signals view.
 * While loading it shows chip-shaped placeholders; if the first read fails the
 * strip stays out of the way rather than showing made-up values.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';
import { Link } from '@/i18n/routing';
import { fetchPerAssetSignals } from '@/lib/api/market-signals';

export function LiveSignalStrip() {
  const t = useTranslations('landing.signals');
  // Same key as the dashboard's signal hook, so opening the app reuses this read.
  const { data, isPending, isError } = useQuery({
    queryKey: ['per-asset-signals'],
    // The strip is a teaser, not the product: if the signal service does not
    // answer within 8 s it steps aside instead of showing empty pills (the
    // endpoint takes ~20 s to fail when its backend is down). No retry.
    queryFn: () => fetchPerAssetSignals(AbortSignal.timeout(8_000)),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
  // A refresh that fails keeps the last good chips on screen; the strip
  // stays out of the way only when nothing has ever loaded. Hiding on any
  // failed refresh made it appear, then vanish.
  if (isError && !data) return null;
  const entries = data ? Object.entries(data) : [];

  return (
    <div className="mb-12 sm:mb-14">
      <p className="flex items-center justify-center gap-2 text-[11px] sm:text-caption-1 font-semibold uppercase tracking-[0.14em] text-label-tertiary mb-3 sm:mb-4">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full rounded-full bg-ios-blue opacity-60 animate-ping" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-ios-blue" />
        </span>
        {t('label')}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        {isPending
          ? [0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="h-11 w-[104px] rounded-full bg-white/70 border border-separator-opaque/40 animate-pulse" aria-hidden />
            ))
          : entries.map(([coin, s]) => {
              const lean = s.direction === 'UP' ? 'up' : s.direction === 'DOWN' ? 'down' : 'none';
              const Icon = lean === 'up' ? ArrowUpRight : lean === 'down' ? ArrowDownRight : Minus;
              const tone = lean === 'up' ? 'text-green-700 bg-green-700/10' : lean === 'down' ? 'text-red-700 bg-red-700/10' : 'text-label-secondary bg-label-primary/[0.06]';
              return (
                <Link
                  key={coin}
                  href="/dashboard?tab=signals"
                  aria-label={t('chip', { coin, lean: t(lean), pct: s.confidence })}
                  className="group inline-flex items-center gap-2 h-11 pl-3.5 pr-2 rounded-full bg-white/80 backdrop-blur border border-separator-opaque/40 shadow-ios-1 hover:border-ios-blue/40 hover:-translate-y-0.5 transition-all"
                >
                  <span className="text-[14px] font-semibold text-label-primary tabular-nums">{coin}</span>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[12px] font-semibold tabular-nums ${tone}`}>
                    <Icon className="w-3.5 h-3.5" strokeWidth={2.5} />
                    {lean !== 'none' && `${s.confidence}%`}
                  </span>
                </Link>
              );
            })}
      </div>
    </div>
  );
}
