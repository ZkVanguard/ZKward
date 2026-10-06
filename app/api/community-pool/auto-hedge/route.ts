/**
 * Community Pool Auto-Hedge Status API
 *
 * GET /api/community-pool/auto-hedge
 *   Returns current auto-hedging configuration, active hedges,
 *   recent AI decisions, and risk assessment for the community pool.
 *
 * POST /api/community-pool/auto-hedge
 *   Enables/disables auto-hedging for the community pool.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import {
  COMMUNITY_POOL_PORTFOLIO_ID,
  COMMUNITY_POOL_ADDRESS,
  chainToPortfolioId,
} from '@/lib/constants';
import { getAutoHedgeConfig, saveAutoHedgeConfig } from '@/lib/storage/auto-hedge-storage';
import { getActiveHedges } from '@/lib/db/hedges';
import { query, ensureAllTables } from '@/lib/db/postgres';
import { autoHedgingService } from '@/lib/services/hedging/AutoHedgingService';
import { readLimiter } from '@/lib/security/rate-limiter';
import { errMsg } from '@/lib/utils/error-handler';

export const runtime = 'nodejs';

export const maxDuration = 15;
// In-memory cache for auto-hedge status (expensive risk assessment)
const autoHedgeCacheByChain = new Map<string, { data: unknown; expiresAt: number }>();
const AUTO_HEDGE_CACHE_TTL = 300_000; // 5 min — reduce DB load
const AUTO_HEDGE_SUI_CACHE_TTL = 60_000; // 1 min for SUI — on-chain hedge state changes faster

// SUI on-chain hedge mapping
const SUI_PAIR_INDEX_TO_ASSET: Record<number, string> = { 0: 'BTC', 1: 'ETH', 2: 'SUI', 3: 'CRO' };

interface OnChainSuiHedge {
  id: string;
  asset: string;
  side: 'LONG' | 'SHORT';
  size: number;
  notionalValue: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  createdAt: string;
}

interface OnChainSuiState {
  hedges: OnChainSuiHedge[];
  enabled: boolean;
  config: { riskThreshold: number; maxLeverage: number; allowedAssets: string[] } | null;
}

/**
 * Read on-chain SUI pool state and convert active hedges into UI shape.
 * The DB `hedges` table only stores BlueFin perp hedges; the SUI pool's
 * Move-contract HedgePosition objects (from open_hedge calls) live in
 * pool.hedge_state.active_hedges and were never surfaced to the UI.
 */
