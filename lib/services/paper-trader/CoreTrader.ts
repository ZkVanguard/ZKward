/**
 * CoreTrader — the floor rule with the trend filter, held as spot, with
 * interest on the cash (portfolio -11), at the user's request (2026-11-11).
 *
 * Rule: exposure is the floor rule's (3 × what the book holds above 90% of
 * its peak, floor-rule.ts), half per coin, and a coin is held only while
 * yesterday's close is above its 100-day average (TrendTrader's rule,
 * decided once a day after 00:05 UTC). The rest is cash, credited
 * CORE_RULE.cashApr a year.
 *
 * Why: replayed on daily BTC and ETH closes from 2021-11 to 2026-11, this had
 * the shallowest worst fall of the rules tried (8.8%) and made +29% with 4%
 * on the cash, against +22% for the cash alone and −17% for holding the
 * coins. In the last year, when the coins fell 40%, it made +2.8% against
 * +4.2% for the cash alone. Most of the return is the interest: the rule's
 * job is to add to it without giving the floor away.
 *
 * The interest is assumed, not earned: no pool lends its cash yet. It is kept
 * apart from the trading result (state.interestUsd) so each can be read.
 * Lots, rows and settling work as in the trend and floor books.
 */
import { query } from '@/lib/db/postgres';
import { getCronStateStrict, setCronState } from '@/lib/db/cron-state';
import { createHedge } from '@/lib/db/hedges';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { FLOOR_RULE, planFloorRebalance } from './floor-rule';
import { dailyCloses, decisionDay, spotClose, spotOpen, spotValue, trendOn, TREND_RULE } from './TrendTrader';
import type { SimulatedPosition } from './simulated-executor';

export const CORE_PORTFOLIO_ID = -11;
export const CORE_START_USD = 100_000;
/** Fixed for the length of the test, like the floor rule's settings. */
export const CORE_RULE = { cashApr: 0.04 } as const;
const ASSETS = ['BTC', 'ETH'] as const;
type Asset = (typeof ASSETS)[number];
const STATE_KEY = 'core-trader:state';
const CHAIN = 'hedera-testnet'; // isPaperHedge() recognises it, which keeps the rows out of live accounting
const YEAR_MS = 365 * 86_400_000;
const DISABLED = /^(1|true|yes|on)$/i.test((process.env.CORE_TRADER_DISABLE || '').trim());

export interface CoreState {
  startedAtMs: number;
  startPrices: Record<string, number>;
  /** Trading result plus interest: what the book is worth. */
  valueUsd: number;
  peakUsd: number;
  lowUsd: number;
  maxDrawdown: number;
  exposureUsd: number;
  /** Interest credited to the cash since the start. No row records it. */
  interestUsd: number;
  updatedAtMs: number;
  /** UTC day (YYYY-MM-DD) of the last trend decision. */
  decidedDay: string | null;
  trend: Record<string, { on: boolean; close: number; average: number }>;
}

export interface CoreTickSummary {
  bought: number;
  sold: number;
  lots: number;
  valueUsd: number;
  floorUsd: number;
  exposureUsd: number;
  interestUsd: number;
  decided?: string;
  skipped?: string;
}

/** Interest on `cashUsd` for `ms`. Ticks a minute apart compound it. */
export function interestFor(cashUsd: number, ms: number, apr: number = CORE_RULE.cashApr): number {
  return cashUsd > 0 && ms > 0 ? cashUsd * apr * (ms / YEAR_MS) : 0;
}

async function markPrice(asset: string): Promise<number | null> {
  const { getMultiSourceValidatedPrice } = await import('@/lib/services/market-data/unified-price-provider');
  const v = await getMultiSourceValidatedPrice(asset, { minSources: 2, maxDeviationPercent: 2, timeout: 8000 });
  return v.price && v.price > 0 ? v.price : null;
}

interface Lot { orderId: string; position: SimulatedPosition }

async function openLots(now: number): Promise<Lot[]> {
  const rows = await query<{ order_id: string; asset: string; entry: number; notional: number; held_ms: number }>(
    `SELECT order_id, asset, entry_price::float8 AS entry, notional_value::float8 AS notional,
            (EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) * 1000)::float8 AS held_ms
       FROM hedges WHERE portfolio_id = $1 AND status = 'active' ORDER BY created_at, order_id`,
    [CORE_PORTFOLIO_ID],
  );
  return rows.map((r) => ({ orderId: r.order_id, position: spotOpen(r.asset, Number(r.notional), Number(r.entry), now - Math.max(0, Number(r.held_ms) || 0)) }));
}

async function realizedUsd(sinceMs: number): Promise<number> {
  const rows = await query<{ realized: number }>(
    `SELECT COALESCE(SUM(realized_pnl), 0)::float8 AS realized FROM hedges
      WHERE portfolio_id = $1 AND status = 'closed' AND created_at >= to_timestamp($2 / 1000.0)`,
    [CORE_PORTFOLIO_ID, sinceMs],
  );
  const v = Number(rows[0]?.realized);
  if (!Number.isFinite(v)) throw new Error('realized P&L did not read as a number');
  return v;
}

