'use client';

/**
 * Paper-pool dashboard tab — one-screen view of the shadow trader's
 * PnL trajectory and its recent trades.
 *
 * Data: /api/paper-trader/status (public, no auth). Same endpoint
 * that powers /paper — this panel is the dashboard-native subset.
 */

import { useQuery } from '@tanstack/react-query';
import { paperStatusQuery } from '@/lib/hooks/paper-status-query';
import { Beaker, TrendingUp, TrendingDown, Target, Zap } from 'lucide-react';
import { SkeletonBox } from '@/components/dashboard/community-pool/Skeletons';

interface StatusResp {
  nav: {
    currentUsd: number;
    startingUsd: number;
    peakUsd: number;
    cumReturnPct: number;
    drawdownFromPeakPct: number;
  };
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    avgBp?: number | null;
    cumRealizedUsd: number;
  };
  activePositions: Array<{
    asset: string;
    side: 'LONG' | 'SHORT';
    notionalUsd: number;
    unrealizedPnlUsd?: number;
    holdSeconds: number;
  }>;
}

const fmtUsd = (n: number, digits = 0) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: digits });
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtHold = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

export function PaperPoolPanel() {
  const { data, isLoading, error } = useQuery(paperStatusQuery<StatusResp>());

  if (isLoading) {
    return (
      <div className="space-y-4 sm:space-y-6" aria-busy="true">
        <SkeletonBox className="h-20 rounded-2xl" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
          {[0, 1, 2, 3].map((i) => <SkeletonBox key={i} className="h-24 rounded-2xl" />)}
        </div>
        <SkeletonBox className="h-40 rounded-2xl" />
      </div>
    );
  }
  if (error || !data) return <div className="p-6 text-red-700">Failed to load: {error instanceof Error ? error.message : 'unknown'}</div>;

  const returnColor = data.nav.cumReturnPct >= 0 ? 'text-green-700' : 'text-red-700';
  const hasTrades = data.stats.trades > 0;
  // The exits set the win rate; the average trade after costs is the result.
  const avgBp = typeof data.stats.avgBp === 'number' ? data.stats.avgBp : null;
  const record = `${data.stats.wins}W / ${data.stats.losses}L · ${data.stats.winRatePct.toFixed(0)}% wins`;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header explains what this is */}
      <div className="flex items-start gap-3 p-4 rounded-2xl bg-ios-blue/8 border border-ios-blue/15">
        <Beaker className="w-5 h-5 text-ios-blue flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold text-label-primary text-callout">Paper pool — signal stack in production</div>
          <div className="text-sm text-label-secondary mt-1">
            A $100,000 simulated book that trades on our signals, net of fees, slippage and funding.
          </div>
        </div>
      </div>

      {/* NAV + result top strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <Stat icon={<TrendingUp className="w-4 h-4" />} label="Live NAV" value={fmtUsd(data.nav.currentUsd)} sub={<span className={returnColor}>{fmtPct(data.nav.cumReturnPct)}</span>} />
        <Stat icon={<Target className="w-4 h-4" />} label="Average trade" value={hasTrades && avgBp !== null ? `${avgBp >= 0 ? '+' : ''}${avgBp.toFixed(1)} bp` : '—'} sub={<span className={!hasTrades || avgBp === null ? 'text-label-secondary' : avgBp > 0 ? 'text-green-700' : 'text-red-700'}>{fmtUsd(data.stats.cumRealizedUsd, 2)} booked</span>} sub2={hasTrades ? `${record} · ${data.stats.trades} trades` : 'no closed trades'} />
        <Stat icon={<TrendingDown className="w-4 h-4" />} label="Drawdown" value={`${data.nav.drawdownFromPeakPct.toFixed(2)}%`} sub={`Peak ${fmtUsd(data.nav.peakUsd)}`} />
        <Stat icon={<Zap className="w-4 h-4" />} label="Active" value={String(data.activePositions.length)} sub={data.activePositions.length ? data.activePositions.map((p) => `${p.asset} ${p.side}`).join(', ') : 'flat'} />
      </div>

      {/* Active positions detail */}
      {data.activePositions.length > 0 && (
        <div className="p-4 rounded-2xl bg-white border border-black/5">
          <div className="text-caption-1 font-semibold text-label-tertiary uppercase tracking-wide mb-3">Active positions</div>
          <div className="space-y-2">
            {data.activePositions.map((p) => (
              <div key={`${p.asset}-${p.side}`} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-label-primary">{p.asset}</span>
                  <span className={p.side === 'LONG' ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>{p.side}</span>
                  <span className="text-label-tertiary text-xs">held {fmtHold(p.holdSeconds)}</span>
                </div>
                <div className="flex items-center gap-4 tabular-nums">
                  <span className="text-label-secondary">{fmtUsd(p.notionalUsd)}</span>
                  {typeof p.unrealizedPnlUsd === 'number' && (
                    <span className={p.unrealizedPnlUsd >= 0 ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>
                      {p.unrealizedPnlUsd >= 0 ? '+' : ''}{fmtUsd(p.unrealizedPnlUsd, 2)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Deep-dive link */}
      <div className="text-center text-sm">
        <a href="/paper" className="text-ios-blue hover:underline">
          Open the full paper-trader view →
        </a>
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  sub,
  sub2,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: React.ReactNode;
  sub2?: string;
}) {
  return (
    <div className="p-3 sm:p-4 rounded-2xl bg-white border border-black/5">
      <div className="flex items-center gap-1.5 text-caption-1 text-label-tertiary uppercase tracking-wide font-medium">
        {icon} {label}
      </div>
      <div className="mt-1.5 text-xl sm:text-2xl font-semibold text-label-primary tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs font-medium">{sub}</div>}
      {sub2 && <div className="text-xs text-label-tertiary">{sub2}</div>}
    </div>
  );
}
