/**
 * LeadTrader — paper book that trades one signal source on its own terms
 * (portfolio -7).
 *
 * Why it exists: on the signal ledger the combined vote has no edge, but one
 * source family (Kalshi) led BTC and ETH at its 4-hour horizon by about
 * +18 bp, at 1.65 standard errors over 39 non-overlapping windows. The main
 * books cannot show whether that is real: the source is a small share of
 * their vote, their gates select on agreement, and their exit is a +18 bp
 * target with a 24-hour limit. This book does only what that evidence
 * describes, so the lead is judged alone and with execution costs.
 *
 * Design:
 *   • Enter when the ledger records a fresh reading from the source for a
 *     traded asset, in the reading's direction, with a RESTING order at the
 *     reading's price. It fills only once the mark trades through that price
 *     by the asset's slippage allowance (restingFilled), at the maker fee;
 *     unfilled after the books' usual wait, it is cancelled.
 *   • Hold to the reading's horizon. No target, no stop, no flip.
 *   • Exit at that time as a market order at full cost: a time exit cannot rest.
 *   • One position per asset. Fixed stake at 1x, so the result is about the
 *     signal and not the sizing.
 *   • Rows only: no gates, no learning writes, no messages.
 *   • Same isolation as the other paper books: own portfolio id, own
 *     cron_state keys, simulationMode rows, settle-first close.
 *
 * The scope (source, horizon, assets) is fixed for the length of the test;
 * the review rule is in docs/_ops/TODO_LEAD_BOOK_2026-10-06.md.
 */

import { query } from '@/lib/db/postgres';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { createHedge } from '@/lib/db/hedges';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { simulateOpen, simulateClose, restingFilled, type Side, type SimulatedPosition } from './simulated-executor';
import { PAPER_RESTING_ENTRY_WAIT_MIN } from './config';

export const LEAD_PORTFOLIO_ID = -7;
// isPaperHedge() recognises this chain, which keeps the rows out of live accounting.
const CHAIN = 'hedera-testnet';

const env = (name: string, fallback: string) => (process.env[name] || '').trim() || fallback;
const SOURCE_LIKE = env('LEAD_TRADER_SOURCE_LIKE', '%kalshi%');
const HOLD_MIN = Number(env('LEAD_TRADER_HOLD_MIN', '240'));
const ASSETS = env('LEAD_TRADER_ASSETS', 'BTC,ETH').split(',').map((a) => a.trim().toUpperCase()).filter(Boolean);
const STAKE_USD = Number(env('LEAD_TRADER_STAKE_USD', '1000'));
const LEVERAGE = 1;
// A reading's price is the price when it was recorded. Resting an order at a
// stale price is a different trade, so only readings from the last few
// minutes qualify; after downtime the watermark still moves past the rest.
const MAX_READING_AGE_MS = Number(env('LEAD_TRADER_MAX_READING_AGE_MIN', '5')) * 60_000;
const DISABLED = /^(1|true|yes|on)$/i.test(env('LEAD_TRADER_DISABLE', ''));

const KEY_POSITIONS = 'lead-trader:active-positions';
const KEY_RESTING = 'lead-trader:resting-entries';
const KEY_WATERMARK = 'lead-trader:reading-watermark';
const KEY_STATS = 'lead-trader:stats';

interface LeadPosition {
  orderId: string;
  position: SimulatedPosition;
  closeAtMs: number;
  source: string;
}

interface RestingLeadEntry {
  asset: string;
  side: Side;
  limitPrice: number;
  /** When the reading was taken; the hold is measured from here, as on the ledger. */
  readingAtMs: number;
  expiresAtMs: number;
  source: string;
}

interface LeadStats {
  trades: number;
  wins: number;
  cumRealizedUsd: number;
  placed: number;
  filled: number;
}

