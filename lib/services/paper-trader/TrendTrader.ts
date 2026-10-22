/**
 * TrendTrader — a slow trend rule on paper (portfolio -10), next to the floor
 * books, at the user's choice (2026-10-22).
 *
 * Rule: once a day, after the daily candle closes (00:05 UTC), each coin is ON
 * when yesterday's close is above the average of its last 100 daily closes.
 * An ON coin holds 12.5% of the book (half of 25%), in $1,000 lots; an OFF coin
 * holds nothing; the rest of the book is USDC. Between decisions the lots stay
 * as they are.
 *
 * Why this rule: it is the first one tested here that held on data its
 * settings never saw (docs/_ops/AUDIT_PAPER_2026-10-22.md). With the average
 * length picked on 2018-2022, every length from 20 to 200 days cut the worst
 * fall on 2023 → 2026-10; half BTC, half ETH at 25% of the book made +13% over
 * the two years to 2026-10 with a worst fall of 9%, against +4% and 10.6% for
 * the floor rule. It is a long-known public rule, judged on one history.
 *
 * Held as spot: 10 bp a side, no funding. Its review is fixed in
 * docs/_ops/TODO_POOL_FLOOR_STRATEGY_2026-10-19.md, item 3.6.
 */
import { query } from '@/lib/db/postgres';
import { getCronStateStrict, setCronState } from '@/lib/db/cron-state';
import { createHedge } from '@/lib/db/hedges';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { SPOT_FEE_BPS_PER_SIDE, computeGrossPnl, type SimulatedCloseResult, type SimulatedPosition } from './simulated-executor';

export const TREND_PORTFOLIO_ID = -10;
export const TREND_START_USD = 100_000;
export const TREND_RULE = { averageDays: 100, shareOfBook: 0.25, lotUsd: 1000 } as const;
const ASSETS = ['BTC', 'ETH'] as const;
type Asset = (typeof ASSETS)[number];
const STATE_KEY = 'trend-trader:state';
const CHAIN = 'hedera-testnet'; // isPaperHedge() recognises it, which keeps the rows out of live accounting
const DAY_MS = 86_400_000;
const DECIDE_AFTER_MS = 5 * 60_000; // past 00:00 UTC, so yesterday's candle has closed
const DISABLED = /^(1|true|yes|on)$/i.test((process.env.TREND_TRADER_DISABLE || '').trim());

export interface TrendState {
  startedAtMs: number;
  startPrices: Record<string, number>;
  valueUsd: number;
  peakUsd: number;
  lowUsd: number;
  maxDrawdown: number;
  exposureUsd: number;
  updatedAtMs: number;
  /** UTC day (YYYY-MM-DD) of the last decision. */
  decidedDay: string | null;
  /** What the last decision saw and wanted, per coin. */
  trend: Record<string, { on: boolean; close: number; average: number; lots: number }>;
}

export interface TrendTickSummary {
  bought: number;
  sold: number;
  lots: number;
  valueUsd: number;
  exposureUsd: number;
  decided?: string;
  skipped?: string;
}

// ── pure rule ──

/** ON when the last close is above the average of the last `days` closes (the last included), as replayed. */
export function trendOn(closes: number[], days: number = TREND_RULE.averageDays): { on: boolean; close: number; average: number } | null {
  if (closes.length < days || closes.slice(-days).some((c) => !(c > 0))) return null;
  const window = closes.slice(-days);
  const average = window.reduce((a, b) => a + b, 0) / days;
  const close = closes[closes.length - 1];
  return { on: close > average, close, average };
}

/** Lots a coin should hold: its half of the book's share when ON, none when OFF. */
export function targetLots(on: boolean, bookValueUsd: number): number {
  // Rounded down, so a coin never holds more than its share.
  return on ? Math.floor((TREND_RULE.shareOfBook * bookValueUsd) / ASSETS.length / TREND_RULE.lotUsd) : 0;
}

/** The UTC day whose close a decision at `now` uses: yesterday's, once the 00:05 UTC margin has passed. */
export function decisionDay(now: number): string | null {
  const sinceMidnight = now % DAY_MS;
  if (sinceMidnight < DECIDE_AFTER_MS) return null;
  return new Date(now - DAY_MS).toISOString().slice(0, 10);
}