async function readOnChainSuiHedges(): Promise<OnChainSuiState> {
  const empty: OnChainSuiState = { hedges: [], enabled: false, config: null };
  // Prefer the USDC pool state ID; fall back to legacy single-pool var.
  // Trim aggressively to drop any \r\n that snuck into env values.
  const trim = (v: string | undefined) => (v || '').replace(/[\s\r\n"']+/g, '').trim();
  const poolStateId =
    trim(process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE) ||
    trim(process.env.NEXT_PUBLIC_SUI_POOL_STATE_ID);
  if (!poolStateId) return empty;

  try {
    // Uses failover transport — public fullnode deprecated JSON-RPC
    // in 2026-07; single-provider clients silently returned $0.
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
    const client = createFailoverSuiClient('mainnet');
    const objectPromise = client.getObject({
      id: poolStateId,
      options: { showContent: true, showType: true },
    });
    // Hard timeout — pool stats already covered upstream; this is a best-effort enrichment.
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), 5_000),
    );
    const res = await Promise.race([objectPromise, timeoutPromise]);
    if (!res) return empty;
    const content = res.data?.content as { fields?: any } | null | undefined;
    const fields = content?.fields;
    if (!fields) return empty;

    const hedgeState = fields.hedge_state?.fields || {};
    const autoCfg = hedgeState.auto_hedge_config?.fields || {};
    const allActiveHedges: any[] = Array.isArray(hedgeState.active_hedges)
      ? hedgeState.active_hedges
      : [];

    // Filter out "internal mechanism" positions: the cron transfers USDC from
    // pool → admin wallet by calling open_hedge with tiny collateral
    // (typically 0.01 USDC, pair_index=0/BTC, is_long=true). These are not
    // real risk hedges and should never surface in the user-facing panel.
    // Real auto-hedges use MIN_HEDGE_SIZE_USD=$25 (see SuiAutoHedgingAdapter).
    const MIN_DISPLAYABLE_COLLATERAL_USDC = 1_000_000; // 1 USDC, raw 6-dec
    const activeHedges = allActiveHedges.filter((h) => {
      const c = Number(h?.fields?.collateral_usdc || 0);
      return c >= MIN_DISPLAYABLE_COLLATERAL_USDC;
    });

    // Fetch live prices for each unique asset present
    const priceMap: Record<string, number> = {};
    if (activeHedges.length > 0) {
      try {
        const { getMarketDataService } =
          await import('@/lib/services/market-data/RealMarketDataService');
        const mds = getMarketDataService();
        const assets = Array.from(
          new Set(
            activeHedges
              .map((h) => SUI_PAIR_INDEX_TO_ASSET[Number(h?.fields?.pair_index ?? -1)])
              .filter((a): a is string => !!a)
          )
        );
        await Promise.all(
          assets.map(async (a) => {
            try {
              const p = await mds.getTokenPrice(a);
              if (p?.price) priceMap[a] = p.price;
            } catch {
              /* missing price is non-fatal */
            }
          })
        );
      } catch (err) {
        logger.warn('[AutoHedge API] Could not load market prices for on-chain hedges', {
          error: errMsg(err),
        });
      }
    }

    const hedges: OnChainSuiHedge[] = activeHedges.map((h, idx) => {
      const f = h?.fields || {};
      const pairIndex = Number(f.pair_index ?? 0);
      const asset = SUI_PAIR_INDEX_TO_ASSET[pairIndex] || `PAIR_${pairIndex}`;
      const isLong = Boolean(f.is_long);
      const collateralUsdc = Number(f.collateral_usdc || 0) / 1e6; // USDC has 6 decimals
      const leverage = Math.max(1, Number(f.leverage || 1));
      const notional = collateralUsdc * leverage;
      const currentPrice = priceMap[asset] || 0;
      // Entry price is not stored on-chain — best-effort: use current as fallback so PnL is 0
      // until we wire a separate entry-price index.
      const entryPrice = currentPrice;
      const sizeBase = currentPrice > 0 ? notional / currentPrice : 0;
      const openTimeMs = Number(f.open_time || 0);
      // Hedge id: bytes -> hex
      let idHex: string;
      const hedgeIdBytes = Array.isArray(f.hedge_id) ? f.hedge_id : [];
      if (hedgeIdBytes.length > 0) {
        idHex =
          '0x' + hedgeIdBytes.map((b: number) => Number(b).toString(16).padStart(2, '0')).join('');
      } else {
        idHex = `sui-onchain-${idx}`;
      }

      return {
        id: idHex,
        asset,
        side: isLong ? 'LONG' : 'SHORT',
        size: Math.round(sizeBase * 1e8) / 1e8,
        notionalValue: Math.round(notional * 100) / 100,
        entryPrice: Math.round(entryPrice * 100) / 100,
        currentPrice: Math.round(currentPrice * 100) / 100,
        pnl: 0,
        pnlPercent: 0,
        createdAt: openTimeMs > 0 ? new Date(openTimeMs).toISOString() : new Date().toISOString(),
      };
    });

    const enabled = Boolean(autoCfg.enabled);
    const riskThresholdBps = Number(autoCfg.risk_threshold_bps || 0);
    const _maxHedgeRatioBps = Number(autoCfg.max_hedge_ratio_bps || 0);
    const defaultLeverage = Number(autoCfg.default_leverage || 1);

    return {
      hedges,
      enabled,
      config: {
        // Convert bps (0-10000) to 0-10 scale used by the UI
        riskThreshold: Math.round((riskThresholdBps / 1000) * 10) / 10,
        maxLeverage: defaultLeverage,
        allowedAssets: ['BTC', 'ETH', 'SUI'],
      },
    };
  } catch (err) {
    logger.warn('[AutoHedge API] Failed to read on-chain SUI hedges (non-critical)', {
      error: errMsg(err),
    });
    return empty;
  }
}

