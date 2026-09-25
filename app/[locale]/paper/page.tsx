'use client';

/**
 * /paper — public paper-trader dashboard.
 *
 * Answers ONE question: does the aggregator's signal source have edge
 * net of realistic BlueFin-parity fees at $100k scale? Shows paper NAV
 * over time vs $100k buy-hold baseline, active position, closed-trade
 * table, per-asset breakdown, and the live signal snapshot the trader
 * is scoring against.
 *
 * Data source: /api/paper-trader/status (public, no auth).
 * Piggybacked on the polymarket-edge-trader 5-min tick.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
  Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Filler, Legend);

interface ActivePos {
  asset: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  markPrice: number | null;
  notionalUsd: number;
  leverage: number;
  openedAt: number;
  holdSeconds: number;
  unrealizedPnlUsd?: number;
  fundingAccruedUsd?: number;
  orderId: string | null;
}

interface Status {
  generatedAt: string;
  lastTickAt: string | null;
  config: {
    startingNavUsd: number;
    universe: string[];
    chain: string;
    portfolioId: number;
  };
  nav: {
    currentUsd: number;
    realizedUsd: number;
    peakUsd: number;
    startingUsd: number;
    cumReturnPct: number;
    drawdownFromPeakPct: number;
  };
  stats: {
    trades: number;
    wins: number;
    losses: number;
    winRatePct: number;
    cumRealizedUsd: number;
    lastRealizedUsd: number;
  };
  activePosition: ActivePos | null;
  activePositions?: ActivePos[];
  recentTrades: Array<{
    id: number;
    orderId: string;
    asset: string;
    side: string;
    notionalUsd: number;
    entryPrice: number;
    realizedPnlUsd: number;
    fundingUsd: number;
    openedAt: string;
    closedAt: string;
    reason: string;
  }>;
  perAsset: Record<string, { trades: number; wins: number; cumRealizedUsd: number }>;
  signals: Record<string, { recommendation: string; confidence: number; sources: number }>;
  navSeries: Array<{ ts: number; nav: number }>;
}

function fmtUsd(n: number): string {
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtDur(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export default function PaperTraderPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch('/api/paper-trader/status');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Status;
      setStatus(j);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const iv = setInterval(load, 30_000);
    return () => clearInterval(iv);
  }, []);

  const chartData = useMemo(() => {
    if (!status) return null;
    const series = status.navSeries ?? [];
    const labels = series.map((p) => new Date(p.ts).toLocaleTimeString());
    return {
      labels,
      datasets: [
        {
          label: 'Paper NAV',
          data: series.map((p) => p.nav),
          borderColor: '#0069D9',
          backgroundColor: 'rgba(0, 105, 217, 0.08)',
          fill: true,
          tension: 0.2,
          pointRadius: 0,
        },
        {
          label: `Buy-hold baseline ($${status.config.startingNavUsd.toLocaleString()})`,
          data: series.map(() => status.config.startingNavUsd),
          borderColor: '#86868B',
          borderDash: [6, 4],
          fill: false,
          pointRadius: 0,
        },
      ],
    };
  }, [status]);

  if (loading && !status) {
    return (
      <div className="min-h-screen bg-system-bg-primary text-label-primary pt-20 sm:pt-24 px-4 sm:px-6 md:px-8 pb-16">
        <div className="max-w-6xl mx-auto space-y-6 animate-pulse">
          <div className="h-10 w-2/3 bg-system-bg-secondary rounded-ios" />
          <div className="h-4 w-full bg-system-bg-secondary rounded-ios" />
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[0,1,2,3].map(i => (
              <div key={i} className="h-28 bg-system-bg-secondary rounded-ios-xl border border-separator-opaque/30" />
            ))}
          </div>
          <div className="h-72 bg-system-bg-secondary rounded-ios-xl border border-separator-opaque/30" />
        </div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="min-h-screen bg-system-bg-primary text-label-primary pt-20 sm:pt-24 px-4 sm:px-6 md:px-8 pb-16">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-2xl mb-4">Signal Stack in Production</h1>
          <div className="text-red-700">Failed to load: {error}</div>
        </div>
      </div>
    );
  }

  if (!status) return null;

  const returnColor = status.nav.cumReturnPct >= 0 ? 'text-green-700' : 'text-red-700';

  return (
    <div className="min-h-screen bg-system-bg-primary text-label-primary pt-20 sm:pt-24 px-4 sm:px-6 md:px-8 pb-16">
      <div className="max-w-6xl mx-auto space-y-6">
        <header>
          <h1 className="text-[28px] sm:text-[34px] md:text-[42px] font-display font-semibold tracking-[-0.03em] leading-[1.1] text-label-primary">Signal Stack in Production</h1>
          <p className="text-label-secondary mt-1">
            Live shadow-execution of the aggregator&apos;s output. 20 sources per asset, per-source
            hit-rate-weighted, autonomous entry + exit with adaptive stops. Mark-price fills, 13&nbsp;bp
            round-trip + 11% APR funding modeled. Answers: does the signal stack have edge net of
            fees at $100k?
          </p>
          <p className="text-xs text-label-tertiary mt-2">
            Last tick: {status.lastTickAt ? new Date(status.lastTickAt).toLocaleString() : 'never'}
            &nbsp;·&nbsp; Chain: {status.config.chain}
            &nbsp;·&nbsp; Universe: {status.config.universe.join(', ')}
          </p>
        </header>

        {/* Top-line NAV */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
            <div className="text-xs text-label-secondary uppercase">Current NAV</div>
            <div className="text-2xl font-bold mt-1">{fmtUsd(status.nav.currentUsd)}</div>
            <div className={`text-sm mt-1 ${returnColor}`}>{fmtPct(status.nav.cumReturnPct)}</div>
          </div>
          <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
            <div className="text-xs text-label-secondary uppercase">vs Buy-hold</div>
            <div className="text-2xl font-bold mt-1">
              {fmtUsd(status.nav.currentUsd - status.config.startingNavUsd)}
            </div>
            <div className="text-sm mt-1 text-label-secondary">
              baseline {fmtUsd(status.config.startingNavUsd)}
            </div>
          </div>
          <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
            <div className="text-xs text-label-secondary uppercase">Trades</div>
            <div className="text-2xl font-bold mt-1">{status.stats.trades}</div>
            <div className="text-sm mt-1 text-label-secondary">
              {status.stats.wins}W / {status.stats.losses}L
              {status.stats.trades > 0 && ` · ${status.stats.winRatePct.toFixed(0)}%`}
            </div>
          </div>
          <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
            <div className="text-xs text-label-secondary uppercase">Peak NAV</div>
            <div className="text-2xl font-bold mt-1">{fmtUsd(status.nav.peakUsd)}</div>
            <div className="text-sm mt-1 text-orange-700">
              {status.nav.drawdownFromPeakPct > 0.1
                ? `-${status.nav.drawdownFromPeakPct.toFixed(1)}% dd`
                : 'at peak'}
            </div>
          </div>
        </div>

        {/* Chart */}
        {chartData && chartData.labels.length > 0 && (
          <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
            <div className="h-64 md:h-80">
              <Line
                data={chartData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  interaction: { intersect: false, mode: 'index' },
                  plugins: {
                    legend: { labels: { color: '#1D1D1F' } },
                    tooltip: {
                      callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${fmtUsd(Number(ctx.parsed.y))}`,
                      },
                    },
                  },
                  scales: {
                    x: {
                      ticks: { color: '#6E6E73', maxTicksLimit: 8 },
                      grid: { color: 'rgba(198, 198, 200, 0.4)' },
                    },
                    y: {
                      ticks: {
                        color: '#6E6E73',
                        callback: (v) => fmtUsd(Number(v)),
                      },
                      grid: { color: 'rgba(198, 198, 200, 0.4)' },
                    },
                  },
                }}
              />
            </div>
          </div>
        )}

        {/* Active positions. Concurrent mode may hold up to
             PAPER_MAX_CONCURRENT (default 3). Falls back to the
             singular activePosition when the API is on an older
             deploy that doesn't yet return the array (PR #129). */}
        {(() => {
          const positions =
            status.activePositions ??
            (status.activePosition ? [status.activePosition] : []);
          if (positions.length === 0) return null;
          return (
            <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
              <div className="text-xs text-label-secondary uppercase mb-2">
                Active {positions.length === 1 ? 'Position' : `Positions (${positions.length})`}
              </div>
              <div className="space-y-2">
                {positions.map((p) => (
                  <div
                    key={p.orderId ?? `${p.asset}-${p.openedAt}`}
                    className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm border-b border-separator-opaque/30 last:border-0 pb-2 last:pb-0"
                  >
                    <div>
                      <div className="text-label-tertiary text-xs">Asset</div>
                      <div className="font-bold">{p.asset}</div>
                    </div>
                    <div>
                      <div className="text-label-tertiary text-xs">Side</div>
                      <div
                        className={p.side === 'LONG' ? 'text-green-700' : 'text-red-700'}
                      >
                        {p.side}
                      </div>
                    </div>
                    <div>
                      <div className="text-label-tertiary text-xs">Entry / Mark</div>
                      <div>
                        ${p.entryPrice.toFixed(2)} /{' '}
                        {p.markPrice ? `$${p.markPrice.toFixed(2)}` : '—'}
                      </div>
                    </div>
                    <div>
                      <div className="text-label-tertiary text-xs">Notional</div>
                      <div>{fmtUsd(p.notionalUsd)}</div>
                    </div>
                    <div>
                      <div className="text-label-tertiary text-xs">Hold</div>
                      <div>{fmtDur(p.holdSeconds)}</div>
                    </div>
                    <div>
                      <div className="text-label-tertiary text-xs">Unrealized</div>
                      <div
                        className={
                          (p.unrealizedPnlUsd ?? 0) >= 0
                            ? 'text-green-700'
                            : 'text-red-700'
                        }
                      >
                        {fmtUsd(p.unrealizedPnlUsd ?? 0)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Live signals */}
        {Object.keys(status.signals).length > 0 && (
          <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
            <div className="text-xs text-label-secondary uppercase mb-2">Current Signals</div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              {Object.entries(status.signals).map(([asset, s]) => (
                <div key={asset} className="bg-system-bg-primary rounded-ios p-2 border border-separator-opaque/30">
                  <div className="font-bold">{asset}</div>
                  <div className="text-xs text-label-secondary">{s.recommendation}</div>
                  <div className="text-xs">
                    <span className="text-label-tertiary">conf </span>
                    <span>{s.confidence}%</span>
                    <span className="text-label-tertiary"> · src </span>
                    <span>{s.sources}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per-asset breakdown */}
        {Object.keys(status.perAsset).length > 0 && (
          <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
            <div className="text-xs text-label-secondary uppercase mb-2">Per-Asset (last 20 closed)</div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              {Object.entries(status.perAsset).map(([asset, a]) => (
                <div key={asset} className="bg-system-bg-primary rounded-ios p-2 border border-separator-opaque/30">
                  <div className="font-bold">{asset}</div>
                  <div className="text-xs text-label-secondary">
                    {a.trades} trades · {a.wins}W
                  </div>
                  <div
                    className={
                      a.cumRealizedUsd >= 0
                        ? 'text-green-700 text-xs'
                        : 'text-red-700 text-xs'
                    }
                  >
                    {fmtUsd(a.cumRealizedUsd)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent trades */}
        <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
          <div className="text-xs text-label-secondary uppercase mb-2">Recent Closed Trades</div>
          {status.recentTrades.length === 0 ? (
            <div className="text-sm text-label-tertiary">No closed trades yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-label-tertiary text-xs uppercase border-b border-separator-opaque/30">
                    <th className="py-2 pr-4">Asset</th>
                    <th className="py-2 pr-4">Side</th>
                    <th className="py-2 pr-4">Notional</th>
                    <th className="py-2 pr-4">Entry</th>
                    <th className="py-2 pr-4">Realized</th>
                    <th className="py-2 pr-4">Funding</th>
                    <th className="py-2 pr-4">Closed</th>
                    <th className="py-2 pr-4">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {status.recentTrades.map((t) => (
                    <tr key={t.id} className="border-b border-separator-opaque/30 last:border-0">
                      <td className="py-2 pr-4">{t.asset}</td>
                      <td
                        className={
                          'py-2 pr-4 ' + (t.side === 'LONG' ? 'text-green-700' : 'text-red-700')
                        }
                      >
                        {t.side}
                      </td>
                      <td className="py-2 pr-4">{fmtUsd(t.notionalUsd)}</td>
                      <td className="py-2 pr-4">${t.entryPrice.toFixed(2)}</td>
                      <td
                        className={
                          'py-2 pr-4 ' +
                          (t.realizedPnlUsd >= 0 ? 'text-green-700' : 'text-red-700')
                        }
                      >
                        {fmtUsd(t.realizedPnlUsd)}
                      </td>
                      <td className="py-2 pr-4 text-label-secondary">
                        {fmtUsd(t.fundingUsd)}
                      </td>
                      <td className="py-2 pr-4 text-label-secondary">
                        {new Date(t.closedAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-label-tertiary max-w-xs truncate">
                        {t.reason.split('|').pop()?.trim() ?? t.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="text-xs text-label-tertiary pt-4 pb-8">
          Auto-refreshes every 30s. Paper-trader runs on the standalone systemd worker every 5 min. Fills at oracle mark price; no venue slippage. Fee model matches
          BlueFin Pro observed 2026-09.
        </footer>
      </div>
    </div>
  );
}
