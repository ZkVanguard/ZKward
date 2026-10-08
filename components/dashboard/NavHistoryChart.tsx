'use client';

/**
 * NAV / share-price time-series chart for /dashboard/risk.
 *
 * Investor-facing view: "here's what the pool has actually done since
 * inception." Reads /api/platform/nav-history, plots share price with
 * peak annotation. Deliberately minimal — no interactions beyond
 * hovering; window buttons are single-click state changes.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import nextDynamic from 'next/dynamic';
import type { ChartOptions } from 'chart.js';
import { TrendingUp } from 'lucide-react';
import { logger } from '@/lib/utils/logger';
import { SkeletonBox } from '@/components/dashboard/community-pool/Skeletons';

// chart.js loads in its own chunk; the skeleton below covers the box until it does.
const Line = nextDynamic(() => import('./NavLineCanvas'), {
  ssr: false,
  loading: () => <SkeletonBox className="absolute inset-0 rounded-xl" />,
});

interface Point {
  t: string;
  sharePrice: number;
  navUsd: number;
}

interface NavHistoryResponse {
  asOf: string;
  window: string;
  count: number;
  first?: Point;
  last?: Point;
  peak?: { t: string; sharePrice: number };
  points: Point[];
}

const WINDOWS: Array<{ label: string; value: '7d' | '30d' | '60d' | 'all'; bucket: string }> = [
  { label: '7D', value: '7d', bucket: 'hour' },
  { label: '30D', value: '30d', bucket: 'hour' },
  { label: '60D', value: '60d', bucket: 'day' },
  { label: 'All', value: 'all', bucket: 'day' },
];

interface NavHistoryChartProps {
  /** Which pool's history to display. Defaults to SUI. */
  chain?: 'sui' | 'hedera' | 'solana';
}

// Hedera adapter fetch removed 2026-09-23 — /api/subgraph/hedera backend
// was retired in commit 5303af22 (ETHGlobal cleanup). Callers now use the
// Mirror Node REST endpoint directly (fallback path was already present).

