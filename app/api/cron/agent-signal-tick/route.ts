/**
 * Agent Signal Tick — proactive reactivity cron
 *
 * Restores the EventEmitter "signal:direction-flip" behavior that's wired
 * at code level inside RiskAgent/HedgingAgent/PriceMonitorAgent but is
 * non-functional on Vercel serverless (Lambda terminates → subscription
 * dies). Runs every ~2 min via QStash, polls the Polymarket 5-min ticker,
 * and triggers the LeadAgent autonomous cycle ONLY when:
 *
 *   - The Polymarket 5-min signal has flipped direction since the last tick
 *   - OR a strong signal (>75% confidence) emerged that wasn't there before
 *
 * On flip → re-runs the full agent cycle so directives are fresh, then
 * pings Discord. The actual hedge re-balance happens on the next
 * sui-community-pool cron tick (every 30 min) which consumes the refreshed
 * directives via agent-trade-guard.
 *
 * This is cheap (one API call + cached state read) when no flip — so a
 * 2-min cadence is fine. Cost only matters on actual flips, typically 3-6/day.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { tryClaimCronRun, getCronState, setCronState, getCronStateOr, CronKeys } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { isPoolTradingEnabled } from '@/lib/services/sui/pool-trading-pause';
// Static so Graphify sees the signal-tick → defense-dispatch chain.
// Previously loaded via await import() (9 sites); tree-sitter drops those.
import { Polymarket5MinService } from '@/lib/services/market-data/Polymarket5MinService';
import { getAgentOrchestrator } from '@/lib/services/agent-orchestrator';
import { BluefinService } from '@/lib/services/sui/BluefinService';
import { checkAndCloseDrifts } from '@/lib/services/agents/position-drift-monitor';
import { getSuiCommunityPoolService } from '@/lib/services/sui/SuiCommunityPoolService';
import { runPortfolioDriverTick } from '@/lib/services/sui/PortfolioDriver';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { envFlag } from '@/lib/utils/env-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CRON_KEY = 'agent-signal-tick';
// Claim debounce. QStash fires every 2 min; the debounce is what actually
// gates cron work. Was 90s (near-continuous polling of the 5-min binary
// market). Prod ring buffer 2026-08-04 showed 125 flips, median gap 4 min,
// 48 at ≥85% conf — that's not signal quality, it's polling faster than
// the underlying signal-to-noise permits. 15 min matches the effective
// persistence of the 5-min-window feed. Env override for tuning.
const TICK_INTERVAL_MS = Number(process.env.SIGNAL_TICK_INTERVAL_MS) || 15 * 60 * 1000;
const STATE_KEY = `${CRON_KEY}:last-signal`;
const HEARTBEAT_KEY = `cron:lastRun:${CRON_KEY}`;

interface LastSignalState {
  direction: 'UP' | 'DOWN';
  confidence: number;
  windowLabel: string;
  observedAt: number;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyCronRequest(request, 'AgentSignalTick');
  if (auth !== true) return auth;

  const now = Date.now();
  // tryClaimCronRun returns { claimed: boolean, lastRunMs, reason? } — an
  // OBJECT, always truthy. `!claim` was always false, so the debounce
  // never triggered and TICK_INTERVAL_MS was silently ignored (cron
  // effectively ran every 2 min per QStash cadence). Same pattern in
  // sui-community-pool:189 uses `!claim.claimed` correctly.
  const claim = await tryClaimCronRun(CRON_KEY, TICK_INTERVAL_MS, now);
  if (!claim.claimed) {
    return NextResponse.json({ skipped: true, reason: claim.reason ?? 'tick claim debounce' });
  }
  await setCronState(HEARTBEAT_KEY, now).catch(() => {});

  try {
    const current = await Polymarket5MinService.getLatest5MinSignal();
    if (!current) {
      return NextResponse.json({ success: true, reason: 'no current signal' });
    }

    const last = await getCronState<LastSignalState>(STATE_KEY);

    // Signal-flip confidence gate. In prod 2026-08-04 the 5-min ticker
    // flipped direction 24x in 3h, many at 39% conf (essentially coin-flip).
    // Every flip fired checkAndCloseDrifts → closed the perp → next flip
    // 2-4 min later re-opened it. Wash-trade engine on perp side.
    // Ignore low-conf flips AND suppress the state write so a noise flip
    // doesn't rewrite the baseline and hide the NEXT real flip.
    const MIN_FLIP_CONFIDENCE = Number(process.env.SIGNAL_FLIP_MIN_CONF) || 55;
    const wouldFlip = !!last && last.direction !== current.direction;
    const directionFlipped = wouldFlip && current.confidence >= MIN_FLIP_CONFIDENCE;
    const strongEmerged = current.confidence >= 75 && (!last || last.confidence < 60);

    const newState: LastSignalState = {
      direction: current.direction,
      confidence: current.confidence,
      windowLabel: current.windowLabel,
      observedAt: now,
    };
    if (wouldFlip && !directionFlipped) {
      logger.debug('[AgentSignalTick] suppressed noise-flip', {
        lastDir: last?.direction, currentDir: current.direction, conf: current.confidence,
      });
    } else {
      await setCronState(STATE_KEY, newState).catch(() => {});
    }

    // No actionable change → done in ~50ms
    if (!directionFlipped && !strongEmerged) {
      logger.debug('[AgentSignalTick] no actionable change', {
        direction: current.direction, conf: current.confidence,
      });
      return NextResponse.json({
        success: true,
        actionable: false,
        direction: current.direction,
        confidence: current.confidence,
      });
    }

    // ACTIONABLE — re-run the LeadAgent autonomous cycle so directives
    // pick up the new signal. The sui-community-pool cron's next tick will
    // consume the refreshed directives via agent-trade-guard.
    logger.info('[AgentSignalTick] signal change — refreshing agent directives', {
      directionFlipped, strongEmerged,
      prev: last ? { dir: last.direction, conf: last.confidence } : null,
      now: { dir: current.direction, conf: current.confidence },
    });

    const orchestrator = getAgentOrchestrator();
    const cycle = await orchestrator.runAutonomousCycle({
      chain: 'sui',
      portfolioId: -2,
    });

    // IMMEDIATE drift-close on signal flip. Refreshing directives is only
    // half the fix — the flipped position also needs to close NOW, not on
    // the next 30-min sui-cron tick. Wraps in try/catch so a BlueFin
    // outage never breaks the directive refresh.
    let driftResult: { checked: number; drifted: number; closed: number; skipped: number; errors: number } | null = null;
    try {
      const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
      if (adminKey && directionFlipped && isPoolTradingEnabled()) {
        const bf = BluefinService.getInstance();
        // Initialize if needed — BluefinService is a singleton but the
        // signal-tick cron often lives in a fresh Lambda so the shared
        // instance may not be booted.
        await bf.initialize(adminKey, 'mainnet').catch(() => {});
        driftResult = await checkAndCloseDrifts('sui', bf);
        if (driftResult.drifted > 0) {
          logger.info('[AgentSignalTick] flip-triggered drift close', driftResult);
        }
      }
    } catch (driftErr) {
      logger.warn('[AgentSignalTick] drift-close on flip failed (non-critical)', {
        error: driftErr instanceof Error ? driftErr.message : String(driftErr),
      });
    }

    // Gap 2: spot-leg unwind on flip. checkAndCloseDrifts only touches
    // BlueFin perp positions — the pool's spot wBTC/wETH/SUI on the admin
    // wallet is a directional exposure the drift-monitor never sees.
    // PortfolioDriver reads current holdings and emits SELL_SPOT_TO_USDC
    // actions when spot contradicts the freshly flipped signal.
    let spotDriverActions: number = 0;
    try {
      if (directionFlipped) {
        const pool = getSuiCommunityPoolService();
        const stats = (await pool.getPoolStats()) as unknown as { totalNAVUsd?: number; allocation?: { BTC?: number; ETH?: number; SUI?: number } };
        const navUsd = stats.totalNAVUsd || 0;
        if (navUsd > 0) {
          const alloc = stats.allocation ?? { BTC: 0, ETH: 0, SUI: 0 };
          const spotUsd: Record<string, number> = {
            wBTC: navUsd * ((alloc.BTC || 0) / 100),
            wETH: navUsd * ((alloc.ETH || 0) / 100),
            SUI:  navUsd * ((alloc.SUI || 0) / 100),
          };
          const spotSum = Object.values(spotUsd).reduce((s, v) => s + v, 0);
          const peakNav = await getCronStateOr<number>(CronKeys.poolNavPeak('community-pool'), navUsd);
          const snapshot = {
            idleUsdc: Math.max(0, navUsd - spotSum),
            spot: spotUsd,
            hedges: [] as Array<{ asset: string; side: 'LONG' | 'SHORT'; notionalUsd: number }>,
            getNav: () => navUsd,
          };
          const actions = await runPortfolioDriverTick({
            sandbox: snapshot,
            signal: {
              direction: current.direction,
              confidence: current.confidence,
              observedAt: now,
            },
            nowMs: now,
            peakNavUsd: peakNav,
            signalFlipped: true,
          });
          spotDriverActions = actions.length;
          if (spotDriverActions > 0) {
            const execute = envFlag('PORTFOLIO_DRIVER_EXECUTE');
            // Log-only by design — sui-community-pool cron owns execution
            // (runs every 30 min; catches up on flip-triggered actions
            // within the next tick). Duplicating swap execution here would
            // race with the 30-min cron; drift-close above already handles
            // the fast perp close via checkAndCloseDrifts. Documented intent.
            logger.warn('[AgentSignalTick] spot-driver actions on flip', {
              execute, count: spotDriverActions, actions,
              note: 'log-only; sui-community-pool cron will execute within 30min',
            });
          }
        }
      }
    } catch (spotErr) {
      logger.warn('[AgentSignalTick] spot-driver on flip failed (non-critical)', {
        error: spotErr instanceof Error ? spotErr.message : String(spotErr),
      });
    }

    // Discord ping — operators want to see the signal-driven refresh
    try {
      const headline = directionFlipped
        ? `🔄 Signal FLIP ${last?.direction} → ${current.direction} (conf ${current.confidence.toFixed(0)}%)`
        : `📈 STRONG signal ${current.direction} emerged (conf ${current.confidence.toFixed(0)}%, up from ${last?.confidence?.toFixed(0) ?? '?'}%)`;
      const driftLine = driftResult && driftResult.closed > 0
        ? ` · closed ${driftResult.closed} drifted position(s)`
        : '';
      await notifyDiscord(
        `${headline} — agent directives refreshed${driftLine}. Risk=${cycle.riskScore ?? '?'} hedge-recs=${cycle.hedgeRecommendations ?? 0}.`,
        directionFlipped ? 'WARN' : 'INFO',
        { directionFlipped, strongEmerged, cycle, driftResult },
      ).catch(() => {});
    } catch { /* best-effort */ }

    return NextResponse.json({
      success: true,
      actionable: true,
      directionFlipped,
      strongEmerged,
      direction: current.direction,
      confidence: current.confidence,
      cycleDurationMs: cycle.durationMs,
      cycleRiskScore: cycle.riskScore,
      driftResult,
    });
  } catch (e) {
    logger.error('[AgentSignalTick] failed', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request);
}
