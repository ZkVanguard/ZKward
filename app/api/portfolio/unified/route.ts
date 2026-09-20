/**
 * Unified Portfolio API
 *
 * Aggregates a single wallet's positions across every ZKward product surface
 * into one read-only response. This is the back-end for /dashboard/portfolio —
 * the "BlackRock for Web3" client portal that shows total platform exposure
 * (SUI USDC pool share + private hedges + EVM portfolios) in one view.
 *
 * Strictly READ-ONLY: no on-chain writes, no DB writes, no mutating side-effects.
 * Reuses existing services + DB helpers; pool state is unaffected.
 *
 * GET /api/portfolio/unified?wallet=0x{64hex_for_sui|40hex_for_evm}
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { readLimiter } from '@/lib/security/rate-limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

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
  metadata?: Record<string, unknown>;
}

interface HedgeExposure {
  market: string;
  side: 'LONG' | 'SHORT';
  attributedNotionalUsd: number;
  attributedUnrealizedPnlUsd: number;
  source: 'pool-share' | 'zk-ownership' | 'wallet-attributed';
}

interface UnifiedPortfolioResponse {
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

const SUI_ADDRESS = /^0x[a-fA-F0-9]{64}$/;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

function detectWalletKind(wallet: string): 'sui' | 'evm' | 'unknown' {
  if (SUI_ADDRESS.test(wallet)) return 'sui';
  if (EVM_ADDRESS.test(wallet)) return 'evm';
  return 'unknown';
}

async function getSuiPoolPosition(wallet: string): Promise<{
  product: ProductPosition | null;
  poolStats: { totalNAVUsdc: number; sharePriceUsdc: number; allocation: unknown } | null;
  warning: string | null;
}> {
  try {
    const { getSuiUsdcPoolService } = await import('@/lib/services/sui/SuiCommunityPoolService');
    const service = getSuiUsdcPoolService('mainnet');
    const [position, stats] = await Promise.all([
      service.getMemberPosition(wallet).catch((e: unknown) => {
        logger.warn('[Unified] SUI member position read failed', { error: String(e) });
        return null;
      }),
      service.getPoolStats().catch((e: unknown) => {
        logger.warn('[Unified] SUI pool stats read failed', { error: String(e) });
        return null;
      }),
    ]);

    if (!position || !position.isMember) {
      return { product: null, poolStats: stats, warning: null };
    }

    return {
      product: {
        product: 'sui-usdc-pool',
        productLabel: 'SUI USDC Community Pool',
        chain: 'sui',
        valueUsd: position.valueUsd,
        costBasisUsd: position.depositedSui,
        unrealizedPnlUsd: position.valueUsd - position.depositedSui,
        shares: position.shares,
        percentage: position.percentage,
        metadata: {
          highWaterMark: position.highWaterMark,
          withdrawnUsd: position.withdrawnSui,
          joinedAt: position.joinedAt,
        },
      },
      poolStats: stats,
      warning: null,
    };
  } catch (e: unknown) {
    return {
      product: null,
      poolStats: null,
      warning: `SUI pool lookup failed: ${String(e)}`,
    };
  }
}

async function getPoolHedgeExposure(
  pctOfPool: number,
): Promise<HedgeExposure[]> {
  if (pctOfPool <= 0) return [];
  try {
    const { query } = await import('@/lib/db/postgres');
    const rows = await query<{
      market: string;
      side: string;
      notional_value: string | number;
      current_pnl: string | number;
    }>(
      `SELECT market, side, notional_value, current_pnl
         FROM hedges
        WHERE chain = 'sui'
          AND status = 'active'
          AND market LIKE '%-PERP'
          AND COALESCE(notional_value, 0) >= 1
        ORDER BY notional_value DESC
        LIMIT 20`,
    );
    return rows.map((r) => ({
      market: String(r.market),
      side: (String(r.side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
      attributedNotionalUsd: Number(r.notional_value) * (pctOfPool / 100),
      attributedUnrealizedPnlUsd: Number(r.current_pnl) * (pctOfPool / 100),
      source: 'pool-share',
    }));
  } catch (e: unknown) {
    logger.warn('[Unified] Pool hedge exposure query failed', { error: String(e) });
    return [];
  }
}

/**
 * Read user's `rwa_manager::Portfolio` objects (Private Portfolio Creator surface).
 * These are user-owned Move objects created via `rwa_manager::create_portfolio`.
 * Hot path: 0 portfolios → single RPC round-trip → empty product. Cold path on
 * any failure → null product, never throws (this is one surface among many).
 */
