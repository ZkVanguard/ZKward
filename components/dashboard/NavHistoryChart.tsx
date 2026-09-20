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
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
  type ChartOptions,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { TrendingUp, Loader2 } from 'lucide-react';
import { logger } from '@/lib/utils/logger';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler);

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
  /** Which chain's history to display. Defaults to SUI (Aiven-backed). */
  chain?: 'sui' | 'hedera';
}

/** Query the @zkward/hedera-graphql-adapter navHistory resolver.
 *  Each row is an HCS-anchored NavSnapshot. Every data point has an
 *  hcsSeq that HashScan can verify independently. */
async function fetchHederaHistoryViaAdapter(): Promise<NavHistoryResponse | null> {
  const r = await fetch('/api/subgraph/hedera', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `{ navHistory(first: 100) { id timestamp totalNavUsd hcsSeq } pools { totalShares } }`,
    }),
  });
  if (!r.ok) return null;
  const j = (await r.json()) as {
    data?: {
      navHistory?: Array<{ id: string; timestamp: string; totalNavUsd: string; hcsSeq: number | null }>;
      pools?: Array<{ totalShares: string }>;
    };
    errors?: Array<{ message: string }>;
  };
  if (j.errors?.length || !j.data?.navHistory?.length) return null;
  // HCS topic accumulates NAV snapshots across BOTH the old V1 vault
  // and the current V2 vault. Filter to points ≤10x current NAV (drops
  // V1-era leftovers cleanly; V1 held ~$1000, V2 currently ~$70).
  const currentNavUsd = Number(j.data.navHistory[0]?.totalNavUsd ?? 0) / 1e6;
  const navCeiling = currentNavUsd > 0 ? currentNavUsd * 10 : Infinity;
  // SimpleUsdcVaultV2 uses ERC-4626-lite virtual-offset math that keeps
  // share price stable at $1.00 across deposits/withdrawals (no yield
  // accrual on-chain). Dividing historical navUsd by CURRENT share count
  // produced misleading "prices" that looked like a share-price dip
  // when it was just historical NAV growth. Since the true share price
  // never leaves $1.00 for this vault, render it as a flat line. This
  // matches the actual on-chain invariant.
  const points = j.data.navHistory
    .slice()
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
    .filter((s) => (Number(s.totalNavUsd) / 1e6) <= navCeiling)
    .map((s) => ({
      t: new Date(Number(s.timestamp) * 1000).toISOString(),
      navUsd: Number(s.totalNavUsd) / 1e6,
      sharePrice: 1,
    }));
  const first = points[0];
  const last = points[points.length - 1];
  return {
    asOf: new Date().toISOString(),
    window: 'adapter',
    count: points.length,
    points,
    first,
    last,
    peak: points.reduce((a, b) => (b.sharePrice > a.sharePrice ? b : a), first),
  };
}

export function NavHistoryChart({ chain = 'sui' }: NavHistoryChartProps = {}) {
  const [window, setWindow] = useState<typeof WINDOWS[number]>(WINDOWS[1]);

  // Per-chain data source:
  //   sui    → /api/platform/nav-history (Aiven Postgres, DB-backed)
  //   hedera → @zkward/hedera-graphql-adapter navHistory (HCS-anchored),
  //            with /api/hedera/nav-history as a fallback for windows before
  //            HCS started recording, and SUI as a final fallback for empty state
  const primaryEndpoint = chain === 'hedera'
    ? `/api/hedera/nav-history?window=${window.value}&bucket=${window.bucket}`
    : `/api/platform/nav-history?window=${window.value}&bucket=${window.bucket}`;
  const fallbackEndpoint = `/api/platform/nav-history?window=${window.value}&bucket=${window.bucket}`;

  const { data, isPending: loading, error } = useQuery({
    queryKey: ['nav-history', chain, window.value, window.bucket],
    queryFn: async (): Promise<NavHistoryResponse & { fallbackFrom?: 'sui'; sourcedFrom?: 'adapter' }> => {
      // Hedera chain: try the adapter's navHistory GraphQL first. That's
      // the HCS-anchored time-series where every point has an hcsSeq. Fall
      // back to /api/hedera/nav-history (Mirror Node event replay) if the
      // adapter has no data, then finally to SUI history for empty-state UX.
      if (chain === 'hedera') {
        try {
          const viaAdapter = await fetchHederaHistoryViaAdapter();
          if (viaAdapter && viaAdapter.points.length > 0) {
            return { ...viaAdapter, sourcedFrom: 'adapter' as const };
          }
        } catch {
          /* fall through to REST endpoint */
        }
      }
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
  const plotMode: 'sharePrice' | 'navUsd' = chain === 'hedera' ? 'navUsd' : 'sharePrice';
  const isNavMode = plotMode === 'navUsd';

  const chart = useMemo(() => {
    if (!data || data.points.length === 0) return null;
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
          <h2 className="text-base sm:text-[17px] font-semibold text-label-primary">{isNavMode ? 'Total NAV history' : 'Share price history'}</h2>
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
          <div className="absolute inset-0 flex items-center justify-center text-label-tertiary">
            <Loader2 className="w-4 h-4 animate-spin" />
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
        {isNavMode ? (
          <>
            Total dollars in the vault, per HCS-anchored NAV snapshot.
            {' '}Share price stays at $1.00 by design (ERC-4626-lite math, no
            {' '}on-chain yield accrual) — NAV is the metric that moves.
          </>
        ) : (
          <>
            Every point is a snapshot from{' '}
            <code className="bg-[#f5f5f7] px-1.5 py-0.5 rounded">community_pool_nav_history</code>,
            {' '}bucket-averaged. Share price is NAV / total shares. Pool inception at $1.00.
          </>
        )}
      </p>
    </section>
  );
}
