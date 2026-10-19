/**
 * FloorTrader — paper book that holds BTC and ETH by the floor rule
 * (portfolio -8).
 *
 * Why it exists: the pool's promise is a deposit that does not fall and that
 * grows when the market does. Nothing on the signal ledger tells direction,
 * so a book cannot keep that promise by forecasting. This one keeps it by
 * limiting what is ever exposed (floor-rule.ts), and runs on live prices so
 * the rule is judged on what it did, with execution costs, before any pool
 * follows it.
 *
 * Design:
 *   • Long only, at 1x, split equally across the assets, in whole lots. Each
 *     lot is one hedges row, opened and closed as a market order through the
 *     simulated executor, so every figure is net of fees, slippage and
 *     funding.
 *   • The book's value is read from its rows on every tick: the starting
 *     value, plus what closed lots realized, plus open lots at the validated
 *     mark. Only what no row holds (the peak, the session's extremes) lives
 *     in cron_state.
 *   • A tick without its state, its rows or a trustworthy price for every
 *     asset does nothing. A missing figure is never read as zero: a book
 *     priced at zero would sell everything.
 *   • Sells run before buys and settle the row first; a lot another tick
 *     already closed is not sold again.
 *   • Rows only: no signal, no gates, no learning writes, no messages.
 *   • Same isolation as the other paper books: own portfolio id, own
 *     cron_state key, simulationMode rows.
 *
 * The tick is runFloorBook(config), so a twin book can run the same rule with
 * a different multiplier (FloorLadderTrader.ts, portfolio -9). This book's
 * config is fixed: multiplier 3, as replayed.
 */

import { query } from '@/lib/db/postgres';
import { getCronStateStrict, setCronState } from '@/lib/db/cron-state';
import { createHedge } from '@/lib/db/hedges';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { simulateOpen, simulateClose, markToMarket, type SimulatedPosition } from './simulated-executor';
import { FLOOR_RULE, planFloorRebalance } from './floor-rule';

export const FLOOR_PORTFOLIO_ID = -8;
export const FLOOR_START_USD = 100_000;
// isPaperHedge() recognises this chain, which keeps the rows out of live accounting.
const CHAIN = 'hedera-testnet';
const ASSETS = ['BTC', 'ETH'] as const;
const DISABLED = /^(1|true|yes|on)$/i.test((process.env.FLOOR_TRADER_DISABLE || '').trim());

/** What makes one floor book differ from another: everything else is the same rule and the same code. */
export interface FloorBookConfig {
  portfolioId: number;
  stateKey: string;
  orderPrefix: string;
  disabled: boolean;
  /** The multiplier for this tick, and what the book keeps to choose it next time (stored in its state). */
  sizing(stored: Record<string, unknown> | undefined, now: number): Promise<{ multiplier: number; sizing?: Record<string, unknown> }>;
}

const PLAIN: FloorBookConfig = {
  portfolioId: FLOOR_PORTFOLIO_ID,
  stateKey: 'floor-trader:state',
  orderPrefix: 'floor',
  disabled: DISABLED,
  sizing: async () => ({ multiplier: FLOOR_RULE.multiplier }),
};

interface FloorState {
  startedAtMs: number;
  /** Highest value the book has reached; the floor is a share of it. */
  peakUsd: number;
  /** Lowest value and deepest fall from a peak. The marks they come from are stored nowhere else. */
  lowUsd: number;
  maxDrawdown: number;
  /** Marks when the book started, so its result can be set against simply holding the coins. */
  startPrices: Record<string, number>;
  valueUsd: number;
  exposureUsd: number;
  updatedAtMs: number;
  /** The book's own sizing memory (the twin's ladder readings); absent for the plain book. */
  sizing?: Record<string, unknown>;
  /** The multiplier the last tick used. */
  multiplier?: number;
}

interface Lot {
  orderId: string;
  position: SimulatedPosition;
}

export interface FloorTickSummary {
  bought: number;
  sold: number;
  lots: number;
  valueUsd: number;
  floorUsd: number;
  exposureUsd: number;
  /** Why the tick did nothing, when it did nothing. */
  skipped?: string;
}

async function markPrice(asset: string): Promise<number | null> {
  const { getMultiSourceValidatedPrice } = await import('@/lib/services/market-data/unified-price-provider');
  const v = await getMultiSourceValidatedPrice(asset, { minSources: 2, maxDeviationPercent: 2, timeout: 8000 });
  return v.price && v.price > 0 ? v.price : null;
}

/** Open lots, oldest first. The position is rebuilt from the row, so the row is the only record a lot needs. */
async function openLots(portfolioId: number, now: number): Promise<Lot[]> {
  const rows = await query<{ order_id: string; asset: string; entry: number; notional: number; held_ms: number }>(
    // Age is a difference of two database clocks: created_at is the server's local wall time, not UTC.
    `SELECT order_id, asset, entry_price::float8 AS entry, notional_value::float8 AS notional,
            (EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) * 1000)::float8 AS held_ms
       FROM hedges
      WHERE portfolio_id = $1 AND status = 'active'
      ORDER BY created_at, order_id`,
    [portfolioId],
  );
  return rows.map((r) => ({
    orderId: r.order_id,
    position: simulateOpen(
      { asset: r.asset, side: 'LONG', notionalUsd: Number(r.notional), leverage: 1, entryPrice: Number(r.entry) },
      now - Math.max(0, Number(r.held_ms) || 0),
    ),
  }));
}