export async function runCoreTick(now: number = Date.now(), closesOf: typeof dailyCloses = dailyCloses): Promise<CoreTickSummary> {
  const summary: CoreTickSummary = { bought: 0, sold: 0, lots: 0, valueUsd: 0, floorUsd: 0, exposureUsd: 0, interestUsd: 0 };
  if (DISABLED) return { ...summary, skipped: 'CORE_TRADER_DISABLE' };

  const marks: Partial<Record<Asset, number>> = {};
  for (const a of ASSETS) {
    const p = await markPrice(a).catch(() => null);
    if (!p) return { ...summary, skipped: `no validated ${a} price` };
    marks[a] = p;
  }

  // Strict: a store that did not answer must not look like a book that has not started.
  let state = await getCronStateStrict<CoreState>(STATE_KEY);
  if (!state) {
    state = {
      startedAtMs: now, startPrices: { ...marks } as Record<string, number>, valueUsd: CORE_START_USD, peakUsd: CORE_START_USD,
      lowUsd: CORE_START_USD, maxDrawdown: 0, exposureUsd: 0, interestUsd: 0, updatedAtMs: now, decidedDay: null, trend: {},
    };
  }

  let lots = await openLots(now);
  const heldUsd: Record<string, number> = {};
  for (const l of lots) heldUsd[l.position.asset] = (heldUsd[l.position.asset] ?? 0) + l.position.size * marks[l.position.asset as Asset]!;
  const tradedUsd = CORE_START_USD + (await realizedUsd(state.startedAtMs)) + lots.reduce((s, l) => s + spotValue(l.position, marks[l.position.asset as Asset]!), 0);
  const cashUsd = tradedUsd + state.interestUsd - Object.values(heldUsd).reduce((a, b) => a + b, 0);
  const interestUsd = state.interestUsd + interestFor(cashUsd, now - state.updatedAtMs);
  const valueUsd = tradedUsd + interestUsd;

  // ── the daily trend decision: both coins on their candles, or none ──
  const day = decisionDay(now);
  if (day && state.decidedDay !== day) {
    const next: CoreState['trend'] = {};
    let readable = true;
    for (const a of ASSETS) {
      try {
        const t = trendOn(await closesOf(a, TREND_RULE.averageDays, now));
        if (!t) { readable = false; break; }
        next[a] = t;
      } catch (e) {
        readable = false;
        logger.warn('[CoreTrader] daily candles unreadable; no decision until they are', { asset: a, error: errMsg(e) });
        break;
      }
    }
    if (readable) {
      state = { ...state, decidedDay: day, trend: next };
      summary.decided = ASSETS.map((a) => `${a} ${next[a].on ? 'ON' : 'off'} (${next[a].close.toFixed(0)} vs ${next[a].average.toFixed(0)})`).join(', ');
    }
  }

  // A coin is held on its trend, never by default: before the first decision nothing is.
  const holding = Object.fromEntries(ASSETS.map((a) => [a, state!.trend[a]?.on === true]));
  const plan = planFloorRebalance({ valueUsd, peakUsd: state.peakUsd, heldUsd, assets: ASSETS, holding });

  for (const a of ASSETS) {
    // Sells first, oldest lots first, settled before anything is counted.
    for (const lot of lots.filter((l) => l.position.asset === a).slice(0, Math.max(0, -plan.lots[a]))) {
      try {
        const { settleHedgeRow } = await import('./close-pipeline');
        const settled = await settleHedgeRow({
          orderId: lot.orderId, pos: lot.position, result: spotClose(lot.position, marks[a]!, now), reason: 'core-rebalance',
          analytics: false, extraMeta: { floorUsd: plan.floorUsd, bookValueUsd: valueUsd, trendOn: holding[a] },
        });
        lots = lots.filter((l) => l.orderId !== lot.orderId);
        if (settled === false) continue; // another tick already closed it: count nothing
        summary.sold += 1;
      } catch (e) {
        logger.warn('[CoreTrader] close failed (retry next tick)', { orderId: lot.orderId, error: errMsg(e) });
      }
    }
    for (let i = 0; i < plan.lots[a]; i++) {
      const position = spotOpen(a, FLOOR_RULE.lotUsd, marks[a]!, now);
      const orderId = `core_${a}_${Math.floor(now / 1000)}_${i}`;
      try {
        await createHedge({
          orderId, portfolioId: CORE_PORTFOLIO_ID, asset: a, market: `${a}-SPOT`, side: 'LONG', size: position.size,
          notionalValue: position.notionalUsd, leverage: 1, entryPrice: marks[a]!, simulationMode: true,
          reason: `core: book ${valueUsd.toFixed(0)} over floor ${plan.floorUsd.toFixed(0)}, ${a} above its ${TREND_RULE.averageDays}-day average`,
          chain: CHAIN,
        });
        lots.push({ orderId, position });
        summary.bought += 1;
      } catch (e) {
        // No row, no lot: the next tick reads the rows and buys what is still missing.
        logger.warn('[CoreTrader] open failed (lot not bought)', { orderId, error: errMsg(e) });
      }
    }
  }

  summary.lots = lots.length;
  summary.valueUsd = valueUsd;
  summary.floorUsd = plan.floorUsd;
  summary.interestUsd = interestUsd;
  summary.exposureUsd = lots.reduce((s, l) => s + l.position.size * marks[l.position.asset as Asset]!, 0);
  await setCronState<CoreState>(STATE_KEY, {
    ...state,
    valueUsd, peakUsd: plan.peakUsd, lowUsd: Math.min(state.lowUsd, valueUsd), maxDrawdown: Math.max(state.maxDrawdown, 1 - valueUsd / plan.peakUsd),
    exposureUsd: summary.exposureUsd, interestUsd, updatedAtMs: now,
  });
  if (summary.bought + summary.sold > 0 || summary.decided) logger.info('[CoreTrader] tick', summary);
  return summary;
}

export class CoreTrader {
  static runTick(now: number = Date.now()): Promise<CoreTickSummary> {
    return runCoreTick(now);
  }
}
