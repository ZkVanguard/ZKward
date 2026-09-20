'use client';

import React, { memo, useMemo } from 'react';
import type { PoolSummary, ChainKey } from './types';
import { formatUSD } from './utils';
import { useLiveSignals } from '@/lib/hooks/useLiveSignals';
import { useLivePrices } from '@/lib/hooks/useLivePrices';

// Assets the Hedera projection covers (BTC + ETH + SUI). Same set as
// HederaPoolHedgesProjection — both components read from the shared
// useLiveSignals / useLivePrices hooks, so numbers are guaranteed to
// match and there's a single deduped fetch behind them.
const PROJECTION_ASSETS = ['BTC', 'ETH', 'SUI'] as const;
const PROJECTION_LEVERAGE = 2;

interface PoolStatsProps {
  poolData: PoolSummary;
  selectedChain: ChainKey;
}

function formatStaleAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type MetricSize = 'mobile-hero' | 'mobile-strip' | 'desktop';

const SIZE_CLASS: Record<MetricSize, { value: string; label: string; wrapper: string }> = {
  'mobile-hero': {
    value: 'text-lg font-bold tabular-nums break-all',
    label: 'text-[11px] mt-0.5 line-clamp-2 leading-tight',
    wrapper: 'text-center min-w-0 rounded-2xl bg-gray-50 dark:bg-gray-700/40 p-3',
  },
  'mobile-strip': {
    value: 'text-xs font-semibold tabular-nums break-all',
    label: 'text-[10px] leading-tight truncate',
    wrapper: 'text-center min-w-0',
  },
  desktop: {
    value: 'text-xl md:text-2xl font-bold tabular-nums break-all',
    label: 'text-xs mt-0.5 line-clamp-2 leading-tight',
    wrapper: 'text-center min-w-0',
  },
};

interface MetricProps {
  value: React.ReactNode;
  label: React.ReactNode;
  size: MetricSize;
  valueColorClass?: string;
  chip?: React.ReactNode;
}

function Metric({ value, label, size, valueColorClass, chip }: MetricProps) {
  const cls = SIZE_CLASS[size];
  return (
    <div className={cls.wrapper}>
      <p className={`${cls.value} ${valueColorClass ?? 'text-gray-900 dark:text-white'}`}>{value}</p>
      <p className={`${cls.label} text-gray-500 dark:text-gray-400`}>{label}</p>
      {chip}
    </div>
  );
}

