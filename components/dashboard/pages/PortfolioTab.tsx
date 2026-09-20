'use client';

import { useEffect, useState } from 'react';
import { useAccount } from '@/lib/evm-wallet/hooks';
import { useSui } from '@/app/sui-providers';
import { Briefcase, TrendingUp, TrendingDown, Layers, Shield, Activity } from 'lucide-react';
import { logger } from '@/lib/utils/logger';
import { ConnectPromptButton } from '@/components/ui/ConnectPromptButton';

interface ProductPosition {
  product: string;
  productLabel: string;
  chain: 'sui' | 'evm';
  valueUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  shares?: number;
  percentage?: number;
  count?: number;
}

interface HedgeExposure {
  market: string;
  side: 'LONG' | 'SHORT';
  attributedNotionalUsd: number;
  attributedUnrealizedPnlUsd: number;
  source: 'pool-share' | 'zk-ownership' | 'wallet-attributed';
}

interface UnifiedPortfolio {
  wallet: string;
  walletKind: 'sui' | 'evm' | 'unknown';
  asOf: string;
  totals: {
    nav: number;
    costBasis: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number;
    activeProductCount: number;
    activeHedgeCount: number;
  };
  products: ProductPosition[];
  hedgeExposure: HedgeExposure[];
  allocation: Record<string, { valueUsd: number; pct: number }>;
  warnings: string[];
}

