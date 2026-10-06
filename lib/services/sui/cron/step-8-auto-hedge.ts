/**
 * Step 8: Auto-Hedge via BlueFin perpetuals — BTC, ETH, SUI.
 *
 * Extracted verbatim from app/api/cron/sui-community-pool/route.ts (was
 * lines 2417-2995 in the pre-extraction shape). The route now dispatches
 * to runStep8AutoHedge() with a Step8Input; all inputs are read once at
 * the boundary. No behavior change vs prior inline block.
 *
 * Signal-driven hedging:
 *  • Direction comes from AI sentiment (BULLISH→LONG, BEARISH/NEUTRAL→SHORT-protective)
 *  • Triggers on every cycle where NAV ≥ HEDGE_MIN_NAV_USD ($20 default), not gated by risk
 *  • Auto-bumps leverage to 5x at sub-$1000 NAV so we clear BlueFin minQty
 *  • Skips assets that already have an active position (no duplicate spam)
 *  • Per-asset allocation ≥ 5% required to qualify (avoids dust)
 *
 * Override behavior via env:
 *  • HEDGE_MIN_NAV_USD          — gate floor (default 20)
 *  • HEDGE_RISK_THRESHOLD_DEFAULT — keep risk-gating (default 0 = disabled)
 *  • SUI_AUTO_HEDGE_DISABLE=1   — fully disable
 *  • HEDGE_DRAWDOWN_HALT_PCT    — drawdown-based auto-halt threshold (default 10)
 *  • PERP_ROUTER_SHADOW=true    — enable shadow-router diagnostic path
 */
import { logger } from '@/lib/utils/logger';
import { envFlag } from '@/lib/utils/env-flag';
import { isChainAutoHedgeDisabled } from '@/lib/utils/chain-halt';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { query } from '@/lib/db/postgres';
import { getCronStateOr, getCronHalt, setCronHalt, deleteCronState, endOfUtcDayMs, CronKeys } from '@/lib/db/cron-state';
import { evaluateHaltRecovery } from '@/lib/services/sui/cron/halt-recovery';
import { getAutoHedgeConfigs } from '@/lib/storage/auto-hedge-storage';
import { BluefinService } from '@/lib/services/sui/BluefinService';
import { bluefinTreasury } from '@/lib/services/sui/BluefinTreasuryService';
import { SUI_COMMUNITY_POOL_PORTFOLIO_ID, isSuiCommunityPool } from '@/lib/constants';
import { createHedge, updateHedgeStatus } from '@/lib/db/hedges';
import { resolveLeverage, hedgeRatioForNav, computeTargetMargin, hedgeValueUsd, hedgeSizeBase, scaledReserves } from '@/lib/services/sui/cron/hedge-sizing';
import { wouldBecomeDust } from '@/lib/services/sui/dust-manager';
import { routeHedge } from '@/lib/services/perps/PerpVenueRouter';
import { HyperliquidService } from '@/lib/services/perps/HyperliquidService';
import { checkBeforeTrade, completeTrade } from '@/lib/services/agents/agent-trade-guard';
import { emitPrivateHedgeCommitment } from '@/lib/services/sui/cron/private-hedge-emit';
import type { AllocationDecision } from '@/agents/specialized/SuiPoolAgent';
import type { SuiUsdcPoolStats } from '@/lib/types/sui-pool-types';
import { deriveEffectivePeakNav } from '@/lib/services/sui/cron/profit-lock-guard';

export interface AutoHedgeRow {
  symbol: string;
  side: string;
  size: number;
  status: string;
  orderId?: string;
  error?: string;
}

export interface Step8Result {
  triggered: boolean;
  hedges?: AutoHedgeRow[];
}

export interface Step8Input {
  navUsd: number;
  pricesUSD: Record<string, number>;
  aiResult: AllocationDecision;
  enhancedContext: { marketSentiment?: string };
  aboveSafetyCeiling: boolean;
  navSafetyCeilingUsdc: number;
  network: 'mainnet' | 'testnet';
  /** Pool stats — used to derive deposit-aware peak NAV for the drawdown halt check. */
  poolStats: SuiUsdcPoolStats;
}

