/**
 * Cron Job: Multi-Market Edge Trader (per-asset aggregated → BlueFin perp)
 *
 * Pipeline (every 5-min master tick):
 *
 *   1. Reconcile any active trade (see handlers/reconcile-active-trade.ts):
 *      • Position missing on Bluefin → book worst-case loss.
 *      • Trailing-stop / stop-loss triggered → close.
 *      • Signal-flip / score-collapse → close.
 *      • Fee-bleed defer → extend hold.
 *      • Max-hold expired → close and book realized PnL.
 *      • Else hold ('idle').
 *
 *   2. Risk gates: halt window, daily PnL cap, regret-based halt,
 *      free-collateral floor, funding-rate guard.
 *
 *   3. Multi-market scan: PredictionAggregatorService.scanAndPickBest
 *      builds per-asset evidence buckets and picks the highest score.
 *
 *   4. Sizing: baseStake × sizeMultiplier × (1 + min(cumPnL/baseStake, 4))
 *      capped by 10% of free collateral and POLYMARKET_EDGE_MAX_STAKE_USD.
 *
 *   5. Open + slippage-gate emergency close on excess slip.
 *
 *   6. Idempotency: clientOrderId = `polyedge_${asset}_${tickEpoch}`.
 *
 * Security: QStash signature or CRON_SECRET. Master scheduler invokes every 5m.
 *
 * Structure — refactored 2026-08-10:
 *   handlers/config.ts               env-driven tunables + cron_state keys
 *   handlers/types.ts                EdgeStats, DailyStats, EdgeResult
 *   handlers/trader-utils.ts         quantize, findActivePosition, recommendationToSide, etc.
 *   handlers/state-transitions.ts    applyOutcome, applyDaily, maybeHalt, finalizeClosingExit
 *   handlers/reconcile-active-trade.ts  the 5-branch reconcile phase
 *   route.ts                         auth, load state, dispatch, risk gates, scan, open (this file)
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { errMsg } from '@/lib/utils/error-handler';
import { computeEdgeStake } from '@/lib/services/trading/edge-sizing';
import { expectedValueUsd } from '@/lib/services/hedging/quant-models';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { envFlag } from '@/lib/utils/env-flag';
import { BluefinService, type BluefinPosition } from '@/lib/services/sui/BluefinService';
import { safeBluefinSnapshot, refreshBluefinCache } from '@/lib/services/sui/bluefin-read-safe';
import { PredictionAggregatorService } from '@/lib/services/market-data/PredictionAggregatorService';
import { getCronStateOr, setCronState } from '@/lib/db/cron-state';
import { query } from '@/lib/db/postgres';
import { computeSizeMultiplier, computeRegretScore } from '@/lib/services/ai/regret-tracker';
import { calibrate as calibrateProbability } from '@/lib/services/ai/probability-calibrator';
import { regretBasedHalt, fundingEdge, exposureCap, riskGate } from '@/lib/services/trading/trade-quality-gates';
import { checkBeforeTrade, completeTrade, getPriceAlertedSymbols } from '@/lib/services/agents/agent-trade-guard';
import {
  SUPPORTED_ASSETS,
  ASSET_MIN_QTY,
  ASSET_STEP,
  type SupportedAsset,
} from '@/lib/config/trader-assets';
import { effectiveGates } from '@/lib/services/trading/adaptive-gates';
import type { ActiveTrade } from '@/lib/services/trading/active-trade';

// ── Extracted config, types, helpers (see handlers/) ─────────────────────
import {
  MIN_CONFIDENCE,
  MIN_CONSENSUS,
  MIN_FREE_COLLATERAL_USD,
  BASE_STAKE_USD,
  MAX_STAKE_USD,
  STAKE_PCT_OF_FREE,
  DYNAMIC_BASE_PCT,
  LEVERAGE,
  EV_FUNDING_APR,
  EV_HOLDING_HOURS,
  EV_FEE_BPS_ROUND_TRIP,
  EV_MIN_USD,
  HALT_DURATION_MS,
  MAX_SLIPPAGE_BPS,
  DAILY_LOSS_CAP_USD,
  KEY_ACTIVE,
  KEY_STATS,
  KEY_HALTED_UNTIL,
  KEY_DAILY,
  KEY_NOEDGE_STREAK,
  MAX_HOLD_MIN_MODERATE,
  MAX_HOLD_MIN_STRONG,
} from './handlers/config';
import type { EdgeStats, DailyStats, EdgeResult } from './handlers/types';
import { DEFAULT_STATS } from './handlers/types';
import {
  quantize,
  findActivePosition,
  recommendationToSide,
  utcDayKey,
  recordSkip,
  trackStarvation,
} from './handlers/trader-utils';
import {
  applyOutcome,
  applyDaily,
  maybeHalt,
  closeWithRetry,
  pickExitPrice,
} from './handlers/state-transitions';
import { reconcileActiveTrade } from './handlers/reconcile-active-trade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse<EdgeResult>> {
  const ranAt = new Date().toISOString();
  // AWAIT the heartbeat — fire-and-forget gets dropped by Vercel's
  // serverless suspension after response (observed 2026-06-22: trader
  // ran successfully via manual trigger, returned full payload, but
  // health endpoint still showed 'traderCron: no entry yet' because
  // the void setCronState write didn't complete before the lambda
  // suspended). Awaiting adds ~50ms but guarantees the heartbeat
  // lands.
  await setCronState('cron:lastRun:polymarket-edge-trader', Date.now()).catch(() => {});

  const auth = await verifyCronRequest(request, 'PolymarketEdgeTrader');
  if (auth !== true) {
    return NextResponse.json(
      { success: false, ranAt, attempted: false, reason: 'Unauthorized' },
      { status: 401 },
    );
  }

  // Piggyback: shadow paper-trader on Hedera testnet vault. Same signals,
  // same tick cadence, mark-price fills with 13 bp round-trip + 11% APR
  // funding. Isolated state under `paper-trader:*` keys, hedge rows under
  // chain='hedera-testnet' + portfolio_id=-3. Non-fatal — a paper failure
  // must never block the real trader. QStash 10-schedule cap means we
  // can't add a standalone cron; piggyback is the shipping constraint.
  try {
    const { PaperTrader } = await import('@/lib/services/paper-trader/PaperTrader');
    await PaperTrader.runTick().catch((e) => {
      logger.warn('[PaperTrader] piggyback tick failed (non-fatal)', {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  } catch (e) {
    logger.warn('[PaperTrader] piggyback import failed (non-fatal)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  // Piggyback: signal-outcome resolver. Closes the learning loop by
  // scoring interpretations that have passed their horizon against
  // realized spot. Runs inline via direct import (not HTTP) because the
  // fetch-based approach silently failed in prod 2026-09-18 — VERCEL_URL
  // resolves to the deployment-specific URL which hits deployment
  // protection when called cross-deploy. Direct import bypasses the
  // network entirely and preserves the same debounce guard.
  // Non-fatal: resolver failure never blocks trading.
  try {
    const { runResolveOutcomesTick } = await import('@/lib/services/ai/resolve-outcomes-tick');
    await runResolveOutcomesTick(Date.now()).catch((e) => {
      logger.warn('[ResolveOutcomes] piggyback tick failed (non-fatal)', {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  } catch (e) {
    logger.warn('[ResolveOutcomes] piggyback import failed (non-fatal)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const adminKey = (process.env.BLUEFIN_PRIVATE_KEY || process.env.SUI_POOL_ADMIN_KEY || '').trim();
  if (!adminKey) {
    return NextResponse.json({
      success: true,
      ranAt,
      attempted: false,
      reason: 'BLUEFIN_PRIVATE_KEY not configured',
    });
  }

  const network: 'mainnet' | 'testnet' =
    (process.env.SUI_NETWORK as 'mainnet' | 'testnet') === 'testnet' ? 'testnet' : 'mainnet';

  const [active, stats, haltedUntil, dailyRaw] = await Promise.all([
    getCronStateOr<ActiveTrade | null>(KEY_ACTIVE, null),
    getCronStateOr<EdgeStats>(KEY_STATS, DEFAULT_STATS),
    getCronStateOr<number>(KEY_HALTED_UNTIL, 0),
    getCronStateOr<DailyStats>(KEY_DAILY, { utcDayKey: '', pnlUsd: 0, trades: 0 }),
  ]);

  // Migrate stats: never silently zero peakPnlUsd if it was set previously
  // and the new fetch returned defaults (e.g. transient DB error). We treat
  // a default value as missing and fall back to a safe "no peak yet" zero.
  const safeStats: EdgeStats = {
    ...DEFAULT_STATS,
    ...stats,
    peakPnlUsd: Math.max(stats.peakPnlUsd || 0, stats.totalPnlUsd || 0),
    perAsset: stats.perAsset || {},
  };

  const now = Date.now();
  const today = utcDayKey(now);
  const daily: DailyStats = dailyRaw.utcDayKey === today
    ? dailyRaw
    : { utcDayKey: today, pnlUsd: 0, trades: 0 };

  try {
    const bf = BluefinService.getInstance();
    await bf.initialize(adminKey, network);

    // ── 0) Refresh shared BlueFin cache for downstream NAV / health
    //    consumers. This cron runs every 5 min and already needs both
    //    getBalance and getPositions — using them to keep the
    //    `bluefin:nav-last-good` cache hot gives the pool a SECOND
    //    5-min cache writer alongside bluefin-health, so a single-cron
    //    failure can't stale the cache.
    try {
      const [bal, pos] = await Promise.all([
        bf.getBalance().catch(() => 0),
        bf.getPositions().catch(() => [] as BluefinPosition[]),
      ]);
      await refreshBluefinCache({
        free: Number(bal) || 0,
        positions: pos as unknown as Array<Record<string, unknown>>,
        source: 'polymarket-edge-trader',
      });
    } catch { /* best-effort; trader loop continues below */ }
    // ── 1) If a trade is active — reconcile via handler ─────────────────
    if (active) {
      const reconciled = await reconcileActiveTrade({
        bf, active, safeStats, daily, haltedUntil, now, ranAt,
      });
      if (reconciled) return reconciled;
      // Reconcile did not return — trade is in flight AND no exit
      // condition. This should be unreachable because in-flight branches
      // (signal-flip 'idle', fee-bleed defer 'idle') respond inline.
      // Guard anyway so a future refactor accidentally reaching here
      // doesn't fall through into risk-gate + open path.
      logger.error('[PolymarketEdge] reconcileActiveTrade returned null with active trade — unexpected');
      return NextResponse.json({
        success: false, ranAt, attempted: true,
        stats: safeStats, daily,
        error: 'reconcile returned no exit for active trade — investigate',
      }, { status: 500 });
    }

    // ── 2) No active trade — check halt & daily cap ──────────────────────
    if (haltedUntil > now) {
      const haltReason = `Halted for ${Math.round((haltedUntil - now) / 60000)}m more (until ${new Date(haltedUntil).toISOString().slice(0, 16)})`;
      // Record so operators can see WHY the trader is idle instead of
      // watching cron:lastRun update with no other diagnostic. Halt was
      // previously the only silent skip path.
      await recordSkip('halted', haltReason);
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'halted',
        stats: safeStats,
        daily,
        haltedUntil,
        reason: haltReason,
      });
    }

    // Treasury halt — pause new opens when the agent's free balance is
    // negative. Opt-in via TREASURY_HALT_ON_UNDERWATER=1 for safe rollout.
    // Idempotency: read-only check; no state mutation.
    if ((process.env.TREASURY_HALT_ON_UNDERWATER || '').trim() === '1') {
      try {
        const { getTreasuryState } = await import('@/lib/db/treasury');
        const t = await getTreasuryState();
        if (!t.healthy) {
          const treasuryHaltReason = `Treasury underwater (freeBalance=$${t.freeBalanceUsd.toFixed(2)}) — no new opens`;
          await recordSkip('treasury-underwater', treasuryHaltReason);
          return NextResponse.json({
            success: true,
            ranAt,
            attempted: true,
            action: 'treasury-halt',
            stats: safeStats,
            daily,
            treasury: t,
            reason: treasuryHaltReason,
          });
        }
      } catch (err) {
        logger.warn('[PolymarketEdge] treasury check failed, continuing', {
          error: err instanceof Error ? err.message : err,
        });
      }
    }
    if (daily.pnlUsd <= DAILY_LOSS_CAP_USD) {
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'daily-cap',
        stats: safeStats,
        daily,
        reason: `daily PnL $${daily.pnlUsd.toFixed(2)} ≤ cap $${DAILY_LOSS_CAP_USD.toFixed(2)}`,
      });
    }

    // Multi-market scan: get a SEPARATE aggregated prediction per asset, then
    // pick the one with the strongest score (sqrt(conf*consensus) + STRONG bonus).
    // This is "AI agents looking at multiple markets and deciding smartly":
    // each asset gets its own bucket of Polymarket / Delphi / Crypto.com /
    // funding-proxy sources before scoring.
    // Load the consecutive no-edge streak counter and derive effective
    // gates. If the operator set MIN_CONFIDENCE/MIN_CONSENSUS above what
    // real signals can achieve, this progressively relaxes them over
    // an hour of skips so the trader can eventually fire.
    //
    // Increment the streak IMMEDIATELY and unconditionally so downstream
    // early-returns (halt, daily-cap, no-collateral, scan errors, risk
    // gate blocks, thrown exceptions caught by outer catch) cannot
    // collapse the accumulator. Only a successful open (setCronState
    // KEY_ACTIVE around line 1070) resets it. Observed 2026-07-11 21:35+:
    // streak froze at 4 across 5 ticks because something between the
    // read and the increment was returning early — that pattern is
    // impossible with pre-increment.
    const priorNoEdgeStreak = await getCronStateOr<number>(KEY_NOEDGE_STREAK, 0);
    const noEdgeStreak = priorNoEdgeStreak + 1;
    await setCronState(KEY_NOEDGE_STREAK, noEdgeStreak).catch(() => {});

    // Regret-weighted conviction gate + full halt (2026-07-15).
    // Two independent uses of regret data:
    //   1. Multiplier (0.25-1.0) → adjusts MIN_CONFIDENCE + stake sizing
    //   2. Raw score (-1..+1) → halts entire trader when < -0.3 (bad streak)
    // Env gate REGRET_TRACKER_DISABLE=1 to bypass everything.
    let regretMultiplierEarly = 1;
    let regretScoreForHalt = 0;
    try {
      if ((process.env.REGRET_TRACKER_DISABLE ?? '') !== '1') {
        const rows = await query<{ open_confidence: number; realized_pnl: number; created_at: Date }>(
          `SELECT COALESCE(open_confidence, 60) as open_confidence,
                  COALESCE(realized_pnl, 0)::float as realized_pnl,
                  created_at
           FROM hedges
           WHERE status='closed' AND created_at > NOW() - INTERVAL '30 days'
           ORDER BY created_at DESC LIMIT 200`
        ).catch(() => []);
        if (rows.length > 0) {
          const decisions = rows.map((r) => ({
            openConfidence: Number(r.open_confidence),
            realizedPnl: Number(r.realized_pnl),
            openedAt: new Date(r.created_at),
          }));
          regretMultiplierEarly = envFlag('REGRET_CONVICTION_GATE_DISABLE')
            ? 1
            : await computeSizeMultiplier({ recentDecisions: decisions });
          regretScoreForHalt = computeRegretScore(decisions);
        }
      }
    } catch { /* best-effort */ }

    // Regret-based full halt: distinct from conviction-adjustment above.
    // Halts trader entirely for the tick when 30-day regret is deeply
    // negative. Env: TRADER_REGRET_HALT_DISABLE=1 to keep trading
    // through losing streaks.
    if ((process.env.TRADER_REGRET_HALT_DISABLE ?? '') !== '1') {
      const haltDecision = regretBasedHalt({ regretScore: regretScoreForHalt });
      if (haltDecision.halt) {
        logger.warn('[EdgeTrader] regret-based halt', haltDecision);
        await notifyDiscord(
          `🛑 Trader HALTED (regret ${regretScoreForHalt.toFixed(3)} < ${haltDecision.threshold})`,
          'KILL', { haltDecision },
        ).catch(() => {});
        await recordSkip('regret-halt', haltDecision.reason);
        return NextResponse.json({
          success: true, ranAt, attempted: true, action: 'regret-halt',
          reason: haltDecision.reason,
        });
      }
    }

    const convictionAdjustMax = Number(process.env.REGRET_CONVICTION_MAX_ADJ_PCT) || 15;
    const regretAdjustedMinConf = Math.min(80,
      MIN_CONFIDENCE + (1 - regretMultiplierEarly) * convictionAdjustMax);

    const { effectiveConf, effectiveCons, relaxSteps } = effectiveGates(
      regretAdjustedMinConf,
      MIN_CONSENSUS,
      priorNoEdgeStreak,   // Use the value the previous tick set — this
                            // tick's increment is a "fingerprint" for future
                            // ticks. Prevents off-by-one where a fresh tick
                            // would see its own increment.
    );
    if (regretAdjustedMinConf !== MIN_CONFIDENCE) {
      logger.info('[EdgeTrader] regret-weighted conviction gate', {
        baseMinConf: MIN_CONFIDENCE,
        regretMultiplier: regretMultiplierEarly.toFixed(3),
        regretAdjustedMinConf: regretAdjustedMinConf.toFixed(1),
      });
    }
    if (relaxSteps > 0) {
      logger.info('[PolymarketEdge] Gates relaxed due to prolonged no-edge streak', {
        priorNoEdgeStreak,
        configuredConf: MIN_CONFIDENCE,
        configuredCons: MIN_CONSENSUS,
        effectiveConf,
        effectiveCons,
        relaxSteps,
      });
    }
    let scan: Awaited<ReturnType<typeof PredictionAggregatorService.scanAndPickBest>>;
    try {
      scan = await PredictionAggregatorService.scanAndPickBest(SUPPORTED_ASSETS, {
        minConfidence: effectiveConf,
        minConsensus: effectiveCons,
        minSources: 2,
      });
    } catch (scanErr) {
      // If the aggregator throws (upstream API down, malformed response,
      // etc.), record it as a skip so operators can see it. Otherwise
      // the outer catch swallows the error into a generic 500 and the
      // last-skip diagnostic stays frozen on stale content.
      const msg = scanErr instanceof Error ? scanErr.message : String(scanErr);
      logger.error('[PolymarketEdge] scanAndPickBest threw', { error: msg });
      await recordSkip('no-edge', `scanAndPickBest threw: ${msg.slice(0, 200)}`);
      return NextResponse.json({
        success: false,
        ranAt,
        attempted: true,
        action: 'no-edge',
        stats: safeStats,
        daily,
        error: msg,
      }, { status: 200 });
    }

    const allSummary = Object.fromEntries(
      Object.entries(scan.all).map(([a, p]) => [
        a,
        {
          direction: p.direction,
          recommendation: p.recommendation,
          confidence: Math.round(p.confidence),
          consensus: Math.round(p.consensus),
          sources: p.sources.length,
          score: Math.round(PredictionAggregatorService.scoreOpportunity(p)),
        },
      ]),
    );

    if (!scan.best) {
      // Log per-asset scoring so operators can see WHY nothing cleared.
      // Compact digest small enough for cron_state.
      const rejectionDigest = Object.entries(scan.all)
        .map(([a, p]) => `${a}:${p.recommendation}/${Math.round(p.confidence)}/${Math.round(p.consensus)}/${p.sources.length}s`)
        .join(' ');
      const relaxTag = relaxSteps > 0
        ? ` (relaxed from ${MIN_CONFIDENCE}/${MIN_CONSENSUS} after ${noEdgeStreak} skips)`
        : '';
      await recordSkip(
        'no-edge',
        `no asset cleared gates. Per-asset (rec/conf/cons/srcs): ${rejectionDigest}. Effective gates: conf>=${effectiveConf}, cons>=${effectiveCons}, srcs>=2${relaxTag}`,
      );
      // Note: streak was already incremented at the top of the tick
      // (pre-increment pattern) so downstream early-returns can't
      // collapse the accumulator.
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'no-edge',
        stats: safeStats,
        daily,
        scan: allSummary,
        reason: 'no asset cleared confidence/consensus/source gates',
      });
    }
    // Note: the no-edge streak is NOT reset here even though scan.best
    // is truthy. Original design reset it "when a directional signal
    // exists", but that turned out to be too eager: any single tick
    // where signals barely cleared the (already-relaxed) gates but
    // downstream checks (minQty walk / risk gate / no affordable
    // asset) blocked the trade would reset the counter and force us
    // to accumulate again. Observed on 2026-07-11: streak hit 4 at
    // 21:00 (gates 63/63), one intermediate tick had scan.best truthy
    // but nothing affordable, reset to 0, then next observed tick was
    // back at streak=1 with gates=70/70. So the relaxation never
    // stayed. Reset only when a trade actually opens (see the
    // post-open reset near the successful-open Discord notify).

    // Rank directional candidates that INDIVIDUALLY clear the effective
    // gates. Without the per-candidate gate filter, the walk can pick
    // a lower-conf asset just because its consensus is high enough to
    // beat scan.best's score (e.g. SOL 56/100 outranks ETH 66/67 by
    // sqrt(conf × cons)). Observed 2026-07-13 20:40 UTC: gates were
    // 63/63 (relaxed) and only ETH cleared, but SOL got picked because
    // scan.all is unfiltered — resulting in a real trade opened on a
    // 56% conf signal, well below the 63% floor the operator set.
    //
    // Applying the same gate on the walk keeps the fallback behaviour
    // (walk lower-scored candidates when top pick fails minQty) but
    // limits the pool to signals that actually cleared the noise floor.
    const rankedCandidates = Object.entries(scan.all)
      .map(([a, p]) => ({
        asset: a as SupportedAsset,
        prediction: p,
        score: PredictionAggregatorService.scoreOpportunity(p),
        side: recommendationToSide(p.recommendation),
      }))
      .filter((c) =>
        c.side !== null &&
        Number.isFinite(c.score) &&
        c.prediction.confidence >= effectiveConf &&
        c.prediction.consensus >= effectiveCons &&
        c.prediction.sources.length >= 2,
      )
      .sort((a, b) => b.score - a.score);

    if (rankedCandidates.length === 0) {
      const bestPrediction = scan.best.prediction;
      await recordSkip('no-edge', 'no directional recommendation across universe');
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'no-edge',
        stats: safeStats,
        daily,
        scan: allSummary,
        prediction: {
          direction: bestPrediction.direction,
          recommendation: bestPrediction.recommendation,
          confidence: bestPrediction.confidence,
          consensus: bestPrediction.consensus,
          probability: bestPrediction.probability,
          sourceNames: bestPrediction.sources.map((s) => s.name.split(':')[0].trim()),
        },
        reason: 'all candidates are WAIT / no directional recommendation',
      });
    }

    // Provisionally use the top-ranked candidate; the minQty affordability
    // walk below may downgrade to a lower-scored candidate when the top
    // pick is too expensive for the pool.
    let asset = rankedCandidates[0].asset;
    let prediction = rankedCandidates[0].prediction;
    let side = rankedCandidates[0].side!;
    let symbol = `${asset}-PERP`;
    let sourceNames = prediction.sources.map((s) => s.name.split(':')[0].trim());

    // Free collateral & sizing.
    //
    // The absolute MIN_FREE_COLLATERAL_USD floor (default $15) was a
    // silent no-op on small pools: a $50-NAV pool with ~$29 in BlueFin
    // collateral and one active hedge locking $16 margin has ~$13 free.
    // The trader would refuse to open every 5-min tick because $13 < $15,
    // even though the actual stake it wants to place is only ~$5.
    //
    // Small-pool relief: cap the effective floor at 1.5× BASE_STAKE_USD.
    // Sized against actual per-trade cost: max slip (30 bps) + fees (13 bps)
    // on 3× levered notional = ~1.3% of stake = ~$0.07 on a $5 stake, so
    // 0.5× stake ($2.50) of headroom is ~35× the expected worst case. The
    // earlier 2× relief was blocking $9.23 free at $10 floor (2026-08-14:
    // 3243-tick no-edge streak) despite the pool having enough for the
    // actual stake. At scale (BASE_STAKE_USD ≥ $10) the operator's $15
    // MIN_FREE_COLLATERAL_USD floor wins via Math.min as intended.
    //
    // Use safeBluefinSnapshot so a transient venue API blip (empty
    // getBalance response) falls back to the last-good cache rather
    // than freezing the trader for hours. `onChainHasExposure: true`
    // means "if venue reports empty AND we have active hedges, prefer
    // cache" — the trader is by definition operating on a chain where
    // it opens hedges, so any hedge id it has ever created counts as
    // exposure. Observed 2026-07-10: 9 consecutive empty BlueFin reads
    // caused the trader to skip 45 minutes of a STRONG_HEDGE_LONG BTC
    // signal at 83% confidence.
    const bfSnap = await safeBluefinSnapshot({
      network: (process.env.BLUEFIN_NETWORK || process.env.SUI_NETWORK || 'mainnet') as 'mainnet' | 'testnet',
      onChainHasExposure: true,
    });
    const free = bfSnap.free;
    if (bfSnap.source !== 'live') {
      logger.info('[PolymarketEdge] Using cached BlueFin snapshot', {
        source: bfSnap.source, ageMs: bfSnap.ageMs, free, warning: bfSnap.warning,
      });
    }
    const effectiveMinFree = Math.min(MIN_FREE_COLLATERAL_USD, BASE_STAKE_USD * 1.5);
    if (free < effectiveMinFree) {
      const reason = `free=$${free.toFixed(2)} < effective-min=$${effectiveMinFree.toFixed(2)} (configured min=$${MIN_FREE_COLLATERAL_USD}, base-stake=$${BASE_STAKE_USD}, bf-source=${bfSnap.source})`;
      await recordSkip('no-collateral', reason);
      // Increment starvation streak + fire ONE KILL alert per 24h once
      // ~1h dormant. Solves the silent-dormancy failure observed
      // 2026-08-16 to 2026-08-28 (11 days, 3411 skips, no alert).
      await trackStarvation('no-collateral', free);
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'no-collateral',
        stats: safeStats,
        daily,
        reason,
      });
    }
    // Any non-starvation exit past this point resets the streak so the
    // alert flag can re-fire cleanly if starvation returns later.
    await trackStarvation('proceed', free);

    // ── MIN-QTY-AWARE CANDIDATE WALK ────────────────────────────────
    // Fetch reference prices for every ranked candidate in parallel so
    // we can rank affordability without adding round-trips. Then walk
    // candidates highest-score first and pick the first one whose
    // minQty stake fits inside MAX_STAKE_PCT_OF_FREE_FOR_MIN_QTY of
    // the pool's free collateral.
    const OPEN_BUFFER = 1.5;             // matches BluefinService dust guard
    // Env-configurable cap: don't spend more than this fraction of free
    // collateral just to clear minQty. Progression: 0.7 → 0.9 → 0.92 →
    // 0.99 → 1.0. Greedy mode 2026-07-14: at 0.99 ETH still blocked at
    // 99.9% (razor thin). Push to 1.0 — accept using all free for the
    // stake, since the trailing-stop cap keeps single-trade loss below
    // the free amount anyway.
    const MAX_STAKE_PCT_OF_FREE_FOR_MIN_QTY = Number(
      process.env.POLYMARKET_EDGE_MAX_STAKE_PCT || 1.0,
    );

    const priceFetches = await Promise.all(
      rankedCandidates.map(async (c) => {
        const md = await bf.getMarketData(`${c.asset}-PERP`).catch(() => null);
        return { asset: c.asset, refPrice: Number(md?.price) || 0 };
      }),
    );
    const priceMap = new Map(priceFetches.map((p) => [p.asset, p.refPrice]));

    // Pre-fetch the PriceMonitorAgent alert list so we can filter alerted
    // assets out of the candidate walk BEFORE running the full agent
    // guard. Without this the walk would pick the top-ranked asset,
    // hit the guard, get rejected with "PriceMonitorAgent alert active
    // on X" and bail — losing the chance to fall through to the next
    // candidate. Observed 2026-07-13: 15+ hours of no trades because
    // SOL kept getting picked and blocked while BTC/ETH were fine.
    let alertedAssets = new Set<string>();
    try {
      alertedAssets = await getPriceAlertedSymbols();
    } catch {
      /* non-critical — if the helper fails, walk proceeds unfiltered
       * and the full guard downstream will still catch alerted trades.
       */
    }

    // Same fall-through pattern for pre-existing positions. Without this,
    // the walk pins the top-ranked candidate (e.g. ETH), then the downstream
    // conflict check at line 754 hard-skips because ETH-PERP is already open
    // — losing the chance to fall through to the next affordable asset.
    // Observed 2026-08-14: pool held a 2-month ETH-PERP SHORT (+$1.37 delta-
    // neutral funding) that blocked the trader every tick whenever ETH ranked
    // top, even though BTC/SOL/SUI were tradeable. The intent expressed at
    // line 751 ("other assets can still trade") was correct; the walk just
    // didn't respect it. Downstream check remains as belt-and-suspenders.
    let openPositionSymbols = new Set<string>();
    try {
      const openNow = await bf.getPositions();
      openPositionSymbols = new Set(
        (openNow || [])
          .filter((p) => Number(p.size ?? 0) !== 0)
          .map((p) => String(p.symbol ?? '')),
      );
    } catch {
      /* non-critical — downstream conflict check will still catch it */
    }

    let compoundMul = 1;
    let stakeUsd = BASE_STAKE_USD;
    let effectiveStake = BASE_STAKE_USD;
    let refPrice = 0;
    let picked: (typeof rankedCandidates)[number] | null = null;
    const rejectedForMinQty: string[] = [];

    // Gap 7 regret multiplier — same value computed earlier for conviction
    // gate; reuse here for stake sizing (multiplied into sizeMultiplier).
    const regretMultiplier = regretMultiplierEarly;
    if (regretMultiplier < 1) {
      logger.warn('[EdgeTrader] regret multiplier applied to stake sizing', {
        multiplier: regretMultiplier.toFixed(3),
      });
    }

    for (const c of rankedCandidates) {
      // Fast alert filter: if PriceMonitor has an active threshold
      // alert on this asset, downstream agent-guard will block it.
      // Skip now so we can fall through to the next affordable
      // non-alerted candidate.
      if (alertedAssets.has(c.asset)) {
        rejectedForMinQty.push(`${c.asset}: price-alert active`);
        continue;
      }
      // Fall past pre-existing positions so a delta-neutral hedge
      // on one asset doesn't lock out trading on the rest.
      if (openPositionSymbols.has(`${c.asset}-PERP`)) {
        rejectedForMinQty.push(`${c.asset}: position already open`);
        continue;
      }
      const rp = priceMap.get(c.asset) || 0;
      if (rp <= 0) {
        rejectedForMinQty.push(`${c.asset}: no mark price`);
        continue;
      }
      const cStake = computeEdgeStake({
        baseStakeUsd: BASE_STAKE_USD,
        totalPnlUsd: safeStats.totalPnlUsd,
        // Compose signal-strength multiplier with regret multiplier so
        // recent losses shrink stake, wins restore it.
        sizeMultiplier: c.prediction.sizeMultiplier * regretMultiplier,
        freeCollateral: free,
        stakePctOfFree: STAKE_PCT_OF_FREE,
        maxStakeUsd: MAX_STAKE_USD,
        dynamicBasePct: DYNAMIC_BASE_PCT,
      });
      const actualMinQty = ASSET_STEP[c.asset];
      const minNotionalToClearFloor = actualMinQty * rp * OPEN_BUFFER;
      const minStakeToClearFloor = minNotionalToClearFloor / LEVERAGE;
      const requiredStakeUsd = Math.max(cStake.stakeUsd, minStakeToClearFloor);
      const requiredStakePct = requiredStakeUsd / free;
      if (requiredStakePct > MAX_STAKE_PCT_OF_FREE_FOR_MIN_QTY) {
        rejectedForMinQty.push(
          `${c.asset}: needs $${requiredStakeUsd.toFixed(2)} stake (${(requiredStakePct * 100).toFixed(1)}% of free)`,
        );
        continue;
      }
      // Found an affordable candidate — pin it and break.
      picked = c;
      asset = c.asset;
      prediction = c.prediction;
      side = c.side!;
      symbol = `${asset}-PERP`;
      sourceNames = prediction.sources.map((s) => s.name.split(':')[0].trim());
      compoundMul = cStake.compoundMul;
      stakeUsd = cStake.stakeUsd;
      effectiveStake = requiredStakeUsd;
      refPrice = rp;
      if (requiredStakeUsd > cStake.stakeUsd) {
        logger.info('[PolymarketEdge] auto-bumping stake to clear minQty', {
          asset, originalStake: cStake.stakeUsd.toFixed(2),
          bumpedStake: requiredStakeUsd.toFixed(2),
          originalPct: (cStake.stakeUsd / free * 100).toFixed(1),
          bumpedPct: (requiredStakeUsd / free * 100).toFixed(1),
        });
      }
      if (c !== rankedCandidates[0]) {
        logger.info('[PolymarketEdge] fell back from top-ranked candidate', {
          topRanked: rankedCandidates[0].asset,
          picked: c.asset,
          reason: 'top-ranked failed minQty affordability check',
          rejected: rejectedForMinQty,
        });
      }
      break;
    }

    if (!picked) {
      const skipReason = `all candidates fail minQty check on free=$${free.toFixed(2)}. Rejects: ${rejectedForMinQty.join('; ')}`;
      await recordSkip('skip-asset-too-small-nav', skipReason);
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'skip-asset-too-small-nav',
        stats: safeStats,
        daily,
        reason: skipReason,
      });
    }

    const step = ASSET_STEP[asset];
    // BlueFin's dust guard requires size ≥ 1.5× minQty AFTER
    // quantization. quantize() floors to step size, so an in-band raw
    // qty like 0.197 for SOL (minQty 0.1) snaps to 0.1 — which is
    // exactly minQty and fails the dust check. Bump to at least
    // ceil(1.5 × minQty / step) × step so we always clear the guard.
    // For minQty === step (all our supported assets) this simplifies
    // to 2 × step. Observed 2026-07-13: SOL was snapping to 0.1 every
    // tick and openHedge rejected with "Size 0.1 < 1.5× minQty 0.1".
    const minDustSafeQty = Math.ceil((1.5 * step) / step) * step;
    const initialNotional = effectiveStake * LEVERAGE;
    const rawQty = initialNotional / refPrice;
    const quantizedQty = quantize(rawQty, step);
    const sizeQty = Math.max(quantizedQty, minDustSafeQty);
    // Recompute notional from the ACTUAL size we're going to send, not
    // the pre-quantize estimate — otherwise risk-gate + Discord alert
    // would see a stale number after the dust-safe bump.
    const notionalUsd = sizeQty * refPrice;
    if (sizeQty > quantizedQty) {
      logger.info('[PolymarketEdge] bumping qty to clear BlueFin dust guard', {
        asset,
        rawQty: rawQty.toFixed(6),
        quantized: quantizedQty,
        bumped: sizeQty,
        minDustSafe: minDustSafeQty,
        step,
        notionalBumped: notionalUsd.toFixed(2),
      });
    }

    // Risk gate (mirrors RiskAgent invariants without an LLM round-trip).
    const risk = riskGate({
      leverage: LEVERAGE,
      minQty: ASSET_MIN_QTY[asset],
      sizeQty,
      notionalUsd,
      free,
      refPrice,
    });
    if (!risk.ok) {
      logger.warn('[PolymarketEdge] risk gate blocked entry', { reason: risk.reason });
      // Record the block reason so it's visible via cron_state instead
      // of a silent 500 or stale last-skip.
      await recordSkip('no-edge', `risk-gate blocked ${asset} ${side}: ${risk.reason}`);
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'no-edge',
        stats: safeStats,
        daily,
        reason: `risk-gate: ${risk.reason}`,
      });
    }

    // ── Funding-adjusted EV gate ─────────────────────────────────────
    // Kelly + calibration only check that p > 0.5 with edge margin. But
    // a 55% edge held 30 min at 11% APR funding + 13 bps round-trip fees
    // on a 3× levered notional is often NEGATIVE-EV once you subtract
    // costs. Skipping these is exactly what prevented the wash-trade
    // pattern from being visible before (100% phantom rate 2026-08-08).
    // Payoff odds = 1 for symmetric perp bet (win or lose 1× stake in
    // notional terms); leverage is captured via notionalUsd (= stake × L).
    // Bayesian-shrunken probability from historical outcomes for this
    // (asset, side, confidence-bucket). Falls back to raw when no
    // history exists. Closes the biggest known PnL leak — historical
    // conf 70-80 bucket won 12% of the time despite the model saying
    // 74% confidence. Fed into EV gate so trades gate on truthful EV.
    const calibration = await calibrateProbability({
      asset,
      side: side as 'LONG' | 'SHORT',
      rawConfidencePct: prediction.confidence,
    });
    const evP = Math.min(0.999, Math.max(0.001, calibration.pCalibrated));
    const ev = expectedValueUsd({
      probability: evP,
      payoffOdds: 1,
      notionalUsd,
      holdingHours: EV_HOLDING_HOURS,
      fundingRateApr: EV_FUNDING_APR,
      feeBpsRoundTrip: EV_FEE_BPS_ROUND_TRIP,
    });
    logger.info('[PolymarketEdge] probability calibration', {
      asset, side,
      rawConf: prediction.confidence,
      pRaw: calibration.pRaw,
      pCalibrated: calibration.pCalibrated,
      nHistory: calibration.nHistory,
      empiricalWinRate: calibration.empiricalWinRate,
    });
    if (ev.evUsd < EV_MIN_USD) {
      const evReason = `ev-gate blocked ${asset} ${side}: EV=$${ev.evUsd.toFixed(3)} < min $${EV_MIN_USD.toFixed(2)} ` +
        `(edge=$${ev.edgeUsd.toFixed(3)} funding=$${ev.fundingCostUsd.toFixed(3)} fees=$${ev.feeCostUsd.toFixed(3)}, ` +
        `p=${(evP * 100).toFixed(1)}% notional=$${notionalUsd.toFixed(2)} hold=${EV_HOLDING_HOURS}h)`;
      logger.warn('[PolymarketEdge] EV gate blocked entry', { reason: evReason, ev });
      await recordSkip('no-edge', evReason);
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'no-edge',
        stats: safeStats,
        daily,
        reason: `ev-gate: ${evReason}`,
      });
    }

    // Idempotency: refuse if THIS asset's perp already has a position.
    // Previously blocked ANY supported perp — meaning an open ETH trade
    // blocked SUI trades even though they're independent bets. Per-asset
    // check unblocks concurrent multi-market opportunities.
    const positionsPre = await bf.getPositions().catch(() => [] as BluefinPosition[]);
    const conflict = !!findActivePosition(positionsPre, symbol);
    if (conflict) {
      logger.warn(`[PolymarketEdge] ${symbol} position already exists — skipping new entry`);
      const preExistingReason = `pre-existing ${symbol} position (other assets can still trade)`;
      await recordSkip('no-edge', preExistingReason);
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'no-edge',
        stats: safeStats,
        daily,
        reason: preExistingReason,
      });
    }

    // Bucket the master tick into a 5-min epoch so retries within the same
    // tick share one clientOrderId.
    const tickEpoch = Math.floor(now / (5 * 60 * 1000));
    const clientOrderId = `polyedge_${asset}_${tickEpoch}`;

    // ── AGENT GATE — AG2 + AG4 ──────────────────────────────────────────
    // Same SafeExecutionGuard + HedgingAgent gate as sui-community-pool.
    // The polymarket-edge-trader previously had its OWN inline risk gate
    // ("mirrors RiskAgent's invariants without needing the actual agent");
    // this unifies it under the same authoritative path so both crons share
    // limits, cooldowns, and circuit breakers.
    const guard = await checkBeforeTrade({
      chain: 'sui',
      asset,
      intendedSide: side as 'LONG' | 'SHORT',
      notionalUsd,
      agentSource: 'polymarket-edge-trader',
    });

    if (!guard.approved) {
      logger.warn('[PolymarketEdge] Agent guard BLOCKED', {
        asset, side, notionalUsd, stage: guard.stage, reason: guard.reason,
      });
      const guardSkipReason = `agent-guard blocked ${asset} ${side} ($${notionalUsd.toFixed(2)}) at stage=${guard.stage}: ${guard.reason}`;
      await recordSkip('no-edge', guardSkipReason);
      // Discord intentionally silent here — agent-guard rejections are
      // routine safety behavior (PriceMonitor alerts fire routinely),
      // and repeat WARN messages for the same block are pure noise.
      // Operators can inspect via polymarket-edge:last-skip cron_state.
      // Discord stays for real capital events only: open, close, KILL.
      return NextResponse.json({
        success: false,
        ranAt,
        attempted: false,
        blockedBy: 'agent-guard',
        stage: guard.stage,
        reason: guard.reason,
        stats: safeStats,
        daily,
      });
    }

    // Funding-rate edge (2026-07-15): fetch funding at trade-open time
    // and skip if we'd be paying meaningful funding (headwind). BlueFin's
    // built-in guard rejects only at threshold (0.0001/8h ≈ 11% APR);
    // this catches the sub-threshold-but-still-negative range where the
    // AI signal would need to be very strong to overcome the bleed.
    if ((process.env.TRADER_FUNDING_EDGE_DISABLE ?? '') !== '1') {
      try {
        const md = await bf.getMarketData(symbol).catch(() => null);
        const fundingRate = md?.fundingRate ?? 0;
        const edge = fundingEdge(side as 'LONG' | 'SHORT', fundingRate);
        if (edge.advantage === 'PAY' && Math.abs(edge.bonusPct) >= 5) {
          logger.warn('[EdgeTrader] funding-edge headwind — skipping', edge);
          await recordSkip('funding-headwind', edge.reason);
          return NextResponse.json({
            success: true, ranAt, attempted: true, action: 'funding-headwind',
            reason: edge.reason,
          });
        }
        if (edge.advantage === 'RECEIVE') {
          logger.info('[EdgeTrader] funding-edge tailwind — proceeding with bonus', edge);
        }
      } catch (fundErr) {
        logger.warn('[EdgeTrader] funding-edge check failed (non-critical)', {
          error: fundErr instanceof Error ? fundErr.message : String(fundErr),
        });
      }
    }

    // Exposure cap (2026-07-15): reject when TRADER-OWNED notional would
    // exceed TRADE_MAX_TOTAL_NOTIONAL_PCT of shared BlueFin capital.
    // Counts only the trader's own position (tracked via KEY_ACTIVE) —
    // pool dual-leg positions live on the same account but have their own
    // sizing logic and don't consume trader headroom. Prevents the
    // 2026-07-15 concentration bleed (single ETH SHORT 48% of NAV) without
    // letting pool positions permanently freeze the trader (2026-07-15 →
    // 2026-07-31 idle streak: pool held $18 dual-leg, old cap counted it
    // against the trader, 60% still wasn't enough at 101% of $20 NAV).
    if ((process.env.TRADER_EXPOSURE_CAP_DISABLE ?? '') !== '1') {
      try {
        // At this point in the pipeline `active` has been narrowed to null
        // (open-new path only reached when no in-flight trade). Re-read from
        // cron_state as belt-and-suspenders — if a future refactor changes
        // the narrowing invariant we still count trader's own contribution
        // correctly, not zero.
        const activeNow = await getCronStateOr<ActiveTrade | null>(KEY_ACTIVE, null);
        const traderOwnNotional = activeNow
          ? Math.abs(Number(activeNow.size) * Number(activeNow.entryPrice))
          : 0;
        const traderNav = free + positionsPre.reduce((s, p) => s + Number(p.margin ?? 0), 0);
        const capDecision = exposureCap({
          navUsd: traderNav,
          currentTotalNotionalUsd: traderOwnNotional,
          proposedTradeNotionalUsd: notionalUsd,
        });
        if (!capDecision.ok) {
          logger.warn('[EdgeTrader] exposure cap rejected trade', capDecision);
          await recordSkip('exposure-cap', capDecision.reason);
          return NextResponse.json({
            success: true, ranAt, attempted: true, action: 'exposure-cap',
            reason: capDecision.reason,
          });
        }
      } catch (capErr) {
        logger.warn('[EdgeTrader] exposure cap check failed (non-critical)', {
          error: capErr instanceof Error ? capErr.message : String(capErr),
        });
      }
    }

    // JWT expiration is handled at the BluefinService apiRequest layer
    // (auto-detects 401, forces re-auth, retries within the same call).
    // Trader just fires and trusts the SDK.
    const open = await bf.openHedge({
      symbol,
      side,
      size: sizeQty,
      leverage: LEVERAGE,
      clientOrderId,
      reason: `polyedge ${prediction.recommendation} conf=${prediction.confidence.toFixed(0)} cons=${prediction.consensus.toFixed(0)} sources=${prediction.sources.length} | agent: ${guard.reason}`,
    });

    // Settle the SafeGuard execution counter regardless of outcome
    try {
      await completeTrade(guard, {
        chain: 'sui', asset,
        intendedSide: side as 'LONG' | 'SHORT',
        notionalUsd,
        orderId: open.orderId ?? null,
        success: !!open.success,
        error: open.error,
      });
    } catch {
      // best-effort; never break trade execution
    }

    if (!open.success) {
      logger.error('[PolymarketEdge] openHedge failed', { error: open.error });
      const openErrMsg = String(open.error || 'openHedge returned !success').slice(0, 200);
      await recordSkip(
        'no-edge',
        `openHedge failed for ${asset} ${side} size=${sizeQty} @ $${refPrice}: ${openErrMsg}`,
      );
      return NextResponse.json({
        success: false,
        ranAt,
        attempted: true,
        stats: safeStats,
        daily,
        error: open.error || 'openHedge returned !success',
      });
    }

    const fillPrice = Number(open.executionPrice ?? refPrice) || refPrice;

    // SLIPPAGE GATE — if we filled outside the budget, close immediately
    // and book the round-trip cost (entry slip + exit slip + fees) as a
    // loss. This converts a runaway market-impact event into a bounded
    // small loss instead of holding a structurally bad position.
    const slipBps = Math.abs((fillPrice - refPrice) / refPrice) * 10_000;
    if (slipBps > MAX_SLIPPAGE_BPS) {
      logger.warn('[PolymarketEdge] Slippage exceeded — emergency close', {
        slipBps: slipBps.toFixed(1),
        limit: MAX_SLIPPAGE_BPS,
        fill: fillPrice,
        ref: refPrice,
      });
      const close = await closeWithRetry(bf, symbol);
      const exitPrice = pickExitPrice(close, refPrice, fillPrice);
      const fees = (Number(open.fees) || 0) + (Number((close as { fees?: number }).fees) || 0);
      const dir = side === 'LONG' ? 1 : -1;
      const realized = (exitPrice - fillPrice) * sizeQty * dir - fees;
      const newStats = await applyOutcome(safeStats, realized, asset);
      const newDaily = await applyDaily(daily, realized);
      const halted = await maybeHalt(newStats, newDaily, haltedUntil);
      await setCronState(KEY_ACTIVE, null);
      await notifyDiscord(
        `Slippage emergency close: ${slipBps.toFixed(1)}bps > ${MAX_SLIPPAGE_BPS}bps. Realized $${realized.toFixed(2)}`,
        'WARN',
        { asset, side, fill: fillPrice, ref: refPrice, exit: exitPrice },
      );
      return NextResponse.json({
        success: true,
        ranAt,
        attempted: true,
        action: 'slippage-exit',
        closed: {
          symbol,
          asset,
          realizedPnlUsd: realized,
          win: realized > 0,
          durationS: 0,
        },
        stats: newStats,
        daily: newDaily,
        haltedUntil: halted ? haltedUntil + HALT_DURATION_MS : undefined,
        reason: `slip ${slipBps.toFixed(1)}bps > ${MAX_SLIPPAGE_BPS}bps`,
      });
    }

    const trade: ActiveTrade = {
      symbol,
      asset,
      side,
      size: sizeQty,
      entryPrice: fillPrice,
      stakeUsd,
      recommendation: prediction.recommendation,
      consensus: prediction.consensus,
      confidence: prediction.confidence,
      sourceCount: prediction.sources.length,
      entryScore: scan.best.score,
      openedAt: now,
      // Max-hold extended 5→20 (HEDGE_) and 10→30 (STRONG_) minutes.
      // Historical: every closed trade hit exactly max-hold expiry with
      // near-zero PnL — trades weren't earning trailing-stop exits,
      // they were dying at expiry before signals could develop past
      // the fee floor. Signal-flip exit still fires FIRST when the
      // signal actually inverts. See handlers/config.ts for rationale.
      closeBy: now + (prediction.recommendation.startsWith('STRONG_') ? MAX_HOLD_MIN_STRONG : MAX_HOLD_MIN_MODERATE) * 60 * 1000,
      clientOrderId,
      highWaterBps: 0,
    };
    await setCronState(KEY_ACTIVE, trade);
    // Write the DB row NOW with actual fill price. Without this, the trader
    // opens on BlueFin and leaves DB blank; bluefin-db-reconcile later
    // creates a `reconstructed_` row 15 min later with markPrice as
    // ESTIMATED entry — corrupting entry_price for every trade closed via
    // this cron (observed 2026-07-31 → 08-03: 20/20 trades adopted as
    // orphans, all with $0 recorded PnL). Best-effort: never blocks the
    // trade — a DB hiccup here still leaves the reconciler as backstop.
    try {
      const { createHedge } = await import('@/lib/db/hedges');
      const { SUI_COMMUNITY_POOL_PORTFOLIO_ID } = await import('@/lib/constants');
      await createHedge({
        orderId: clientOrderId,
        portfolioId: SUI_COMMUNITY_POOL_PORTFOLIO_ID,
        walletAddress: (process.env.SUI_ADMIN_ADDRESS || '').trim(),
        asset,
        market: symbol,
        side,
        size: sizeQty,
        notionalValue: sizeQty * fillPrice,
        leverage: LEVERAGE,
        entryPrice: fillPrice,
        simulationMode: false,
        chain: 'sui',
        reason: `PolymarketEdge ${prediction.recommendation} conf=${prediction.confidence.toFixed(0)} cons=${prediction.consensus.toFixed(0)} score=${scan.best.score.toFixed(2)}`,
        predictionMarket: prediction.sources.map((s) => s.name).join(','),
      });
    } catch (dbErr) {
      logger.warn('[PolymarketEdge] createHedge failed after openHedge succeeded — reconciler will adopt as orphan', {
        error: errMsg(dbErr),
        symbol, side, fillPrice, sizeQty,
      });
    }
    // Trade actually opened — reset the no-edge streak so gates snap
    // back to the operator's configured MIN_CONFIDENCE / MIN_CONSENSUS.
    // Only reset here (not on scan.best truthy) so a signal that
    // exists but can't be traded doesn't collapse the accumulator.
    // The pre-increment at tick top has already bumped by 1 above; the
    // reset overwrites that with 0 so a successful trade wipes the
    // relaxation state cleanly.
    await setCronState(KEY_NOEDGE_STREAK, 0).catch(() => {});

    logger.info('[PolymarketEdge] Opened trade', {
      asset,
      side,
      size: sizeQty,
      stakeUsd: stakeUsd.toFixed(2),
      compoundMul: compoundMul.toFixed(2),
      sizeMul: prediction.sizeMultiplier.toFixed(2),
      recommendation: prediction.recommendation,
      consensus: prediction.consensus.toFixed(0),
      sources: prediction.sources.length,
    });
    await notifyDiscord(
      `Opened ${asset}-PERP ${side} size=${sizeQty} stake=$${stakeUsd.toFixed(2)} (${prediction.recommendation}, conf ${prediction.confidence.toFixed(0)}, cons ${prediction.consensus.toFixed(0)})`,
      'TRADE',
      { fill: fillPrice, slipBps: slipBps.toFixed(1), sources: sourceNames.length },
    );

    return NextResponse.json({
      success: true,
      ranAt,
      attempted: true,
      action: 'opened',
      trade: {
        symbol,
        asset,
        side,
        size: sizeQty,
        stakeUsd,
        consensus: prediction.consensus,
        confidence: prediction.confidence,
        sourceCount: prediction.sources.length,
        recommendation: prediction.recommendation,
      },
      prediction: {
        direction: prediction.direction,
        recommendation: prediction.recommendation,
        confidence: prediction.confidence,
        consensus: prediction.consensus,
        probability: prediction.probability,
        sourceNames,
      },
      scan: allSummary,
      stats: safeStats,
      daily,
    });
  } catch (e) {
    const errText = errMsg(e);
    logger.error('[PolymarketEdge] tick failed', { error: errText });
    // Record the exception as a skip so operators can see WHY the tick
    // failed instead of watching noedge-streak climb forever with a
    // stale last-skip. Fire-and-forget: if setCronState itself fails
    // we don't want to swallow the original error.
    try {
      await recordSkip('no-edge', `tick threw: ${errText.slice(0, 220)}`);
    } catch {
      /* best-effort observability */
    }
    return NextResponse.json(
      { success: false, ranAt, attempted: true, stats: safeStats, daily, error: errText },
      { status: 500 },
    );
  }
}

// QStash sends POST by default — support both methods. Without this the cron
// silently 405s on every tick (root cause of zero cron-initiated trades from
// 2026-05-07 through 2026-06-14; manual GET probes still worked).
export const POST = GET;
