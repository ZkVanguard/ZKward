'use client';

/**
 * Market lean: the per-asset signal the books trade, with the markets behind
 * it. Replaces a list of generated "insight" questions that had no market
 * behind them.
 *
 * Reads `/api/predictions/per-asset` (the same read as the Risk and Agents
 * views, so the three never disagree) and `/api/prices` for the spot price.
 * A failed read shows as an error, never as a flat market.
 */
import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { ChevronDown, RefreshCw, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { fetchPerAssetSignals, fetchSpotPrices } from '@/lib/api/market-signals';
import type { PerAssetSignal } from '@/lib/types/market-signals';
import { logoPath, providerForSource } from '@/lib/api/signal-providers';

const REFRESH_MS = 60_000;

interface Loaded {
  signals: Record<string, PerAssetSignal>;
  prices: Record<string, number>;
  at: number;
}

const money = (v: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: v >= 100 ? 2 : 4, maximumFractionDigits: v >= 100 ? 2 : 4 }).format(v);

function ProviderLogo({ sourceName, size = 12 }: { sourceName: string; size?: number }) {
  const p = providerForSource(sourceName);
  if (!p) return <span className="text-[11px] font-medium text-label-tertiary">{sourceName.split(':')[0].replace(/\s*\(.*\)$/, '')}</span>;
  return (
    <span className="inline-flex items-center gap-1" title={p.name}>
      <Image src={logoPath(p)} alt={`${p.name} logo`} width={Math.round(size * p.ratio)} height={size} unoptimized style={{ height: size, width: 'auto' }} />
      {p.markOnly && <span className="text-[11px] font-medium text-label-secondary">{p.name}</span>}
    </span>
  );
}

/** One chip per provider: several feeds from the same market (the 5-minute, hourly and daily reads) show once, with a count, and a dot that is tinted only when they agree. */
function groupByProvider(sources: PerAssetSignal['sources']): Array<{ key: string; name: string; count: number; direction: 'UP' | 'DOWN' | 'NEUTRAL' }> {
  const groups = new Map<string, { name: string; dirs: Set<string>; count: number }>();
  for (const src of sources) {
    const p = providerForSource(src.name);
    const key = p ? p.slug : src.name.split(':')[0].replace(/\s*\(.*\)$/, '');
    const g = groups.get(key) ?? { name: src.name, dirs: new Set<string>(), count: 0 };
    g.dirs.add(src.direction);
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.entries()].map(([key, g]) => ({
    key,
    name: g.name,
    count: g.count,
    direction: g.dirs.size === 1 && (g.dirs.has('UP') || g.dirs.has('DOWN')) ? ([...g.dirs][0] as 'UP' | 'DOWN') : 'NEUTRAL',
  }));
}

