/**
 * GET /api/sui/venue-divergence
 *
 * Read-only diagnostic: shows DB hedge state, BlueFin venue state,
 * and the cached `bluefin:nav-last-good` value side-by-side. Surfaces
 * any divergence (DB has hedges venue doesn't, or vice versa, or
 * cached collateral disagrees with live).
 *
 * Useful for ops + AI when the venue API misbehaves — gives a one-
 * shot view of all three sources of truth so the operator can decide
 * whether to trust each.
 *
 * No state-changing side effects.
 */

import { NextResponse } from 'next/server';
import { query } from '@/lib/db/postgres';
import { safeBluefinSnapshot } from '@/lib/services/sui/bluefin-read-safe';
import { getCronStateOr } from '@/lib/db/cron-state';
import { BLUEFIN_NAV_CACHE_KEY } from '@/lib/services/sui/bluefin-read-safe';
import { errMsg } from '@/lib/utils/error-handler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CachedSnapshot {
  value: number;
  free: number;
  lockedMargin: number;
  upnl: number;
  positions: number;
  ts: number;
}

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  const network: 'mainnet' | 'testnet' =
    (process.env.SUI_NETWORK as 'mainnet' | 'testnet') === 'testnet' ? 'testnet' : 'mainnet';

  // SERIALIZED queries — Aiven's plan-wide connection_limit (20) is
  // shared across every Vercel lambda, so a Promise.all of 4 DB-touching
  // operations from a single request can tip the pool into "remaining
  // connection slots reserved for SUPERUSER" while other lambdas are
  // mid-query. Sequential adds ~600ms total but never causes the 500
  // we hit on first deploy (Aiven plan-wide pool limit).
  let dbRows: Array<{
    id: number; market: string; side: string;
    size: string | number; notional_value: string | number;
    entry_price: string | number | null; current_pnl: string | number;
  }> = [];
  let snap: Awaited<ReturnType<typeof safeBluefinSnapshot>> | null = null;
  let cached: CachedSnapshot | null = null;
  let consecutiveEmpty = 0;

  try {
    dbRows = await query(
      `SELECT id, market, side, size, notional_value, entry_price, current_pnl
         FROM hedges
        WHERE chain = 'sui' AND status = 'active' AND market LIKE '%-PERP'
        ORDER BY notional_value DESC`,
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `db unavailable: ${errMsg(e)}`, hint: 'Aiven pool likely saturated; retry in 5s' },
      { status: 503 },
    );
  }

  try {
    cached = await getCronStateOr<CachedSnapshot | null>(BLUEFIN_NAV_CACHE_KEY, null);
  } catch { /* fall back to null */ }
  try {
    consecutiveEmpty = await getCronStateOr<number>('bluefin:consecutiveEmptyReads', 0);
  } catch { /* fall back to 0 */ }
  try {
    snap = await safeBluefinSnapshot({ network, onChainHasExposure: dbRows.length > 0 });
  } catch (e) {
    snap = {
      free: 0, lockedMargin: 0, upnl: 0, totalValue: 0,
      positions: [], positionsCount: 0,
      source: 'unknown', warning: `snapshot threw: ${errMsg(e)}`,
    };
  }

  // Pure-compute section below — no I/O — so no try/catch needed.
  {
    const dbHedges = dbRows.map(r => ({
      id: r.id,
      market: String(r.market).toUpperCase(),
      side: String(r.side).toUpperCase(),
      size: Number(r.size),
      notionalValue: Number(r.notional_value),
      entryPrice: r.entry_price == null ? 0 : Number(r.entry_price),
      currentPnl: Number(r.current_pnl ?? 0),
    }));

    const venuePositions = snap.positions.map(p => {
      const pp = p as unknown as Record<string, unknown>;
      return {
        market: String(pp.symbol || '').toUpperCase(),
        side: String(pp.side || '').toUpperCase(),
        size: Number(pp.size ?? 0),
        entryPrice: Number(pp.entryPrice ?? 0),
        markPrice: Number(pp.markPrice ?? 0),
        uPnL: Number(pp.unrealizedPnl ?? 0),
      };
    });

    // Match DB to venue and compute divergence
    const matched: Array<Record<string, unknown>> = [];
    const dbOnly: typeof dbHedges = [];
    const venueOnly: typeof venuePositions = [];

    for (const d of dbHedges) {
      const v = venuePositions.find(p => p.market === d.market && p.side === d.side);
      if (v) {
        matched.push({
          market: d.market,
          side: d.side,
          db: { size: d.size, entry: d.entryPrice, notional: d.notionalValue, pnl: d.currentPnl },
          venue: { size: v.size, entry: v.entryPrice, mark: v.markPrice, pnl: v.uPnL },
          sizeDelta: v.size - d.size,
          entryDelta: v.entryPrice - d.entryPrice,
        });
      } else {
        dbOnly.push(d);
      }
    }
    for (const v of venuePositions) {
      if (!dbHedges.find(d => d.market === v.market && d.side === v.side)) {
        venueOnly.push(v);
      }
    }

    // Cache freshness
    const cacheAgeMs = cached ? now - cached.ts : null;
    const cacheAgeMin = cacheAgeMs !== null ? Math.round(cacheAgeMs / 60_000) : null;

    return NextResponse.json({
      success: true,
      now: new Date(now).toISOString(),
      network,
      summary: {
        dbCount: dbHedges.length,
        venueCount: venuePositions.length,
        matched: matched.length,
        dbOnly: dbOnly.length,
        venueOnly: venueOnly.length,
        venueAlive: snap.source === 'live' && venuePositions.length > 0,
        snapshotSource: snap.source,
        snapshotWarning: snap.warning,
        consecutiveEmptyReads: consecutiveEmpty,
        cacheAgeMin,
      },
      matched,
      dbOnly,
      venueOnly,
      cachedSnapshot: cached,
      liveSnapshot: {
        free: snap.free,
        lockedMargin: snap.lockedMargin,
        upnl: snap.upnl,
        totalValue: snap.totalValue,
        positionsCount: snap.positionsCount,
        source: snap.source,
        ageMs: snap.ageMs,
        warning: snap.warning,
      },
    }, {
      // Venue snapshot updates on BlueFin cadence + DB writes on cron;
      // 15s edge cache is safe for dashboard polling.
      headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=45' },
    });
  }
}