/** Spot lot: 10 bp on the way in, 10 bp on the way out, no funding. */
export function spotOpen(asset: string, notionalUsd: number, price: number, now: number): SimulatedPosition {
  return { asset, side: 'LONG', entryPrice: price, size: notionalUsd / price, notionalUsd, leverage: 1, openedAt: now, openFeeUsd: notionalUsd * (SPOT_FEE_BPS_PER_SIDE / 10_000), slippageOpenUsd: 0 };
}

export function spotValue(pos: SimulatedPosition, mark: number): number {
  return computeGrossPnl('LONG', pos.entryPrice, mark, pos.notionalUsd) - pos.openFeeUsd;
}

export function spotClose(pos: SimulatedPosition, exitPrice: number, now: number): SimulatedCloseResult {
  const grossPnlUsd = computeGrossPnl('LONG', pos.entryPrice, exitPrice, pos.notionalUsd);
  const closeFeeUsd = pos.notionalUsd * (SPOT_FEE_BPS_PER_SIDE / 10_000);
  return {
    asset: pos.asset, side: 'LONG', entryPrice: pos.entryPrice, exitPrice, notionalUsd: pos.notionalUsd, size: pos.size,
    holdSeconds: Math.round(Math.max(0, now - pos.openedAt) / 1000), grossPnlUsd, openFeeUsd: pos.openFeeUsd, closeFeeUsd,
    slippageUsd: 0, fundingUsd: 0, realizedPnlUsd: grossPnlUsd - pos.openFeeUsd - closeFeeUsd,
  };
}

// ── reads ──

