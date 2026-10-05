/**
 * Does the loop find a real edge, and does it leave noise alone?
 *
 * A source family with a planted edge is simulated next to ten families with
 * none, on noise shaped like the ledger's (measured 2026-10-05 at 60 min:
 * one coin's window has a spread of 23 to 39 bp, and the same family's
 * coins are correlated 0.1 to 0.45 inside a window). The loop is run as
 * production runs it: a 14-day window, one judgment a day.
 *
 * The numbers asserted are floors with margin, not the measured values
 * (over 300 runs: +5 bp found in about 70% by day 10 and 90% by day 14,
 * +10 bp in 95% by day 5, +3 bp in under 40% inside the 14-day window; a
 * family with no edge held a verdict in about 1.5% of evaluations).
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('@/lib/db/cron-state', () => ({ getCronState: jest.fn(async () => null), setCronState: jest.fn(async () => undefined) }));
jest.mock('@/lib/db/signal-outcomes', () => ({ getLedgerBucketRows: jest.fn(async () => []) }));

import type { LedgerBucketRow } from '@/lib/db/signal-outcomes';
import { evaluateLoop, sourceFamily } from '@/lib/services/market-data/feedback-loop';
import { LEDGER_WINDOW_DAYS } from '@/lib/services/market-data/ledger-cells';

const HOUR = 3_600_000;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
const PLANTED = (coin: string) => `short_term:orderbook-${coin.toLowerCase()}-depth-imbalance`;
const NULL_SOURCES: Array<(coin: string) => string> = [
  (c) => `on_chain:bybit-${c.toLowerCase()}-funding`,
  (c) => `short_term:kalshi-${c.toLowerCase()}`,
  (c) => `polymarket-5min-${c}`,
  (c) => `polymarket-5min-${c}-synth`,
  (c) => `polymarket-5min-${c}-ticker`,
  (c) => `medium_term:crypto-com-${c.toLowerCase()}-24h`,
  (c) => `medium_term:options-skew-${c.toLowerCase()}-risk-reversal`,
  (c) => `on_chain:binance-${c.toLowerCase()}-long-short`,
  (c) => `medium_term:polymarket-daily-${c.toLowerCase()}-up-or-down`,
  () => 'cross-asset-alignment',
];
const PLANTED_FAMILY = sourceFamily(PLANTED('BTC'));

/** mulberry32: a fixed seed gives the same run on every machine. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(random: () => number): number {
  let u = 0;
  while (u === 0) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

interface Shape { edgeBp: number; spreadBp: number; coinCorrelation: number; presence: number }
const TYPICAL: Omit<Shape, 'edgeBp'> = { spreadBp: 30, coinCorrelation: 0.35, presence: 0.7 };

function simulate(seed: number, days: number, shape: Shape): LedgerBucketRow[] {
  const random = seeded(seed);
  const rows: LedgerBucketRow[] = [];
  const sources = [PLANTED, ...NULL_SOURCES];
  sources.forEach((sourceOf, f) => {
    for (let bucket = 0; bucket < days * 24; bucket++) {
      const shared = normal(random);
      for (const coin of COINS) {
        if (random() > shape.presence) continue;
        const noise = shape.spreadBp * (Math.sqrt(shape.coinCorrelation) * shared + Math.sqrt(1 - shape.coinCorrelation) * normal(random));
        rows.push({ source: sourceOf(coin), asset: coin, horizonMin: 60, bucket, n: 6, timingBp: (f === 0 ? shape.edgeBp : 0) + noise });
      }
    }
  });
  return rows;
}

function runMany(trials: number, day: number, shape: Shape) {
  let proven = 0;
  let wrongWay = 0;
  let noiseFamilies = 0;
  let noiseCells = 0;
  for (let t = 0; t < trials; t++) {
    const from = Math.max(0, day - LEDGER_WINDOW_DAYS) * 24;
    const state = evaluateLoop(simulate(7_000 + t, day, shape).filter((r) => r.bucket >= from), day * 24 * HOUR, 60);
    const planted = state.families[PLANTED_FAMILY]?.verdict;
    if (planted === 'proven') proven++;
    if (planted === 'wrong-way') wrongWay++;
    noiseFamilies += Object.keys(state.families).filter((k) => k !== PLANTED_FAMILY).length;
    noiseCells += Object.keys(state.cells).filter((k) => !k.includes('orderbook')).length;
  }
  return { proven: proven / trials, wrongWay: wrongWay / trials, noiseFamiliesPerRun: noiseFamilies / trials, noiseCellsPerRun: noiseCells / trials };
}

const TRIALS = 50;

describe('a planted edge of 5 bp shared by a family across coins', () => {
  const day10 = runMany(TRIALS, 10, { ...TYPICAL, edgeBp: 5 });
  const day14 = runMany(TRIALS, 14, { ...TYPICAL, edgeBp: 5 });

  it('is in force in most runs by day 10 and in four of five by day 14', () => {
    expect(day10.proven).toBeGreaterThanOrEqual(0.6);
    expect(day14.proven).toBeGreaterThanOrEqual(0.8);
  });

  it('is never called the wrong way', () => {
    expect(day10.wrongWay).toBe(0);
    expect(day14.wrongWay).toBe(0);
  });

  it('does not drag the families with no edge along', () => {
    // Ten families with no edge per run.
    expect(day14.noiseFamiliesPerRun).toBeLessThanOrEqual(0.4);
  });
});

describe('a planted wrong-way source of the same size', () => {
  it('is removed as fast as an edge is found', () => {
    const day14 = runMany(TRIALS, 14, { ...TYPICAL, edgeBp: -5 });
    expect(day14.wrongWay).toBeGreaterThanOrEqual(0.8);
    expect(day14.proven).toBe(0);
  });
});

describe('a larger edge', () => {
  it('10 bp is in force within five days', () => {
    expect(runMany(TRIALS, 5, { ...TYPICAL, edgeBp: 10 }).proven).toBeGreaterThanOrEqual(0.85);
  });
});

describe('no edge anywhere', () => {
  it('eleven families and fifty-odd cells of noise hold almost no verdict', () => {
    const quiet = runMany(TRIALS, 14, { ...TYPICAL, edgeBp: 0 });
    // Per run: eleven families, about fifty cells. Two standard errors alone would hold about three.
    expect(quiet.proven + quiet.wrongWay + quiet.noiseFamiliesPerRun).toBeLessThanOrEqual(0.4);
    expect(quiet.noiseCellsPerRun).toBeLessThanOrEqual(0.4);
  });
});
