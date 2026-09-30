/**
 * Solana pool sleeve trader — the pool's win-rate engine (portfolio -6).
 *
 * Implements the plan's portfolio-margin model on testnet: deposited JIMP
 * never trades; a USD sleeve sized off the pool's live NAV takes the
 * platform's signals on BTC/ETH/SOL through the honest simulated executor
 * (fees + funding + slippage). Realized PnL accumulates as the
 * "pending buyback" line — share price stays chain-truth until real
 * mainnet buybacks exist (plan §1b/§2: conservative, manipulation-proof).
 *
 * Reuses the shared brain end-to-end: PredictionAggregatorService entries,
 * normalized source snapshots, close-pipeline settlement, learning under
 * the 'solana' calibrator namespace. Ledger-admission gating replaces the
 * confidence floor once n≥500 cells exist (see entry note below).
 *
 * One position at a time, by design — this book exists to prove the loop
 * on a small honest pool, not to farm samples.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { SOLANA_POOL_PORTFOLIO_ID } from '@/lib/constants';
import {
  simulateOpen,
  simulateClose,
  markToMarket,
  type SimulatedPosition,
  type Side,
  type SourceSnapshot,
} from '@/lib/services/paper-trader/simulated-executor';
import {
  recordCloseLearning,
  settleHedgeRow,
} from '@/lib/services/paper-trader/close-pipeline';

const KEY_POSITION = 'solana-pool:sleeve-position';
const KEY_STATS = 'solana-pool:sleeve-stats';

const ASSETS = ['BTC', 'ETH', 'SOL'];
const num = (name: string, def: number): number => {
  const v = Number((process.env[name] || '').trim());
  return isFinite(v) && v > 0 ? v : def;
};

// Portfolio-margin sizing (plan §1b): sleeve notional tracks pool NAV.
const MARGIN_RATIO = () => num('SOLANA_SLEEVE_MARGIN_RATIO', 0.3);
const MIN_NOTIONAL = () => num('SOLANA_SLEEVE_MIN_NOTIONAL_USD', 50);
const MAX_NOTIONAL = () => num('SOLANA_SLEEVE_MAX_NOTIONAL_USD', 1000);
const MIN_CONF = () => num('SOLANA_SLEEVE_MIN_CONF', 70);
const STOP_PCT = () => num('SOLANA_SLEEVE_STOP_PCT', 2.5); // % of entry, price-anchored
const MAX_HOLD_MIN = () => num('SOLANA_SLEEVE_MAX_HOLD_MIN', 240);

export interface SleevePositionState {
  orderId: string;
  position: SimulatedPosition;
  stopLossPrice: number;
}

export interface SleeveStats {
  trades: number;
  wins: number;
  cumRealizedUsd: number;
  lastRealizedUsd?: number;
}

export interface SleeveTickSummary {
  action: 'held' | 'opened' | 'closed' | 'idle' | 'disabled';
  detail?: string;
  navUsd?: number;
  targetNotionalUsd?: number;
}

async function markPrice(asset: string): Promise<number | null> {
  try {
    const { getMultiSourceValidatedPrice } = await import(
      '@/lib/services/market-data/unified-price-provider'
    );
    const v = await getMultiSourceValidatedPrice(asset, {
      minSources: 2,
      maxDeviationPercent: 2,
      timeout: 8000,
    });
    return v.price && v.price > 0 ? v.price : null;
  } catch {
    return null;
  }
}

export async function runSolanaSleeveTick(
  poolNavUsd: number | null,
  now: number = Date.now(),
): Promise<SleeveTickSummary> {
  if ((process.env.SOLANA_SLEEVE_DISABLE || '').trim() === '1') {
    return { action: 'disabled' };
  }

  const state = await getCronState<SleevePositionState>(KEY_POSITION);

  // ── Manage the open position ──
  if (state?.position) {
    const pos = state.position;
    const mark = await markPrice(pos.asset);
    if (!mark) return { action: 'held', detail: 'no validated mark; retry next tick' };

    const mtm = markToMarket(pos, mark, now);
    pos.peakUnrealizedPnl = Math.max(pos.peakUnrealizedPnl ?? 0, mtm.unrealizedPnlUsd);
    pos.troughUnrealizedPnl = Math.min(pos.troughUnrealizedPnl ?? 0, mtm.unrealizedPnlUsd);

    const holdMin = (now - pos.openedAt) / 60_000;
    const stopHit =
      pos.side === 'LONG' ? mark <= state.stopLossPrice : mark >= state.stopLossPrice;

    let closeReason: string | null = null;
    if (stopHit) closeReason = `stop-loss hit at ${mark.toFixed(2)}`;
    else if (holdMin >= MAX_HOLD_MIN()) closeReason = `max-hold ${MAX_HOLD_MIN()}min ceiling`;

    if (!closeReason) {
      await setCronState(KEY_POSITION, state); // persist peak/trough drift
      return { action: 'held', detail: `${pos.asset} ${pos.side} uPnL $${mtm.unrealizedPnlUsd.toFixed(2)}` };
    }

    const result = simulateClose(pos, mark, now);
    await recordCloseLearning(pos, mark, result.realizedPnlUsd, now, {
      calibratorNamespace: 'solana',
    });
    await settleHedgeRow({
      orderId: state.orderId,
      pos,
      result,
      reason: closeReason,
      nav: poolNavUsd ?? 0,
    });

    const stats = (await getCronState<SleeveStats>(KEY_STATS)) ?? {
      trades: 0,
      wins: 0,
      cumRealizedUsd: 0,
    };
    stats.trades += 1;
    if (result.realizedPnlUsd > 0) stats.wins += 1;
    stats.cumRealizedUsd += result.realizedPnlUsd;
    stats.lastRealizedUsd = result.realizedPnlUsd;
    await setCronState(KEY_STATS, stats);
    await setCronState(KEY_POSITION, null);

    logger.info('[SolanaSleeve] closed', {
      orderId: state.orderId,
      reason: closeReason,
      realizedUsd: result.realizedPnlUsd.toFixed(2),
      wr: (stats.wins / stats.trades).toFixed(3),
    });
    return { action: 'closed', detail: `${closeReason} → $${result.realizedPnlUsd.toFixed(2)}` };
  }

  // ── Entry ──
  if (!poolNavUsd || poolNavUsd <= 0) {
    return { action: 'idle', detail: 'pool NAV unavailable — no sizing basis' };
  }
  const target = Math.min(
    Math.max(poolNavUsd * MARGIN_RATIO(), MIN_NOTIONAL()),
    MAX_NOTIONAL(),
  );

  try {
    const { PredictionAggregatorService } = await import(
      '@/lib/services/market-data/PredictionAggregatorService'
    );
    const { normalizeSourceKey } = await import('@/lib/services/ai/source-calibrator');
    // A single hung source once wedged this scan for 20+ minutes locally.
    // Prod's maxDuration would cap it, but the tick should own its budget:
    // no signal read in 25s → idle, retry next minute.
    let scanTimer: ReturnType<typeof setTimeout> | undefined;
    let preds: Awaited<ReturnType<typeof PredictionAggregatorService.getPerAssetPredictions>>;
    try {
      preds = await Promise.race([
        PredictionAggregatorService.getPerAssetPredictions(ASSETS),
        new Promise<never>((_, rej) => {
          scanTimer = setTimeout(() => rej(new Error('aggregator scan timeout (25s)')), 25_000);
        }),
      ]);
    } finally {
      if (scanTimer) clearTimeout(scanTimer);
    }

    // Highest-confidence directional signal above the floor.
    // TODO(ledger-admission): once getLedgerHitRates(n>=500) returns cells,
    // rank by proven per-(source,asset,horizon) hit rate instead of raw
    // confidence — measured conf≥70 intraday aggregate sits BELOW 50%.
    let best: { asset: string; side: Side; conf: number; snapshot: SourceSnapshot[] } | null = null;
    for (const asset of ASSETS) {
      const p = preds[asset];
      if (!p || p.direction === 'NEUTRAL' || p.confidence < MIN_CONF()) continue;
      if (!best || p.confidence > best.conf) {
        best = {
          asset,
          side: p.direction === 'UP' ? 'LONG' : 'SHORT',
          conf: p.confidence,
          snapshot: (p.sources ?? []).map((s: { name?: string; type?: string; direction?: string }) => ({
            key: normalizeSourceKey(s.name ?? '', s.type ?? ''),
            direction: (s.direction ?? 'NEUTRAL') as 'UP' | 'DOWN' | 'NEUTRAL',
          })),
        };
      }
    }
    if (!best) {
      return { action: 'idle', detail: `no directional signal ≥${MIN_CONF()} conf`, navUsd: poolNavUsd, targetNotionalUsd: target };
    }

    const entry = await markPrice(best.asset);
    if (!entry) return { action: 'idle', detail: 'no validated entry price' };

    const pos = simulateOpen(
      { asset: best.asset, side: best.side, notionalUsd: target, leverage: 1, entryPrice: entry },
      now,
    );
    pos.sourceSnapshot = best.snapshot;
    pos.entryConfidence = best.conf;
    const stopLossPrice =
      best.side === 'LONG' ? entry * (1 - STOP_PCT() / 100) : entry * (1 + STOP_PCT() / 100);

    const orderId = `solsleeve_${best.asset}_${Math.floor(now / 1000)}`;
    try {
      const { createHedge } = await import('@/lib/db/hedges');
      await createHedge({
        orderId,
        portfolioId: SOLANA_POOL_PORTFOLIO_ID,
        asset: best.asset,
        market: `${best.asset}-PERP`,
        side: best.side,
        size: pos.size,
        notionalValue: target,
        leverage: 1,
        entryPrice: entry,
        stopLoss: stopLossPrice,
        simulationMode: true,
        chain: 'solana-devnet',
        reason: `sleeve entry conf=${best.conf}`,
      });
    } catch (e) {
      logger.warn('[SolanaSleeve] hedge row create failed (position still tracked)', {
        error: errMsg(e),
      });
    }

    await setCronState(KEY_POSITION, { orderId, position: pos, stopLossPrice } satisfies SleevePositionState);
    logger.info('[SolanaSleeve] opened', {
      orderId,
      asset: best.asset,
      side: best.side,
      notionalUsd: target.toFixed(2),
      conf: best.conf,
    });
    return {
      action: 'opened',
      detail: `${best.asset} ${best.side} $${target.toFixed(2)} @ ${entry.toFixed(2)} (conf ${best.conf})`,
      navUsd: poolNavUsd,
      targetNotionalUsd: target,
    };
  } catch (e) {
    logger.warn('[SolanaSleeve] entry scan failed', { error: errMsg(e) });
    return { action: 'idle', detail: errMsg(e) };
  }
}

/** Status-API read: current stats + live-marked open position. */
export async function getSleeveStatus(): Promise<{
  stats: SleeveStats;
  position:
    | (SleevePositionState & { markPrice: number | null; unrealizedPnlUsd: number | null })
    | null;
}> {
  const stats = (await getCronState<SleeveStats>(KEY_STATS)) ?? {
    trades: 0,
    wins: 0,
    cumRealizedUsd: 0,
  };
  const state = await getCronState<SleevePositionState>(KEY_POSITION);
  if (!state?.position) return { stats, position: null };
  const mark = await markPrice(state.position.asset);
  const u = mark ? markToMarket(state.position, mark, Date.now()).unrealizedPnlUsd : null;
  return { stats, position: { ...state, markPrice: mark, unrealizedPnlUsd: u } };
}
