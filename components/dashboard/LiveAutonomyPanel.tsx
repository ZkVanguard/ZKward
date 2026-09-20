'use client';

/**
 * LiveAutonomyPanel — wallet-agnostic proof-of-life for /dashboard.
 *
 * Renders the real autonomy state from /api/dashboard/autonomy-status:
 * cron heartbeats, trader stats, calibration, alarms, signals. Anyone
 * loading the dashboard (wallet or not) can immediately see the machine
 * is alive — that's the visible-track-record lever the pool needs to
 * attract deposits.
 *
 * Design language matches the homepage vault meter: Double-Bezel card,
 * ios-blue accent, tabular-nums, no marketing verbs. Refresh every 30s
 * to match the endpoint's CDN cache.
 */

import { memo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity, CheckCircle2, AlertCircle, TrendingUp, TrendingDown,
  Minus, ShieldAlert, Bot, Zap,
} from 'lucide-react';

interface CronHeartbeat {
  name: string;
  ageMinutes: number;
  status: 'fresh' | 'stale' | 'silent';
}

interface AutonomyStatus {
  fetchedAt: number;
  crons: CronHeartbeat[];
  trader: {
    trades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    totalPnlUsd: number;
    noEdgeStreakTicks: number;
    hoursDormant: number;
    lastSkipReason: string | null;
    activeTradeAsset: string | null;
  };
  hedges: {
    active: number;
    activeOnChainDust: number;
    closedLifetime: number;
    realizedPnlLifetime: number;
  };
  alarms: {
    dustFlags: number;
    starvationAlerted: boolean;
    haltsActive: number;
    profitLockActive: boolean;
  };
  signals: Record<string, { side: 'LONG' | 'SHORT' | null; confidence: number; reason: string }>;
}

async function fetchAutonomy(): Promise<AutonomyStatus> {
  const r = await fetch('/api/dashboard/autonomy-status');
  if (!r.ok) throw new Error(`autonomy status ${r.status}`);
  return r.json();
}

function StatusDot({ status }: { status: 'fresh' | 'stale' | 'silent' }) {
  const color =
    status === 'fresh' ? 'bg-ios-green' :
    status === 'stale' ? 'bg-ios-orange' : 'bg-ios-red';
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} aria-hidden />;
}

function SignalPill({
  asset, side, confidence,
}: { asset: string; side: 'LONG' | 'SHORT' | null; confidence: number }) {
  const Icon = side === 'LONG' ? TrendingUp : side === 'SHORT' ? TrendingDown : Minus;
  // Icon uses ios-* (3:1 minimum for non-text. Passes); text uses darker
  // green-700 / red-700 (4.5:1 required for 12px small caption. Ios-green
  // is 1.85:1 and ios-red is 3.76:1, both fail).
  const iconTone =
    side === 'LONG' ? 'text-ios-green' :
    side === 'SHORT' ? 'text-ios-red' : 'text-label-tertiary';
  const textTone =
    side === 'LONG' ? 'text-green-700 dark:text-green-400' :
    side === 'SHORT' ? 'text-red-700 dark:text-red-400' : 'text-label-tertiary';
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="w-10 text-caption-1 font-semibold text-label-primary tabular-nums">{asset}</span>
      <Icon className={`w-3.5 h-3.5 ${iconTone}`} strokeWidth={2.5} />
      <span className={`text-caption-1 font-semibold ${textTone}`}>{side ?? 'WAIT'}</span>
      <span className="text-caption-2 text-label-tertiary tabular-nums ml-auto">{confidence}%</span>
    </div>
  );
}

