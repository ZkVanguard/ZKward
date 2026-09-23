'use client';

/**
 * Paper-pool dashboard tab — one-screen view of the shadow trader's
 * PnL trajectory + how the learning subsystems (bandit, source
 * calibrator) are evolving.
 *
 * Data: /api/paper-trader/status (public, no auth). Same endpoint
 * that powers /paper — this panel is the dashboard-native subset.
 */

import { useQuery } from '@tanstack/react-query';
import { Beaker, TrendingUp, TrendingDown, Target, Zap, Ban } from 'lucide-react';

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
    cumRealizedUsd: number;
  };
  activePositions: Array<{
    asset: string;
    side: 'LONG' | 'SHORT';
    notionalUsd: number;
    unrealizedPnlUsd?: number;
    holdSeconds: number;
  }>;
  learning?: {
    bandit: {
      armCount: number;
      arms: Array<{
        key: string;
        wins: number;
        trades: number;
        winPct: number;
        avgRewardPct: number;
      }>;
    };
    sources: {
      total: number;
      killed: number;
      top: Array<{ key: string; obs: number; hitPct: number; killed: boolean }>;
      bottom: Array<{ key: string; obs: number; hitPct: number; killed: boolean }>;
    };
  };
}

const fmtUsd = (n: number, digits = 0) =>
  n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: digits });
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtHold = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);

export function PaperPoolPanel() {
  const { data, isLoading, error } = useQuery<StatusResp>({
    queryKey: ['paper-trader-status'],
    queryFn: async () => {
      const r = await fetch('/api/paper-trader/status');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  if (isLoading) return <div className="p-6 text-label-secondary">Loading paper-pool state…</div>;
  if (error || !data) return <div className="p-6 text-red-700">Failed to load: {error instanceof Error ? error.message : 'unknown'}</div>;

  const returnColor = data.nav.cumReturnPct >= 0 ? 'text-green-700' : 'text-red-700';
  const winRateGood = data.stats.winRatePct >= 50;

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header explains what this is */}
      <div className="flex items-start gap-3 p-4 rounded-2xl bg-ios-blue/8 border border-ios-blue/15">
        <Beaker className="w-5 h-5 text-ios-blue flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-semibold text-label-primary text-callout">Paper pool — signal stack in production</div>
          <div className="text-sm text-label-secondary mt-1">
            Shadow trader running the aggregator&apos;s output at $100K notional. Mark-price fills, 13&nbsp;bp
            round-trip + 11% APR funding modeled. Answers: does the signal stack have edge net of fees?
          </div>
        </div>
      </div>

      {/* NAV + win-rate top strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <Stat icon={<TrendingUp className="w-4 h-4" />} label="Live NAV" value={fmtUsd(data.nav.currentUsd)} sub={<span className={returnColor}>{fmtPct(data.nav.cumReturnPct)}</span>} />
        <Stat icon={<Target className="w-4 h-4" />} label="Win rate" value={`${data.stats.winRatePct.toFixed(1)}%`} sub={<span className={winRateGood ? 'text-green-700' : 'text-red-700'}>{data.stats.wins}W / {data.stats.losses}L</span>} sub2={`${data.stats.trades} trades`} />
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

      {/* Learning: bandit arms */}
      {data.learning?.bandit && data.learning.bandit.armCount > 0 && (
        <div className="p-4 rounded-2xl bg-white border border-black/5">
          <div className="flex items-baseline justify-between mb-3">
            <div className="text-caption-1 font-semibold text-label-tertiary uppercase tracking-wide">Bandit arms — (asset, side) selection</div>
            <div className="text-xs text-label-tertiary">{data.learning.bandit.armCount} arms learning</div>
          </div>
          <div className="space-y-1.5">
            {data.learning.bandit.arms.map((arm) => (
              <div key={arm.key} className="flex items-center gap-3 text-sm">
                <div className="w-24 font-mono text-xs text-label-secondary">{arm.key}</div>
                <div className="flex-1 h-2 rounded-full bg-black/5 overflow-hidden">
                  <div
                    className={arm.winPct >= 50 ? 'h-full bg-green-500' : 'h-full bg-red-500'}
                    style={{ width: `${Math.min(100, arm.winPct)}%` }}
                  />
                </div>
                <div className="text-xs tabular-nums text-label-tertiary w-20 text-right">{arm.wins}/{arm.trades} · {arm.winPct.toFixed(0)}%</div>
                <div className={`text-xs tabular-nums w-16 text-right ${arm.avgRewardPct >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  {arm.avgRewardPct >= 0 ? '+' : ''}{arm.avgRewardPct.toFixed(2)}%
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Learning: source calibrator */}
      {data.learning?.sources && data.learning.sources.total > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Top */}
          <div className="p-4 rounded-2xl bg-white border border-black/5">
            <div className="flex items-baseline justify-between mb-3">
              <div className="text-caption-1 font-semibold text-label-tertiary uppercase tracking-wide">Best signals</div>
              <div className="text-xs text-label-tertiary">of {data.learning.sources.total} tracked</div>
            </div>
            <div className="space-y-1">
              {data.learning.sources.top.slice(0, 8).map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-xs">
                  <div className="flex-1 truncate font-mono text-label-secondary">{s.key}</div>
                  <div className="w-10 text-right text-label-tertiary tabular-nums">n={s.obs}</div>
                  <div className={`w-14 text-right tabular-nums font-medium ${s.hitPct >= 60 ? 'text-green-700' : 'text-label-primary'}`}>{s.hitPct.toFixed(1)}%</div>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom / killed */}
          <div className="p-4 rounded-2xl bg-white border border-black/5">
            <div className="flex items-baseline justify-between mb-3">
              <div className="text-caption-1 font-semibold text-label-tertiary uppercase tracking-wide">Worst signals</div>
              <div className="flex items-center gap-1 text-xs text-red-700">
                <Ban className="w-3 h-3" /> {data.learning.sources.killed} killed
              </div>
            </div>
            <div className="space-y-1">
              {data.learning.sources.bottom.slice(0, 8).map((s) => (
                <div key={s.key} className="flex items-center gap-2 text-xs">
                  <div className="flex-1 truncate font-mono text-label-secondary">{s.key}</div>
                  <div className="w-10 text-right text-label-tertiary tabular-nums">n={s.obs}</div>
                  <div className={`w-14 text-right tabular-nums font-medium ${s.killed ? 'text-red-700' : s.hitPct < 40 ? 'text-orange-700' : 'text-label-primary'}`}>
                    {s.hitPct.toFixed(1)}%{s.killed ? ' ×' : ''}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t border-black/5 text-xs text-label-tertiary">
              Sources below 40% hit rate with ≥15 observations drop to 0.05× weight.
            </div>
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