/** Closed daily closes, oldest first, from a large exchange's public candles. Throws on a failed read. */
export async function dailyCloses(asset: string, days: number, now: number): Promise<number[]> {
  const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${asset}USDT&interval=1d&limit=${days + 2}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`daily candles ${asset}: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<[number, string, string, string, string, string, number]>;
  if (!Array.isArray(rows)) throw new Error(`daily candles ${asset}: not a list`);
  return rows.filter((k) => Number(k[6]) < now).map((k) => Number(k[4]));
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
    [TREND_PORTFOLIO_ID],
  );
  return rows.map((r) => ({ orderId: r.order_id, position: spotOpen(r.asset, Number(r.notional), Number(r.entry), now - Math.max(0, Number(r.held_ms) || 0)) }));
}

async function realizedUsd(sinceMs: number): Promise<number> {
  const rows = await query<{ realized: number }>(
    `SELECT COALESCE(SUM(realized_pnl), 0)::float8 AS realized FROM hedges
      WHERE portfolio_id = $1 AND status = 'closed' AND created_at >= to_timestamp($2 / 1000.0)`,
    [TREND_PORTFOLIO_ID, sinceMs],
  );
  const v = Number(rows[0]?.realized);
  if (!Number.isFinite(v)) throw new Error('realized P&L did not read as a number');
  return v;
}

// ── one tick ──

export async function runTrendTick(now: number = Date.now(), closesOf: typeof dailyCloses = dailyCloses): Promise<TrendTickSummary> {
  const summary: TrendTickSummary = { bought: 0, sold: 0, lots: 0, valueUsd: 0, exposureUsd: 0 };
  if (DISABLED) return { ...summary, skipped: 'TREND_TRADER_DISABLE' };

  const marks: Partial<Record<Asset, number>> = {};
  for (const a of ASSETS) {
    const p = await markPrice(a).catch(() => null);
    if (!p) return { ...summary, skipped: `no validated ${a} price` };
    marks[a] = p;
  }

  let state = await getCronStateStrict<TrendState>(STATE_KEY);
  if (!state) {
    state = {
      startedAtMs: now, startPrices: { ...marks } as Record<string, number>, valueUsd: TREND_START_USD, peakUsd: TREND_START_USD,
      lowUsd: TREND_START_USD, maxDrawdown: 0, exposureUsd: 0, updatedAtMs: now, decidedDay: null, trend: {},
    };
  }

  let lots = await openLots(now);
  const valueUsd = TREND_START_USD + (await realizedUsd(state.startedAtMs)) + lots.reduce((s, l) => s + spotValue(l.position, marks[l.position.asset as Asset]!), 0);

  // ── the daily decision ──
  const day = decisionDay(now);
  if (day && state.decidedDay !== day) {
    const next: TrendState['trend'] = {};
    let readable = true;
    for (const a of ASSETS) {
      try {
        const t = trendOn(await closesOf(a, TREND_RULE.averageDays, now));
        if (!t) { readable = false; break; }
        next[a] = { ...t, lots: targetLots(t.on, valueUsd) };
      } catch (e) {
        readable = false;
        logger.warn('[TrendTrader] daily candles unreadable; no decision until they are', { asset: a, error: errMsg(e) });
        break;
      }
    }
    // No partial decision: either both coins are decided on their candles or the lots stay as they are.
    if (readable) {
      state = { ...state, decidedDay: day, trend: next };
      summary.decided = ASSETS.map((a) => `${a} ${next[a].on ? 'ON' : 'off'} (${next[a].close.toFixed(0)} vs ${next[a].average.toFixed(0)}) → ${next[a].lots} lots`).join(', ');
    }
  }

  // ── keep the lots at the decision's target: sells settle before anything is counted; a failed buy retries next tick ──
  for (const a of ASSETS) {
    const want = state.trend[a]?.lots ?? 0;
    const held = lots.filter((l) => l.position.asset === a);
    for (const lot of held.slice(0, Math.max(0, held.length - want))) {
      try {
        const { settleHedgeRow } = await import('./close-pipeline');
        const settled = await settleHedgeRow({ orderId: lot.orderId, pos: lot.position, result: spotClose(lot.position, marks[a]!, now), reason: 'trend-off', analytics: false, extraMeta: { bookValueUsd: valueUsd } });
        lots = lots.filter((l) => l.orderId !== lot.orderId);
        if (settled === false) continue;
        summary.sold += 1;
      } catch (e) {
        logger.warn('[TrendTrader] close failed (retry next tick)', { orderId: lot.orderId, error: errMsg(e) });
      }
    }
    for (let i = held.length; i < want; i++) {
      const position = spotOpen(a, TREND_RULE.lotUsd, marks[a]!, now);
      const orderId = `trend_${a}_${Math.floor(now / 1000)}_${i}`;
      try {
        await createHedge({
          orderId, portfolioId: TREND_PORTFOLIO_ID, asset: a, market: `${a}-SPOT`, side: 'LONG', size: position.size,
          notionalValue: position.notionalUsd, leverage: 1, entryPrice: marks[a]!, simulationMode: true,
          reason: `trend: ${a} ${state.trend[a]?.close.toFixed(0)} above its ${TREND_RULE.averageDays}-day average ${state.trend[a]?.average.toFixed(0)}`,
          chain: CHAIN,
        });
        lots.push({ orderId, position });
        summary.bought += 1;
      } catch (e) {
        logger.warn('[TrendTrader] open failed (lot not bought)', { orderId, error: errMsg(e) });
      }
    }
  }

  summary.lots = lots.length;
  summary.valueUsd = valueUsd;
  summary.exposureUsd = lots.reduce((s, l) => s + l.position.size * marks[l.position.asset as Asset]!, 0);
  const peakUsd = Math.max(state.peakUsd, valueUsd);
  await setCronState<TrendState>(STATE_KEY, {
    ...state,
    valueUsd, peakUsd, lowUsd: Math.min(state.lowUsd, valueUsd), maxDrawdown: Math.max(state.maxDrawdown, 1 - valueUsd / peakUsd),
    exposureUsd: summary.exposureUsd, updatedAtMs: now,
  });
  if (summary.bought + summary.sold > 0 || summary.decided) logger.info('[TrendTrader] tick', summary);
  return summary;
}

export class TrendTrader {
  static runTick(now: number = Date.now()): Promise<TrendTickSummary> {
    return runTrendTick(now);
  }
}
