/**
 * Unit tests for source-calibrator.
 *
 * Locks:
 *   • normalizeSourceKey: rolling-title markets collapse to one bucket
 *   • recordSourceOutcome: NEUTRAL on either side is a no-op (defensible label)
 *   • getCalibratedHitRate: Bayesian shrinkage boundaries
 *   • hitRateToMultiplier: clamped and symmetric around 0.5
 *   • applyCalibrationToSources: re-normalizes to sum-1
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const store: Record<string, any> = {};
const mockGet = jest.fn<any>(((k: string) => Promise.resolve(store[k] ?? null)) as any);
const mockGetOr = jest.fn<any>(((k: string, def: any) => Promise.resolve(store[k] ?? def)) as any);
const mockSet = jest.fn<any>(((k: string, v: any) => {
  store[k] = v;
  return Promise.resolve();
}) as any);

jest.mock('@/lib/db/cron-state', () => ({
  getCronState: (...args: any[]) => mockGet(...args),
  getCronStateOr: (...args: any[]) => mockGetOr(...args),
  setCronState: (...args: any[]) => mockSet(...args),
}));

import {
  normalizeSourceKey,
  recordSourceOutcome,
  getCalibratedHitRate,
  getCalibratedMultiplier,
  hitRateToMultiplier,
  applyCalibrationToSources,
  _MIN_MULTIPLIER,
  _MAX_MULTIPLIER,
  _NEUTRAL_HIT_RATE,
  _PRIOR_STRENGTH,
} from '@/lib/services/ai/source-calibrator';

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  mockGet.mockClear();
  mockGetOr.mockClear();
  mockSet.mockClear();
});

describe('normalizeSourceKey', () => {
  it('collapses rolling Polymarket 5-min titles to one bucket per asset', () => {
    // Titles change every 5 min ("BTC 3:20AM-3:25AM ET", etc.) — key must not
    expect(normalizeSourceKey('Polymarket 5-Min BTC')).toBe('polymarket-5min-BTC');
    expect(normalizeSourceKey('Polymarket 5-Min ETH')).toBe('polymarket-5min-ETH');
  });
  it('distinguishes the "(ticker)" variant of Polymarket 5-min', () => {
    expect(normalizeSourceKey('Polymarket 5-Min BTC (ticker)')).toBe('polymarket-5min-BTC-ticker');
  });
  it('keys the "(synthetic STRONG)" variant separately', () => {
    expect(normalizeSourceKey('Polymarket 5-Min SOL (synthetic STRONG)')).toBe(
      'polymarket-5min-SOL-synth',
    );
  });
  it('collapses Delphi 5-min per-asset signals (rotating time text)', () => {
    expect(normalizeSourceKey('Delphi: ⚡ 5-Min BTC Signal: UP (3:20AM-3:25AM ET)')).toBe(
      'delphi-5min-BTC',
    );
    expect(normalizeSourceKey('Delphi: ⚡ 5-Min ETH Signal: DOWN (4:00-4:05 ET)')).toBe(
      'delphi-5min-ETH',
    );
  });
  it('keys cross-asset alignment as a single bucket regardless of dominance text', () => {
    expect(normalizeSourceKey('Cross-asset alignment (4UP/0DOWN/1~)')).toBe(
      'cross-asset-alignment',
    );
    expect(normalizeSourceKey('Cross-asset alignment (2UP/3DOWN/0~)')).toBe(
      'cross-asset-alignment',
    );
  });
  it('keys funding-rate proxies to one bucket', () => {
    expect(normalizeSourceKey('Funding Rate Proxy')).toBe('funding-rate');
    expect(normalizeSourceKey('Bluefin Funding Rate')).toBe('funding-rate');
  });
  it('slugs generic Delphi questions and truncates to 40 chars', () => {
    const key = normalizeSourceKey('Delphi: Will crypto market cap increase this month?');
    expect(key).toMatch(/^delphi:will-crypto-market/);
    expect(key.length).toBeLessThan(60);
  });
  it('slugs generic Manifold questions', () => {
    const key = normalizeSourceKey('Manifold: Will Bitcoin be higher than $66,666?');
    expect(key).toMatch(/^manifold:will-bitcoin/);
  });
  it('falls back to type:name-slug for anything unrecognized', () => {
    expect(normalizeSourceKey('Some Random Source', 'sentiment')).toBe(
      'sentiment:some-random-source',
    );
    expect(normalizeSourceKey('X', '')).toBe('other:x');
  });
});

describe('recordSourceOutcome', () => {
  it('increments n and wins on correct call (UP/UP)', async () => {
    await recordSourceOutcome({
      sourceKey: 'polymarket-5min-BTC',
      sourceDirection: 'UP',
      actualDirection: 'UP',
    });
    expect(store['trader:source-cal:polymarket-5min-BTC']).toMatchObject({ n: 1, wins: 1 });
  });
  it('increments n but not wins on wrong call (UP/DOWN)', async () => {
    await recordSourceOutcome({
      sourceKey: 'polymarket-5min-BTC',
      sourceDirection: 'UP',
      actualDirection: 'DOWN',
    });
    expect(store['trader:source-cal:polymarket-5min-BTC']).toMatchObject({ n: 1, wins: 0 });
  });
  it('accumulates over calls', async () => {
    for (let i = 0; i < 3; i++) {
      await recordSourceOutcome({
        sourceKey: 'polymarket-5min-BTC',
        sourceDirection: 'UP',
        actualDirection: 'UP',
      });
    }
    await recordSourceOutcome({
      sourceKey: 'polymarket-5min-BTC',
      sourceDirection: 'UP',
      actualDirection: 'DOWN',
    });
    expect(store['trader:source-cal:polymarket-5min-BTC']).toMatchObject({ n: 4, wins: 3 });
  });
  it('is a no-op when source predicts NEUTRAL', async () => {
    await recordSourceOutcome({
      sourceKey: 'x',
      sourceDirection: 'NEUTRAL',
      actualDirection: 'UP',
    });
    expect(store['trader:source-cal:x']).toBeUndefined();
  });
  it('is a no-op when actual outcome is NEUTRAL', async () => {
    await recordSourceOutcome({
      sourceKey: 'x',
      sourceDirection: 'UP',
      actualDirection: 'NEUTRAL',
    });
    expect(store['trader:source-cal:x']).toBeUndefined();
  });
  it('is a no-op with empty sourceKey (defensive)', async () => {
    await recordSourceOutcome({
      sourceKey: '',
      sourceDirection: 'UP',
      actualDirection: 'UP',
    });
    expect(Object.keys(store).length).toBe(0);
  });
});

describe('getCalibratedHitRate — Bayesian shrinkage', () => {
  it('returns 0.5 when there is no history', async () => {
    const r = await getCalibratedHitRate('unseen-source');
    expect(r).toBe(_NEUTRAL_HIT_RATE);
  });
  it('with n=PRIOR and empirical=1.0, weighted midpoint of 0.5 and 1.0 = 0.75', async () => {
    store['trader:source-cal:x'] = { n: _PRIOR_STRENGTH, wins: _PRIOR_STRENGTH, updatedAt: 0 };
    const r = await getCalibratedHitRate('x');
    expect(r).toBeCloseTo(0.75, 4);
  });
  it('with n=100 and empirical=0.8, shrunken hit rate close to 0.77', async () => {
    store['trader:source-cal:x'] = { n: 100, wins: 80, updatedAt: 0 };
    const r = await getCalibratedHitRate('x');
    // (100*0.8 + 10*0.5) / 110 = 85/110 ≈ 0.7727
    expect(r).toBeCloseTo(0.7727, 3);
  });
  it('with n=1000, shrinkage disappears — empirical dominates', async () => {
    store['trader:source-cal:x'] = { n: 1000, wins: 800, updatedAt: 0 };
    const r = await getCalibratedHitRate('x');
    // (1000*0.8 + 10*0.5) / 1010 ≈ 0.7970
    expect(r).toBeCloseTo(0.797, 3);
  });
});

describe('hitRateToMultiplier', () => {
  it('0.5 maps to 1.0 (no change)', () => {
    expect(hitRateToMultiplier(0.5)).toBe(1.0);
  });
  it('0.7 maps to 1.4 (40% boost)', () => {
    expect(hitRateToMultiplier(0.7)).toBeCloseTo(1.4, 6);
  });
  it('0.3 maps to 0.6 (40% cut)', () => {
    expect(hitRateToMultiplier(0.3)).toBeCloseTo(0.6, 6);
  });
  it('clamps at MAX_MULTIPLIER on extreme high', () => {
    expect(hitRateToMultiplier(1.0)).toBe(_MAX_MULTIPLIER);
    expect(hitRateToMultiplier(5.0)).toBe(_MAX_MULTIPLIER);
  });
  it('clamps at MIN_MULTIPLIER on extreme low', () => {
    expect(hitRateToMultiplier(0.05)).toBe(_MIN_MULTIPLIER);
    expect(hitRateToMultiplier(0)).toBe(_MIN_MULTIPLIER);
  });
});

describe('getCalibratedMultiplier', () => {
  it('returns 1.0 for an unseen source (no data)', async () => {
    const m = await getCalibratedMultiplier('unseen');
    expect(m).toBe(1.0);
  });
  it('returns > 1 for a proven-good source (high hit rate)', async () => {
    store['trader:source-cal:proven'] = { n: 100, wins: 80, updatedAt: 0 };
    const m = await getCalibratedMultiplier('proven');
    expect(m).toBeGreaterThan(1.4);
    expect(m).toBeLessThanOrEqual(_MAX_MULTIPLIER);
  });
  it('returns < 1 for a proven-bad source (low hit rate)', async () => {
    store['trader:source-cal:noisy'] = { n: 100, wins: 20, updatedAt: 0 };
    const m = await getCalibratedMultiplier('noisy');
    expect(m).toBeLessThan(0.6);
    expect(m).toBeGreaterThanOrEqual(_MIN_MULTIPLIER);
  });
});

describe('applyCalibrationToSources', () => {
  it('leaves weights unchanged when all sources are un-calibrated (multiplier = 1)', async () => {
    const inp = [
      { name: 'X', type: 'a', weight: 0.5 },
      { name: 'Y', type: 'b', weight: 0.5 },
    ];
    const out = await applyCalibrationToSources(inp);
    expect(out[0].weight).toBeCloseTo(0.5, 6);
    expect(out[1].weight).toBeCloseTo(0.5, 6);
  });
  it('shifts weight toward calibrated-good source and normalizes to sum 1', async () => {
    // Bucket the "good" source name (fallback path key: other:good)
    store['trader:source-cal:other:good'] = { n: 100, wins: 80, updatedAt: 0 };
    const inp = [
      { name: 'Good', type: 'other', weight: 0.5 },
      { name: 'Neutral', type: 'other', weight: 0.5 },
    ];
    const out = await applyCalibrationToSources(inp);
    const total = out.reduce((s, r) => s + r.weight, 0);
    expect(total).toBeCloseTo(1, 4);
    expect(out[0].weight).toBeGreaterThan(0.55);
    expect(out[1].weight).toBeLessThan(0.45);
  });
  it('returns input unchanged on empty list', async () => {
    const out = await applyCalibrationToSources([]);
    expect(out).toEqual([]);
  });
});