export const LiveAutonomyPanel = memo(function LiveAutonomyPanel() {
  const { data, isPending, error } = useQuery({
    queryKey: ['dashboard-autonomy-status'],
    queryFn: fetchAutonomy,
    refetchInterval: 30_000,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  if (isPending) {
    return (
      <div className="p-6 sm:p-8 space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-system-bg-secondary rounded-ios-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 sm:p-8 text-center">
        <AlertCircle className="w-6 h-6 text-label-tertiary mx-auto mb-2" />
        <p className="text-caption-1 text-label-tertiary">
          Autonomy status unavailable. Check again in a moment.
        </p>
      </div>
    );
  }

  const { crons, trader, hedges, alarms, signals } = data;
  const freshCrons = crons.filter((c) => c.status === 'fresh').length;
  const pnlPositive = trader.totalPnlUsd >= 0;

  return (
    <div className="p-4 sm:p-6 space-y-6">
      {/* Top KPI strip — 4 stats matching the vault-meter aesthetic */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <KpiTile
          icon={<Zap className="w-4 h-4" />}
          label="Crons healthy"
          value={`${freshCrons}/${crons.length}`}
          tone={freshCrons === crons.length ? 'good' : 'warn'}
        />
        <KpiTile
          icon={<Bot className="w-4 h-4" />}
          label="Trader trades"
          value={String(trader.trades)}
          hint={`${trader.winRatePct}% win rate`}
        />
        <KpiTile
          icon={pnlPositive ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
          label="Realized PnL"
          value={`${pnlPositive ? '+' : '−'}$${Math.abs(trader.totalPnlUsd).toFixed(2)}`}
          tone={pnlPositive ? 'good' : 'bad'}
        />
        <KpiTile
          icon={<ShieldAlert className="w-4 h-4" />}
          label="Active hedges"
          value={String(hedges.active)}
          hint={hedges.activeOnChainDust > 0 ? `+${hedges.activeOnChainDust} dust` : undefined}
        />
      </div>

      {/* Alarms strip — only shown when something is firing */}
      {(alarms.starvationAlerted || alarms.haltsActive > 0 || alarms.dustFlags > 0 || alarms.profitLockActive) && (
        <div className="flex flex-wrap gap-2">
          {alarms.starvationAlerted && (
            <AlarmChip tone="warn" text="Trader starved (auto-topup pending)" />
          )}
          {alarms.haltsActive > 0 && (
            <AlarmChip tone="warn" text={`${alarms.haltsActive} halt${alarms.haltsActive === 1 ? '' : 's'} active`} />
          )}
          {alarms.dustFlags > 0 && (
            <AlarmChip tone="info" text={`${alarms.dustFlags} dust flag${alarms.dustFlags === 1 ? '' : 's'} (venue-locked)`} />
          )}
          {alarms.profitLockActive && (
            <AlarmChip tone="info" text="Profit-lock active" />
          )}
        </div>
      )}

      {/* Two-column: signals + crons */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section>
          <SectionHeader title="Live signals" caption="per-asset probability + recommended side" />
          <div className="divide-y divide-separator-opaque/20 border border-separator-opaque/30 rounded-ios-lg overflow-hidden bg-system-bg-primary">
            {Object.entries(signals).map(([asset, s]) => (
              <div key={asset} className="px-4">
                <SignalPill asset={asset} side={s.side} confidence={s.confidence} />
              </div>
            ))}
            {Object.keys(signals).length === 0 && (
              <p className="p-4 text-caption-1 text-label-tertiary">
                No live signals. Aggregator is warming up.
              </p>
            )}
          </div>
        </section>

        <section>
          <SectionHeader
            title="Cron heartbeats"
            caption={`${crons.length} background worker${crons.length === 1 ? '' : 's'} · scroll for more`}
          />
          {/* Container + gradient fade at bottom to signal overflow.
              Previously the list scrolled silently — users didn't know
              hidden rows existed. */}
          <div className="relative">
            <div className="border border-separator-opaque/30 rounded-ios-lg overflow-hidden bg-system-bg-primary max-h-[320px] overflow-y-auto">
              {crons.map((c) => (
                <div
                  key={c.name}
                  className="flex items-center gap-2.5 px-4 py-2 border-b border-separator-opaque/20 last:border-b-0"
                >
                  <StatusDot status={c.status} />
                  <span className="text-caption-1 font-medium text-label-primary truncate">
                    {c.name}
                  </span>
                  <span className="ml-auto text-caption-2 text-label-tertiary tabular-nums">
                    {c.ageMinutes < 60 ? `${c.ageMinutes}m` : `${Math.round(c.ageMinutes / 60)}h`}
                  </span>
                </div>
              ))}
            </div>
            {crons.length > 9 && (
              <div className="pointer-events-none absolute bottom-0 inset-x-0 h-8 bg-gradient-to-t from-white to-transparent rounded-b-ios-lg" />
            )}
          </div>
        </section>
      </div>

      {/* Trader status footer — one dense line of truth */}
      <div className="px-4 py-3 bg-system-bg-secondary rounded-ios-lg">
        <div className="flex items-center gap-2 mb-1">
          <Activity className="w-3.5 h-3.5 text-label-tertiary" />
          <span className="text-caption-2 uppercase tracking-wide font-semibold text-label-tertiary">
            Trader
          </span>
        </div>
        <p className="text-caption-1 text-label-secondary leading-relaxed">
          {trader.activeTradeAsset
            ? `Active: ${trader.activeTradeAsset}. `
            : `Idle. `}
          {trader.trades} lifetime trades ({trader.wins}W / {trader.losses}L).
          {hedges.closedLifetime > 0 && (
            <> Lifetime hedges: {hedges.closedLifetime} closed ({hedges.realizedPnlLifetime >= 0 ? '+' : '−'}${Math.abs(hedges.realizedPnlLifetime).toFixed(2)}).</>
          )}
          {trader.lastSkipReason && (
            <> Last skip: <span className="text-label-tertiary">{trader.lastSkipReason}</span></>
          )}
        </p>
      </div>
    </div>
  );
});

function KpiTile({
  icon, label, value, tone = 'neutral', hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad' | 'neutral';
  hint?: string;
}) {
  // 11px uppercase caption label: 4.5:1 required. ios-blue (#0069D9,
  // 5.22:1) is safe; the others aren't at small size. Swap for darker
  // Tailwind tones. Actual big-value number renders text-label-primary
  // (17.4:1 on white), so tone only styles the tiny caption chip.
  const toneClass =
    tone === 'good' ? 'text-green-700 dark:text-green-400' :
    tone === 'warn' ? 'text-orange-700 dark:text-orange-400' :
    tone === 'bad' ? 'text-red-700 dark:text-red-400' : 'text-ios-blue';
  return (
    <div className="rounded-ios-lg border border-separator-opaque/30 bg-system-bg-primary p-3">
      <div className={`flex items-center gap-1.5 ${toneClass} mb-1`}>
        {icon}
        <span className="text-caption-2 uppercase tracking-wide font-semibold">{label}</span>
      </div>
      <div className="text-title-3 font-bold tabular-nums text-label-primary">{value}</div>
      {hint && <div className="text-caption-2 text-label-tertiary tabular-nums mt-0.5">{hint}</div>}
    </div>
  );
}

function AlarmChip({ tone, text }: { tone: 'info' | 'warn' | 'bad'; text: string }) {
  // Chip text is 12px caption (small text → 4.5:1). Keep the softer
  // ios-*/10 backgrounds but pair with dark Tailwind orange/red so text
  // is readable. The pill dot uses bg-current, so it inherits the same
  // dark tone. Still visually red-on-red-tint, just accessible.
  const cls =
    tone === 'warn' ? 'bg-ios-orange/10 text-orange-800 dark:text-orange-300 border-ios-orange/20' :
    tone === 'bad' ? 'bg-ios-red/10 text-red-800 dark:text-red-300 border-ios-red/20' :
    'bg-ios-blue/10 text-ios-blue border-ios-blue/20';
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-caption-1 font-medium ${cls}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {text}
    </span>
  );
}

function SectionHeader({ title, caption }: { title: string; caption?: string }) {
  return (
    <div className="mb-3">
      <h3 className="text-headline font-semibold text-label-primary">{title}</h3>
      {caption && <p className="text-caption-1 text-label-tertiary mt-0.5">{caption}</p>}
    </div>
  );
}