function fmtUsd(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

function fmtPct(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}%`;
}

function PnlBadge({ value, pct }: { value: number; pct?: number }) {
  const positive = value >= 0;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ${positive ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
      {positive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {fmtUsd(value)}
      {pct !== undefined && <span className="opacity-70">· {fmtPct(pct)}</span>}
    </span>
  );
}

function StatCard({ label, value, sub, icon: Icon }: {
  label: string; value: string; sub?: string; icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="bg-white border border-black/5 rounded-2xl p-4 sm:p-5">
      <div className="flex items-center gap-2 text-[#86868b] text-[11px] sm:text-[12px] font-medium mb-1.5 sm:mb-2">
        <Icon className="w-3.5 h-3.5 flex-shrink-0" /> <span className="truncate">{label}</span>
      </div>
      <div className="text-[20px] sm:text-[28px] font-semibold text-[#1d1d1f] tracking-[-0.02em] break-all">{value}</div>
      {sub && <div className="text-[12px] sm:text-[13px] text-[#86868b] mt-1 truncate">{sub}</div>}
    </div>
  );
}

function ProductCard({ p }: { p: ProductPosition }) {
  // SUI-only UI: hide the chain badge (redundant when everything is SUI). The
  // chain field is retained on the type for API completeness.
  return (
    <div className="bg-white border border-black/5 rounded-2xl p-5">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="text-[17px] font-semibold text-[#1d1d1f]">{p.productLabel}</h3>
        </div>
        <PnlBadge value={p.unrealizedPnlUsd} />
      </div>
      <div className="grid grid-cols-2 gap-3 text-[13px]">
        <div>
          <div className="text-[#86868b]">Value</div>
          <div className="text-[#1d1d1f] font-semibold">{fmtUsd(p.valueUsd)}</div>
        </div>
        <div>
          <div className="text-[#86868b]">Cost basis</div>
          <div className="text-[#1d1d1f] font-semibold">{fmtUsd(p.costBasisUsd)}</div>
        </div>
        {p.percentage !== undefined && (
          <div>
            <div className="text-[#86868b]">Pool share</div>
            <div className="text-[#1d1d1f] font-semibold">{p.percentage.toFixed(2)}%</div>
          </div>
        )}
        {p.count !== undefined && (
          <div>
            <div className="text-[#86868b]">Positions</div>
            <div className="text-[#1d1d1f] font-semibold">{p.count}</div>
          </div>
        )}
        {p.shares !== undefined && (
          <div className="col-span-2">
            <div className="text-[#86868b]">Shares</div>
            <div className="text-[#1d1d1f] font-mono text-[12px]">{p.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function AllocationBar({ allocation }: { allocation: Record<string, { valueUsd: number; pct: number }> }) {
  const palette: Record<string, string> = {
    BTC: '#f7931a', ETH: '#627eea', SUI: '#4ca3ff', CRO: '#103f68',
    OTHER: '#86868b',
  };
  const items = Object.entries(allocation)
    .map(([k, v]) => ({ k, ...v }))
    .sort((a, b) => b.pct - a.pct);
  if (items.length === 0) {
    return <div className="text-[13px] text-[#86868b]">No allocation data yet — make a deposit to see your exposure.</div>;
  }
  return (
    <div>
      <div className="flex h-3 rounded-full overflow-hidden bg-[#f5f5f7]">
        {items.map(({ k, pct }) => (
          <div
            key={k}
            style={{ width: `${pct}%`, backgroundColor: palette[k] || '#86868b' }}
            title={`${k}: ${pct.toFixed(1)}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[13px]">
        {items.map(({ k, pct, valueUsd }) => (
          <span key={k} className="inline-flex items-center gap-1.5 text-[#1d1d1f]">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: palette[k] || '#86868b' }} />
            <span className="font-medium">{k}</span>
            <span className="text-[#86868b]">{pct.toFixed(1)}% · {fmtUsd(valueUsd)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function HedgeRow({ h }: { h: HedgeExposure }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-black/5 last:border-b-0">
      <div>
        <div className="text-[14px] font-semibold text-[#1d1d1f]">
          {h.market}
          <span className={`ml-2 text-[11px] px-1.5 py-0.5 rounded ${h.side === 'LONG' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
            {h.side}
          </span>
        </div>
        <div className="text-[11px] text-[#86868b] mt-0.5">
          {h.source === 'pool-share' ? 'Pool exposure' : h.source === 'zk-ownership' ? 'ZK-owned' : 'Wallet'}
        </div>
      </div>
      <div className="text-right">
        <div className="text-[14px] font-mono text-[#1d1d1f]">{fmtUsd(h.attributedNotionalUsd)}</div>
        <div className={`text-[12px] font-medium ${h.attributedUnrealizedPnlUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
          {fmtUsd(h.attributedUnrealizedPnlUsd)}
        </div>
      </div>
    </div>
  );
}

export function PortfolioTab() {
  const evm = useAccount();
  const sui = useSui();
  const [data, setData] = useState<UnifiedPortfolio | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Prefer SUI wallet (live product); fall back to EVM
  const suiWallet = sui?.address || null;
  const evmWallet = evm?.address || null;
  const wallet = suiWallet || evmWallet;

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/portfolio/unified?wallet=${wallet}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        if (!cancelled) setData(json as UnifiedPortfolio);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error('[OverviewPage] fetch failed', { error: msg });
        if (!cancelled) setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  if (!wallet) {
    return (
      <div className="max-w-6xl mx-auto px-3 sm:px-4 md:px-6 py-8 sm:py-12 min-w-0">
        <div className="bg-white border border-black/5 rounded-3xl p-6 sm:p-10 text-center min-w-0">
          <Briefcase className="w-8 h-8 sm:w-10 sm:h-10 text-[#86868b] mx-auto mb-3" />
          <h1 className="text-xl sm:text-2xl md:text-[28px] font-semibold text-[#1d1d1f] mb-2 break-words">Connect a wallet to view your platform overview</h1>
          <p className="text-[#86868b] text-sm sm:text-[15px] leading-relaxed mb-6">
            Aggregates your positions across the SUI USDC pool, private hedges, and any custom portfolios into one view.
          </p>
          <ConnectPromptButton />
        </div>
      </div>
    );
  }

  return (
    // Navbar clearance + horizontal tab strip live in dashboard/layout.tsx.
    <div className="max-w-6xl mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-10 space-y-3 sm:space-y-6 min-w-0">
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 min-w-0">
        <div className="min-w-0">
          <div className="text-[11px] sm:text-[12px] text-[#86868b] uppercase tracking-wide font-medium mb-1">Platform overview</div>
          <h1 className="text-2xl sm:text-3xl md:text-[32px] font-semibold text-[#1d1d1f] tracking-[-0.02em] leading-tight break-words">Your ZKward portfolio</h1>
          <p className="text-xs sm:text-[13px] text-[#86868b] mt-1 font-mono truncate tabular-nums">{wallet.slice(0, 10)}…{wallet.slice(-6)}</p>
        </div>
        {data?.asOf && (
          <div className="text-[11px] sm:text-[12px] text-[#86868b] flex-shrink-0 tabular-nums">
            as of {new Date(data.asOf).toLocaleTimeString()}
          </div>
        )}
      </header>

      {loading && <div className="text-[14px] text-[#86868b]">Loading your unified portfolio…</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-[13px]">
          Failed to load: {error}
        </div>
      )}

      {data && (
        <>
          {/* Hero stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              label="Total NAV"
              value={fmtUsd(data.totals.nav)}
              sub={`across ${data.totals.activeProductCount} product${data.totals.activeProductCount === 1 ? '' : 's'}`}
              icon={Briefcase}
            />
            <StatCard
              label="Unrealized P&L"
              value={fmtUsd(data.totals.unrealizedPnl)}
              sub={fmtPct(data.totals.unrealizedPnlPct)}
              icon={data.totals.unrealizedPnl >= 0 ? TrendingUp : TrendingDown}
            />
            <StatCard
              label="Cost basis"
              value={fmtUsd(data.totals.costBasis)}
              sub="lifetime net deposits"
              icon={Layers}
            />
            <StatCard
              label="Active hedges"
              value={String(data.totals.activeHedgeCount)}
              sub="≥ $1 notional, all sources"
              icon={Shield}
            />
          </div>

          {/* Allocation breakdown */}
          <section className="bg-white border border-black/5 rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-4">
              <Activity className="w-4 h-4 text-[#1d1d1f]" />
              <h2 className="text-[17px] font-semibold text-[#1d1d1f]">Asset allocation across your positions</h2>
            </div>
            <AllocationBar allocation={data.allocation} />
          </section>

          {/* Products */}
          {data.products.length === 0 ? (
            <div className="bg-white border border-black/5 rounded-2xl p-8 text-center text-[#86868b]">
              No active positions yet. Make a deposit on the dashboard to populate this view.
            </div>
          ) : (
            <section>
              <h2 className="text-[17px] font-semibold text-[#1d1d1f] mb-3">Products</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {data.products.map((p) => (
                  <ProductCard key={p.product} p={p} />
                ))}
              </div>
            </section>
          )}

          {/* Hedge exposure */}
          {data.hedgeExposure.length > 0 && (
            <section className="bg-white border border-black/5 rounded-2xl p-5">
              <h2 className="text-[17px] font-semibold text-[#1d1d1f] mb-3">Hedge exposure</h2>
              <p className="text-[12px] text-[#86868b] mb-3">
                Includes your pro-rata share of pool hedges plus any wallet-attributed or ZK-owned positions.
              </p>
              <div>
                {data.hedgeExposure.map((h, i) => (
                  <HedgeRow key={`${h.market}-${i}`} h={h} />
                ))}
              </div>
            </section>
          )}

          {data.warnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-[12px]">
              <div className="font-semibold mb-1">Partial data:</div>
              <ul className="list-disc list-inside space-y-0.5">
                {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
