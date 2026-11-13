/**
 * ShortTrader — the core rule turned down (portfolio -12), at the user's
 * request on 2026-11-13: short proactively, so the paper books earn when the
 * market falls and not only when it rises.
 *
 * Rule: the floor rule's exposure (floor-rule.ts), half per coin, sold short
 * on the perp at 1x while yesterday's close is below its 100-day average and
 * below its close 30 days before. Cash otherwise, credited the same assumed
 * 4% a year as the core book and kept apart from the trading result. Decided
 * once a day after 00:05 UTC on the trend and core books' candles. Funding is
 * the venue's measured hourly funding, paid or collected by the side.
 *
 * Why this rule: chosen on daily closes from 2021-11 to 2025-11 among ten
 * short rules (two sizes and five conditions). Every short side lost money
 * over those four years; this one lost the least, about 1% of the book. In
 * the next year, which was not used to choose it, its shorts made about 6%
 * and the book about 10%, against 4% for cash alone. It pays in a falling
 * market and sits in cash in a rising one: a hedge, not a forecast.
 */
import { runCoreBook, type CoreBook, type CoreTickSummary, type TrendReading } from './CoreTrader';
import { dailyCloses, trendOn, TREND_RULE } from './TrendTrader';

export const SHORT_PORTFOLIO_ID = -12;
/** Fixed for the length of the test. */
export const SHORT_RULE = { lookbackDays: 30 } as const;

/** Short a coin while its last close is under its 100-day average and under its close `lookbackDays` before. */
export function shortOn(closes: number[], lookbackDays: number = SHORT_RULE.lookbackDays): TrendReading | null {
  const t = trendOn(closes);
  const before = closes[closes.length - 1 - lookbackDays];
  if (!t || !(before > 0)) return null;
  return { ...t, on: t.close < t.average && t.close < before };
}

const SHORT: CoreBook = {
  name: 'ShortTrader',
  portfolioId: SHORT_PORTFOLIO_ID,
  stateKey: 'short-trader:state',
  orderPrefix: 'short',
  disabled: /^(1|true|yes|on)$/i.test((process.env.SHORT_TRADER_DISABLE || '').trim()),
  side: 'SHORT',
  decide: (closes) => shortOn(closes),
  because: `below its ${TREND_RULE.averageDays}-day average and its close ${SHORT_RULE.lookbackDays} days before`,
};

export function runShortTick(now: number = Date.now(), closesOf: typeof dailyCloses = dailyCloses): Promise<CoreTickSummary> {
  return runCoreBook(SHORT, now, closesOf);
}

export class ShortTrader {
  static runTick(now: number = Date.now()): Promise<CoreTickSummary> {
    return runShortTick(now);
  }
}