export interface LeadReading {
  source: string;
  asset: string;
  direction: string;
  entry_price: number;
  /** Epoch ms the reading was taken: window_end_time - horizon. Never observed_at, which is local wall clock. */
  reading_at_ms: number;
}

/**
 * Pure selection — exported for tests. Newest usable reading per asset, for
 * assets the book trades and is not already in (open or resting).
 */
export function selectLeadEntries(
  readings: LeadReading[],
  now: number,
  busyAssets: Set<string>,
): Array<{ reading: LeadReading; side: Side }> {
  const byAsset = new Map<string, { reading: LeadReading; side: Side }>();
  for (const reading of readings) {
    const asset = (reading.asset || '').toUpperCase();
    if (!ASSETS.includes(asset) || busyAssets.has(asset)) continue;
    const side: Side | null = reading.direction === 'UP' ? 'LONG' : reading.direction === 'DOWN' ? 'SHORT' : null;
    if (!side) continue;
    if (!Number.isFinite(reading.entry_price) || reading.entry_price <= 0) continue;
    const age = now - reading.reading_at_ms;
    if (!Number.isFinite(age) || age < 0 || age > MAX_READING_AGE_MS) continue;
    const held = byAsset.get(asset);
    if (!held || reading.reading_at_ms > held.reading.reading_at_ms) byAsset.set(asset, { reading: { ...reading, asset }, side });
  }
  return [...byAsset.values()];
}

export interface LeadTickSummary {
  placed: number;
  filled: number;
  cancelled: number;
  closed: number;
  active: number;
  resting: number;
}

async function markPrice(asset: string): Promise<number | null> {
  const { getMultiSourceValidatedPrice } = await import('@/lib/services/market-data/unified-price-provider');
  const v = await getMultiSourceValidatedPrice(asset, { minSources: 2, maxDeviationPercent: 2, timeout: 8000 });
  return v.price && v.price > 0 ? v.price : null;
}

const emptyStats = (): LeadStats => ({ trades: 0, wins: 0, cumRealizedUsd: 0, placed: 0, filled: 0 });

