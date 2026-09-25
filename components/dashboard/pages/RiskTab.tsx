'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity, Shield, TrendingUp, TrendingDown, AlertTriangle,
  CheckCircle2, Clock, Layers, Database, Zap, Eye,
} from 'lucide-react';
import { logger } from '@/lib/utils/logger';
import { NavHistoryChart } from '@/components/dashboard/NavHistoryChart';

interface HedgeRow {
  market: string;
  side: 'LONG' | 'SHORT';
  notionalUsd: number;
  unrealizedPnlUsd: number;
  leverage: number;
  ageMinutes: number;
}

interface CronHealth {
  key: string;
  ageMinutes: number;
  status: 'ok' | 'warn' | 'stale';
}

interface ZkAttestationRow {
  market: string;
  side: string;
  zkProofHash: string;
  createdAt: string;
}

interface DefenseState {
  gates: {
    portfolioDriverExecute: boolean;
    staleHedgeAutoClose: boolean;
    alertResponseExecute: boolean;
    alertResponseExecuteHalt: boolean;
    profitLockDisable: boolean;
    suiAutoHedgeDisable: boolean;
  };
  dustFlagsCount: number;
  activeHaltsCount: number;
  integrityDriftCount: number;
  activeHalts?: Array<{ name: string; untilIso: string; reason?: string }>;
  integrityDriftKeys?: string[];
}

interface IncidentsState {
  last24h: { KILL: number; ERROR: number; WARN: number };
  last7d: { KILL: number; ERROR: number; WARN: number };
  lastKillMinutesAgo: number | null;
  lastKillCategory: 'dust' | 'halt' | 'phantom' | 'deploy-drift' | 'other' | null;
}

interface CompositionState {
  asOf: string | null;
  byAsset: Record<string, number>;
  unhedgeable: string[];
}

interface HedgeHistoryState {
  settledCount: number;
  winCount: number;
  lossCount: number;
  totalPnlUsd: number;
  recent: Array<{
    id: number;
    market: string;
    side: 'LONG' | 'SHORT';
    notionalUsd: number;
    pnlUsd: number;
    closedAt: string;
    durationHours: number;
  }>;
}

interface PaperTraderState {
  navUsd: number;
  startingNavUsd: number;
  cumRealizedUsd: number;
  trades: number;
  wins: number;
  losses: number;
  winRatePct: number;
  lastTickIso: string | null;
  activePositionsCount: number;
}

interface RiskOverview {
  asOf: string;
  platform: {
    tvlUsd: number;
    netCapitalDeposited: number;
    netCapitalReturn: { absoluteUsd: number; percent: number };
    memberCount: number;
    sharePrice: number;
    peakSharePrice: number;
    drawdownPct: number;
    sharePriceReturn: number;
  };
  hedge: {
    activeCount: number;
    totalNotionalUsd: number;
    totalUnrealizedPnlUsd: number;
    coverageRatio: number;
    positions: HedgeRow[];
  };
  reconciliation: {
    cronHealth: CronHealth[];
    healthyCount: number;
    warnCount: number;
    staleCount: number;
  };
  zkAttestations: {
    last24hCount: number;
    recentFeed: ZkAttestationRow[];
  };
  signals: Record<string, { direction: string; confidence: number }>;
  defense?: DefenseState;
  incidents?: IncidentsState;
  composition?: CompositionState;
  hedgeHistory?: HedgeHistoryState;
  paperTrader?: PaperTraderState;
}

