/**
 * Fix H (2026-09-25) — hard-filter mode for source calibrator.
 *
 * A source with n >= HARD_FILTER_MIN_TRADES and hit_rate below
 * HARD_FILTER_MIN_HIT_RATE should be REMOVED entirely from the
 * aggregation, not merely down-weighted.
 *
 * Also verifies:
 *   - cold sources (n < MIN_TRADES) survive (bootstrap mode)
 *   - the defensive floor keeps ≥ 2 sources even if filter is aggressive
 */
const state = new Map<string, unknown>();

jest.mock('../../lib/db/cron-state', () => ({
  getCronState: jest.fn(async <T,>(key: string): Promise<T | null> => (state.get(key) as T | null) ?? null),
  getCronStateOr: jest.fn(async <T,>(key: string, def: T): Promise<T> => (state.get(key) as T | undefined) ?? def),
  setCronState: jest.fn(async (key: string, value: unknown) => { state.set(key, value); }),
}));

process.env.SOURCE_HARD_FILTER_ENABLED = 'true';
process.env.SOURCE_HARD_FILTER_MIN_TRADES = '20';
process.env.SOURCE_HARD_FILTER_MIN_HIT_RATE = '0.52';

import {
  applyCalibrationToSources,
  shouldHardFilterSource,
} from '../../lib/services/ai/source-calibrator';

function seedBucket(sourceKey: string, wins: number, n: number) {
  state.set(`trader:source-cal:${sourceKey}`, { n, wins, updatedAt: Date.now() });
}

describe('Fix H — source-calibrator hard filter', () => {
  beforeEach(() => { state.clear(); });

  it('removes a source below MIN_HIT_RATE once n >= MIN_TRADES', async () => {
    seedBucket('badsource', 8, 20); // 40% wr, n=20
    expect(await shouldHardFilterSource('badsource')).toBe(true);
  });

  it('keeps a source at or above MIN_HIT_RATE', async () => {
    seedBucket('goodsource', 12, 20); // 60% wr, n=20
    expect(await shouldHardFilterSource('goodsource')).toBe(false);
  });

  it('keeps a cold source (n < MIN_TRADES) regardless of hit rate', async () => {
    seedBucket('coldsource', 2, 10); // 20% wr but n=10 < 20
    expect(await shouldHardFilterSource('coldsource')).toBe(false);
  });

  it('applyCalibrationToSources filters out bad + normalises survivors', async () => {
    // Real source display-names → normalizeSourceKey buckets
    seedBucket('polymarket-5min-BTC-ticker', 40, 100); // 40% wr, n=100 → SKIP
    seedBucket('polymarket-5min-XRP', 11, 20);         // 55% wr, n=20 → KEEP
    seedBucket('delphi-5min-BTC', 23, 42);             // 55% wr, n=42 → KEEP
    const sources = [
      { name: 'Polymarket 5-Min BTC (ticker)', type: 'polymarket', weight: 0.30 },
      { name: 'Polymarket 5-Min XRP', type: 'polymarket', weight: 0.20 },
      { name: 'Delphi ⚡ 5-Min BTC Signal', type: 'delphi', weight: 0.20 },
    ];
    const out = await applyCalibrationToSources(sources);
    // Bad source removed
    expect(out.find((s) => s.name === 'Polymarket 5-Min BTC (ticker)')).toBeUndefined();
    // Survivors kept
    expect(out.map((s) => s.name).sort()).toEqual([
      'Delphi ⚡ 5-Min BTC Signal',
      'Polymarket 5-Min XRP',
    ]);
    // Weights re-normalised to sum ~ 1
    const total = out.reduce((s, x) => s + x.weight, 0);
    expect(total).toBeCloseTo(1.0, 3);
  });

  it('defensive floor — falls back to full list when filter would leave < 2', async () => {
    // normalizeSourceKey turns 'bad1' + type 't' into 't:bad1'
    seedBucket('t:bad1', 4, 20);
    seedBucket('t:bad2', 4, 20);
    seedBucket('t:bad3', 4, 20);
    const sources = [
      { name: 'bad1', type: 't', weight: 0.4 },
      { name: 'bad2', type: 't', weight: 0.4 },
      { name: 'bad3', type: 't', weight: 0.2 },
    ];
    const out = await applyCalibrationToSources(sources);
    // All 3 survived because filtering would drop to 0
    expect(out.length).toBe(3);
  });

  it('cold sources pass through even when others are filtered', async () => {
    seedBucket('t:bad', 4, 20);         // 20% n=20 → filter
    seedBucket('t:warm-good', 12, 20);  // 60% n=20 → keep
    // no bucket for 't:cold' → cold, keep
    const sources = [
      { name: 'bad', type: 't', weight: 0.3 },
      { name: 'warm-good', type: 't', weight: 0.4 },
      { name: 'cold', type: 't', weight: 0.3 },
    ];
    const out = await applyCalibrationToSources(sources);
    expect(out.map((s) => s.name).sort()).toEqual(['cold', 'warm-good']);
  });
});
