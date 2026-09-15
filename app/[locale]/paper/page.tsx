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

interface Status {
  success: boolean;
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
  activePosition: {
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
  } | null;
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
      const r = await fetch('/api/paper-trader/status', { cache: 'no-store' });
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
          borderColor: 'rgb(59, 130, 246)',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          fill: true,
          tension: 0.2,
          pointRadius: 0,
        },
        {
          label: `Buy-hold baseline ($${status.config.startingNavUsd.toLocaleString()})`,
          data: series.map(() => status.config.startingNavUsd),
          borderColor: 'rgb(156, 163, 175)',
          borderDash: [6, 4],
          fill: false,
          pointRadius: 0,
        },
      ],
    };
  }, [status]);

  if (loading && !status) {
    return (
      <div className="min-h-screen bg-black text-white p-8">
        <div className="max-w-6xl mx-auto">Loading paper-trader status…</div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="min-h-screen bg-black text-white p-8">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-2xl mb-4">Paper Trader</h1>
          <div className="text-red-400">Failed to load: {error}</div>
        </div>
      </div>
    );
  }

  if (!status) return null;

  const returnColor = status.nav.cumReturnPct >= 0 ? 'text-green-400' : 'text-red-400';

  return (
    <div className="min-h-screen bg-black text-white p-4 md:p-8">
      <div className="max-w-6xl mx-auto space-y-6">
        <header>
          <h1 className="text-3xl md:text-4xl font-bold">Paper Trader</h1>
          <p className="text-gray-400 mt-1">
            Live shadow-simulator on Hedera testnet. Same signals as the SUI mainnet trader, mark-price
            fills, realistic 13&nbsp;bp round-trip + 11% APR funding. Answers: does the strategy have edge
            net of fees at $100k?
          </p>
          <p className="text-xs text-gray-500 mt-2">
            Last tick: {status.lastTickAt ? new Date(status.lastTickAt).toLocaleString() : 'never'}
            &nbsp;·&nbsp; Chain: {status.config.chain}
            &nbsp;·&nbsp; Universe: {status.config.universe.join(', ')}
          </p>
        </header>

        {/* Top-line NAV */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-gray-900 rounded-lg p-4">
            <div className="text-xs text-gray-400 uppercase">Current NAV</div>
            <div className="text-2xl font-bold mt-1">{fmtUsd(status.nav.currentUsd)}</div>
            <div className={`text-sm mt-1 ${returnColor}`}>{fmtPct(status.nav.cumReturnPct)}</div>
          </div>
          <div className="bg-gray-900 rounded-lg p-4">
            <div className="text-xs text-gray-400 uppercase">vs Buy-hold</div>
            <div className="text-2xl font-bold mt-1">
              {fmtUsd(status.nav.currentUsd - status.config.startingNavUsd)}
            </div>
            <div className="text-sm mt-1 text-gray-400">
              baseline {fmtUsd(status.config.startingNavUsd)}
            </div>
          </div>
          <div className="bg-gray-900 rounded-lg p-4">
            <div className="text-xs text-gray-400 uppercase">Trades</div>
            <div className="text-2xl font-bold mt-1">{status.stats.trades}</div>
            <div className="text-sm mt-1 text-gray-400">
              {status.stats.wins}W / {status.stats.losses}L
              {status.stats.trades > 0 && ` · ${status.stats.winRatePct.toFixed(0)}%`}
            </div>
          </div>
          <div className="bg-gray-900 rounded-lg p-4">
            <div className="text-xs text-gray-400 uppercase">Peak NAV</div>
            <div className="text-2xl font-bold mt-1">{fmtUsd(status.nav.peakUsd)}</div>
            <div className="text-sm mt-1 text-orange-400">
              {status.nav.drawdownFromPeakPct > 0.1
                ? `-${status.nav.drawdownFromPeakPct.toFixed(1)}% dd`
                : 'at peak'}
            </div>
          </div>
        </div>

        {/* Chart */}
        {chartData && chartData.labels.length > 0 && (
          <div className="bg-gray-900 rounded-lg p-4">
            <div className="h-64 md:h-80">
              <Line
                data={chartData}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  interaction: { intersect: false, mode: 'index' },
                  plugins: {
                    legend: { labels: { color: 'rgb(209, 213, 219)' } },
                    tooltip: {
                      callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${fmtUsd(Number(ctx.parsed.y))}`,
                      },
                    },
                  },
                  scales: {
                    x: {
                      ticks: { color: 'rgb(156, 163, 175)', maxTicksLimit: 8 },
                      grid: { color: 'rgba(75, 85, 99, 0.2)' },
                    },
                    y: {
                      ticks: {
                        color: 'rgb(156, 163, 175)',
                        callback: (v) => fmtUsd(Number(v)),
                      },
                      grid: { color: 'rgba(75, 85, 99, 0.2)' },
                    },
                  },
                }}
              />
            </div>
          </div>
        )}

        {/* Active position */}
        {status.activePosition && (
          <div className="bg-gray-900 rounded-lg p-4">
            <div className="text-xs text-gray-400 uppercase mb-2">Active Position</div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-4 text-sm">
              <div>
                <div className="text-gray-500 text-xs">Asset</div>
                <div className="font-bold">{status.activePosition.asset}</div>
              </div>
              <div>
                <div className="text-gray-500 text-xs">Side</div>
                <div
                  className={
                    status.activePosition.side === 'LONG' ? 'text-green-400' : 'text-red-400'
                  }
                >
                  {status.activePosition.side}
                </div>
              </div>
              <div>
                <div className="text-gray-500 text-xs">Entry / Mark</div>
                <div>
                  ${status.activePosition.entryPrice.toFixed(2)} /{' '}
                  {status.activePosition.markPrice
                    ? `$${status.activePosition.markPrice.toFixed(2)}`
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-gray-500 text-xs">Notional</div>
                <div>{fmtUsd(status.activePosition.notionalUsd)}</div>
              </div>
              <div>
                <div className="text-gray-500 text-xs">Hold</div>
                <div>{fmtDur(status.activePosition.holdSeconds)}</div>
              </div>
              <div>
                <div className="text-gray-500 text-xs">Unrealized</div>
                <div
                  className={
                    (status.activePosition.unrealizedPnlUsd ?? 0) >= 0
                      ? 'text-green-400'
                      : 'text-red-400'
                  }
                >
                  {fmtUsd(status.activePosition.unrealizedPnlUsd ?? 0)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Live signals */}
        {Object.keys(status.signals).length > 0 && (
          <div className="bg-gray-900 rounded-lg p-4">
            <div className="text-xs text-gray-400 uppercase mb-2">Current Signals</div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              {Object.entries(status.signals).map(([asset, s]) => (
                <div key={asset} className="bg-gray-800 rounded p-2">
                  <div className="font-bold">{asset}</div>
                  <div className="text-xs text-gray-400">{s.recommendation}</div>
                  <div className="text-xs">
                    <span className="text-gray-500">conf </span>
                    <span>{s.confidence}%</span>
                    <span className="text-gray-500"> · src </span>
                    <span>{s.sources}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per-asset breakdown */}
        {Object.keys(status.perAsset).length > 0 && (
          <div className="bg-gray-900 rounded-lg p-4">
            <div className="text-xs text-gray-400 uppercase mb-2">Per-Asset (last 20 closed)</div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              {Object.entries(status.perAsset).map(([asset, a]) => (
                <div key={asset} className="bg-gray-800 rounded p-2">
                  <div className="font-bold">{asset}</div>
                  <div className="text-xs text-gray-400">
                    {a.trades} trades · {a.wins}W
                  </div>
                  <div
                    className={
                      a.cumRealizedUsd >= 0
                        ? 'text-green-400 text-xs'
                        : 'text-red-400 text-xs'
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
        <div className="bg-gray-900 rounded-lg p-4">
          <div className="text-xs text-gray-400 uppercase mb-2">Recent Closed Trades</div>
          {status.recentTrades.length === 0 ? (
            <div className="text-sm text-gray-500">No closed trades yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 text-xs uppercase border-b border-gray-800">
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
                    <tr key={t.id} className="border-b border-gray-800 last:border-0">
                      <td className="py-2 pr-4">{t.asset}</td>
                      <td
                        className={
                          'py-2 pr-4 ' + (t.side === 'LONG' ? 'text-green-400' : 'text-red-400')
                        }
                      >
                        {t.side}
                      </td>
                      <td className="py-2 pr-4">{fmtUsd(t.notionalUsd)}</td>
                      <td className="py-2 pr-4">${t.entryPrice.toFixed(2)}</td>
                      <td
                        className={
                          'py-2 pr-4 ' +
                          (t.realizedPnlUsd >= 0 ? 'text-green-400' : 'text-red-400')
                        }
                      >
                        {fmtUsd(t.realizedPnlUsd)}
                      </td>
                      <td className="py-2 pr-4 text-gray-400">
                        {fmtUsd(t.fundingUsd)}
                      </td>
                      <td className="py-2 pr-4 text-gray-400">
                        {new Date(t.closedAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-gray-500 max-w-xs truncate">
                        {t.reason.split('|').pop()?.trim() ?? t.reason}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <footer className="text-xs text-gray-600 pt-4 pb-8">
          Auto-refreshes every 30s. Paper-trader piggybacks the polymarket-edge-trader 5-min cron
          (QStash 10-schedule cap). Fills at oracle mark price; no venue slippage. Fee model matches
          BlueFin Pro observed 2026-09.
        </footer>
      </div>
    </div>
  );
}