function fmtUsd(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}
function fmtPct(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(decimals)}%`;
}
function fmtAge(min: number): string {
  if (!Number.isFinite(min)) return '∞';
  if (min < 60) return `${min.toFixed(1)} min`;
  return `${(min / 60).toFixed(1)} h`;
}

function StatusDot({ status }: { status: 'ok' | 'warn' | 'stale' }) {
  const color = status === 'ok' ? 'bg-green-500' : status === 'warn' ? 'bg-amber-500' : 'bg-red-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

function StatCard({ label, value, sub, icon: Icon, tone = 'neutral' }: {
  label: string; value: string; sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'positive' | 'negative' | 'warn' | 'critical';
}) {
  const toneClass = tone === 'positive' ? 'text-green-700'
    : tone === 'negative' ? 'text-red-700'
    : tone === 'critical' ? 'text-red-700'
    : tone === 'warn' ? 'text-amber-700'
    : 'text-[#1d1d1f]';
  return (
    <div className="bg-white border border-black/5 rounded-2xl p-3 sm:p-4 md:p-5 min-w-0">
      <div className="flex items-center gap-2 text-[#86868b] text-[11px] sm:text-[12px] font-medium mb-1.5 sm:mb-2 min-w-0">
        <Icon className="w-3.5 h-3.5 flex-shrink-0" /> <span className="truncate">{label}</span>
      </div>
      <div className={`text-lg sm:text-2xl md:text-[28px] font-semibold tracking-[-0.02em] tabular-nums break-all ${toneClass}`}>{value}</div>
      {sub && <div className="text-[11px] sm:text-[13px] text-[#86868b] mt-1 truncate">{sub}</div>}
    </div>
  );
}

function DefenseGateBadge({ label, on, danger }: { label: string; on: boolean; danger?: boolean }) {
  // `danger` inverts the color meaning. E.g. PROFIT_LOCK_DISABLE=on is BAD (safety off).
  const isGood = danger ? !on : on;
  const bg = isGood ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700';
  const dot = isGood ? 'bg-green-500' : 'bg-amber-500';
  return (
    <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium ${bg}`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className="font-mono">{label}</span>
      <span className="opacity-60">{on ? 'ON' : 'OFF'}</span>
    </div>
  );
}

