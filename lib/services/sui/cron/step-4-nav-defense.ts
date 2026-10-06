/**
 * Step 4: NAV snapshot + v0.3.0 defense stack.
 *
 * Extracted verbatim from app/api/cron/sui-community-pool/route.ts
 * (was lines 1068-1475 pre-extraction). The route now dispatches to
 * runStep4NavDefense() with a Step4Input; behavior unchanged.
 *
 * What runs here, in order:
 *   1. NAV + share-price USD conversion from on-chain poolStats.
 *   2. Scale safety ceiling — halt writes above NAV_SAFETY_CEILING_USDC.
 *   3. Hedgeability block:
 *      • BlueFin OI fetch (best-effort)
 *      • Profit-lock guard (may mutate aiResult.allocations)
 *      • Alert-response override (may mutate aiResult.allocations)
 *      • profit-lock:zero-since state tracking
 *      • PortfolioDriver corrective unwind (env-gated execution)
 *      • Hedgeability clamp (may mutate aiResult.allocations)
 *   4. External NAV oracle attest (skipped above safety ceiling).
 *   5. Persist the NAV snapshot to community_pool_nav_history.
 *
 * `aiResult.allocations` is mutated in-place — matches the inline
 * block's behavior. Callers see the updated allocations after this
 * returns without a separate reassignment.
 */
import { logger } from '@/lib/utils/logger';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { query } from '@/lib/db/postgres';
import { getCronStateOr, setCronState, CronKeys } from '@/lib/db/cron-state';
import { BluefinService } from '@/lib/services/sui/BluefinService';
import { resolveLeverage, hedgeRatioForNav } from '@/lib/services/sui/cron/hedge-sizing';
import { clampAllocationsToHedgeable } from '@/lib/services/sui/cron/hedgeable-allocation';
import { applyProfitLock, deriveEffectivePeakNav } from '@/lib/services/sui/cron/profit-lock-guard';
import { runPortfolioDriverTick } from '@/lib/services/sui/PortfolioDriver';
import { Polymarket5MinService } from '@/lib/services/market-data/Polymarket5MinService';
import { attestExternalNav } from '@/lib/services/sui/cron/nav-oracle';
import { replenishAdminUsdc } from '@/lib/services/sui/cron/admin-swaps';
import { POOL_ASSETS } from '@/lib/services/sui/cron/allocation';
import { recordPoolNavSnapshot } from '@/lib/services/sui/cron/persistence';
import { envFlagOnByDefault } from '@/lib/utils/env-flag';
import { isPoolTradingEnabled } from '@/lib/services/sui/pool-trading-pause';
import type { AllocationDecision } from '@/agents/specialized/SuiPoolAgent';
import type { SuiUsdcPoolStats } from '@/lib/types/sui-pool-types';

/** The contract stops deposits and withdrawals at 120 minutes; alert well before. */
const ATTESTATION_ALERT_AFTER_MIN = 30;

export interface Step4Input {
  poolStats: SuiUsdcPoolStats;
  pricesUSD: Record<string, number>;
  /**
   * Mutated in-place. Callers see the final adjustments (profit-lock,
   * alert-response override, hedgeability clamp) after runStep4NavDefense
   * returns without a reassignment.
   */
  aiResult: AllocationDecision;
  navSafetyCeilingUsdc: number;
  network: 'mainnet' | 'testnet';
}

export interface Step4Result {
  navUsd: number;
  sharePriceUsd: number;
  aboveSafetyCeiling: boolean;
}

