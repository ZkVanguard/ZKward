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
 * Every reading is the move priced over one day (movePerDay). "Normal" is the
 * median of the readings seen so far, today's included, so nothing looks
 * ahead; until 20 readings exist the multiplier stays at 3.
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
  /** Priced one-day moves seen so far (average of BTC and ETH, percent), oldest first. */
  dayMoves: number[];
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

/**
 * A ladder prices the move from now until it resolves, which grows with the
 * square root of the time left. The nearest readable ladder is 12 to 84 hours
 * out, so read raw the figure shrank through each day and jumped when the next
 * ladder took over: the multiplier followed the clock, and the book bought
 * lots each day and sold them at the roll. The replay read every ladder at
 * one lead; scaling each reading to one day does the same at any lead. Null
 * when it cannot be scaled.
 */
export function movePerDay(movePct: number, resolvesAtMs: number, now: number): number | null {
  const hours = (resolvesAtMs - now) / 3_600_000;
  return movePct > 0 && hours > 0 ? movePct * Math.sqrt(24 / hours) : null;
}

/** The one-day priced move for BTC and ETH, averaged; null when either ladder cannot be read. */
async function readPricedMove(now: number): Promise<number | null> {
  const { getExpectedMove } = await import('@/lib/services/market-data/StrikeLadderService');
  const [btc, eth] = await Promise.all(
    ['BTC', 'ETH'].map((a) =>
      getExpectedMove(a, now).then((m) => movePerDay(m.movePct, Date.parse(m.resolvesAt), now), () => null),
    ),
  );
  return btc !== null && eth !== null ? (btc + eth) / 2 : null;
}

/** Pure apart from the ladder read: the sizing step the twin runs each tick. */
export async function ladderSizing(
  stored: Record<string, unknown> | undefined,
  now: number,
  read: (now: number) => Promise<number | null> = readPricedMove,
): Promise<{ multiplier: number; sizing: Record<string, unknown> }> {
  const prev: LadderSizing = {
    // Readings stored before 2026-11-12 (`history`) were not scaled to one day and are left behind.
    dayMoves: Array.isArray(stored?.dayMoves) ? (stored!.dayMoves as number[]).filter((x) => x > 0) : [],
    lastTryAtMs: Number(stored?.lastTryAtMs) || 0,
    lastOkAtMs: Number(stored?.lastOkAtMs) || 0,
    multiplier: Number(stored?.multiplier) || FLOOR_RULE.multiplier,
  };
  let next = prev;
  if (now - prev.lastTryAtMs >= READ_EVERY_MS) {
    const move = await read(now).catch(() => null);
    if (move !== null) {
      const dayMoves = [...prev.dayMoves, move].slice(-HISTORY_MAX);
      next = { dayMoves, lastTryAtMs: now, lastOkAtMs: now, multiplier: ladderMultiplier(dayMoves) };
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