function DefenseStatusPanel({ d, i }: { d: DefenseState; i?: IncidentsState }) {
  const drift = d.dustFlagsCount + d.activeHaltsCount + d.integrityDriftCount;
  return (
    <section className="bg-white border border-black/5 rounded-2xl p-3 sm:p-5 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3 sm:mb-4">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-[#1d1d1f] flex-shrink-0" />
          <h2 className="text-base sm:text-[17px] font-semibold text-[#1d1d1f]">v0.3.0 defense stack</h2>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] sm:text-[12px] text-[#86868b] tabular-nums">
          <span>Dust flags: <strong className="text-[#1d1d1f]">{d.dustFlagsCount}</strong></span>
          <span>Active halts: <strong className="text-[#1d1d1f]">{d.activeHaltsCount}</strong></span>
          <span>Integrity drift: <strong className={drift > 0 ? 'text-amber-700' : 'text-[#1d1d1f]'}>{d.integrityDriftCount}</strong></span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <DefenseGateBadge label="PortfolioDriver" on={d.gates.portfolioDriverExecute} />
        <DefenseGateBadge label="StaleHedgeClose" on={d.gates.staleHedgeAutoClose} />
        <DefenseGateBadge label="AlertResponse" on={d.gates.alertResponseExecute} />
        <DefenseGateBadge label="AlertHalt" on={d.gates.alertResponseExecuteHalt} />
        <DefenseGateBadge label="ProfitLockDISABLE" on={d.gates.profitLockDisable} danger />
        <DefenseGateBadge label="AutoHedgeDISABLE" on={d.gates.suiAutoHedgeDisable} danger />
      </div>

      {(d.activeHalts?.length ?? 0) > 0 && (
        <div className="mt-4 pt-4 border-t border-black/5">
          <div className="text-[11px] sm:text-[12px] font-medium text-[#86868b] uppercase tracking-wide mb-2">
            Active halts
          </div>
          <div className="space-y-1.5">
            {d.activeHalts!.map((h) => {
              const untilMs = new Date(h.untilIso).getTime();
              const minsLeft = Math.max(0, Math.round((untilMs - Date.now()) / 60000));
              return (
                <div key={h.name} className="bg-amber-50 border border-amber-200 rounded-md px-2.5 py-2 text-[12px]">
                  <div className="flex items-center justify-between gap-2 mb-0.5">
                    <span className="font-mono text-amber-800 truncate">{h.name}</span>
                    <span className="text-[11px] text-amber-700 flex-shrink-0 tabular-nums">
                      clears in {fmtAge(minsLeft)}
                    </span>
                  </div>
                  {h.reason && <div className="text-[11px] text-[#5a4a1f] leading-snug">{h.reason}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {(d.integrityDriftKeys?.length ?? 0) > 0 && (
        <div className="mt-4 pt-4 border-t border-black/5">
          <div className="text-[11px] sm:text-[12px] font-medium text-[#86868b] uppercase tracking-wide mb-2">
            Integrity drift ({d.integrityDriftKeys!.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {d.integrityDriftKeys!.map((k) => (
              <span
                key={k}
                className="font-mono text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5"
                title={k}
              >
                {k}
              </span>
            ))}
          </div>
        </div>
      )}

      {i && (
        <div className="mt-4 pt-4 border-t border-black/5">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] sm:text-[12px] font-medium text-[#86868b] uppercase tracking-wide">
              Operational incidents
            </div>
            <div className="text-[11px] text-[#86868b]">
              {i.lastKillMinutesAgo == null
                ? 'no KILL in ring'
                : `last KILL ${fmtAge(i.lastKillMinutesAgo)} ago${i.lastKillCategory ? ` (${i.lastKillCategory})` : ''}`}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-[12px]">
            <div className="bg-[#f5f5f7] rounded-lg px-2.5 py-2">
              <div className="text-[10px] text-[#86868b] uppercase">24h</div>
              <div className="flex gap-2 tabular-nums">
                <span className={i.last24h.KILL > 0 ? 'text-red-700 font-semibold' : 'text-[#1d1d1f]'}>{i.last24h.KILL}K</span>
                <span className={i.last24h.ERROR > 0 ? 'text-red-700' : 'text-[#86868b]'}>{i.last24h.ERROR}E</span>
                <span className={i.last24h.WARN > 0 ? 'text-amber-700' : 'text-[#86868b]'}>{i.last24h.WARN}W</span>
              </div>
            </div>
            <div className="bg-[#f5f5f7] rounded-lg px-2.5 py-2">
              <div className="text-[10px] text-[#86868b] uppercase">7d</div>
              <div className="flex gap-2 tabular-nums">
                <span className={i.last7d.KILL > 0 ? 'text-red-700 font-semibold' : 'text-[#1d1d1f]'}>{i.last7d.KILL}K</span>
                <span className={i.last7d.ERROR > 0 ? 'text-red-700' : 'text-[#86868b]'}>{i.last7d.ERROR}E</span>
                <span className={i.last7d.WARN > 0 ? 'text-amber-700' : 'text-[#86868b]'}>{i.last7d.WARN}W</span>
              </div>
            </div>
            <div className="bg-[#f5f5f7] rounded-lg px-2.5 py-2">
              <div className="text-[10px] text-[#86868b] uppercase">Ring buffer</div>
              <div className="tabular-nums text-[#86868b]">200 entries max</div>
            </div>
          </div>
        </div>
      )}

      <p className="text-[11px] text-[#86868b] mt-3 leading-relaxed">
        Live gate footprint from the deployed build. Green = safety is engaged; amber = OFF (either
        pending rollout or an emergency kill-switch is active). Drift counters read the same cron_state
        keys the state-integrity fsck watches.
      </p>
    </section>
  );
}

const ASSET_COLORS: Record<string, string> = {
  USDC: 'bg-green-400',
  BTC: 'bg-amber-400',
  ETH: 'bg-purple-400',
  SUI: 'bg-blue-400',
};

function PoolCompositionPanel({ c }: { c: CompositionState }) {
  const entries = Object.entries(c.byAsset)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (total === 0) return null;
  return (
    <section className="bg-white border border-black/5 rounded-2xl p-3 sm:p-5 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3 sm:mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-[#1d1d1f] flex-shrink-0" />
          <h2 className="text-base sm:text-[17px] font-semibold text-[#1d1d1f]">Pool composition</h2>
        </div>
        <div className="text-[11px] text-[#86868b]">
          allocation as of {c.asOf ? new Date(c.asOf).toLocaleTimeString() : '—'}
        </div>
      </div>

      <div className="h-6 sm:h-7 rounded-lg overflow-hidden flex bg-[#f5f5f7] mb-3">
        {entries.map(([asset, pct]) => (
          <div
            key={asset}
            className={ASSET_COLORS[asset] || 'bg-gray-400'}
            style={{ width: `${(pct / total) * 100}%` }}
            title={`${asset} ${pct.toFixed(1)}%`}
          />
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[12px]">
        {['USDC', 'BTC', 'ETH', 'SUI'].map((asset) => {
          const pct = c.byAsset[asset] ?? 0;
          const unhedgeable = c.unhedgeable.includes(asset);
          return (
            <div key={asset} className="flex items-center gap-2 min-w-0">
              <span className={`inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0 ${ASSET_COLORS[asset] || 'bg-gray-400'} ${pct === 0 ? 'opacity-30' : ''}`} />
              <span className={`font-mono truncate ${pct === 0 ? 'text-[#86868b]' : 'text-[#1d1d1f]'}`}>
                {asset} <span className="tabular-nums">{pct.toFixed(1)}%</span>
              </span>
              {unhedgeable && (
                <span className="text-[10px] text-amber-700 flex-shrink-0" title="Hedgeability clamp: current NAV too small for this asset's perp minQty">
                  min-clamp
                </span>
              )}
            </div>
          );
        })}
      </div>

      {c.unhedgeable.length > 0 && (
        <p className="text-[11px] text-[#86868b] mt-3 leading-relaxed">
          <span className="text-amber-700 font-medium">{c.unhedgeable.join(', ')}</span> at 0% by design:
          at current NAV, allocating there would produce a perp hedge below the venue's minQty (creates dust).
          Hedgeability clamp redirects to USDC / other assets until NAV grows past the threshold.
        </p>
      )}
    </section>
  );
}

function HedgeHistoryPanel({ h }: { h: HedgeHistoryState }) {
  const winRate = h.settledCount > 0 ? (h.winCount / h.settledCount) * 100 : 0;
  const pnlPositive = h.totalPnlUsd >= 0;
  return (
    <section className="bg-white border border-black/5 rounded-2xl p-3 sm:p-5 min-w-0 overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3 sm:mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#1d1d1f] flex-shrink-0" />
          <h2 className="text-base sm:text-[17px] font-semibold text-[#1d1d1f]">Settled hedge track record</h2>
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] sm:text-[12px] text-[#86868b] tabular-nums">
          <span>Settled: <strong className="text-[#1d1d1f]">{h.settledCount}</strong></span>
          <span>Win rate: <strong className="text-[#1d1d1f]">{winRate.toFixed(1)}%</strong></span>
          <span>Realised: <strong className={pnlPositive ? 'text-green-700' : 'text-red-700'}>{fmtUsd(h.totalPnlUsd)}</strong></span>
        </div>
      </div>
      {h.recent.length === 0 ? (
        <div className="text-[#86868b] text-xs sm:text-[13px] py-4 text-center">No settled hedges yet.</div>
      ) : (
        <div className="-mx-3 sm:mx-0 overflow-x-auto">
          <div className="min-w-[520px] sm:min-w-0 px-3 sm:px-0">
            <div className="grid grid-cols-12 gap-2 pb-2 mb-1 border-b border-black/5 text-[10px] sm:text-[11px] text-[#86868b] uppercase tracking-wide font-medium">
              <div className="col-span-3">Market</div>
              <div className="col-span-2 text-right">Notional</div>
              <div className="col-span-2 text-right">Realised</div>
              <div className="col-span-2 text-right">Duration</div>
              <div className="col-span-3 text-right">Closed</div>
            </div>
            <div>
              {h.recent.map((r) => {
                const pnlPos = r.pnlUsd >= 0;
                return (
                  <div key={r.id} className="grid grid-cols-12 gap-2 py-2.5 border-b border-black/5 last:border-b-0 items-center text-[13px]">
                    <div className="col-span-3 font-semibold text-[#1d1d1f] flex items-center gap-2">
                      <span className="truncate">{r.market}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${r.side === 'LONG' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                        {r.side}
                      </span>
                    </div>
                    <div className="col-span-2 text-right font-mono text-[#86868b]">{fmtUsd(r.notionalUsd)}</div>
                    <div className={`col-span-2 text-right font-mono font-medium ${pnlPos ? 'text-green-700' : 'text-red-700'}`}>
                      {fmtUsd(r.pnlUsd)}
                    </div>
                    <div className="col-span-2 text-right text-[12px] text-[#86868b]">{r.durationHours.toFixed(1)}h</div>
                    <div className="col-span-3 text-right text-[12px] text-[#86868b]">
                      {new Date(r.closedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      <p className="text-[11px] text-[#86868b] mt-3 leading-relaxed">
        Settled = closed hedges with non-zero realised PnL. Rows with $0 PnL (reconciler-adopted
        orphans and phantom closes) are excluded. They're bookkeeping entries, not real trades.
      </p>
    </section>
  );
}

function PaperTraderPanel({ p }: { p: PaperTraderState }) {
  const cumReturn = p.startingNavUsd > 0 ? ((p.navUsd - p.startingNavUsd) / p.startingNavUsd) * 100 : 0;
  const lastTickMins = p.lastTickIso
    ? Math.round((Date.now() - new Date(p.lastTickIso).getTime()) / 60000)
    : null;
  const pnlPositive = p.cumRealizedUsd >= 0;
  return (
    <section className="bg-white border border-black/5 rounded-2xl p-3 sm:p-5 min-w-0">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3 sm:mb-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-[#1d1d1f] flex-shrink-0" />
          <h2 className="text-base sm:text-[17px] font-semibold text-[#1d1d1f]">Shadow trader</h2>
          <span className="text-[11px] text-[#86868b] hidden sm:inline">
            /paper — full stack against ${p.startingNavUsd.toLocaleString()} notional
          </span>
        </div>
        {lastTickMins != null && (
          <span className="text-[11px] text-[#86868b] tabular-nums">
            last tick {fmtAge(lastTickMins)} ago
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
        <StatCard
          label="NAV"
          value={fmtUsd(p.navUsd)}
          sub={`${fmtPct(cumReturn)} since inception`}
          icon={cumReturn >= 0 ? TrendingUp : TrendingDown}
          tone={cumReturn >= 0 ? 'positive' : 'negative'}
        />
        <StatCard
          label="Realized PnL"
          value={fmtUsd(p.cumRealizedUsd)}
          sub={`${p.trades} trades · ${p.winRatePct.toFixed(1)}% win`}
          icon={pnlPositive ? TrendingUp : TrendingDown}
          tone={pnlPositive ? 'positive' : 'negative'}
        />
        <StatCard
          label="Win / loss"
          value={`${p.wins} / ${p.losses}`}
          sub="lifetime"
          icon={Activity}
        />
        <StatCard
          label="Active positions"
          value={String(p.activePositionsCount)}
          sub={p.activePositionsCount > 0 ? 'live now' : 'flat'}
          icon={Shield}
        />
      </div>

      <p className="text-[11px] text-[#86868b] mt-3 leading-relaxed">
        Same signal pipeline, agent guards, and stop/take-profit machinery as the live pool — running against
        a simulated ${p.startingNavUsd.toLocaleString()} book on Bakchodi every 5 minutes. Public receipts at{' '}
        <a href="/paper" className="text-ios-blue hover:underline">/paper</a>.
      </p>
    </section>
  );
}

function HedgePositionRow({ h }: { h: HedgeRow }) {
  const pnlPositive = h.unrealizedPnlUsd >= 0;
  return (
    <div className="grid grid-cols-12 gap-2 py-2.5 border-b border-black/5 last:border-b-0 items-center text-[13px]">
      <div className="col-span-3 font-semibold text-[#1d1d1f]">
        {h.market}
        <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded font-medium ${h.side === 'LONG' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {h.side}
        </span>
      </div>
      <div className="col-span-2 text-right font-mono text-[#1d1d1f]">{fmtUsd(h.notionalUsd)}</div>
      <div className="col-span-2 text-right text-[#86868b]">{h.leverage}×</div>
      <div className={`col-span-2 text-right font-mono font-medium ${pnlPositive ? 'text-green-700' : 'text-red-700'}`}>
        {fmtUsd(h.unrealizedPnlUsd)}
      </div>
      <div className="col-span-3 text-right text-[12px] text-[#86868b]">{fmtAge(h.ageMinutes)} ago</div>
    </div>
  );
}

async function fetchRiskOverview(): Promise<RiskOverview> {
  const r = await fetch('/api/platform/risk-overview');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export function RiskTab() {
  const { data, isPending: loading, error: queryError } = useQuery({
    queryKey: ['platform-risk-overview'],
    queryFn: fetchRiskOverview,
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
  const error = queryError
    ? (queryError instanceof Error ? queryError.message : String(queryError))
    : null;
  if (queryError) {
    logger.error('[RiskPage] fetch failed', { error });
  }

  return (
    // Navbar clearance + horizontal tab strip live in dashboard/layout.tsx.
    <div className="max-w-6xl mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-8 md:py-10 space-y-3 sm:space-y-6 min-w-0">
      <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 sm:gap-4">
        <div className="min-w-0">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] uppercase tracking-wide font-medium mb-1">Platform risk overview</div>
          <h1 className="text-2xl sm:text-3xl md:text-[32px] font-semibold text-[#1d1d1f] tracking-[-0.02em] break-words">
            ZKward. Live institutional view
          </h1>
          <p className="text-xs sm:text-[13px] text-[#86868b] mt-1 leading-relaxed">
            Real-time aggregate metrics for every shipped fund and the operational layer behind them.
            Updates every 60 seconds.
          </p>
        </div>
        {data?.asOf && (
          <div className="text-[11px] sm:text-[12px] text-[#86868b] font-mono tabular-nums flex-shrink-0">
            as of {new Date(data.asOf).toLocaleTimeString()}
          </div>
        )}
      </header>

      {loading && !data && (
        <div className="space-y-6">
          {/* Platform AUM skeleton — 4-tile grid mirrors the loaded state. */}
          <section>
            <div className="h-3 w-32 bg-[#f5f5f7] rounded animate-pulse mb-3" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="bg-white border border-black/5 rounded-2xl p-4 h-[104px] animate-pulse">
                  <div className="h-3 w-16 bg-[#f5f5f7] rounded mb-3" />
                  <div className="h-6 w-24 bg-[#f5f5f7] rounded mb-2" />
                  <div className="h-3 w-12 bg-[#f5f5f7] rounded" />
                </div>
              ))}
            </div>
          </section>
          {/* Fund table skeleton */}
          <section>
            <div className="h-3 w-40 bg-[#f5f5f7] rounded animate-pulse mb-3" />
            <div className="bg-white border border-black/5 rounded-2xl p-4 space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-8 bg-[#f5f5f7] rounded animate-pulse" />
              ))}
            </div>
          </section>
        </div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-[13px]">
          Failed to load: {error}
        </div>
      )}

      {data && (
        <>
          {/* Platform TVL + return */}
          <section>
            <h2 className="text-[13px] font-medium text-[#86868b] uppercase tracking-wide mb-3">Platform AUM</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard
                label="Total NAV"
                value={fmtUsd(data.platform.tvlUsd)}
                sub={`${data.platform.memberCount} members`}
                icon={Layers}
              />
              <StatCard
                label="Capital-flow return"
                value={fmtUsd(data.platform.netCapitalReturn.absoluteUsd)}
                sub={`${fmtPct(data.platform.netCapitalReturn.percent)} on ${fmtUsd(data.platform.netCapitalDeposited)} deposits`}
                icon={data.platform.netCapitalReturn.absoluteUsd >= 0 ? TrendingUp : TrendingDown}
                tone={data.platform.netCapitalReturn.absoluteUsd >= 0 ? 'positive' : 'negative'}
              />
              <StatCard
                label="Share price"
                value={`$${data.platform.sharePrice.toFixed(4)}`}
                sub={`${fmtPct(data.platform.sharePriceReturn)} since inception`}
                icon={data.platform.sharePriceReturn >= 0 ? TrendingUp : TrendingDown}
                tone={data.platform.sharePriceReturn >= 0 ? 'positive' : 'negative'}
              />
              <StatCard
                label={data.platform.drawdownPct > 0 ? 'Drawdown from ATH' : 'At ATH'}
                value={data.platform.drawdownPct > 0 ? fmtPct(-data.platform.drawdownPct) : 'New peak'}
                sub={`peak $${data.platform.peakSharePrice.toFixed(4)}`}
                icon={data.platform.drawdownPct > 3 ? AlertTriangle : Eye}
                tone={
                  data.platform.drawdownPct >= 20 ? 'critical'
                  : data.platform.drawdownPct > 5 ? 'warn'
                  : 'neutral'
                }
              />
            </div>
          </section>

          {/* Share-price history — visual centerpiece */}
          <NavHistoryChart />

          {/* Pool composition — where's the money */}
          {data.composition && <PoolCompositionPanel c={data.composition} />}

          {/* Hedge engine */}
          <section className="bg-white border border-black/5 rounded-2xl p-3 sm:p-5 min-w-0 overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3 sm:mb-4 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <Shield className="w-4 h-4 text-[#1d1d1f] flex-shrink-0" />
                <h2 className="text-base sm:text-[17px] font-semibold text-[#1d1d1f] truncate">Hedge engine</h2>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:gap-4 text-[11px] sm:text-[12px] text-[#86868b] tabular-nums">
                <span>Coverage: <strong className="text-[#1d1d1f]">{(data.hedge.coverageRatio * 100).toFixed(0)}%</strong></span>
                <span>Active: <strong className="text-[#1d1d1f]">{data.hedge.activeCount}</strong></span>
                <span className={`font-medium ${data.hedge.totalUnrealizedPnlUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                  uPnL {fmtUsd(data.hedge.totalUnrealizedPnlUsd)}
                </span>
              </div>
            </div>
            {data.hedge.positions.length === 0 ? (
              <div className="text-[#86868b] text-xs sm:text-[13px] py-4 text-center">No active hedges.</div>
            ) : (
              <div className="-mx-3 sm:mx-0 overflow-x-auto">
                <div className="min-w-[520px] sm:min-w-0 px-3 sm:px-0">
                  <div className="grid grid-cols-12 gap-2 pb-2 mb-1 border-b border-black/5 text-[10px] sm:text-[11px] text-[#86868b] uppercase tracking-wide font-medium">
                    <div className="col-span-3">Market</div>
                    <div className="col-span-2 text-right">Notional</div>
                    <div className="col-span-2 text-right">Leverage</div>
                    <div className="col-span-2 text-right">uPnL</div>
                    <div className="col-span-3 text-right">Age</div>
                  </div>
                  <div>
                    {data.hedge.positions.map((h, i) => <HedgePositionRow key={`${h.market}-${i}`} h={h} />)}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* Settled hedge track record — actual trading PnL */}
          {data.hedgeHistory && <HedgeHistoryPanel h={data.hedgeHistory} />}

          {/* v0.3.0 defense stack. Gate footprint + drift counters + incident summary */}
          {data.defense && <DefenseStatusPanel d={data.defense} i={data.incidents} />}

          {/* Two-column: reconciliation + ZK attestations */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Reconciliation */}
            <section className="bg-white border border-black/5 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Database className="w-4 h-4 text-[#1d1d1f]" />
                  <h2 className="text-[17px] font-semibold text-[#1d1d1f]">Operational reconciliation</h2>
                </div>
                <div className="flex items-center gap-3 text-[12px]">
                  <span className="text-green-700">{data.reconciliation.healthyCount} ok</span>
                  {data.reconciliation.warnCount > 0 && <span className="text-amber-700">{data.reconciliation.warnCount} warn</span>}
                  {data.reconciliation.staleCount > 0 && <span className="text-red-700">{data.reconciliation.staleCount} stale</span>}
                </div>
              </div>
              <div className="space-y-1.5">
                {data.reconciliation.cronHealth.map((c) => (
                  <div key={c.key} className="flex items-center justify-between text-[13px] py-1.5 border-b border-black/5 last:border-b-0">
                    <div className="flex items-center gap-2">
                      <StatusDot status={c.status} />
                      <span className="font-mono text-[12px] text-[#1d1d1f]">{c.key}</span>
                    </div>
                    <span className={`text-[12px] font-medium ${c.status === 'ok' ? 'text-[#86868b]' : c.status === 'warn' ? 'text-amber-700' : 'text-red-700'}`}>
                      {fmtAge(c.ageMinutes)} ago
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-[#86868b] mt-3">
                Three independent reconciliation loops: on-chain Move state ↔ BlueFin venue ↔ Postgres mirror.
              </p>
            </section>

            {/* ZK attestation feed */}
            <section className="bg-white border border-black/5 rounded-2xl p-5">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-[#1d1d1f]" />
                  <h2 className="text-[17px] font-semibold text-[#1d1d1f]">ZK attestation feed</h2>
                </div>
                <div className="text-[12px] text-[#86868b]">
                  <strong className="text-[#1d1d1f]">{data.zkAttestations.last24hCount}</strong> in 24h
                </div>
              </div>
              {data.zkAttestations.recentFeed.length === 0 ? (
                <div className="text-[#86868b] text-[13px] py-4 text-center">No recent ZK proofs on attached hedges.</div>
              ) : (
                <div className="space-y-1.5">
                  {data.zkAttestations.recentFeed.map((z, i) => (
                    <div key={i} className="flex items-center justify-between text-[12px] py-1.5 border-b border-black/5 last:border-b-0">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-3 h-3 text-green-700" />
                        <span className="text-[#1d1d1f]">{z.market} {z.side}</span>
                        <span className="font-mono text-[11px] text-[#86868b]">{z.zkProofHash}</span>
                      </div>
                      <span className="text-[#86868b]">{new Date(z.createdAt).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-[#86868b] mt-3">
                Post-quantum STARK proofs (NIST P-521) bound on-chain via <code className="bg-[#f5f5f7] px-1.5 py-0.5 rounded">zk_verifier.move</code>.
              </p>
            </section>
          </div>

          {/* Paper trader — mirror of the pool section but for the shadow book */}
          {data.paperTrader && <PaperTraderPanel p={data.paperTrader} />}

          {/* Signals strip — all assets in the trader universe, not just BTC/ETH */}
          {Object.keys(data.signals).length > 0 && (
            <section className="bg-white border border-black/5 rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Clock className="w-4 h-4 text-[#1d1d1f]" />
                <h2 className="text-[17px] font-semibold text-[#1d1d1f]">Live prediction signal</h2>
                <span className="text-[11px] text-[#86868b]">per asset · fused: Polymarket + Manifold + funding + momentum</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                {Object.entries(data.signals).map(([asset, s]) => {
                  const dirColor = s.direction === 'UP' ? 'text-green-700'
                    : s.direction === 'DOWN' ? 'text-red-700'
                    : 'text-[#1d1d1f]';
                  return (
                    <div key={asset} className="bg-[#f5f5f7] rounded-xl px-4 py-3">
                      <div className="text-[11px] text-[#86868b] font-mono">{asset}</div>
                      <div className={`text-[15px] font-semibold ${dirColor}`}>
                        {s.direction}
                        <span className="text-[12px] text-[#86868b] font-normal"> · {s.confidence}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <footer className="text-center text-[11px] text-[#86868b] pt-4">
            Every number on this page is verifiable on-chain or via <code className="bg-[#f5f5f7] px-1.5 py-0.5 rounded">/api/health/production</code>.
            Pool capped at $10K TVL by contract until external audit closes.
          </footer>
        </>
      )}
    </div>
  );
}
