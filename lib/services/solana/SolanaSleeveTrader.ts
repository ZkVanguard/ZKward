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
 *
 * Armed, not trading: an entry needs the signal ledger to have PROVEN the
 * combined signal on that coin. Until then the sleeve opens nothing. The
 * ledger scores every call whether or not anything trades, so the proof
 * does not depend on the sleeve, and the day a coin is proven the sleeve
 * starts on it without a deploy. This is the gate a live executor inherits.
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
import {
  closeLive,
  flattenUntracked,
  liveEntryBlock,
  liveHasPosition,
  liveStatus,
  openLive,
  recordLiveOutcome,
  settledResult,
  sleeveLiveEnabled,
} from './sleeve-live';

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
  /** Set when the position is real: the venue account's equity just before it was opened. */
  live?: { equityBeforeUsd: number };
}

/** Every live event is said out loud. `chain` keeps it out of the SUI pool's alert counts. */
async function alertLive(message: string, level: 'TRADE' | 'WARN' | 'ERROR', context: Record<string, unknown> = {}): Promise<void> {
  try {
    const { notifyDiscord } = await import('@/lib/utils/discord-notify');
    await notifyDiscord(`[SolanaSleeve live · ${liveStatus().network}] ${message}`, level, { chain: 'solana', ...context });
  } catch { /* the log line at the call site stands */ }
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

export type SleeveEvidence = Record<string, 'proven' | 'unproven' | 'wrong-way'>;

/** The ledger's verdict on the combined signal for each coin the sleeve trades. An unreadable store reads as unproven. */
export async function sleeveEvidence(): Promise<SleeveEvidence> {
  const { getLoopState, resolveVerdict } = await import('@/lib/services/market-data/feedback-loop');
  const loop = await getLoopState().catch(() => null);
  return Object.fromEntries(ASSETS.map((a) => [a, resolveVerdict(loop, 'aggregate', a).verdict]));
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
    // A live position that is gone from the venue was closed there (a
    // liquidation, or by hand). There is nothing left to send; it is settled.
    let venueClosed = false;
    if (state.live) {
      try {
        venueClosed = !(await liveHasPosition(pos.asset));
      } catch (e) {
        return { action: 'held', detail: `venue unreadable; retry next tick (${errMsg(e).slice(0, 80)})` };
      }
      if (venueClosed) closeReason = 'closed on the venue';
    }
    if (closeReason) { /* decided above */ }
    else if (stopHit) closeReason = `stop-loss hit at ${mark.toFixed(2)}`;
    else if (holdMin >= MAX_HOLD_MIN()) closeReason = `max-hold ${MAX_HOLD_MIN()}min ceiling`;

    if (!closeReason) {
      await setCronState(KEY_POSITION, state); // persist peak/trough drift
      return { action: 'held', detail: `${pos.asset} ${pos.side} uPnL $${mtm.unrealizedPnlUsd.toFixed(2)}` };
    }

    let result = simulateClose(pos, mark, now);
    if (state.live) {
      // The venue decides the result: its fill, its fees, its funding.
      let live: Awaited<ReturnType<typeof closeLive>>;
      try {
        live = venueClosed
          ? { ok: true, ...(await settledResult(pos.asset, state.live.equityBeforeUsd)) }
          : await closeLive({ asset: pos.asset, side: pos.side, orderId: state.orderId, equityBeforeUsd: state.live.equityBeforeUsd, now });
      } catch (e) {
        live = { ok: false, reason: errMsg(e).slice(0, 120) };
      }
      if (!live.ok) {
        logger.error('[SolanaSleeve] live close did not complete', { orderId: state.orderId, reason: live.reason });
        await alertLive(`close of ${pos.asset} ${pos.side} did not complete: ${live.reason}. Retrying every minute.`, 'ERROR');
        return { action: 'held', detail: `live close pending: ${live.reason}` };
      }
      result = { ...simulateClose(pos, live.exitPrice, now), realizedPnlUsd: live.realizedUsd };
    }
    // Settle first: it decides which of two overlapping ticks closed the
    // position. The loser counts nothing.
    const settled = await settleHedgeRow({
      orderId: state.orderId,
      pos,
      result,
      reason: closeReason,
      nav: poolNavUsd ?? 0,
    });
    if (settled === false) {
      const current = await getCronState<SleevePositionState>(KEY_POSITION);
      if (current?.orderId === state.orderId) await setCronState(KEY_POSITION, null);
      return { action: 'idle', detail: 'position already closed by an overlapping tick' };
    }
    await recordCloseLearning(pos, mark, result.realizedPnlUsd, now, {
      calibratorNamespace: 'solana',
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
    if (state.live) {
      const { halted } = await recordLiveOutcome(result.realizedPnlUsd, now);
      await alertLive(
        `closed ${pos.asset} ${pos.side}: ${result.realizedPnlUsd >= 0 ? '+' : '−'}$${Math.abs(result.realizedPnlUsd).toFixed(2)} (${closeReason})${halted ? ' · new entries halted for 24 h after a run of losses' : ''}`,
        halted ? 'WARN' : 'TRADE',
      );
    }

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

  // A venue position the sleeve has no record of has no stop: close it
  // before anything else, and open nothing this tick.
  const live = sleeveLiveEnabled();
  if (live) {
    try {
      const untracked = await flattenUntracked(ASSETS, now);
      if (untracked.length) {
        await alertLive(`found a venue position with no record and sent its close: ${untracked.join(', ')}`, 'ERROR');
        return { action: 'idle', detail: `closing untracked venue position (${untracked.join(', ')})` };
      }
    } catch (e) {
      return { action: 'idle', detail: `venue unreadable; no live entry (${errMsg(e).slice(0, 80)})` };
    }
  }

  // Proof first: with nothing proven there is nothing to scan for.
  const evidence = await sleeveEvidence();
  const proven = ASSETS.filter((a) => evidence[a] === 'proven');
  if (proven.length === 0) {
    return {
      action: 'idle',
      detail: `waiting for a proven signal (${ASSETS.map((a) => `${a} ${evidence[a]}`).join(' · ')})`,
      navUsd: poolNavUsd,
      targetNotionalUsd: target,
    };
  }

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
        PredictionAggregatorService.getPerAssetPredictions(proven),
        new Promise<never>((_, rej) => {
          scanTimer = setTimeout(() => rej(new Error('aggregator scan timeout (25s)')), 25_000);
        }),
      ]);
    } finally {
      if (scanTimer) clearTimeout(scanTimer);
    }

    // Highest-confidence directional signal above the floor, admitted and
    // ranked by the ledger: an asset measured wrong-way at every hold
    // horizon is skipped (fail-open cold).
    const { getLedgerCells, getRecentLedgerCells, assetHoldPlan } = await import('@/lib/services/market-data/ledger-cells');
    const [cells, recent] = await Promise.all([getLedgerCells().catch(() => []), getRecentLedgerCells().catch(() => [])]);
    let best: {
      asset: string; side: Side; conf: number; rank: number; snapshot: SourceSnapshot[];
      horizonMin: number | null; hitRate: number | null;
    } | null = null;
    for (const asset of proven) {
      const p = preds[asset];
      if (!p || p.direction === 'NEUTRAL' || p.confidence < MIN_CONF()) continue;
      const { plan, measured } = assetHoldPlan(cells, asset, undefined, recent);
      if (measured && !plan) continue;
      const rank = p.confidence * (plan ? Math.max(0.5, Math.min(1.5, plan.hitRate / 0.5)) : 1);
      if (!best || rank > best.rank) {
        best = {
          asset,
          side: p.direction === 'UP' ? 'LONG' : 'SHORT',
          conf: p.confidence,
          rank,
          horizonMin: plan?.horizonMin ?? null,
          hitRate: plan?.hitRate ?? null,
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

    const orderId = `solsleeve_${best.asset}_${Math.floor(now / 1000)}`;

    // Live: the venue's fill replaces the simulated one. No fill, no position.
    let entryPrice = entry;
    let notional = target;
    let liveState: SleevePositionState['live'];
    if (live) {
      const block = await liveEntryBlock(now);
      if (block) return { action: 'idle', detail: block, navUsd: poolNavUsd, targetNotionalUsd: target };
      const opened = await openLive({ asset: best.asset, side: best.side, notionalUsd: target, orderId });
      if (!opened.ok) {
        logger.warn('[SolanaSleeve] live open refused', { asset: best.asset, reason: opened.reason, sent: opened.sent });
        if (opened.sent) await alertLive(`${opened.reason}. If it fills late it is closed on the next tick.`, 'ERROR');
        return { action: 'idle', detail: `live open: ${opened.reason}`, navUsd: poolNavUsd, targetNotionalUsd: target };
      }
      entryPrice = opened.entryPrice;
      notional = opened.size * opened.entryPrice;
      liveState = { equityBeforeUsd: opened.equityBeforeUsd };
    }

    const pos = simulateOpen(
      { asset: best.asset, side: best.side, notionalUsd: notional, leverage: 1, entryPrice },
      now,
    );
    pos.sourceSnapshot = best.snapshot;
    pos.entryConfidence = best.conf;
    const stopLossPrice =
      best.side === 'LONG' ? entryPrice * (1 - STOP_PCT() / 100) : entryPrice * (1 + STOP_PCT() / 100);

    try {
      const { createHedge } = await import('@/lib/db/hedges');
      await createHedge({
        orderId,
        portfolioId: SOLANA_POOL_PORTFOLIO_ID,
        asset: best.asset,
        market: `${best.asset}-PERP`,
        side: best.side,
        size: pos.size,
        notionalValue: notional,
        leverage: 1,
        entryPrice,
        stopLoss: stopLossPrice,
        simulationMode: !liveState,
        chain: liveState ? `solana-perps-${liveStatus().network}` : 'solana-devnet',
        reason: `sleeve entry conf=${best.conf}${best.horizonMin ? ` | ledger ${best.horizonMin}m@${Math.round((best.hitRate ?? 0) * 100)}%` : ''}`,
        metadata: { holdPlan: { horizonMin: best.horizonMin, hitRate: best.hitRate } },
      });
    } catch (e) {
      logger.warn('[SolanaSleeve] hedge row create failed (position still tracked)', {
        error: errMsg(e),
      });
    }

    await setCronState(KEY_POSITION, { orderId, position: pos, stopLossPrice, ...(liveState ? { live: liveState } : {}) } satisfies SleevePositionState);
    if (liveState) await alertLive(`opened ${best.asset} ${best.side} $${notional.toFixed(2)} at ${entryPrice.toFixed(2)}`, 'TRADE');
    logger.info('[SolanaSleeve] opened', {
      orderId,
      asset: best.asset,
      side: best.side,
      notionalUsd: notional.toFixed(2),
      conf: best.conf,
      live: !!liveState,
    });
    return {
      action: 'opened',
      detail: `${best.asset} ${best.side} $${notional.toFixed(2)} @ ${entryPrice.toFixed(2)} (conf ${best.conf})${liveState ? ' LIVE' : ''}`,
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
  evidence: SleeveEvidence;
  /** Whether entries go to a real venue, and on which of its networks. */
  live: { enabled: boolean; network: string };
}> {
  const stats = (await getCronState<SleeveStats>(KEY_STATS)) ?? {
    trades: 0,
    wins: 0,
    cumRealizedUsd: 0,
  };
  const state = await getCronState<SleevePositionState>(KEY_POSITION);
  const evidence = await sleeveEvidence();
  const live = liveStatus();
  if (!state?.position) return { stats, position: null, evidence, live };
  const mark = await markPrice(state.position.asset);
  const u = mark ? markToMarket(state.position, mark, Date.now()).unrealizedPnlUsd : null;
  return { stats, position: { ...state, markPrice: mark, unrealizedPnlUsd: u }, evidence, live };
}