async function realizedUsd(portfolioId: number, sinceMs: number): Promise<number> {
  const rows = await query<{ realized: number }>(
    `SELECT COALESCE(SUM(realized_pnl), 0)::float8 AS realized
       FROM hedges
      WHERE portfolio_id = $1 AND status = 'closed' AND created_at >= to_timestamp($2 / 1000.0)`,
    [portfolioId, sinceMs],
  );
  const realized = Number(rows[0]?.realized);
  if (!Number.isFinite(realized)) throw new Error('realized P&L did not read as a number');
  return realized;
}

/** One tick of a floor book. */
export async function runFloorBook(cfg: FloorBookConfig, now: number = Date.now()): Promise<FloorTickSummary> {
    const summary: FloorTickSummary = { bought: 0, sold: 0, lots: 0, valueUsd: 0, floorUsd: 0, exposureUsd: 0 };
    if (cfg.disabled) return { ...summary, skipped: 'disabled' };

    const marks: Record<string, number> = {};
    for (const asset of ASSETS) {
      const price = await markPrice(asset).catch(() => null);
      if (!price) return { ...summary, skipped: `no price for ${asset}` };
      marks[asset] = price;
    }

    // Strict: a store that did not answer must not look like a book that has not started.
    const stored = await getCronStateStrict<FloorState>(cfg.stateKey);
    const state: FloorState = stored ?? {
      startedAtMs: now,
      peakUsd: FLOOR_START_USD,
      lowUsd: FLOOR_START_USD,
      maxDrawdown: 0,
      startPrices: { ...marks },
      valueUsd: FLOOR_START_USD,
      exposureUsd: 0,
      updatedAtMs: now,
    };

    let lots = await openLots(cfg.portfolioId, now);
    const valueUsd =
      FLOOR_START_USD +
      (await realizedUsd(cfg.portfolioId, state.startedAtMs)) +
      lots.reduce((sum, l) => sum + markToMarket(l.position, marks[l.position.asset], now).unrealizedPnlUsd, 0);
    const heldUsd: Record<string, number> = {};
    for (const l of lots) heldUsd[l.position.asset] = (heldUsd[l.position.asset] ?? 0) + l.position.size * marks[l.position.asset];

    const { multiplier, sizing } = await cfg.sizing(state.sizing, now);
    const plan = planFloorRebalance({ valueUsd, peakUsd: state.peakUsd, heldUsd, assets: ASSETS, rule: { ...FLOOR_RULE, multiplier } });

    // ── Sell: oldest lots first, settled before anything is counted ──
    for (const asset of ASSETS) {
      const selling = lots.filter((l) => l.position.asset === asset).slice(0, Math.max(0, -plan.lots[asset]));
      for (const lot of selling) {
        try {
          const result = simulateClose(lot.position, marks[asset], now);
          const { settleHedgeRow } = await import('./close-pipeline');
          const settled = await settleHedgeRow({
            orderId: lot.orderId,
            pos: lot.position,
            result,
            reason: 'floor-rebalance',
            analytics: false,
            extraMeta: { floorUsd: plan.floorUsd, bookValueUsd: valueUsd },
          });
          lots = lots.filter((l) => l.orderId !== lot.orderId);
          if (settled === false) continue; // another tick already closed it: count nothing
          summary.sold += 1;
        } catch (e) {
          logger.warn('[FloorTrader] close failed (retry next tick)', { orderId: lot.orderId, error: errMsg(e) });
        }
      }
    }

    // ── Buy: one row per lot at the validated mark ──
    for (const asset of ASSETS) {
      for (let i = 0; i < plan.lots[asset]; i++) {
        const position = simulateOpen(
          { asset, side: 'LONG', notionalUsd: FLOOR_RULE.lotUsd, leverage: 1, entryPrice: marks[asset] },
          now,
        );
        const orderId = `${cfg.orderPrefix}_${asset}_${Math.floor(now / 1000)}_${i}`;
        try {
          await createHedge({
            orderId,
            portfolioId: cfg.portfolioId,
            asset,
            market: `${asset}-PERP`,
            side: 'LONG',
            size: position.size,
            notionalValue: position.notionalUsd,
            leverage: 1,
            entryPrice: marks[asset],
            simulationMode: true,
            reason: `floor: book ${valueUsd.toFixed(0)} over floor ${plan.floorUsd.toFixed(0)}`,
            chain: CHAIN,
          });
          lots.push({ orderId, position });
          summary.bought += 1;
        } catch (e) {
          // No row, no lot: the next tick reads the rows and buys what is still missing.
          logger.warn('[FloorTrader] open failed (lot not bought)', { orderId, error: errMsg(e) });
        }
      }
    }

    summary.lots = lots.length;
    summary.valueUsd = valueUsd;
    summary.floorUsd = plan.floorUsd;
    summary.exposureUsd = lots.reduce((sum, l) => sum + l.position.size * marks[l.position.asset], 0);

    await setCronState<FloorState>(cfg.stateKey, {
      ...state,
      ...(sizing ? { sizing } : {}),
      multiplier,
      peakUsd: plan.peakUsd,
      lowUsd: Math.min(state.lowUsd, valueUsd),
      maxDrawdown: Math.max(state.maxDrawdown, 1 - valueUsd / plan.peakUsd),
      valueUsd,
      exposureUsd: summary.exposureUsd,
      updatedAtMs: now,
    });

    if (summary.bought + summary.sold > 0) logger.info('[FloorTrader] tick', { book: cfg.portfolioId, multiplier, ...summary });
    return summary;
}

export class FloorTrader {
  static runTick(now: number = Date.now()): Promise<FloorTickSummary> {
    return runFloorBook(PLAIN, now);
  }
}