function Lean({ direction, confidence }: { direction: PerAssetSignal['direction']; confidence: number }) {
  const t = useTranslations('dashboard.marketBoard');
  if (direction === 'UP') {
    return (
      <span className="inline-flex items-center gap-1.5 text-green-700 font-semibold">
        <TrendingUp className="w-4 h-4" strokeWidth={2.5} />
        {t('leanUp')} · {t('confidence', { pct: confidence })}
      </span>
    );
  }
  if (direction === 'DOWN') {
    return (
      <span className="inline-flex items-center gap-1.5 text-red-700 font-semibold">
        <TrendingDown className="w-4 h-4" strokeWidth={2.5} />
        {t('leanDown')} · {t('confidence', { pct: confidence })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-label-tertiary font-semibold">
      <Minus className="w-4 h-4" strokeWidth={2.5} />
      {t('noLean')}
    </span>
  );
}

function AssetCard({ asset, s, price }: { asset: string; s: PerAssetSignal; price?: number }) {
  const t = useTranslations('dashboard.marketBoard');
  const [open, setOpen] = useState(false);
  const agree = s.sources.filter((x) => x.direction === s.direction).length;
  const tone = s.direction === 'UP' ? 'bg-green-600' : s.direction === 'DOWN' ? 'bg-red-600' : 'bg-label-primary/20';
  return (
    <article className="rounded-2xl border border-label-primary/[0.06] bg-system-bg-secondary/60 p-4 min-w-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold text-label-primary tracking-[-0.01em]">{asset}</h3>
        {price !== undefined && <span className="text-sm text-label-secondary tabular-nums">{money(price)}</span>}
      </div>
      <div className="mt-2 text-sm">
        <Lean direction={s.direction} confidence={s.confidence} />
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-label-primary/[0.06] overflow-hidden" aria-hidden>
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${s.direction === 'NEUTRAL' ? 0 : Math.max(4, Math.min(100, s.confidence))}%` }} />
      </div>
      <p className="mt-2 text-xs text-label-tertiary">
        {!s.sources.length ? t('noSources') : s.direction === 'NEUTRAL' ? t('split', { total: s.sources.length }) : t('agree', { n: agree, total: s.sources.length })}
      </p>
      {s.sources.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            {groupByProvider(s.sources).map((g) => (
              <span key={g.key} className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`w-1.5 h-1.5 rounded-full ${g.direction === 'UP' ? 'bg-green-600' : g.direction === 'DOWN' ? 'bg-red-600' : 'bg-label-primary/25'}`}
                />
                <ProviderLogo sourceName={g.name} />
                {g.count > 1 && <span className="text-[10px] font-semibold text-label-tertiary tabular-nums">×{g.count}</span>}
              </span>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-ios-blue hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/60 rounded"
          >
            {t('sources')} ({s.sources.length})
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          {open && (
            <ul className="mt-2 divide-y divide-label-primary/[0.06] text-xs">
              {s.sources.map((src, i) => (
                <li key={`${src.name}-${i}-row`} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate text-label-secondary" title={src.name}>{src.name}</span>
                  <span className="shrink-0 tabular-nums text-label-tertiary">
                    <span className={src.direction === 'UP' ? 'text-green-700' : src.direction === 'DOWN' ? 'text-red-700' : ''}>
                      {t(`dir.${src.direction === 'UP' ? 'up' : src.direction === 'DOWN' ? 'down' : 'flat'}`)}
                    </span>
                    {' · '}{src.confidence}%{' · '}{t('weight', { pct: src.weight })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}

function Skeleton() {
  return (
    <div className="rounded-2xl border border-label-primary/[0.06] p-4 animate-pulse" aria-hidden>
      <div className="h-4 w-14 rounded bg-label-primary/10" />
      <div className="mt-3 h-3.5 w-32 rounded bg-label-primary/10" />
      <div className="mt-3 h-1.5 w-full rounded bg-label-primary/10" />
      <div className="mt-3 h-3 w-24 rounded bg-label-primary/10" />
    </div>
  );
}

export function MarketLeanBoard() {
  const t = useTranslations('dashboard.marketBoard');
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const signals = await fetchPerAssetSignals();
      const assets = Object.keys(signals);
      const prices = await fetchSpotPrices(assets).catch(() => ({}));
      setData({ signals, prices, at: Date.now() });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = setInterval(() => void load(), REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => { clearInterval(refresh); clearInterval(tick); };
  }, [load]);

  const entries = data ? Object.entries(data.signals) : [];
  const ups = entries.filter(([, s]) => s.direction === 'UP').length;
  const downs = entries.filter(([, s]) => s.direction === 'DOWN').length;
  const overall = !entries.length ? null : ups > downs ? 'up' : downs > ups ? 'down' : 'mixed';
  const ageS = data ? Math.max(0, Math.round((now - data.at) / 1000)) : 0;

  return (
    <section className="bg-white rounded-2xl sm:rounded-3xl border border-label-primary/[0.06] shadow-[0_1px_2px_rgba(15,23,42,0.04),0_8px_24px_-12px_rgba(15,23,42,0.08)] overflow-hidden">
      <header className="px-4 sm:px-6 py-3.5 sm:py-4 border-b border-label-primary/[0.06] flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base sm:text-lg font-semibold text-label-primary tracking-[-0.01em]">{t('title')}</h2>
            {overall && (
              <span className={`text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-md ${overall === 'up' ? 'bg-green-700/10 text-green-700' : overall === 'down' ? 'bg-red-700/10 text-red-700' : 'bg-label-primary/[0.06] text-label-secondary'}`}>
                {t(`overall.${overall}`)}
              </span>
            )}
          </div>
          <p className="text-xs sm:text-sm text-label-tertiary mt-1">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {data && <span className="text-[11px] text-label-tertiary tabular-nums hidden sm:inline">{t('updated', { s: ageS })}</span>}
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label={t('refresh')}
            className="p-2 rounded-full text-label-tertiary hover:text-label-primary hover:bg-label-primary/[0.06] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/60"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>
      <div className="p-4 sm:p-6">
        {error && !data ? (
          <div className="rounded-2xl border border-red-700/20 bg-red-700/5 p-4 text-sm text-red-700 flex items-center justify-between gap-3">
            <span>{t('error')}</span>
            <button type="button" onClick={() => void load()} className="font-semibold underline underline-offset-2">{t('retry')}</button>
          </div>
        ) : loading && !data ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} />)}</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {entries.map(([asset, s]) => <AssetCard key={asset} asset={asset} s={s} price={data?.prices[asset]} />)}
          </div>
        )}
        {error && data && <p className="mt-3 text-xs text-red-700">{t('staleAfterError')}</p>}
        <p className="mt-4 text-[11px] text-label-tertiary">{t('footer')}</p>
      </div>
    </section>
  );
}
