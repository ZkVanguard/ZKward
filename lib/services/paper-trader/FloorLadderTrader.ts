/**
 * FloorLadderTrader — the floor book's twin (portfolio -9).
 *
 * Same rule, same code, same lots as FloorTrader (-8); one difference: the
 * multiplier follows the move the prediction market prices for BTC and ETH
 * (the daily strike ladder, StrikeLadderService). When the market prices a
 * bigger move than normal the book holds less, when it prices a calm one it
 * holds more:
 *
 *   multiplier = 3 × (normal priced move ÷ today's priced move), kept within 1.5 to 4.5
 *
 * "Normal" is the median of the readings seen so far, today's included, so
 * nothing looks ahead; until 20 readings exist the multiplier stays at 3.
 * This is the variant replayed on 2026-10-13 (a small gain there). The two
 * books are compared on 2026-12-12 by the rule in
 * docs/_ops/TODO_POOL_FLOOR_STRATEGY_2026-10-19.md, phase 3.
 *
 * The ladder is read at most every 30 minutes. A failed read keeps the last
 * multiplier for up to 6 hours, then falls back to 3: an unread market is not
 * a calm one, and not a wild one either.
 */
import { FLOOR_RULE } from './floor-rule';
import { runFloorBook, type FloorBookConfig, type FloorTickSummary } from './FloorTrader';

export const FLOOR_LADDER_PORTFOLIO_ID = -9;
const DISABLED = /^(1|true|yes|on)$/i.test((process.env.FLOOR_LADDER_TRADER_DISABLE || '').trim());
const READ_EVERY_MS = 30 * 60_000;
const STALE_AFTER_MS = 6 * 60 * 60_000;
const MIN_HISTORY = 20;
const HISTORY_MAX = 500;

export interface LadderSizing {
  /** Priced moves seen so far (average of BTC and ETH, percent), oldest first. */
  history: number[];
  lastTryAtMs: number;
  lastOkAtMs: number;
  multiplier: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pure: the multiplier for a history of priced moves whose last entry is today's. */
export function ladderMultiplier(history: number[], base: number = FLOOR_RULE.multiplier): number {
  if (history.length < MIN_HISTORY) return base;
  const today = history[history.length - 1];
  if (!(today > 0)) return base;
  return Math.min(1.5 * base, Math.max(0.5 * base, (base * median(history)) / today));
}

/** The priced move for BTC and ETH, averaged; null when either ladder cannot be read. */
async function readPricedMove(): Promise<number | null> {
  const { getExpectedMove } = await import('@/lib/services/market-data/StrikeLadderService');
  const [btc, eth] = await Promise.all([getExpectedMove('BTC'), getExpectedMove('ETH')].map((p) => p.catch(() => null)));
  if (!btc || !eth || !(btc.movePct > 0) || !(eth.movePct > 0)) return null;
  return (btc.movePct + eth.movePct) / 2;
}

/** Pure apart from the ladder read: the sizing step the twin runs each tick. */
export async function ladderSizing(
  stored: Record<string, unknown> | undefined,
  now: number,
  read: () => Promise<number | null> = readPricedMove,
): Promise<{ multiplier: number; sizing: Record<string, unknown> }> {
  const prev: LadderSizing = {
    history: Array.isArray(stored?.history) ? (stored!.history as number[]).filter((x) => x > 0) : [],
    lastTryAtMs: Number(stored?.lastTryAtMs) || 0,
    lastOkAtMs: Number(stored?.lastOkAtMs) || 0,
    multiplier: Number(stored?.multiplier) || FLOOR_RULE.multiplier,
  };
  let next = prev;
  if (now - prev.lastTryAtMs >= READ_EVERY_MS) {
    const move = await read().catch(() => null);
    if (move !== null) {
      const history = [...prev.history, move].slice(-HISTORY_MAX);
      next = { history, lastTryAtMs: now, lastOkAtMs: now, multiplier: ladderMultiplier(history) };
    } else {
      next = { ...prev, lastTryAtMs: now };
    }
  }
  const multiplier = now - next.lastOkAtMs <= STALE_AFTER_MS ? next.multiplier : FLOOR_RULE.multiplier;
  return { multiplier, sizing: next as unknown as Record<string, unknown> };
}

const TWIN: FloorBookConfig = {
  portfolioId: FLOOR_LADDER_PORTFOLIO_ID,
  stateKey: 'floor-ladder-trader:state',
  orderPrefix: 'floorladder',
  disabled: DISABLED,
  sizing: (stored, now) => ladderSizing(stored, now),
};

export class FloorLadderTrader {
  static runTick(now: number = Date.now()): Promise<FloorTickSummary> {
    return runFloorBook(TWIN, now);
  }
}