export const PoolStats = memo(function PoolStats({ poolData, selectedChain }: PoolStatsProps) {
  const isSui = selectedChain === 'sui';
  const isHedera = selectedChain === 'hedera';
  const isStale = Boolean(poolData.stale) && isSui;

  // Projected 24h return @ 2× — Hedera only, since Hedera share price is
  // pinned to \$1.00 by design (ERC-4626-lite math). Answers the user
  // question "what would this look like if the AI actually executed?".
  // Reads from the shared useLiveSignals + useLivePrices hooks so the
  // number here matches the projected-hedges panel below exactly.
  const { data: signals } = useLiveSignals(PROJECTION_ASSETS);
  const { data: prices } = useLivePrices(PROJECTION_ASSETS);
  const projectedPct = useMemo(() => {
    if (!isHedera || !signals || !prices) return null;
    let sum = 0;
    for (const asset of PROJECTION_ASSETS) {
      const dir = signals[asset]?.direction;
      const ch = prices[asset]?.change24h;
      if (typeof ch !== 'number' || !dir || dir === 'NEUTRAL') continue;
      const side = dir === 'DOWN' ? -1 : 1;
      sum += ch * side * PROJECTION_LEVERAGE;
    }
    return (sum / PROJECTION_ASSETS.length) * 100;
  }, [isHedera, signals, prices]);
  const projectedShare = projectedPct != null ? 1 + projectedPct / 100 : null;
  const staleAgeLabel = poolData.staleAgeSeconds != null
    ? formatStaleAge(poolData.staleAgeSeconds)
    : undefined;

  const sharePriceDisplay = useMemo(() => {
    const price = Number(poolData.sharePrice) || (isSui ? 1 : 0);
    return `$${price.toFixed(4)}`;
  }, [isSui, poolData.sharePrice]);

  const sharePriceSubtext = isSui ? 'Current Share Price (USDC at inception)' : 'Share Price';

  const profit = useMemo(() => {
    if (!isSui) return null;
    const sharePrice = Number(poolData.sharePrice) || 1;
    const returnPct = (sharePrice - 1) * 100;
    const nav = Number(poolData.totalValueUSD) || 0;
    const netCapital = (Number(poolData.totalDeposited) || 0) - (Number(poolData.totalWithdrawn) || 0);
    const profitUsd = netCapital > 0 ? nav - netCapital : null;
    const ath = Number(poolData.allTimeHighNav) || 0;
    const offAthPct = ath > 0 ? (sharePrice / ath - 1) * 100 : null;
    return { returnPct, profitUsd, offAthPct };
  }, [isSui, poolData.sharePrice, poolData.totalValueUSD, poolData.totalDeposited, poolData.totalWithdrawn, poolData.allTimeHighNav]);

  const signedPct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const signedUsd = (v: number) => `${v >= 0 ? '+' : '-'}${formatUSD(Math.abs(v))}`;
  // Softer than red-600/green-600 (the pre-refactor default), still WCAG
  // AA-compliant at every size the Metric component renders (12px mobile-
  // strip up to 24px desktop). Cannot use text-ios-red / text-ios-green
  // here: ios-red is #FF3B30 (3.76:1 on white. Fails AA for small text),
  // ios-green is #34C759 (1.85:1. Fails everywhere). red-700 / green-700
  // are darker and more "serious", which also matches the user's request
  // to de-shout the loss indicators without erasing them.
  const pnlColor = (v: number) =>
    v >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400';

  // Single stale chip used on both breakpoints. One wording ("snapshot · Xh
  // old"), one tooltip. Was two different phrasings pre-2026-07-31 refactor.
  const staleChip = useMemo(() => {
    if (!isStale) return null;
    return (
      <span
        className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 text-[10px] font-medium"
        title="Live SUI RPC unavailable. Showing last recorded on-chain snapshot from DB. Pool is unaffected; RPC-level issue."
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        {staleAgeLabel ? `snapshot · ${staleAgeLabel} old` : 'snapshot'}
      </span>
    );
  }, [isStale, staleAgeLabel]);

  const athChip = useMemo(() => {
    if (!isSui || !profit || profit.offAthPct == null || profit.offAthPct >= 0) return null;
    const dd = profit.offAthPct;
    // Soft tint background + dark WCAG-safe text. Was red-100 / amber-100
    // Tailwind saturated tints reading as alarm chips; new bg-ios-red/10
    // etc. give the same softer feel but text must stay a dark tailwind
    // red-800 / orange-800. Text-ios-red on bg-ios-red/10 is 3.5:1 which
    // fails AA for the 10px chip text.
    const tone =
      dd <= -15
        ? 'bg-ios-red/10 text-red-800 dark:text-red-300'
        : dd <= -5
          ? 'bg-ios-orange/10 text-orange-800 dark:text-orange-300'
          : 'bg-system-bg-secondary text-label-tertiary dark:text-gray-400';
    const ath = Number(poolData.allTimeHighNav) || 0;
    return (
      <span
        className={`inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tabular-nums ${tone}`}
        title={`Currently ${dd.toFixed(2)}% below ATH share price of $${ath.toFixed(4)}`}
      >
        {dd.toFixed(1)}% off ATH
      </span>
    );
  }, [isSui, profit, poolData.allTimeHighNav]);

  // Total Value + Total Shares tiles removed 2026-08-17: superseded by the
  // NavHistoryChart hero (share price chart tells the story better; NAV is
  // the chart's last-point tooltip; total-share count is investor-irrelevant).
  // Keep: Return, Profit, Members, Share Price. Stale chip re-anchored on
  // the Share Price tile so users still see "snapshot · Xh old" context.
  return (
    <div className="p-3 sm:p-4 md:p-5 border-b border-gray-100 dark:border-gray-700 min-w-0">
      {/* Mobile compact strip — hero row removed; chart above owns the hero slot.
          Hedera shows projected metrics instead of the flat \$1.00 (which is
          pinned by design and would just repeat the same number). */}
      <div className="grid grid-cols-3 gap-2 sm:hidden">
        {isSui && profit && profit.profitUsd !== null ? (
          <Metric
            size="mobile-strip"
            value={signedUsd(profit.profitUsd)}
            label="Profit"
            valueColorClass={pnlColor(profit.profitUsd)}
          />
        ) : isHedera && projectedShare != null ? (
          <Metric
            size="mobile-strip"
            value={`$${projectedShare.toFixed(4)}`}
            label="Strategy NAV"
            valueColorClass={pnlColor(projectedPct ?? 0)}
          />
        ) : (
          <Metric size="mobile-strip" value={sharePriceDisplay} label="Share Price" chip={staleChip} />
        )}
        {isSui && profit && (
          <Metric
            size="mobile-strip"
            value={signedPct(profit.returnPct)}
            label="Return"
            valueColorClass={pnlColor(profit.returnPct)}
            chip={athChip}
          />
        )}
        {isHedera && projectedPct != null && (
          <Metric
            size="mobile-strip"
            value={signedPct(projectedPct)}
            label="24h @ 2×"
            valueColorClass={pnlColor(projectedPct)}
          />
        )}
        <Metric
          size="mobile-strip"
          value={Number(poolData.memberCount).toLocaleString()}
          label={poolData.memberCount === 1 ? 'Member' : 'Members'}
        />
      </div>

      {/* Desktop grid — Total Value + Total Shares removed (chart owns them).
          Hedera gets 4 tiles: Members · Share Price (actual) · Projected @ 2× ·
          Projected Share Price. SUI gets Return · Profit · Members · Share Price. */}
      <div className={`hidden sm:grid gap-3 sm:gap-4 ${(isSui || isHedera) ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2'}`}>
        {isSui && profit && (
          <Metric
            size="desktop"
            value={signedPct(profit.returnPct)}
            label="Total Return"
            valueColorClass={pnlColor(profit.returnPct)}
            chip={athChip}
          />
        )}
        {isSui && profit && profit.profitUsd !== null && (
          <Metric
            size="desktop"
            value={signedUsd(profit.profitUsd)}
            label="Total Profit (USDC)"
            valueColorClass={pnlColor(profit.profitUsd)}
          />
        )}
        <Metric
          size="desktop"
          value={Number(poolData.memberCount).toLocaleString()}
          label={poolData.memberCount === 1 ? 'Pool Member' : 'Pool Members'}
        />
        <Metric size="desktop" value={sharePriceDisplay} label={sharePriceSubtext} chip={staleChip} />
        {isHedera && projectedPct != null && (
          <Metric
            size="desktop"
            value={signedPct(projectedPct)}
            label="Strategy Return · 24h @ 2×"
            valueColorClass={pnlColor(projectedPct)}
          />
        )}
        {isHedera && projectedShare != null && (
          <Metric
            size="desktop"
            value={`$${projectedShare.toFixed(4)}`}
            label="Strategy NAV · 24h @ 2×"
            valueColorClass={pnlColor(projectedPct ?? 0)}
          />
        )}
      </div>
    </div>
  );
});