export class LeadTrader {
  static async runTick(now: number = Date.now()): Promise<LeadTickSummary> {
    const summary: LeadTickSummary = { placed: 0, filled: 0, cancelled: 0, closed: 0, active: 0, resting: 0 };
    if (DISABLED) return summary;

    let positions = ((await getCronState<LeadPosition[]>(KEY_POSITIONS)) ?? []).filter(Boolean);
    let resting = ((await getCronState<RestingLeadEntry[]>(KEY_RESTING)) ?? []).filter(Boolean);
    const stats = { ...emptyStats(), ...((await getCronState<LeadStats>(KEY_STATS)) ?? {}) };
    let statsChanged = false;

    // ── Close: horizon reached → market order at the validated mark ──
    for (const pos of positions.filter((p) => now >= p.closeAtMs)) {
      try {
        const price = await markPrice(pos.position.asset);
        if (!price) continue; // no trustworthy price this tick: try again next tick
        const result = simulateClose(pos.position, price, now);
        const { settleHedgeRow } = await import('./close-pipeline');
        const settled = await settleHedgeRow({
          orderId: pos.orderId,
          pos: pos.position,
          result,
          reason: 'horizon-expiry',
          analytics: false,
          extraMeta: { source: pos.source, holdMin: HOLD_MIN, execution: 'resting-entry' },
        });
        positions = positions.filter((p) => p.orderId !== pos.orderId);
        if (settled === false) continue; // another tick already closed it: count nothing
        stats.trades += 1;
        if (result.realizedPnlUsd > 0) stats.wins += 1;
        stats.cumRealizedUsd += result.realizedPnlUsd;
        statsChanged = true;
        summary.closed += 1;
      } catch (e) {
        logger.warn('[LeadTrader] close failed (retry next tick)', { orderId: pos.orderId, error: errMsg(e) });
      }
    }

    // ── Resting entries: filled, still waiting, or lapsed ──
    const stillResting: RestingLeadEntry[] = [];
    for (const entry of resting) {
      if (now >= entry.expiresAtMs) {
        summary.cancelled += 1;
        continue;
      }
      let mark: number | null = null;
      try {
        mark = await markPrice(entry.asset);
      } catch {
        mark = null;
      }
      if (!mark || !restingFilled(entry.side === 'LONG' ? 'buy' : 'sell', entry.limitPrice, mark, entry.asset)) {
        stillResting.push(entry);
        continue;
      }
      const position = simulateOpen(
        { asset: entry.asset, side: entry.side, notionalUsd: STAKE_USD * LEVERAGE, leverage: LEVERAGE, entryPrice: entry.limitPrice, resting: true },
        now,
      );
      const orderId = `lead_${entry.asset}_${Math.floor(entry.readingAtMs / 1000)}`;
      try {
        await createHedge({
          orderId,
          portfolioId: LEAD_PORTFOLIO_ID,
          asset: entry.asset,
          market: `${entry.asset}-PERP`,
          side: entry.side,
          size: position.size,
          notionalValue: position.notionalUsd,
          leverage: LEVERAGE,
          entryPrice: entry.limitPrice,
          simulationMode: true,
          reason: `lead: ${entry.source.slice(0, 60)} | hold ${HOLD_MIN}min | resting entry`,
          predictionMarket: 'signal-ledger',
          chain: CHAIN,
        });
        positions.push({ orderId, position, closeAtMs: entry.readingAtMs + HOLD_MIN * 60_000, source: entry.source });
        stats.filled += 1;
        statsChanged = true;
        summary.filled += 1;
      } catch (e) {
        // The order is gone either way: a row that could not be written must not become an untracked position.
        logger.warn('[LeadTrader] open failed (entry dropped)', { orderId, error: errMsg(e) });
      }
    }
    resting = stillResting;

    // ── New readings since the watermark ──
    try {
      const watermark = Number((await getCronState<number>(KEY_WATERMARK)) ?? 0) || now - MAX_READING_AGE_MS;
      const rows = await query<LeadReading>(
        `SELECT source, asset, direction, entry_price::float8 AS entry_price,
                (window_end_time - horizon_min * 60000)::float8 AS reading_at_ms
         FROM signal_outcomes
         WHERE source LIKE $1 AND horizon_min = $2
           AND (window_end_time - horizon_min * 60000) > $3
         ORDER BY window_end_time ASC
         LIMIT 50`,
        [SOURCE_LIKE, HOLD_MIN, watermark],
      );
      if (rows.length > 0) {
        // The watermark moves over everything scanned, used or not, so the scan stays small.
        await setCronState(KEY_WATERMARK, Math.max(...rows.map((r) => Number(r.reading_at_ms))));
        const busy = new Set<string>([...positions.map((p) => p.position.asset), ...resting.map((r) => r.asset)]);
        for (const { reading, side } of selectLeadEntries(rows, now, busy)) {
          resting.push({
            asset: reading.asset,
            side,
            limitPrice: reading.entry_price,
            readingAtMs: reading.reading_at_ms,
            expiresAtMs: now + PAPER_RESTING_ENTRY_WAIT_MIN * 60_000,
            source: reading.source,
          });
          stats.placed += 1;
          statsChanged = true;
          summary.placed += 1;
        }
      }
    } catch (e) {
      logger.warn('[LeadTrader] reading scan failed (non-fatal)', { error: errMsg(e) });
    }

    await setCronState(KEY_POSITIONS, positions);
    await setCronState(KEY_RESTING, resting);
    if (statsChanged) await setCronState(KEY_STATS, stats);

    summary.active = positions.length;
    summary.resting = resting.length;
    if (summary.placed + summary.filled + summary.cancelled + summary.closed > 0) {
      logger.info('[LeadTrader] tick', { ...summary });
    }
    return summary;
  }
}