export function NavHistoryChart({ chain = 'sui' }: NavHistoryChartProps = {}) {
  const [window, setWindow] = useState<typeof WINDOWS[number]>(WINDOWS[1]);

  // Per-chain data source:
  //   sui    → /api/platform/nav-history (Aiven Postgres, DB-backed)
  //   hedera → @zkward/hedera-graphql-adapter navHistory (HCS-anchored),
  //            with /api/hedera/nav-history as a fallback for windows before
  //            HCS started recording, and SUI as a final fallback for empty state
  const query = `window=${window.value}&bucket=${window.bucket}`;
  const primaryEndpoint =
    chain === 'hedera' ? `/api/hedera/nav-history?${query}`
    : chain === 'solana' ? `/api/solana-pool/history?${query}`
    : `/api/platform/nav-history?${query}`;
  const fallbackEndpoint = `/api/platform/nav-history?window=${window.value}&bucket=${window.bucket}`;

  const { data, isPending: loading, error } = useQuery({
    queryKey: ['nav-history', chain, window.value, window.bucket],
    queryFn: async (): Promise<NavHistoryResponse & { fallbackFrom?: 'sui'; sourcedFrom?: 'adapter' }> => {
      // Hedera chain uses Mirror Node event replay via
      // /api/hedera/nav-history. Falls back to SUI history for empty-state
      // UX if Mirror Node has nothing. (Previously the GraphQL adapter
      // was tried first; that backend was retired in commit 5303af22.)
      const r = await fetch(primaryEndpoint);
      const primary = (await r.json()) as NavHistoryResponse;
      if (chain === 'hedera' && (!primary.points || primary.points.length === 0)) {
        try {
          const s = await fetch(fallbackEndpoint);
          const sui = (await s.json()) as NavHistoryResponse;
          if (sui.points && sui.points.length > 0) {
            return { ...sui, fallbackFrom: 'sui' as const };
          }
        } catch {
          /* fall through to primary result */
        }
      }
      return primary;
    },
    staleTime: 30_000,
  });
  if (error) {
    logger.warn('[NavHistoryChart] fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const usedFallback = (data as { fallbackFrom?: 'sui' } | undefined)?.fallbackFrom === 'sui';

  // Hedera SimpleUsdcVaultV2 uses ERC-4626-lite math with zero on-chain
  // yield accrual. Share price is mathematically pinned to $1.00 forever
  // (every $1 deposit = 1 share). Plotting share price for Hedera is a
  // trivially flat line. Plot total NAV instead: deposits/withdrawals show
  // as real steps, which is the metric that actually changes.
  // Solana shares are token-denominated, so the USD story is total value too.
  const plotMode: 'sharePrice' | 'navUsd' = chain === 'sui' ? 'sharePrice' : 'navUsd';
  const isNavMode = plotMode === 'navUsd';

  const chart = useMemo(() => {
    if (!data?.points || data.points.length === 0) return null;
    const labels = data.points.map((p) => new Date(p.t).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric',
    }));
    const values = data.points.map((p) => (isNavMode ? p.navUsd : p.sharePrice));
    return {
      labels,
      datasets: [{
        label: isNavMode ? 'Total NAV (USD)' : 'Share price',
        data: values,
        borderColor: 'rgb(29, 29, 31)',
        backgroundColor: 'rgba(29, 29, 31, 0.05)',
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
      }],
    };
  }, [data, isNavMode]);

  const options: ChartOptions<'line'> = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const p = data?.points[ctx.dataIndex];
            if (!p) return '';
            return `NAV $${p.navUsd.toFixed(2)} · share $${p.sharePrice.toFixed(4)}`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        // Fewer x ticks on narrow charts. Chart.js exposes chart.width via
        // scale.chart in the ticks callback context but not the config.
        // Use maxTicksLimit: 4 (was 6) which auto-shrinks on narrow, keeps
        // desktop readable via the same limit acting as a soft cap.
        ticks: { maxTicksLimit: 4, font: { size: 10 } },
      },
      y: {
        grid: { color: 'rgba(0,0,0,0.05)' },
        ticks: {
          font: { size: 10 },
          maxTicksLimit: 5,
          // Compact currency in NAV mode ($60K, $1.2M) — 4-digit dollar values
          // take too much y-axis pixel budget on 375px viewports. Share-price
          // mode stays at 2 decimals since values hover around $1.00.
          callback: (v) => isNavMode
            ? '$' + Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(v))
            : '$' + Number(v).toFixed(2),
        },
      },
    },
  }), [data, isNavMode]);

  const change = data?.first && data?.last
    ? isNavMode && data.first.navUsd > 0
      ? ((data.last.navUsd - data.first.navUsd) / data.first.navUsd) * 100
      : ((data.last.sharePrice - data.first.sharePrice) / data.first.sharePrice) * 100
    : null;

  return (
    <section className="bg-white border border-black/5 rounded-2xl p-3 sm:p-5 min-w-0">
      {/* Title row + metric row ALWAYS stacked — clean at every width, no
          clip risk (previous inline-on-sm+ layout got squeezed by parent
          card padding at ~768 and clipped the value). */}
      <div className="flex flex-col gap-y-1 mb-3 sm:mb-4 min-w-0">
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <TrendingUp className="w-4 h-4 text-label-primary flex-shrink-0" />
          <h2 className="text-base sm:text-[17px] font-semibold text-label-primary">{isNavMode ? 'Pool value' : 'Share price'}</h2>
          {usedFallback && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide"
              style={{ background: '#4DA2FF15', color: '#4DA2FF' }}
              title="Hedera pool is fresh; showing SUI pool history as a reference series until Hedera accumulates events."
            >
              Reference · SUI
            </span>
          )}
        </div>
        {/* flex-wrap on mobile so 'Peak' + 'First → Now' can stack instead of
            being forced onto one line + clipping. gap-y-1 gives a bit of
            breathing room between wrapped lines. */}
        <div className="flex items-baseline flex-wrap gap-x-3 gap-y-1 text-[11px] sm:text-[12px]">
          {data?.peak && (
            <span className="text-label-tertiary">
              Peak <strong className="text-label-primary font-mono">
                ${isNavMode
                  ? (data.points.reduce((a, b) => (b.navUsd > a.navUsd ? b : a), data.points[0]).navUsd).toLocaleString(undefined, { maximumFractionDigits: 0 })
                  : data.peak.sharePrice.toFixed(4)}
              </strong>
            </span>
          )}
          {/* Hide % change in NAV mode. NAV grows with deposits AND yield, so
              % is misleading (a big deposit shows +8000% but that's capital
              inflow, not return). Show the first→last dollar delta instead. */}
          {isNavMode && data?.first && data?.last ? (
            <span className="text-label-tertiary">
              First{' '}
              <strong className="text-label-primary font-mono">
                ${data.first.navUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </strong>
              {' '}→ Now{' '}
              <strong className="text-label-primary font-mono">
                ${data.last.navUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </strong>
            </span>
          ) : change !== null && (
            <span className={change >= 0 ? 'text-green-700' : 'text-red-700'}>
              {change >= 0 ? '+' : ''}{change.toFixed(2)}% window
            </span>
          )}
        </div>
      </div>

      <div className="flex gap-1.5 mb-3">
        {WINDOWS.map((w) => (
          <button
            key={w.value}
            onClick={() => setWindow(w)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors ${
              w.value === window.value
                ? 'bg-[#1d1d1f] text-white'
                : 'bg-[#f5f5f7] text-label-tertiary hover:bg-[#e8e8ed]'
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {/* Chart height: 176px mobile / 224px tablet / 256px desktop. Chart.js
          scales fill this container width (responsive: true, maintain-
          AspectRatio: false). Height picked so mobile shows a clear
          trend line without dominating the viewport. */}
      <div className="h-44 sm:h-56 md:h-64 relative">
        {loading && !data && (
          <SkeletonBox className="absolute inset-0 rounded-xl" />
        )}
        {!loading && data && (data.points?.length ?? 0) === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[13px] text-label-tertiary text-center px-6">
            History appears here after the first snapshots.
          </div>
        )}
        {chart && (
          <Line
            data={chart}
            options={options}
            aria-label={`Share-price history over the last ${window.label} — from $${data?.first?.sharePrice.toFixed(4) ?? '…'} to $${data?.last?.sharePrice.toFixed(4) ?? '…'}, peak $${data?.peak?.sharePrice.toFixed(4) ?? '…'}`}
          />
        )}
      </div>
      <p className="text-[11px] text-label-tertiary mt-3">
        {chain === 'solana'
          ? 'Vault value in US dollars at the token’s market price, recorded every 15 minutes.'
          : chain === 'hedera'
            ? 'Total value held by the vault. Each share stays at $1.00 by design, so total value is what moves.'
            : 'Value of one pool share over time (pool value ÷ shares). The pool started at $1.00.'}
      </p>
    </section>
  );
}