export async function runStep4NavDefense(input: Step4Input): Promise<Step4Result> {
  const { poolStats, pricesUSD, aiResult, navSafetyCeilingUsdc: NAV_SAFETY_CEILING_USDC, network } = input;

  // Step 4: Record NAV snapshot
  // For SUI pool, totalNAV is in SUI. Convert to USD for consistent tracking.
  const navUsd = poolStats.totalNAVUsd || (poolStats.totalNAV * (pricesUSD['SUI'] || 0));
  const sharePriceUsd = poolStats.sharePriceUsd || (poolStats.sharePrice * (pricesUSD['SUI'] || 0));

  // ── Scale safety ceiling ─────────────────────────────────────
  // Above NAV_SAFETY_CEILING_USDC the on-chain Move contract's
  // `nav * bps * time_elapsed` math approaches u64.MAX and may wrap
  // silently, breaking fee accrual and the daily-withdrawal-cap
  // circuit breaker. Halt write-side actions (rebalance, hedge,
  // top-up) but still record snapshots so dashboards keep working.
  let aboveSafetyCeiling = false;
  // Pre-halt warning at 80% so the team gets weeks of lead time to plan
  // the u128 Move redeploy + audit rather than scrambling at the wall.
  const NAV_SAFETY_WARN_PCT = Number(process.env.NAV_SAFETY_WARN_PCT) || 80;
  const navPctOfCeiling = (navUsd / NAV_SAFETY_CEILING_USDC) * 100;
  if (navUsd > NAV_SAFETY_CEILING_USDC) {
    aboveSafetyCeiling = true;
    logger.error('[SUI Cron] NAV exceeds safety ceiling — write actions disabled', {
      navUsd: navUsd.toFixed(2),
      ceiling: NAV_SAFETY_CEILING_USDC,
      message: 'Redeploy Move contracts with u128 fee/cap math before continuing.',
    });
    await notifyDiscord(
      `NAV $${navUsd.toFixed(0)} exceeds safety ceiling $${NAV_SAFETY_CEILING_USDC.toLocaleString()} — write actions HALTED. Redeploy Move contracts with u128 math before resuming.`,
      'KILL',
      { navUsd: navUsd.toFixed(2), ceiling: NAV_SAFETY_CEILING_USDC },
    );
  } else if (navPctOfCeiling >= NAV_SAFETY_WARN_PCT) {
    // De-bounce: only re-alert if we haven't pinged about this in 6h.
    const lastWarnKey = 'sui-community-pool:nav-ceiling-warn-ms';
    const lastWarn = await getCronStateOr<number>(lastWarnKey, 0);
    if (Date.now() - lastWarn > 6 * 3600_000) {
      logger.warn('[SUI Cron] NAV approaching safety ceiling', {
        navUsd: navUsd.toFixed(2),
        ceiling: NAV_SAFETY_CEILING_USDC,
        pctOfCeiling: navPctOfCeiling.toFixed(1),
      });
      await notifyDiscord(
        `NAV $${navUsd.toFixed(0)} is ${navPctOfCeiling.toFixed(1)}% of safety ceiling $${NAV_SAFETY_CEILING_USDC.toLocaleString()} — plan the u128 Move contract redeploy + audit BEFORE the pool hits 100%. Halt is automatic at the ceiling and freezes all writes.`,
        'WARN',
        { navUsd: navUsd.toFixed(2), ceiling: NAV_SAFETY_CEILING_USDC, pctOfCeiling: navPctOfCeiling.toFixed(1) },
      );
      await setCronState(lastWarnKey, Date.now()).catch(() => {});
    }
  }

  // ── Hedgeability clamp (T1-A) ────────────────────────────────
  // BlueFin's per-symbol minQty creates a naked-long gap at small NAV:
  // if NAV × alloc% × leverage / price < minQty, the perp leg can't
  // open and the spot leg sits unhedged when AI signals BEARISH/NEUTRAL.
  // Concrete: at $50 NAV with 45% BTC alloc, BTC perp needs
  // ≥0.001 BTC = $73 notional but only sees $14 → silently skipped,
  // wBTC stays naked-long. Clamp drops unhedgeable assets and
  // redistributes their share to assets that CAN clear minQty.
  {
    const tierLev = resolveLeverage(navUsd, undefined);
    const ratio = hedgeRatioForNav(navUsd);
    // Per-symbol minQty/stepSize. Known tickers baked in for zero-RPC path;
    // anything else falls back to venue metadata (fetched below alongside OI).
    // Kept the baked defaults because BluefinService.getMarketData is best-
    // effort and can 429 — losing a hedgeability check to a rate-limit is
    // a real bleed, so we cache what we know.
    const KNOWN_PERP_SPECS: Record<string, { minQuantity: number; stepSize: number }> = {
      BTC: { minQuantity: 0.001, stepSize: 0.001 },
      ETH: { minQuantity: 0.01,  stepSize: 0.01  },
      SUI: { minQuantity: 1,     stepSize: 1     },
      SOL: { minQuantity: 0.1,   stepSize: 0.1   },
    };
    const perpSpecs: Record<string, { minQuantity: number; stepSize: number }> = {};
    for (const asset of POOL_ASSETS) {
      if (KNOWN_PERP_SPECS[asset]) perpSpecs[asset] = KNOWN_PERP_SPECS[asset];
    }
    // Fetch BlueFin OI for the 3 perps so the clamp also enforces the
    // T3-B OI cap (5% of venue OI by default). At BlueFin's real ETH OI
    // ~$40k, any hedge > ~$2k would be rejected by T3-B at open time;
    // without checking here, the cron would still swap USDC to wETH
    // and end up holding naked spot. Fetch is best-effort — if BlueFin
    // is unreachable we proceed with minQty-only check (acceptable
    // degradation; OI guard still gates the actual open).
    let openInterestUsd: Record<string, number> | undefined;
    try {
      const bfService = BluefinService.getInstance();
      // Fetch OI + fill in unknown minQty for every enabled asset in one pass.
      const marketFetches = await Promise.all(
        POOL_ASSETS.map(a => bfService.getMarketData(`${a}-PERP`).catch(() => null).then(m => ({ asset: a, market: m }))),
      );
      openInterestUsd = {};
      for (const { asset, market } of marketFetches) {
        if (!market) continue;
        if (market.openInterestUsd) openInterestUsd[asset] = market.openInterestUsd;
        // Fill perpSpecs for tickers not in KNOWN_PERP_SPECS. Guard against
        // undefined venue fields (minQty schema is best-effort per exchange).
        if (!perpSpecs[asset]) {
          const mq = Number((market as unknown as { minQuantity?: number; stepSize?: number }).minQuantity);
          const ss = Number((market as unknown as { minQuantity?: number; stepSize?: number }).stepSize);
          if (Number.isFinite(mq) && mq > 0) {
            perpSpecs[asset] = { minQuantity: mq, stepSize: Number.isFinite(ss) && ss > 0 ? ss : mq };
          }
        }
      }
    } catch {
      // best-effort — fall back to minQty-only clamp
    }
    // ── PROFIT-LOCK GUARD ─────────────────────────────────────────
    // Before hedgeability clamp, cap RISK allocation based on drawdown
    // from rolling peak NAV. Prevents the tiny-pool "slow bleed" where
    // spot LONG positions decay while hedges can't cover them at
    // sub-minQty scale. Env-tunable via PROFIT_LOCK_DRAWDOWN_START (5%)
    // and PROFIT_LOCK_ZERO_RISK_AT (20%). Disable with PROFIT_LOCK_DISABLE=1.
    try {
      // Peak derived from on-chain ATH share price × current shares — see
      // deriveEffectivePeakNav docstring for why this beats a static
      // cron-state peak (fixes the 2026-08-11 deposit-during-halt deadlock).
      const cronStatePeak = await getCronStateOr<number>(CronKeys.poolNavPeak('community-pool'), navUsd);
      const peakNavForLock = deriveEffectivePeakNav(
        poolStats.allTimeHighNav || 0,  // ATH share price in USD (see SuiUsdcPoolService.ts:369)
        poolStats.totalShares,
        cronStatePeak,
      );

      // Fetch 7-day-ago NAV so profit-lock can compute recovery momentum
      // (avoid "sit in USDC through the rally" pattern).
      let drawdownPct7dAgo: number | undefined;
      try {
        const rows = await query<{ dd_pct: string }>(
          `SELECT ROUND((($1::float - AVG(total_nav))::numeric / $1::float) * 100, 2)::text as dd_pct
           FROM community_pool_nav_history
           WHERE chain='sui' AND timestamp BETWEEN NOW() - INTERVAL '7 days 6 hours' AND NOW() - INTERVAL '6 days 18 hours'`,
          [peakNavForLock],
        );
        const parsed = Number(rows[0]?.dd_pct);
        if (Number.isFinite(parsed) && parsed >= 0) drawdownPct7dAgo = parsed;
      } catch { /* best-effort */ }

      // Pass in-zero-risk-streak flag so applyProfitLock can hysteresis-hold
      // us in zero-risk until drawdown truly recovers (see PROFIT_LOCK_HYSTERESIS_PCT
      // in profit-lock-guard). Reused key: `profit-lock:zero-since` is already
      // tracked below for alert-response 24h UNWIND_ALL_SPOT.
      const priorZeroSince = await getCronStateOr<number | null>('profit-lock:zero-since', null);
      const lockDecision = applyProfitLock(
        aiResult.allocations as Record<string, number>,
        navUsd,
        peakNavForLock,
        { drawdownPct7dAgo, wasInZeroRisk: priorZeroSince !== null },
      );
      if (lockDecision.active) {
        logger.warn('[SUI Cron] Profit-lock guard capped risk allocation', {
          drawdownPct: lockDecision.drawdownPct.toFixed(2),
          peakNav: peakNavForLock.toFixed(2),
          navUsd: navUsd.toFixed(2),
          riskCap: lockDecision.riskAllocationCap,
          before: lockDecision.originalAllocations,
          after: lockDecision.cappedAllocations,
        });
        await notifyDiscord(
          `🛡️ Profit-lock ACTIVE: NAV $${navUsd.toFixed(2)} is ${lockDecision.drawdownPct.toFixed(1)}% below peak $${peakNavForLock.toFixed(2)}. Risk capped at ${lockDecision.riskAllocationCap}%, ${lockDecision.cappedAllocations.USDC ?? 0}% held in USDC.`,
          'WARN',
          {
            drawdownPct: lockDecision.drawdownPct,
            riskCap: lockDecision.riskAllocationCap,
            before: lockDecision.originalAllocations,
            after: lockDecision.cappedAllocations,
          },
        ).catch(() => {});
        aiResult.allocations = lockDecision.cappedAllocations as typeof aiResult.allocations;
      }

      // ── alert-response-loop force-cap override ─────────────────────
      // If alert-response-loop set an emergency risk cap (SHRINK_SPOT
      // or UNWIND_ALL_SPOT), apply the tighter of that + profit-lock.
      try {
        const override = await getCronStateOr<{ capPct: number; reason: string; expiresAtMs: number } | null>(
          'alert-response:spot-target-risk-cap', null,
        );
        if (override && override.expiresAtMs > Date.now()) {
          const currentRiskAlloc = ['BTC', 'ETH', 'SUI'].reduce((s, k) => s + (aiResult.allocations[k as keyof typeof aiResult.allocations] || 0), 0);
          if (currentRiskAlloc > override.capPct) {
            // Scale risk assets proportionally to hit override cap
            const scale = override.capPct / currentRiskAlloc;
            const capped: Record<string, number> = {};
            let cappedRisk = 0;
            for (const asset of Object.keys(aiResult.allocations)) {
              if (asset.toUpperCase() === 'USDC') continue;
              capped[asset] = Math.round((aiResult.allocations[asset as keyof typeof aiResult.allocations] || 0) * scale);
              cappedRisk += capped[asset];
            }
            capped.USDC = Math.max(0, 100 - cappedRisk);
            aiResult.allocations = capped as typeof aiResult.allocations;
            logger.warn('[SUI Cron] alert-response override applied', {
              capPct: override.capPct, reason: override.reason,
              before: currentRiskAlloc, after: cappedRisk,
            });
            await notifyDiscord(
              `🚨 alert-response force-cap: risk ${currentRiskAlloc}% → ${cappedRisk}% (${override.reason})`,
              'WARN', { override, capped },
            ).catch(() => {});
          }
        } else if (override) {
          // Expired — clear it
          await setCronState('alert-response:spot-target-risk-cap', null).catch(() => {});
        }
      } catch { /* best-effort */ }

      // Track continuous zero-risk-tier duration for alert-response-loop
      // Gap 8's UNWIND_ALL_SPOT rule triggers after > 24h at 0% risk cap.
      //
      // Silent-catch removed 2026-07-17: same class of bug as the halt
      // writes and stale-close. If the write fails silently, either:
      // (a) 24h clock never starts → UNWIND_ALL_SPOT never fires when
      //     it should, OR
      // (b) key never clears on recovery → spurious UNWIND after recovery
      // Both leak downstream. Now logs + alerts on write failure.
      try {
        if (lockDecision.active && lockDecision.riskAllocationCap === 0) {
          const existing = await getCronStateOr<number | null>('profit-lock:zero-since', null);
          if (!existing) {
            try {
              await setCronState('profit-lock:zero-since', Date.now());
            } catch (writeErr) {
              logger.error('[SUI Cron] profit-lock:zero-since START write FAILED', {
                error: writeErr instanceof Error ? writeErr.message : String(writeErr),
              });
            }
          }
        } else {
          try {
            await setCronState('profit-lock:zero-since', null);
          } catch (writeErr) {
            logger.error('[SUI Cron] profit-lock:zero-since CLEAR write FAILED', {
              error: writeErr instanceof Error ? writeErr.message : String(writeErr),
            });
          }
        }
      } catch { /* best-effort */ }

      // ── PortfolioDriver — corrective unwind (Gaps 1, 2, 5) ─────
      // Profit-lock caps FUTURE allocations. PortfolioDriver actively
      // reshapes existing holdings toward the cap. Env-gated so the
      // first few days after deploy are log-only — operator watches
      // Discord for what it WOULD do before flipping execute on.
      try {
        const currentSignal = await Polymarket5MinService.getLatest5MinSignal().catch(() => null);
        if (currentSignal) {
          // Build a sandbox-like snapshot from real holdings for the pure driver.
          // Derive per-asset spot USD from the live allocation × NAV. poolStats
          // is already available in this scope from the earlier getPoolStats call.
          const liveAlloc = (poolStats.allocation ?? {}) as unknown as Record<string, number>;
          // Dynamic: iterate the enabled asset set instead of hardcoding
          // BTC/ETH/SUI. Wrapped tickers (wBTC/wETH) still use the wrapped
          // key so PortfolioDriver's SPOT_TO_ASSET map resolves cleanly;
          // everything else uses the ticker as its own spot key.
          const WRAP_KEY: Record<string, string> = { BTC: 'wBTC', ETH: 'wETH' };
          const spotUsd: Record<string, number> = {};
          for (const asset of POOL_ASSETS) {
            const pct = liveAlloc[asset as keyof typeof liveAlloc] || 0;
            const spotKey = WRAP_KEY[asset] ?? asset;
            spotUsd[spotKey] = navUsd * (Number(pct) / 100);
          }
          const spotSum = Object.values(spotUsd).reduce((s, v) => s + v, 0);
          const snapshot = {
            idleUsdc: Math.max(0, navUsd - spotSum),
            spot: spotUsd,
            hedges: [] as Array<{ asset: string; side: 'LONG' | 'SHORT'; notionalUsd: number }>,
            getNav: () => navUsd,
          };
          const actions = await runPortfolioDriverTick({
            sandbox: snapshot,
            signal: {
              direction: currentSignal.direction,
              confidence: currentSignal.confidence,
              observedAt: Date.now(),
            },
            nowMs: Date.now(),
            peakNavUsd: peakNavForLock,
            aiAllocation: aiResult.allocations as Record<string, number>,
            spotPrices: pricesUSD,
          });
          if (actions.length > 0) {
            // The driver sells spot; it obeys the pool-wide trading pause too.
            const execute = envFlagOnByDefault('PORTFOLIO_DRIVER_EXECUTE') && isPoolTradingEnabled();
            logger.warn('[SUI Cron] PortfolioDriver suggests corrective actions', {
              execute, count: actions.length, actions,
            });
            await notifyDiscord(
              `🎯 PortfolioDriver: ${actions.length} corrective action(s) [${execute ? 'EXECUTING' : 'log-only'}]. ${actions.map(a => `${a.type}:${a.asset} $${a.amountUsd}`).join(', ')}`,
              'WARN',
              { actions, execute },
            ).catch(() => {});

            // Execution wiring — env-gated. Reuses existing capital paths:
            //   SELL_SPOT_TO_USDC → replenishAdminUsdc (largest-first swap
            //   of admin's non-USDC balances back to USDC via 7k aggregator)
            //   CLOSE_HEDGE      → BluefinService.closeHedge({ symbol })
            //   BUY_SPOT_FROM_USDC / OPEN_HEDGE → deferred to Step 7 in the
            //   same cron cycle (which drives allocation-to-target swaps
            //   from the possibly-just-topped-up admin USDC balance).
            if (execute) {
              const executionResults: Array<{ type: string; asset: string; ok: boolean; detail?: string }> = [];

              // Batch SELL_SPOT_TO_USDC into a single replenish call summing
              // the shortfalls. replenishAdminUsdc already picks the largest
              // holdings first, so we only need to pass total USD to raise.
              const sellSum = actions
                .filter(a => a.type === 'SELL_SPOT_TO_USDC')
                .reduce((s, a) => s + a.amountUsd, 0);
              if (sellSum > 0.5) {
                try {
                  const rep = await replenishAdminUsdc(network, sellSum, pricesUSD);
                  executionResults.push({
                    type: 'SELL_SPOT_TO_USDC',
                    asset: '(batched)',
                    ok: rep.swapped > 0,
                    detail: `swapped $${rep.swapped.toFixed(2)} of $${sellSum.toFixed(2)} target`,
                  });
                } catch (sellErr) {
                  executionResults.push({
                    type: 'SELL_SPOT_TO_USDC', asset: '(batched)', ok: false,
                    detail: sellErr instanceof Error ? sellErr.message : String(sellErr),
                  });
                }
              }

              // CLOSE_HEDGE actions — one call per hedge/symbol.
              const closeActions = actions.filter(a => a.type === 'CLOSE_HEDGE');
              if (closeActions.length > 0) {
                try {
                  const bf = BluefinService.getInstance();
                  await bf.initialize(
                    (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim(),
                    network === 'mainnet' ? 'mainnet' : 'testnet',
                  ).catch(() => {});
                  for (const a of closeActions) {
                    const symbol = `${a.asset}-PERP`;
                    try {
                      const res = await bf.closeHedge({ symbol });
                      executionResults.push({
                        type: 'CLOSE_HEDGE', asset: a.asset, ok: res.success,
                        detail: res.error || `closed ${symbol}`,
                      });
                    } catch (closeErr) {
                      executionResults.push({
                        type: 'CLOSE_HEDGE', asset: a.asset, ok: false,
                        detail: closeErr instanceof Error ? closeErr.message : String(closeErr),
                      });
                    }
                  }
                } catch (bfErr) {
                  executionResults.push({
                    type: 'CLOSE_HEDGE', asset: '(init)', ok: false,
                    detail: `BluefinService init failed: ${bfErr instanceof Error ? bfErr.message : String(bfErr)}`,
                  });
                }
              }

              // BUY_SPOT / OPEN_HEDGE deferred: Step 7 rebalance already
              // handles USDC → spot swap toward target allocation. We log
              // the driver's intent so operators can correlate.
              const deferredCount = actions.filter(
                a => a.type === 'BUY_SPOT_FROM_USDC' || a.type === 'OPEN_HEDGE',
              ).length;

              logger.warn('[SUI Cron] PortfolioDriver execution results', {
                attempted: executionResults.length, deferredToStep7: deferredCount,
                results: executionResults,
              });
              await notifyDiscord(
                `🎯 PortfolioDriver EXECUTED ${executionResults.filter(r => r.ok).length}/${executionResults.length} action(s)${deferredCount > 0 ? ` (${deferredCount} deferred to Step 7)` : ''}`,
                'WARN',
                { executionResults, deferredCount },
              ).catch(() => {});
            }
          }
        }
      } catch (driverErr) {
        logger.warn('[SUI Cron] PortfolioDriver threw (non-critical)', {
          error: driverErr instanceof Error ? driverErr.message : String(driverErr),
        });
      }
    } catch (lockErr) {
      logger.warn('[SUI Cron] Profit-lock guard threw (non-critical)', {
        error: lockErr instanceof Error ? lockErr.message : String(lockErr),
      });
    }

    const clamp = clampAllocationsToHedgeable({
      navUsd,
      allocations: aiResult.allocations as Record<string, number>,
      prices: pricesUSD,
      hedgeRatio: ratio,
      perpSpecs,
      openInterestUsd,
      maxOiPct: Number(process.env.BLUEFIN_MAX_OI_PCT) || 5,
    });
    if (clamp.redistributed) {
      logger.warn('[SUI Cron] Hedgeability clamp redistributed allocations', {
        dropped: clamp.dropped,
        before: aiResult.allocations,
        after: clamp.allocations,
        navUsd: navUsd.toFixed(2),
        leverage: tierLev,
        hedgeRatio: ratio,
      });
      // Discord intentionally silent — "AI target > minQty" is the
      // steady state on a $50 pool and firing INFO every 30-min cron
      // tick is pure noise. Logged above via logger for audit.
      aiResult.allocations = clamp.allocations as typeof aiResult.allocations;
    } else if (clamp.dropped.length > 0 && !clamp.redistributed) {
      // No survivor — every asset unhedgeable. Fall back to keeping
      // pool in USDC for this cycle (skip swap + skip hedge).
      logger.error('[SUI Cron] No asset can clear minQty at current NAV — skipping swap + hedge', {
        navUsd: navUsd.toFixed(2),
        leverage: tierLev,
        dropped: clamp.dropped,
      });
      // Discord silent — same reason: repeated WARN on a permanently-
      // small pool is noise. Structural state, not an event.
      for (const a of Object.keys(aiResult.allocations)) {
        (aiResult.allocations as Record<string, number>)[a] = 0;
      }
    }
  }

  // Push the off-chain NAV portion to the Move contract's oracle field
  // so deposit + withdraw share math reflects true pool value. Without
  // this, the contract pays withdrawing members against only the
  // on-chain USDC balance (~$0.40 vs $44.99 true NAV on 2026-06-03 =
  // 97% underpayment). Best-effort: failure does NOT block the cron
  // tick (NAV snapshot + reconcile still need to run); the next tick
  // retries. With admin_set_external_nav_required(true), the contract
  // will revert deposits/withdrawals if attestation goes stale,
  // pausing user flow until the cron catches up.
  if (!aboveSafetyCeiling) {
    // Only a figure whose parts were read together is attested. Fallback
    // stats have no basis, and when the admin wallet could not be read its
    // holdings were replaced by a cost basis that the venue figure may also
    // contain.
    const basis = poolStats.isUsdcPool ? poolStats.navBasis : undefined;
    const attest: Awaited<ReturnType<typeof attestExternalNav>> = !basis
      ? { pushed: false, error: 'pool stats came from the fallback path — not attesting' }
      : !basis.adminRead
        ? { pushed: false, error: 'admin wallet holdings could not be read or priced this tick — not attesting' }
        : await attestExternalNav(network, { externalUsd: basis.externalUsdc, trusted: basis.venueSource === 'live' });
    if (attest.pushed) {
      logger.info('[SUI Cron] External NAV oracle updated', {
        externalNavUsd: attest.externalNavUsd?.toFixed(2),
        txDigest: attest.txDigest,
      });
    } else if (attest.error && !attest.error.includes('AdminCap is on MSafe')) {
      // MSafe-gated path is expected; everything else is worth surfacing.
      logger.warn('[SUI Cron] External NAV attestation failed (non-fatal)', { error: attest.error });
      // Deposits and withdrawals stop when the attestation is two hours old.
      // From 2026-10-01 that happened for days with only this log line to
      // show for it. ERROR, not KILL: this is not a reason to shrink the book.
      const ageMin = attest.attestationAgeMin;
      if (ageMin === undefined || ageMin > ATTESTATION_ALERT_AFTER_MIN) {
        await notifyDiscord(
          ageMin !== undefined && ageMin > 120
            ? `Pool deposits and withdrawals are BLOCKED: the on-chain NAV attestation is ${Math.round(ageMin)} min old (limit 120) and the last attempt failed: ${attest.error}`
            : `NAV attestation is failing (${ageMin === undefined ? 'age unknown' : `${Math.round(ageMin)} min old`}); deposits and withdrawals stop at 120 min. Last error: ${attest.error}`,
          'ERROR',
          { chain: 'sui', attestationAgeMin: ageMin === undefined ? 'unknown' : Math.round(ageMin), error: attest.error },
        ).catch(() => {});
      }
    }
  }

  await recordPoolNavSnapshot({ sharePriceUsd, navUsd, poolStats, allocations: aiResult.allocations });

  return { navUsd, sharePriceUsd, aboveSafetyCeiling };
}