export async function runStep8AutoHedge(input: Step8Input): Promise<Step8Result> {
  const {
    navUsd,
    pricesUSD,
    aiResult,
    enhancedContext,
    aboveSafetyCeiling,
    navSafetyCeilingUsdc: NAV_SAFETY_CEILING_USDC,
    network,
    poolStats,
  } = input;

  let autoHedgeResult: Step8Result = { triggered: false };
  const MIN_HEDGE_NAV_USD = Number(process.env.HEDGE_MIN_NAV_USD) || 20;
  const HEDGE_DISABLED = isChainAutoHedgeDisabled('sui');

  // ── Drawdown auto-halt ─────────────────────────────────────────
  // The cron auto-opens positions every 30min but has no global
  // equity stop — many small losses can bleed the pool without any
  // individual position hitting liquidation-guard. Use the
  // `poolNav:peak:community-pool` value that pool-nav-monitor
  // already tracks as a global peak, compare against current NAV,
  // and halt auto-hedge for the rest of the UTC day if drawdown
  // exceeds the configured ceiling (default 10%).
  //
  // Halt is honored via cronHaltUntil — same primitive bluefin-
  // health uses. Clears at UTC midnight when the next day's pool-
  // nav-monitor tick can re-establish peak.
  const HEDGE_DRAWDOWN_HALT_PCT = Number(process.env.HEDGE_DRAWDOWN_HALT_PCT) || 10;
  let drawdownHalted = false;
  try {
    const existingHalt = await getCronHalt('sui-community-pool:autohedge');
    if (existingHalt) {
      // Autonomous recovery: re-verify the halt condition on every tick.
      // Historically the halt would honor its `untilMs` deadline blindly
      // (paused until UTC midnight regardless of underlying drawdown
      // recovering). With rolling-window peak (PR #55) the drawdown can
      // drop under threshold well before natural expiry — smart behavior
      // is to clear the halt as soon as the reason no longer holds.
      // Never touches non-drawdown halts (manual, phantom-rate, etc.)
      // — see halt-recovery.ts for the decision rules.
      const peakNav = await getCronStateOr<number>(CronKeys.poolNavPeak('community-pool'), navUsd);
      const recovery = evaluateHaltRecovery({
        haltReason: existingHalt.reason,
        currentNavUsd: navUsd,
        peakNavUsd: peakNav,
        thresholdPct: HEDGE_DRAWDOWN_HALT_PCT,
      });
      if (recovery.shouldClear) {
        await deleteCronState('cron:haltUntil:sui-community-pool:autohedge');
        logger.info('[SUI Cron] Auto-cleared drawdown halt — recovery detected', {
          navUsd, peakNav, ddPct: recovery.drawdownPct.toFixed(2),
          threshold: HEDGE_DRAWDOWN_HALT_PCT,
        });
        await notifyDiscord(
          `✅ Auto-hedge halt AUTO-CLEARED — pool NAV $${navUsd.toFixed(2)} recovered to ${recovery.drawdownPct.toFixed(1)}% below peak $${peakNav.toFixed(2)} (< ${HEDGE_DRAWDOWN_HALT_PCT}% threshold). Autohedge resumes.`,
          'INFO',
          { navUsd, peakNav, drawdownPct: recovery.drawdownPct.toFixed(2) },
        );
        // Fall through — halt cleared, let this tick proceed with autohedge
      } else {
        drawdownHalted = true;
        logger.warn('[SUI Cron] Auto-hedge halt active', {
          until: new Date(existingHalt.untilMs).toISOString(),
          reason: existingHalt.reason,
          recoveryDecision: recovery.reason,
        });
      }
    } else if (navUsd <= 0) {
      // ponytail: navUsd=0 is an oracle/RPC read failure, not a real 100%
      // drawdown (2026-07-30 incident: SUI public RPC died → navUsd came in
      // as 0 → halt tripped for the whole UTC day). Skip the check and log
      // loudly so bad reads don't disappear silently.
      logger.warn('[SUI Cron] Drawdown halt SKIPPED — navUsd non-positive (oracle/RPC read failure suspected)', { navUsd });
    } else {
      // Derived peak scales with deposits (see deriveEffectivePeakNav docstring)
      // so a fresh deposit unhalts the drawdown gate without a manual reset.
      const cronStatePeak = await getCronStateOr<number>(CronKeys.poolNavPeak('community-pool'), navUsd);
      const peakNav = deriveEffectivePeakNav(
        poolStats.allTimeHighNav || 0,
        poolStats.totalShares,
        cronStatePeak,
      );
      if (peakNav > 0 && navUsd < peakNav) {
        const ddPct = ((peakNav - navUsd) / peakNav) * 100;
        if (ddPct >= HEDGE_DRAWDOWN_HALT_PCT) {
          await setCronHalt(
            'sui-community-pool:autohedge',
            endOfUtcDayMs(),
            `Pool NAV $${navUsd.toFixed(2)} is ${ddPct.toFixed(1)}% below peak $${peakNav.toFixed(2)} (>= ${HEDGE_DRAWDOWN_HALT_PCT}% halt threshold). Auto-hedge paused until UTC midnight.`,
          );
          await notifyDiscord(
            `Auto-hedge HALTED — pool NAV $${navUsd.toFixed(2)} is ${ddPct.toFixed(1)}% below peak $${peakNav.toFixed(2)} (threshold ${HEDGE_DRAWDOWN_HALT_PCT}%). Paused until UTC midnight.`,
            'KILL',
            { navUsd, peakNav, drawdownPct: ddPct.toFixed(2), threshold: HEDGE_DRAWDOWN_HALT_PCT },
          );
          drawdownHalted = true;
        }
      }
    }
  } catch (haltErr) {
    logger.warn('[SUI Cron] Drawdown halt check threw — failing open', { error: haltErr });
  }

  if (HEDGE_DISABLED) {
    logger.info('[SUI Cron] Auto-hedge disabled by SUI_AUTO_HEDGE_DISABLE=1');
  } else if (drawdownHalted) {
    logger.warn('[SUI Cron] Auto-hedge skipped — drawdown halt active');
  } else if (aboveSafetyCeiling) {
    logger.warn('[SUI Cron] Auto-hedge skipped — NAV above safety ceiling', {
      navUsd: navUsd.toFixed(2),
      ceiling: NAV_SAFETY_CEILING_USDC,
    });
  } else if (navUsd < MIN_HEDGE_NAV_USD) {
    logger.info(`[SUI Cron] Pool NAV $${navUsd.toFixed(2)} below HEDGE_MIN_NAV_USD=$${MIN_HEDGE_NAV_USD} — skipping Step 8`);
  } else {
    try {
      const allConfigs = await getAutoHedgeConfigs();
      const suiPoolConfig = allConfigs.find(c =>
        isSuiCommunityPool(c.portfolioId) ||
        c.portfolioId === SUI_COMMUNITY_POOL_PORTFOLIO_ID ||
        (c as { poolAddress?: string }).poolAddress === process.env.NEXT_PUBLIC_SUI_POOL_STATE_ID,
      );

      // Default-enabled when DB row missing (signal-driven hedging)
      const enabled = suiPoolConfig ? suiPoolConfig.enabled : true;
      const riskScore = aiResult.riskScore ?? 0;
      // Default threshold = 0 → AI sentiment drives hedging, not risk-cascade
      const threshold = suiPoolConfig?.riskThreshold ?? Number(process.env.HEDGE_RISK_THRESHOLD_DEFAULT || 0);
      const passesRiskGate = riskScore >= threshold;

      if (!enabled) {
        logger.debug('[SUI Cron] Auto-hedging disabled in suiPoolConfig');
      } else if (!passesRiskGate) {
        logger.info('[SUI Cron] Auto-hedge skipped — risk gate not met', { riskScore, threshold });
      } else if (!process.env.BLUEFIN_PRIVATE_KEY) {
        logger.warn('[SUI Cron] Auto-hedge skipped — BLUEFIN_PRIVATE_KEY missing');
      } else {
        // ── Direction: AI sentiment ────────────────────────────────
        const sentiment = (enhancedContext.marketSentiment || 'NEUTRAL').toUpperCase();
        const side: 'LONG' | 'SHORT' = sentiment === 'BULLISH' ? 'LONG' : 'SHORT';

        // ── Leverage: bump to 10x for tiny NAV so BTC clears minQty=0.001 ─
        // BTC at $78k requires effective notional ≥ $78.66 to snap to minQty.
        // At NAV=$50, alloc=30%, that means we need leverage ≥ 6x.
        // We default to 10x at NAV<$1000 (BlueFin max for BTC perp), with
        // suiPoolConfig.maxLeverage as a soft cap that operators can lower.
        // Above $1k we drop to 5x; above $1M we cap at 3x to limit
        // single-wallet liquidation risk; above $100M cap at 2x because
        // a single 50% adverse move would wipe a pool of that size.
        const leverage = resolveLeverage(navUsd, suiPoolConfig?.maxLeverage);
        const hedgeRatio = hedgeRatioForNav(navUsd);

        logger.info('[SUI Cron] Auto-hedge plan', {
          navUsd: navUsd.toFixed(2), sentiment, side, leverage, hedgeRatio,
          riskScore, threshold,
          allocations: aiResult.allocations,
        });

        const hedges: AutoHedgeRow[] = [];
        try {
          const bluefin = BluefinService.getInstance();

          // ── Margin top-up: pool USDC → admin spot → BlueFin margin bank ─
          // Money flow each cycle:
          //   1. Step 6.5 already moved USDC pool → admin (treasury rail
          //      via open_hedge) and Step 7 swapped portions to spot
          //      BTC/ETH/SUI per AI allocation.
          //   2. Now deposit remaining admin USDC into BlueFin margin bank
          //      so the perp hedges have collateral. Falls back to swapping
          //      a small amount of admin SUI → USDC if spot USDC is short.
          //   3. After hedges close (separate flow), BlueFin USDC withdraws
          //      back to admin, which feeds the next reverse-swap cycle.
          // Margin requirement: notional / leverage (10x => 10% of NAV).
          const totalAllocPct = (['BTC','ETH','SUI'] as const)
            .reduce((s, a) => s + Math.max(0, aiResult.allocations[a] || 0), 0);
          const targetMargin = computeTargetMargin(navUsd, totalAllocPct, hedgeRatio, leverage);
          const minMargin = targetMargin * 0.9;
          try {
            // Reserves and swap caps scale with NAV so the same code
            // works for $50 testnet pools and $100M production pools.
            //   • spotReserve: 0.05% of NAV (min $0.50, max $5k buffer)
            //   • suiReserve:  0.001% of NAV in SUI equiv (min 0.5 SUI)
            //   • maxSwapSui:  0.1% of NAV per tick, expressed in SUI
            const { spotReserve: scaledSpotReserve, suiReserve: scaledSuiReserve, maxSwapSui: scaledMaxSwapSui } = scaledReserves(navUsd, pricesUSD['SUI']);
            // Honor the AI's SUI allocation: autoTopUp must NOT sweep the
            // target SUI spot position back to USDC. Without this guard,
            // Step 7 buys SUI for the spot leg → autoTopUp immediately
            // swaps it to USDC → SUI never accumulates on the wallet.
            // Reserve covers gas + the target SUI allocation; only EXCESS
            // SUI above (reserve + target) is sweepable.
            const suiPrice = pricesUSD['SUI'] || 0;
            const targetSuiUsd = (navUsd * Number(aiResult.allocations.SUI || 0)) / 100;
            const targetSuiUnits = suiPrice > 0 ? targetSuiUsd / suiPrice : 0;
            const suiReserveWithTarget = scaledSuiReserve + targetSuiUnits;
            const topUp = await bluefinTreasury.autoTopUp({
              minMargin, targetMargin,
              spotReserve: scaledSpotReserve,
              swapFromSui: true,
              suiReserve: suiReserveWithTarget,
              maxSwapSui: scaledMaxSwapSui,
            });
            logger.info('[SUI Cron] Margin top-up', {
              minMargin: minMargin.toFixed(4),
              targetMargin: targetMargin.toFixed(4),
              result: topUp,
            });
          } catch (tuErr) {
            logger.warn('[SUI Cron] Margin top-up failed (proceeding to hedge loop)', {
              error: tuErr instanceof Error ? tuErr.message : String(tuErr),
            });
          }

          // ── Dedup gate: skip assets with an active live position ─
          // Strict: with an unreadable venue there is no dedup information.
          // Treating that as "no positions" closed every active row below as
          // an orphan and let a duplicate hedge open. Skip the step instead.
          const existing = await bluefin.getPositionsStrict();
          const liveSet = new Set(
            existing.map(p => `${p.symbol}|${(p.side || '').toUpperCase()}`),
          );

          // ── Self-healing reconciler ────────────────────────────
          // Two failure modes the open-loop hedger can leave behind:
          //   (a) Orphan rows: DB row exists but BlueFin has no matching
          //       position (margin call, manual close, failed open we
          //       optimistically recorded, etc.). Close them so dashboard
          //       and dedup gate stay accurate.
          //   (b) Duplicate rows: multiple active rows for one live
          //       (market, side). Keep the newest, close the rest.
          // Scope is intentionally narrow: only sui rows that are NOT
          // mirrored from on-chain pool hedges (hedge_id_onchain IS NULL).
          try {
            const dbActive = await query<{
              id: number; order_id: string; market: string; side: string; created_at: Date;
            }>(
              `SELECT id, order_id, market, side, created_at
               FROM hedges
               WHERE chain = 'sui'
                 AND status = 'active'
                 AND (hedge_id_onchain IS NULL OR hedge_id_onchain = '')`,
            );
            const groups = new Map<string, typeof dbActive>();
            for (const row of dbActive) {
              const key = `${row.market}|${(row.side || '').toUpperCase()}`;
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(row);
            }
            let closedOrphans = 0;
            let closedDups = 0;
            for (const [key, rows] of groups.entries()) {
              if (!liveSet.has(key)) {
                // (a) orphan: no live counterpart
                for (const r of rows) {
                  await updateHedgeStatus(r.order_id, 'closed').catch(() => {});
                  closedOrphans++;
                }
              } else if (rows.length > 1) {
                // (b) duplicate: keep newest, close rest
                const sorted = [...rows].sort(
                  (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
                );
                for (let i = 1; i < sorted.length; i++) {
                  await updateHedgeStatus(sorted[i].order_id, 'closed').catch(() => {});
                  closedDups++;
                }
              }
            }
            if (closedOrphans + closedDups > 0) {
              logger.info('[SUI Cron] Self-healing reconciler', {
                closedOrphans, closedDups, totalActive: dbActive.length,
              });
            }
          } catch (rcErr) {
            logger.warn('[SUI Cron] Self-healing reconciler failed', {
              error: rcErr instanceof Error ? rcErr.message : String(rcErr),
            });
          }

          const PERP_SPECS: Record<string, { minQty: number; stepSize: number }> = {
            BTC: { minQty: 0.001, stepSize: 0.001 },
            ETH: { minQty: 0.01, stepSize: 0.01 },
            SUI: { minQty: 1, stepSize: 1 },
          };

          for (const asset of ['BTC', 'ETH', 'SUI'] as const) {
            const symbol = `${asset}-PERP`;
            const key = `${symbol}|${side}`;
            if (liveSet.has(key)) {
              logger.info(`[SUI Cron] Skip ${asset}-PERP ${side}: position already active`);
              hedges.push({ symbol, side, size: 0, status: 'SKIPPED_DUP' });
              continue;
            }

            // Direction-flip: if an opposite-side position exists, close
            // it before opening the new direction. Without this the cron
            // accumulates both legs (one LONG + one SHORT on the same
            // symbol) and burns margin for net-zero exposure until
            // liquidation-guard fires. The existing dedup gate above
            // only catches same-side dupes, not flips.
            const oppositeSide: 'LONG' | 'SHORT' = side === 'LONG' ? 'SHORT' : 'LONG';
            const oppositeKey = `${symbol}|${oppositeSide}`;
            if (liveSet.has(oppositeKey)) {
              logger.info(`[SUI Cron] Direction flip — closing existing ${oppositeKey} before opening ${key}`);
              try {
                const closeRes = await bluefin.closeHedge({ symbol });
                if (!closeRes.success) {
                  logger.warn(`[SUI Cron] Direction-flip close FAILED for ${symbol} — skipping open to avoid double-leg accumulation`, {
                    error: closeRes.error,
                    preCloseSize: (closeRes as { preCloseSize?: number }).preCloseSize,
                    postCloseSize: (closeRes as { postCloseSize?: number }).postCloseSize,
                  });
                  await notifyDiscord(
                    `Direction-flip close FAILED for ${symbol} (was ${oppositeSide}, wanted ${side}). Skipping open to avoid double-leg margin burn. Investigate: ${closeRes.error}`,
                    'WARN',
                    { symbol, fromSide: oppositeSide, toSide: side, error: closeRes.error },
                  );
                  hedges.push({ symbol, side, size: 0, status: 'SKIPPED_FLIP_CLOSE_FAILED', error: closeRes.error });
                  continue;
                }
                await notifyDiscord(
                  `Direction-flip on ${symbol}: closed ${oppositeSide}, opening ${side}.`,
                  'INFO',
                  { symbol, fromSide: oppositeSide, toSide: side, closeOrderId: closeRes.orderId },
                );
                // Brief settle window so the next openHedge's pre-trade
                // margin check sees the freed collateral.
                await new Promise(r => setTimeout(r, 1500));
              } catch (flipErr) {
                const msg = flipErr instanceof Error ? flipErr.message : String(flipErr);
                logger.warn(`[SUI Cron] Direction-flip close threw for ${symbol} — skipping open`, { error: msg });
                hedges.push({ symbol, side, size: 0, status: 'SKIPPED_FLIP_CLOSE_ERROR', error: msg });
                continue;
              }
            }

            const allocation = aiResult.allocations[asset] || 0;
            if (allocation < 5) {
              hedges.push({ symbol, side, size: 0, status: 'SKIPPED_LOW_ALLOC' });
              continue;
            }

            const price = pricesUSD[asset] || 0;
            if (price <= 0) {
              hedges.push({ symbol, side, size: 0, status: 'SKIPPED_NO_PRICE' });
              continue;
            }

            const hedgeValueUSD = hedgeValueUsd(navUsd, allocation, hedgeRatio);
            // Size is the notional over price; leverage only sets the margin behind it.
            const sizeBase = hedgeSizeBase(navUsd, allocation, hedgeRatio, price);
            const spec = PERP_SPECS[asset];
            const snappedSize = Math.floor(sizeBase / spec.stepSize) * spec.stepSize;

            if (snappedSize < spec.minQty) {
              logger.info(`[SUI Cron] Skip ${asset}-PERP: size ${snappedSize} < minQty ${spec.minQty}`, {
                allocation, hedgeValueUSD, leverage, hedgeRatio,
              });
              hedges.push({ symbol, side, size: snappedSize, status: 'SKIPPED_MIN_QTY' });
              continue;
            }

            // ── DUST5: prevent creating positions that WILL become dust ───
            // Opening at exactly minQty leaves no buffer; a single partial
            // fill / funding shrink / PnL normalization can drop the size
            // below minQty and trap the margin. Require 1.5x minQty (see
            // OPEN_MIN_QTY_BUFFER in dust-manager.ts). Compare against the
            // TARGET post-snap size, not the pre-snap raw size.
            try {
              if (wouldBecomeDust(symbol, snappedSize)) {
                const minSafe = spec.minQty * 1.5;
                logger.info(`[SUI Cron] Skip ${asset}-PERP: size ${snappedSize} risks dust (< ${minSafe.toFixed(4)} = 1.5x minQty)`, {
                  snappedSize, minQty: spec.minQty, minSafeSize: minSafe, hedgeValueUSD,
                });
                hedges.push({ symbol, side, size: snappedSize, status: 'SKIPPED_DUST_RISK' });
                continue;
              }
            } catch (dustGuardErr) {
              logger.debug('[SUI Cron] Dust guard threw (non-critical)', {
                error: dustGuardErr instanceof Error ? dustGuardErr.message : String(dustGuardErr),
              });
            }

            // ── T5-A Phase 3 shadow mode ─────────────────────────
            // When PERP_ROUTER_SHADOW=true, compute what the multi-
            // venue router WOULD do alongside the existing BlueFin
            // direct call. Logs the plan + Discord-alerts if the
            // router would have made a different choice (e.g. split
            // across venues, picked Hyperliquid for lower funding).
            // Zero execution change — purely diagnostic so we can
            // validate the router in production before flipping live.
            // envFlag canonical parser — one of the two sites e6a80411
            // fixed by hand; now delegated.
            if (envFlag('PERP_ROUTER_SHADOW')) {
              try {
                const hl = HyperliquidService.getInstance();
                const [bfMd, hlSnap] = await Promise.all([
                  bluefin.getMarketData(symbol).catch(() => null),
                  hl.getMarketSnapshot(symbol).catch(() => null),
                ]);
                const venues = [] as Array<{ name: string; oiUsd: number; fundingRate8h: number; canTrade: boolean }>;
                if (bfMd) venues.push({ name: 'bluefin', oiUsd: bfMd.openInterestUsd ?? 0, fundingRate8h: bfMd.fundingRate ?? 0, canTrade: true });
                if (hlSnap) venues.push({ name: 'hyperliquid', oiUsd: hlSnap.openInterestUsd, fundingRate8h: hlSnap.fundingRate, canTrade: false });
                const plan = routeHedge({ symbol, notionalUsd: hedgeValueUSD, side, venues, maxOiPct: Number(process.env.BLUEFIN_MAX_OI_PCT) || 5 });
                logger.info('[SUI Cron][shadow-router]', { symbol, plan, venues });
                const primaryVenue = plan.legs[0]?.venue ?? 'none';
                const wouldDiverge = plan.legs.length > 1 || (primaryVenue !== 'bluefin' && plan.legs.length > 0);
                if (wouldDiverge) {
                  await notifyDiscord(
                    `[shadow-router] ${symbol} ${side} $${hedgeValueUSD.toFixed(2)}: router would split across ${plan.legs.length} legs (primary ${primaryVenue}), blended cost ${plan.blendedFundingCostBps8h.toFixed(2)}bps/8h. Live path still using direct BlueFin.`,
                    'INFO',
                    { symbol, primaryVenue, legs: plan.legs, blendedCostBps: plan.blendedFundingCostBps8h },
                  );
                }
              } catch (shadowErr) {
                logger.debug('[SUI Cron][shadow-router] failed (non-critical)', {
                  error: shadowErr instanceof Error ? shadowErr.message : String(shadowErr),
                });
              }
            }

            try {
              logger.info(`[SUI Cron] Opening ${asset}-PERP ${side}`, {
                allocation, hedgeValueUSD: hedgeValueUSD.toFixed(4),
                snappedSize, leverage, sentiment,
              });

              // ── AGENT GATE — AG1 + AG2 ──────────────────────────────
              // Consult HedgingAgent + RiskAgent (cached from runAutonomous
              // Cycle) + SafeExecutionGuard before opening. Block on:
              //   - per-asset HOLD directive
              //   - high-confidence side mismatch
              //   - risk score above ceiling
              //   - position cap / slippage / cooldown breach
              // Logs to agent_decisions for outcome tracking.
              const guard = await checkBeforeTrade({
                chain: 'sui',
                asset,
                intendedSide: side as 'LONG' | 'SHORT',
                notionalUsd: hedgeValueUSD,
                agentSource: 'sui-community-pool-cron',
              });

              if (!guard.approved) {
                logger.warn(`[SUI Cron] Agent guard BLOCKED ${asset}-PERP ${side}`, {
                  stage: guard.stage, reason: guard.reason,
                });
                await notifyDiscord(
                  `🛡️ Agent guard blocked ${asset}-PERP ${side} ($${hedgeValueUSD.toFixed(2)}): ${guard.reason}`,
                  'WARN',
                  { stage: guard.stage, asset, side, notionalUsd: hedgeValueUSD.toFixed(2), agentSide: guard.agentSide, agentConfidence: guard.agentConfidence },
                );
                hedges.push({
                  symbol, side, size: snappedSize,
                  status: 'BLOCKED_BY_AGENT',
                  error: guard.reason,
                });
                continue;
              }

              if (guard.agentSide && guard.agentSide !== side) {
                // Side mismatch under low confidence → log informationally
                logger.info(`[SUI Cron] Agent diverged on ${asset} side but confidence too low to block`, {
                  cronSide: side, agentSide: guard.agentSide, conf: guard.agentConfidence,
                });
              }

              const result = await bluefin.openHedge({
                symbol,
                side,
                size: snappedSize,
                leverage,
                portfolioId: -2,
                reason: `Auto-hedge: ${side} via ${sentiment} signal (risk=${riskScore}/${threshold}) | agent: ${guard.reason}`,
              });

              // Post-open verification: BlueFin returns `success` as soon as
              // the order is accepted, but the position only materializes
              // after the matching engine fills it. With tight margin the
              // fill can be rejected, leaving us with an orphan DB row.
              // Wait briefly and re-poll positions; only persist if the
              // (symbol, side) actually shows up.
              let filled = false;
              if (result.success && result.orderId) {
                await new Promise(r => setTimeout(r, 2_500));
                try {
                  const post = await bluefin.getPositions();
                  filled = post.some(p =>
                    p.symbol === symbol &&
                    (p.side || '').toUpperCase() === side &&
                    Number((p as { size?: number }).size ?? 0) > 0,
                  );
                } catch {
                  // If the verification call fails we can't confirm — be
                  // conservative and skip persisting; the order is on
                  // BlueFin and the next cycle's reconciler will adopt it
                  // into the DB if it actually exists.
                  filled = false;
                }
              }

              hedges.push({
                symbol, side, size: snappedSize,
                status: result.success
                  ? (filled ? 'OPENED' : 'ACCEPTED_NOT_FILLED')
                  : 'FAILED',
                orderId: result.orderId, error: result.error,
              });

              // Settle the SafeGuard execution + record outcome for agent
              // accuracy tracking. Best-effort; never breaks the cron.
              try {
                await completeTrade(guard, {
                  chain: 'sui', asset,
                  intendedSide: side as 'LONG' | 'SHORT',
                  notionalUsd: hedgeValueUSD,
                  orderId: result.orderId ?? null,
                  success: result.success && filled,
                  error: result.error,
                });
              } catch (settleErr) {
                logger.debug('[SUI Cron] completeTrade settle threw (non-fatal)', {
                  error: settleErr instanceof Error ? settleErr.message : String(settleErr),
                });
              }

              if (result.success && result.orderId && filled) {
                try {
                  await createHedge({
                    orderId: result.orderId,
                    portfolioId: SUI_COMMUNITY_POOL_PORTFOLIO_ID,
                    walletAddress: (process.env.SUI_ADMIN_ADDRESS || '').trim(),
                    asset,
                    market: symbol,
                    side,
                    size: snappedSize,
                    notionalValue: hedgeValueUSD,
                    leverage,
                    entryPrice: price,
                    simulationMode: false,
                    chain: 'sui',
                    reason: `Auto-hedge: ${side} via ${sentiment} signal`,
                  });
                } catch (dbErr) {
                  logger.warn('[SUI Cron] Failed to persist hedge', { asset, error: dbErr });
                }
                await notifyDiscord(
                  `Auto-hedge OPENED: ${side} ${snappedSize} ${asset}-PERP @ ${leverage}x (notional $${hedgeValueUSD.toFixed(2)}, signal=${sentiment}).`,
                  'TRADE',
                  { network, asset, side, size: snappedSize, leverage, notionalUsd: hedgeValueUSD.toFixed(2), orderId: result.orderId },
                );

                // Privacy attestation: emit zk_hedge_commitment::store_commitment
                // for the hedge we just opened. Hides asset/side/size/leverage/
                // entryPrice behind a 32-byte commitment hash. Skips cleanly if
                // privacy contracts aren't deployed (mainnet env vars unset).
                try {
                  const emit = await emitPrivateHedgeCommitment({
                    asset, side, size: snappedSize,
                    notionalValue: hedgeValueUSD, leverage,
                    entryPrice: price, orderId: result.orderId,
                  }, network as 'mainnet' | 'testnet');
                  if (emit.success) {
                    logger.info('[SUI Cron] Private hedge commitment emitted', {
                      orderId: result.orderId,
                      commitment: emit.commitmentHashHex?.slice(0, 16) + '...',
                      txDigest: emit.txDigest,
                    });
                    // Discord silent — the "Auto-hedge OPENED" TRADE
                    // alert above already announced the hedge. Adding
                    // a second INFO ping about the ZK commitment
                    // that ALWAYS accompanies it doubles Discord
                    // volume without adding operator-actionable info.
                    // ZK commitment digest is logged via logger for
                    // audit trail.
                  } else if (!emit.skipped) {
                    logger.warn('[SUI Cron] Private hedge commitment failed (non-critical)', {
                      orderId: result.orderId, error: emit.error,
                    });
                  }
                } catch (zkErr) {
                  // Privacy emission is best-effort — never fail the cron over it
                  logger.debug('[SUI Cron] Private hedge emit threw (non-critical)', {
                    error: zkErr instanceof Error ? zkErr.message : String(zkErr),
                  });
                }
              } else if (result.success && result.orderId && !filled) {
                // Order accepted by BlueFin but not yet filled — collateral
                // is reserved against the resting order. Visible state but
                // not yet a position. Surface this to operators since the
                // reconciler will pick it up only after fill.
                await notifyDiscord(
                  `Auto-hedge PENDING: ${side} ${snappedSize} ${asset}-PERP @ ${leverage}x accepted, awaiting fill (notional $${hedgeValueUSD.toFixed(2)}, signal=${sentiment}).`,
                  'INFO',
                  { network, asset, side, size: snappedSize, leverage, notionalUsd: hedgeValueUSD.toFixed(2), orderId: result.orderId },
                );
              } else if (!result.success) {
                await notifyDiscord(
                  `Auto-hedge FAILED: ${side} ${snappedSize} ${asset}-PERP @ ${leverage}x — ${result.error || 'unknown'}.`,
                  'WARN',
                  { network, asset, side, size: snappedSize, leverage, error: result.error },
                );
              }
              logger.info(`[SUI Cron] ${asset}-PERP ${side} ${result.success ? 'OPENED' : 'FAILED'}`, {
                size: snappedSize, leverage, orderId: result.orderId, error: result.error,
              });
            } catch (hedgeErr) {
              hedges.push({
                symbol, side, size: snappedSize, status: 'ERROR',
                error: hedgeErr instanceof Error ? hedgeErr.message : String(hedgeErr),
              });
              logger.error(`[SUI Cron] ${asset}-PERP ${side} threw`, { error: hedgeErr });
            }
          }

          autoHedgeResult = { triggered: true, hedges };
        } catch (bfErr) {
          logger.error('[SUI Cron] BlueFin hedging failed', { error: bfErr });
          autoHedgeResult = {
            triggered: true,
            hedges: [{ symbol: 'ALL', side: 'N/A', size: 0, status: 'ERROR', error: String(bfErr) }],
          };
        }
      }
    } catch (hedgeConfigErr) {
      logger.warn('[SUI Cron] Auto-hedge config check failed (non-critical)', { error: hedgeConfigErr });
    }
  }

  return autoHedgeResult;
}