/**
 * Read live BlueFin Pro mainnet positions for the pool admin wallet and
 * convert them to the UI hedge shape. This is the source of truth for
 * perpetual hedges — the DB `hedges` table is a mirror that can lag behind
 * fills/closures. Surfacing live positions ensures the dashboard always
 * matches what an operator sees on bluefin.io.
 */
async function readLiveBluefinPositions(): Promise<{
  hedges: OnChainSuiHedge[];
  authoritative: boolean;
}> {
  const PK = (process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  if (!PK) return { hedges: [], authoritative: false };
  try {
    const { BluefinService } = await import('@/lib/services/sui/BluefinService');
    const bf = BluefinService.getInstance();
    await bf.initialize(PK, 'mainnet');
    const positions = await bf.getPositions();
    const hedges = positions.map((p, idx) => {
      const asset = (p.symbol || '').replace('-PERP', '');
      const side = ((p.side || 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') as
        | 'LONG'
        | 'SHORT';
      const size = Number((p as { size?: number }).size ?? 0);
      const entry = Number((p as { entryPrice?: number }).entryPrice ?? 0);
      const mark = Number((p as { markPrice?: number }).markPrice ?? entry);
      const margin = Number((p as { margin?: number }).margin ?? 0);
      const lev = Number((p as { leverage?: number }).leverage ?? 1);
      const notional = margin * Math.max(1, lev);
      const upnl = Number((p as { unrealizedPnl?: number }).unrealizedPnl ?? 0);
      const pnlPercent =
        entry > 0 ? ((mark - entry) / entry) * 100 * (side === 'SHORT' ? -1 : 1) : 0;
      return {
        id: `bf-live-${p.symbol}-${side}-${idx}`,
        asset,
        side,
        size,
        notionalValue: notional,
        entryPrice: entry,
        currentPrice: mark,
        pnl: upnl,
        pnlPercent,
        createdAt: new Date().toISOString(),
      };
    });
    // Auth + positions read both succeeded → live data is authoritative.
    return { hedges, authoritative: true };
  } catch (err) {
    logger.warn('[AutoHedge API] Failed to read live BlueFin positions (non-critical)', {
      error: errMsg(err),
    });
    return { hedges: [], authoritative: false };
  }
}

interface AutoHedgeStatus {
  enabled: boolean;
  config: {
    riskThreshold: number;
    maxLeverage: number;
    allowedAssets: string[];
  } | null;
  activeHedges: Array<{
    id: number | string;
    asset: string;
    side: 'LONG' | 'SHORT';
    size: number;
    notionalValue: number;
    entryPrice: number;
    currentPrice: number;
    pnl: number;
    pnlPercent: number;
    createdAt: string;
  }>;
  recentDecisions: Array<{
    id: string;
    action: string;
    reasoning: string;
    riskScore: number;
    executed: boolean;
    timestamp: string;
  }>;
  riskAssessment: {
    riskScore: number;
    drawdownPercent: number;
    volatility: number;
    recommendations: number;
    lastUpdated: string;
    aggregatedPrediction?: {
      direction: string;
      confidence: number;
      consensus: number;
      recommendation: string;
      sizeMultiplier: number;
      sources: Array<{
        name: string;
        available: boolean;
        weight: number;
        direction?: string;
        confidence?: number;
      }>;
    } | null;
  } | null;
  stats: {
    totalHedgeValue: number;
    totalPnL: number;
    hedgeCount: number;
    decisionsToday: number;
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Rate limit
  const limited = readLimiter.check(request);
  if (limited) return limited;

  const chain = request.nextUrl.searchParams.get('chain') || 'cronos';
  const isSui = chain === 'sui';
  const portfolioId = chainToPortfolioId(chain);

  // Return cached if fresh (prevents expensive re-assessment)
  const autoHedgeCache = autoHedgeCacheByChain.get(chain);
  if (autoHedgeCache && Date.now() < autoHedgeCache.expiresAt) {
    return NextResponse.json(autoHedgeCache.data, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }

  // Ensure tables exist and DB is reachable (idempotent, runs once per cold start)
  const dbAvailable = await ensureAllTables();

  try {
    // Get auto-hedge config (graceful fallback if DB is unavailable)
    let config: Awaited<ReturnType<typeof getAutoHedgeConfig>> = null;
    if (dbAvailable) {
      try {
        config = await getAutoHedgeConfig(portfolioId);

        // MAINNET: Auto-seed default config if none exists
        // This ensures auto-hedge is always configured for the community pool
        if (!config) {
          const defaultConfig = {
            portfolioId: portfolioId,
            walletAddress: COMMUNITY_POOL_ADDRESS,
            enabled: true,
            riskThreshold: 4,
            maxLeverage: 3,
            allowedAssets: ['BTC', 'ETH', 'CRO', 'SUI'],
            riskTolerance: 30,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
          try {
            await saveAutoHedgeConfig(defaultConfig);
            config = defaultConfig;
            logger.info('[AutoHedge API] Auto-seeded default config for community pool');
          } catch (seedErr) {
            logger.warn('[AutoHedge API] Could not seed default config', { error: seedErr });
          }
        }
      } catch (e: unknown) {
        logger.warn('[AutoHedge API] Could not fetch config', { error: errMsg(e) });
      }
    }

    // Get active hedges (graceful fallback if DB is unavailable)
    let hedges: Awaited<ReturnType<typeof getActiveHedges>> = [];
    if (dbAvailable) {
      try {
        hedges = await getActiveHedges(portfolioId, isSui ? 'sui' : undefined);
      } catch (e: unknown) {
        logger.warn('[AutoHedge API] Could not fetch hedges', { error: errMsg(e) });
      }
    }

    // For SUI: also read on-chain HedgePosition objects from the Move pool state.
    // The DB `hedges` table only stores BlueFin perp hedges. SUI's actual pool
    // hedges are Move-contract objects in pool.hedge_state.active_hedges and
    // were never surfaced to the UI before this branch.
    let onChainSui: OnChainSuiState = { hedges: [], enabled: false, config: null };
    let liveBluefinHedges: OnChainSuiHedge[] = [];
    let liveBluefinAuthoritative = false;
    if (isSui) {
      const [sui, live] = await Promise.all([readOnChainSuiHedges(), readLiveBluefinPositions()]);
      onChainSui = sui;
      liveBluefinHedges = live.hedges;
      liveBluefinAuthoritative = live.authoritative;
    }

    // Get recent AI decisions from database
    let recentDecisions: AutoHedgeStatus['recentDecisions'] = [];
    let decisionsToday = 0;

    if (dbAvailable) {
      try {
        const decisions = (await query(
          `
          SELECT transaction_id as id, details, created_at 
          FROM community_pool_transactions 
          WHERE type = 'AI_DECISION'
            AND (details->>'chain' = $1 OR ($1 = 'cronos' AND details->>'chain' IS NULL))
          ORDER BY created_at DESC 
          LIMIT 10
        `,
          [chain]
        )) as Array<{ id: string; details: Record<string, unknown>; created_at: Date }>;

        recentDecisions = decisions.map((d) => ({
          id: String(d.id || ''),
          action: String(d.details?.action || 'UNKNOWN'),
          reasoning: String(d.details?.reasoning || ''),
          riskScore: Number(d.details?.riskScore || 0),
          executed: Boolean(d.details?.executed),
          timestamp: d.created_at?.toISOString?.() || new Date().toISOString(),
        }));

        // Count today's decisions
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayCount = await query(
          `
          SELECT COUNT(*) as count FROM community_pool_transactions 
          WHERE type = 'AI_DECISION' AND created_at >= $1
            AND (details->>'chain' = $2 OR ($2 = 'cronos' AND details->>'chain' IS NULL))
        `,
          [todayStart, chain]
        );
        decisionsToday = Number(todayCount[0]?.count || 0);
      } catch (e) {
        logger.warn('[AutoHedge API] Could not fetch AI decisions', { error: e });
      }
    }

    // Get latest risk assessment from service (LIVE — no mock data)
    // Use timeout to prevent Vercel 504 — risk assessment involves multiple external APIs
    let riskAssessment: AutoHedgeStatus['riskAssessment'] = null;
    try {
      const RISK_TIMEOUT_MS = 8_000;
      const assessment = await Promise.race([
        autoHedgingService.triggerRiskAssessment(
          portfolioId,
          COMMUNITY_POOL_ADDRESS,
          isSui ? 'sui' : undefined
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Risk assessment timed out')), RISK_TIMEOUT_MS)
        ),
      ]);
      riskAssessment = {
        riskScore: Math.round(assessment.riskScore * 100) / 100,
        drawdownPercent: Math.round(assessment.drawdownPercent * 100) / 100,
        volatility: Math.round(assessment.volatility * 100) / 100,
        recommendations: assessment.recommendations.length,
        lastUpdated: new Date().toISOString(),
        aggregatedPrediction: assessment.aggregatedPrediction
          ? {
              ...assessment.aggregatedPrediction,
              confidence: Math.round(assessment.aggregatedPrediction.confidence * 100) / 100,
              consensus: Math.round(assessment.aggregatedPrediction.consensus * 100) / 100,
              sizeMultiplier:
                Math.round(assessment.aggregatedPrediction.sizeMultiplier * 100) / 100,
            }
          : null,
      };
    } catch (e) {
      logger.warn('[AutoHedge API] Could not get risk assessment — returning null (no mock data)', {
        error: e,
      });
      // riskAssessment stays null — frontend must handle null gracefully
    }

    // Calculate stats
    const totalHedgeValue = hedges.reduce((sum, h) => sum + Number(h.notional_value || 0), 0);
    const totalPnL = hedges.reduce((sum, h) => sum + Number(h.current_pnl || 0), 0);

    // Merge sources of hedge data into one display list. Priority order:
    //   1. Live BlueFin mainnet positions (source of truth for perp hedges)
    //   2. On-chain SUI Move hedges (open_hedge calls into the pool state)
    //   3. DB-recorded BlueFin hedges (rich metadata, may lag fills)
    //
    // Dedup keys:
    //   • (asset, side) → matches a live BlueFin position to a DB row,
    //     suppressing the DB mirror so PnL/mark are always live.
    //   • hedge_id_onchain → matches DB row to on-chain SUI hedge.
    //
    // AUTHORITATIVE MODE: when the live BlueFin read succeeded (auth + positions
    // call both returned), the live snapshot is the truth. ANY DB row whose
    // (asset, side) is NOT in the live set is stale — the perp was closed
    // outside the cron path (manual liquidation, off-cron close, or cron close
    // that failed to update DB). Suppress and schedule background cleanup so
    // the dashboard never inflates TVL/PnL with phantom positions.
    const liveKeySet = new Set(liveBluefinHedges.map((h) => `${h.asset}|${h.side}`));
    const staleDbRows =
      liveBluefinAuthoritative && !isSui
        ? hedges.filter((h) => !liveKeySet.has(`${h.asset}|${h.side}`))
        : [];
    if (staleDbRows.length > 0) {
      // Fire-and-forget: do NOT await — keeps the GET response fast.
      void (async () => {
        try {
          const { closeHedge } = await import('@/lib/db/hedges');
          for (const stale of staleDbRows) {
            try {
              await closeHedge(
                stale.order_id || `stale-${stale.id}`,
                Number(stale.current_pnl || 0),
                'closed'
              );
            } catch (e) {
              logger.warn('[AutoHedge API] Failed to close stale hedge row', {
                id: stale.id,
                error: errMsg(e),
              });
            }
          }
          logger.info('[AutoHedge API] Reconciled stale hedge rows against live BlueFin', {
            count: staleDbRows.length,
            ids: staleDbRows.map((s) => s.id),
          });
        } catch (e) {
          logger.warn('[AutoHedge API] Stale hedge cleanup skipped', { error: errMsg(e) });
        }
      })();
    }
    const staleIdSet = new Set(staleDbRows.map((s) => String(s.id)));
    const dbActiveHedges = hedges
      // Drop DB rows whose live counterpart we already have — the live
      // version has fresher entry/mark and unrealized PnL.
      // Drop stale rows (no live counterpart when live read is authoritative).
      .filter((h) => !liveKeySet.has(`${h.asset}|${h.side}`) && !staleIdSet.has(String(h.id)))
      .map((h) => ({
        id: String(h.id),
        asset: h.asset,
        side: h.side as 'LONG' | 'SHORT',
        size: Number(h.size),
        notionalValue: Number(h.notional_value),
        entryPrice: Number(h.entry_price),
        currentPrice: Number(h.current_price),
        pnl: Number(h.current_pnl),
        pnlPercent:
          Number(h.entry_price) > 0
            ? ((Number(h.current_price) - Number(h.entry_price)) / Number(h.entry_price)) * 100
            : 0,
        createdAt: h.created_at?.toISOString?.() || new Date().toISOString(),
      }));
    const dbOnChainIds = new Set(
      hedges.map((h) => (h.hedge_id_onchain || '').toLowerCase()).filter(Boolean)
    );
    const onChainOnly = onChainSui.hedges.filter(
      (h) => !dbOnChainIds.has(String(h.id).toLowerCase())
    );
    const mergedActiveHedges = [...liveBluefinHedges, ...dbActiveHedges, ...onChainOnly];
    const liveHedgeValue = liveBluefinHedges.reduce((sum, h) => sum + h.notionalValue, 0);
    const liveHedgePnL = liveBluefinHedges.reduce((sum, h) => sum + h.pnl, 0);
    // Subtract the suppressed DB rows (live-counterpart matches AND stale rows
    // with no live counterpart) so we don't double-count or inflate phantoms.
    const suppressedDbValue = hedges
      .filter((h) => liveKeySet.has(`${h.asset}|${h.side}`) || staleIdSet.has(String(h.id)))
      .reduce((sum, h) => sum + Number(h.notional_value || 0), 0);
    const suppressedDbPnL = hedges
      .filter((h) => liveKeySet.has(`${h.asset}|${h.side}`) || staleIdSet.has(String(h.id)))
      .reduce((sum, h) => sum + Number(h.current_pnl || 0), 0);
    const onChainHedgeValue = onChainOnly.reduce((sum, h) => sum + h.notionalValue, 0);

    // For SUI, the on-chain auto_hedge_config is the source of truth for `enabled`.
    // Fall back to the DB config only if on-chain read failed (no hedges and no config).
    const effectiveEnabled = isSui
      ? onChainSui.config !== null
        ? onChainSui.enabled
        : (config?.enabled ?? false)
      : (config?.enabled ?? false);
    const effectiveConfig =
      isSui && onChainSui.config !== null
        ? onChainSui.config
        : config
          ? {
              riskThreshold: config.riskThreshold,
              maxLeverage: config.maxLeverage,
              allowedAssets: config.allowedAssets,
            }
          : null;

    const status: AutoHedgeStatus = {
      enabled: effectiveEnabled,
      config: effectiveConfig,
      activeHedges: mergedActiveHedges,
      recentDecisions,
      riskAssessment,
      stats: {
        totalHedgeValue:
          Math.round(
            (totalHedgeValue - suppressedDbValue + liveHedgeValue + onChainHedgeValue) * 100
          ) / 100,
        totalPnL: Math.round((totalPnL - suppressedDbPnL + liveHedgePnL) * 100) / 100,
        hedgeCount: mergedActiveHedges.length,
        decisionsToday,
      },
    };

    const responseData = {
      success: true,
      ...status,
    };

    // Cache the response (but not if no hedges found — may be due to DB issues)
    if (status.activeHedges.length > 0) {
      autoHedgeCacheByChain.set(chain, {
        data: responseData,
        expiresAt: Date.now() + (isSui ? AUTO_HEDGE_SUI_CACHE_TTL : AUTO_HEDGE_CACHE_TTL),
      });
    }

    return NextResponse.json(responseData, {
      headers:
        status.activeHedges.length > 0
          ? { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' }
          : { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logger.error('[AutoHedge API] Error fetching status', { error });
    // Return error with 503 — do NOT cache or return fake "success" data
    logger.error('[AutoHedge API] Returning 503 — no mock/fallback data allowed', { error });
    return NextResponse.json(
      {
        success: false,
        error: 'Auto-hedge service temporarily unavailable',
        enabled: false,
        config: null,
        activeHedges: [],
        recentDecisions: [],
        riskAssessment: null,
        stats: null,
      },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // SECURITY: Rate-limit BEFORE auth so attackers can't burn CPU on auth checks.
  const { mutationLimiter } = await import('@/lib/security/rate-limiter');
  const rlResp = await mutationLimiter.checkDistributed(request);
  if (rlResp) return rlResp as NextResponse;

  // SECURITY: service credential only. This endpoint changes the pool's
  // hedging configuration and starts the hedging service; a wallet signature
  // proves nothing about a right to do that.
  const { verifyCronRequest } = await import('@/lib/qstash');
  const authResult = await verifyCronRequest(request, 'community-pool/auto-hedge');
  if (authResult !== true) return authResult;

  try {
    const body = await request.json();
    const { enabled, riskThreshold, maxLeverage } = body;

    // ── Input validation: clamp/reject out-of-range values ─────────
    // riskThreshold: 1-10 (anything else is nonsense or hostile)
    // maxLeverage:   1-10 (on-chain pool caps real leverage anyway, but
    //                       reject obvious abuse before we persist)
    if (riskThreshold !== undefined) {
      const rt = Number(riskThreshold);
      if (!Number.isFinite(rt) || rt < 1 || rt > 10) {
        return NextResponse.json(
          { success: false, error: 'riskThreshold must be a number 1-10' },
          { status: 400 }
        );
      }
    }
    if (maxLeverage !== undefined) {
      const ml = Number(maxLeverage);
      if (!Number.isFinite(ml) || ml < 1 || ml > 10) {
        return NextResponse.json(
          { success: false, error: 'maxLeverage must be a number 1-10' },
          { status: 400 }
        );
      }
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json(
        { success: false, error: 'enabled must be a boolean' },
        { status: 400 }
      );
    }

    // Get current config or create new one
    let config = await getAutoHedgeConfig(COMMUNITY_POOL_PORTFOLIO_ID);

    if (!config) {
      // Create new config
      config = {
        portfolioId: COMMUNITY_POOL_PORTFOLIO_ID,
        walletAddress: COMMUNITY_POOL_ADDRESS,
        enabled: enabled ?? true,
        riskThreshold: riskThreshold ?? 4,
        maxLeverage: maxLeverage ?? 3,
        allowedAssets: ['BTC', 'ETH'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      // Update existing config
      if (enabled !== undefined) config.enabled = enabled;
      if (riskThreshold !== undefined) config.riskThreshold = riskThreshold;
      if (maxLeverage !== undefined) config.maxLeverage = maxLeverage;
      // Defensive clamp on existing stored values that may have been
      // written by a previous unauthenticated POST (pre-auth-fix).
      if (
        !Number.isFinite(config.riskThreshold) ||
        config.riskThreshold < 1 ||
        config.riskThreshold > 10
      )
        config.riskThreshold = 4;
      if (!Number.isFinite(config.maxLeverage) || config.maxLeverage < 1 || config.maxLeverage > 10)
        config.maxLeverage = 3;
      config.updatedAt = Date.now();
    }

    await saveAutoHedgeConfig(config);

    // Trigger service reload
    await autoHedgingService.start();

    logger.info('[AutoHedge API] Config updated', {
      portfolioId: COMMUNITY_POOL_PORTFOLIO_ID,
      enabled: config.enabled,
    });

    return NextResponse.json({
      success: true,
      config: {
        enabled: config.enabled,
        riskThreshold: config.riskThreshold,
        maxLeverage: config.maxLeverage,
        allowedAssets: config.allowedAssets,
      },
    });
  } catch (error) {
    logger.error('[AutoHedge API] Error updating config', { error });
    return NextResponse.json(
      { success: false, error: 'Failed to update auto-hedge config' },
      { status: 500 }
    );
  }
}