async function getPrivatePortfolios(wallet: string): Promise<{
  position: ProductPosition | null;
  warning: string | null;
}> {
  try {
    const packageId = (
      process.env.NEXT_PUBLIC_SUI_MAINNET_RWA_PACKAGE_ID ||
      process.env.NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID ||
      ''
    ).trim();
    if (!packageId) return { position: null, warning: null };
    const rpcUrl = (process.env.SUI_MAINNET_RPC || 'https://fullnode.mainnet.sui.io:443').trim();

    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'suix_getOwnedObjects',
        params: [
          wallet,
          {
            filter: { StructType: `${packageId}::rwa_manager::Portfolio` },
            options: { showContent: true },
          },
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return { position: null, warning: `Private portfolio RPC returned HTTP ${response.status}` };
    }
    const data = (await response.json()) as {
      result?: { data?: Array<{ data?: { objectId?: string; content?: { fields?: Record<string, unknown> } } }> };
    };
    const objects = data.result?.data || [];
    if (!objects.length) return { position: null, warning: null };

    // total_value is stored in MIST (u64). Sum across all portfolios owned by the wallet.
    let totalValueMist = 0n;
    for (const obj of objects) {
      const fields = obj.data?.content?.fields || {};
      const tv = fields.total_value;
      if (tv !== undefined && tv !== null) {
        try {
          totalValueMist += BigInt(String(tv));
        } catch {
          // skip non-numeric
        }
      }
    }

    // Convert MIST → SUI → USD using the same live SUI price the rest of the system uses.
    let suiUsd = 2.5;
    try {
      const { getLivePrice } = await import('@/lib/services/market-data/unified-price-provider');
      const price = await getLivePrice('SUI');
      if (Number.isFinite(price) && price > 0) suiUsd = price;
    } catch {
      // fall through with conservative default
    }
    const valueUsd = (Number(totalValueMist) / 1e9) * suiUsd;

    return {
      position: {
        product: 'private-portfolios',
        productLabel: 'Private Portfolios (RWA Manager)',
        chain: 'sui',
        valueUsd,
        costBasisUsd: valueUsd, // no historical basis tracked on-chain
        unrealizedPnlUsd: 0,
        count: objects.length,
        metadata: {
          backedBy: 'rwa_manager.move',
          attestationsAvailable: 'See /dashboard/custody and /api/custody?action=list-attestations',
        },
      },
      warning: null,
    };
  } catch (e: unknown) {
    logger.warn('[Unified] Private portfolio lookup failed', { error: String(e) });
    return { position: null, warning: `Private portfolio lookup failed: ${String(e)}` };
  }
}

async function getZkOwnedHedges(wallet: string): Promise<{
  position: ProductPosition | null;
  hedges: HedgeExposure[];
}> {
  try {
    const { getActiveHedgesByZKOwnership } = await import('@/lib/db/hedges');
    const rows = await getActiveHedgesByZKOwnership(wallet);
    if (!rows.length) return { position: null, hedges: [] };
    const totalNotional = rows.reduce((s, r) => s + (Number(r.notional_value) || 0), 0);
    const totalPnl = rows.reduce((s, r) => s + (Number(r.current_pnl) || 0), 0);
    return {
      position: {
        product: 'private-hedges',
        productLabel: 'Private Hedges (ZK-owned)',
        chain: 'sui',
        valueUsd: totalNotional,
        costBasisUsd: totalNotional - totalPnl,
        unrealizedPnlUsd: totalPnl,
        count: rows.length,
      },
      hedges: rows.map((r) => ({
        market: String(r.market || ''),
        side: (String(r.side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
        attributedNotionalUsd: Number(r.notional_value) || 0,
        attributedUnrealizedPnlUsd: Number(r.current_pnl) || 0,
        source: 'zk-ownership',
      })),
    };
  } catch (e: unknown) {
    logger.warn('[Unified] ZK-owned hedge lookup failed', { error: String(e) });
    return { position: null, hedges: [] };
  }
}

async function getWalletAttributedHedges(wallet: string): Promise<{
  position: ProductPosition | null;
  hedges: HedgeExposure[];
}> {
  try {
    const { getActiveHedgesByWallet } = await import('@/lib/db/hedges');
    const rows = await getActiveHedgesByWallet(wallet);
    if (!rows.length) return { position: null, hedges: [] };
    const totalNotional = rows.reduce((s, r) => s + (Number(r.notional_value) || 0), 0);
    const totalPnl = rows.reduce((s, r) => s + (Number(r.current_pnl) || 0), 0);
    return {
      position: {
        product: 'wallet-hedges',
        productLabel: 'Wallet-attributed Hedges',
        chain: 'sui',
        valueUsd: totalNotional,
        costBasisUsd: totalNotional - totalPnl,
        unrealizedPnlUsd: totalPnl,
        count: rows.length,
      },
      hedges: rows.map((r) => ({
        market: String(r.market || ''),
        side: (String(r.side).toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
        attributedNotionalUsd: Number(r.notional_value) || 0,
        attributedUnrealizedPnlUsd: Number(r.current_pnl) || 0,
        source: 'wallet-attributed',
      })),
    };
  } catch (e: unknown) {
    logger.warn('[Unified] Wallet hedge lookup failed', { error: String(e) });
    return { position: null, hedges: [] };
  }
}

function aggregateAllocation(
  products: ProductPosition[],
  poolAllocation: Record<string, number> | null,
  hedges: HedgeExposure[],
): Record<string, { valueUsd: number; pct: number }> {
  const buckets: Record<string, number> = {};

  // Pool position decomposed by pool's current allocation (BTC/ETH/SUI %)
  if (poolAllocation) {
    const poolValue = products
      .filter((p) => p.product === 'sui-usdc-pool')
      .reduce((s, p) => s + p.valueUsd, 0);
    for (const [asset, pct] of Object.entries(poolAllocation)) {
      const numericPct = Number(pct);
      if (!Number.isFinite(numericPct) || numericPct <= 0) continue;
      buckets[asset] = (buckets[asset] || 0) + poolValue * (numericPct / 100);
    }
  }

  // Hedge notionals add to the asset they reference
  for (const h of hedges) {
    const base = h.market.replace(/-PERP$/i, '').toUpperCase();
    if (!base) continue;
    buckets[base] = (buckets[base] || 0) + h.attributedNotionalUsd;
  }

  // EVM portfolios + wallet-attributed hedges that don't decompose → "OTHER"
  const otherValue = products
    .filter((p) => p.product !== 'sui-usdc-pool')
    .filter((p) => p.product !== 'private-hedges')
    .filter((p) => p.product !== 'wallet-hedges')
    .reduce((s, p) => s + p.valueUsd, 0);
  if (otherValue > 0) {
    buckets['OTHER'] = (buckets['OTHER'] || 0) + otherValue;
  }

  const total = Object.values(buckets).reduce((s, v) => s + v, 0);
  const result: Record<string, { valueUsd: number; pct: number }> = {};
  for (const [k, v] of Object.entries(buckets)) {
    if (v <= 0) continue;
    result[k] = {
      valueUsd: v,
      pct: total > 0 ? (v / total) * 100 : 0,
    };
  }
  return result;
}

export async function GET(request: NextRequest): Promise<NextResponse<UnifiedPortfolioResponse | { error: string }>> {
  const limited = readLimiter.check(request);
  if (limited) return limited as NextResponse<UnifiedPortfolioResponse | { error: string }>;

  try {
    const wallet = request.nextUrl.searchParams.get('wallet')?.trim() || '';
    if (!wallet) {
      return NextResponse.json({ error: 'wallet parameter required' }, { status: 400 });
    }
    const kind = detectWalletKind(wallet);
    if (kind === 'unknown') {
      return NextResponse.json(
        { error: 'Invalid wallet address (expected 0x + 64 hex for SUI, 40 hex for EVM)' },
        { status: 400 },
      );
    }

    const warnings: string[] = [];
    const products: ProductPosition[] = [];
    let poolAllocation: Record<string, number> | null = null;
    let userPoolPctOfTotal = 0;

    if (kind === 'sui') {
      const [suiPool, zkHedges, attributedHedges, privatePortfolios] = await Promise.all([
        getSuiPoolPosition(wallet),
        getZkOwnedHedges(wallet),
        getWalletAttributedHedges(wallet),
        getPrivatePortfolios(wallet),
      ]);

      if (suiPool.warning) warnings.push(suiPool.warning);
      if (privatePortfolios.warning) warnings.push(privatePortfolios.warning);
      if (privatePortfolios.position) products.push(privatePortfolios.position);
      if (suiPool.product) {
        products.push(suiPool.product);
        userPoolPctOfTotal = suiPool.product.percentage || 0;
      }
      if (suiPool.poolStats) {
        const alloc = (suiPool.poolStats as { allocation?: { targets?: Record<string, number> } | Record<string, number> } | null)?.allocation;
        if (alloc && typeof alloc === 'object') {
          if ('targets' in alloc && alloc.targets) {
            poolAllocation = alloc.targets as Record<string, number>;
          } else {
            // Treat alloc itself as a map of asset → bps/percentage
            poolAllocation = Object.fromEntries(
              Object.entries(alloc as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'number')
                .map(([k, v]) => [k, Number(v)]),
            );
          }
        }
      }
      if (zkHedges.position) products.push(zkHedges.position);
      if (attributedHedges.position) products.push(attributedHedges.position);

      const poolHedgeExposure = await getPoolHedgeExposure(userPoolPctOfTotal);
      const allHedges = [...poolHedgeExposure, ...zkHedges.hedges, ...attributedHedges.hedges];

      const nav = products.reduce((s, p) => s + p.valueUsd, 0);
      const costBasis = products.reduce((s, p) => s + p.costBasisUsd, 0);
      const unrealizedPnl = nav - costBasis;
      const allocation = aggregateAllocation(products, poolAllocation, poolHedgeExposure);

      const response: UnifiedPortfolioResponse = {
        wallet,
        walletKind: kind,
        asOf: new Date().toISOString(),
        totals: {
          nav,
          costBasis,
          unrealizedPnl,
          unrealizedPnlPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
          activeProductCount: products.length,
          activeHedgeCount: allHedges.length,
        },
        products,
        hedgeExposure: allHedges,
        allocation,
        warnings,
      };
      return NextResponse.json(response, {
        // Per-wallet URL — edge cache keys on ?wallet=X, so cross-user
        // isolation is preserved; repeat views collapse in 15s window.
        headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45' },
      });
    }

    // EVM path: hit existing portfolio list as the data source
    try {
      const baseUrl = request.nextUrl.origin;
      const resp = await fetch(`${baseUrl}/api/portfolio/list?address=${wallet}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const json = (await resp.json()) as {
          portfolios?: Array<{ id: number; totalValue: string }>;
        };
        const portfolios = json.portfolios || [];
        const totalValue = portfolios.reduce(
          (s, p) => s + Number(p.totalValue || 0) / 1e18,
          0,
        );
        if (portfolios.length > 0) {
          products.push({
            product: 'evm-portfolios',
            productLabel: 'EVM Portfolios (Cronos)',
            chain: 'evm',
            valueUsd: totalValue,
            costBasisUsd: totalValue,
            unrealizedPnlUsd: 0,
            count: portfolios.length,
          });
        }
      } else {
        warnings.push(`EVM portfolio fetch returned HTTP ${resp.status}`);
      }
    } catch (e: unknown) {
      warnings.push(`EVM portfolio fetch failed: ${String(e)}`);
    }

    const attributedHedges = await getWalletAttributedHedges(wallet);
    if (attributedHedges.position) products.push(attributedHedges.position);

    const nav = products.reduce((s, p) => s + p.valueUsd, 0);
    const costBasis = products.reduce((s, p) => s + p.costBasisUsd, 0);
    const unrealizedPnl = nav - costBasis;
    const allocation = aggregateAllocation(products, null, attributedHedges.hedges);

    const response: UnifiedPortfolioResponse = {
      wallet,
      walletKind: kind,
      asOf: new Date().toISOString(),
      totals: {
        nav,
        costBasis,
        unrealizedPnl,
        unrealizedPnlPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0,
        activeProductCount: products.length,
        activeHedgeCount: attributedHedges.hedges.length,
      },
      products,
      hedgeExposure: attributedHedges.hedges,
      allocation,
      warnings,
    };
    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45' },
    });
  } catch (error: unknown) {
    return safeErrorResponse(error, 'Unified portfolio') as NextResponse<UnifiedPortfolioResponse | { error: string }>;
  }
}
