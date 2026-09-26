/**
 * Fix D (2026-09-25) — DOGE/XRP get a wider stop floor so 1-1.5% mean-
 * reversion doesn't pick off a 45-min hold. Regression check that:
 *   1. DOGE stop floor holds even when vol says tighter would fit
 *   2. Env override wins
 *   3. Other assets keep the 1.0% base floor
 *
 * Uses computeAdaptiveThresholds directly; upstream vol fetch is mocked
 * to null so the fail-open branch is hit — no network calls.
 */
jest.mock('../../lib/services/paper-trader/volatility-gate', () => ({
  getRealizedVolPct: jest.fn(async () => null),
  getBinanceRealizedVolPct: jest.fn(async () => null),
}));

import { computeAdaptiveThresholds } from '../../lib/services/paper-trader/adaptive-stops';

describe('adaptive-stops per-asset floor', () => {
  afterEach(() => {
    delete process.env.PAPER_ASSET_STOP_FLOOR_PCT_DOGE;
    delete process.env.PAPER_ASSET_STOP_FLOOR_PCT_BTC;
  });

  it('DOGE static-fallback stop >= 2.5% default floor', async () => {
    const t = await computeAdaptiveThresholds('DOGE');
    expect(t.stopLossPct).toBeGreaterThanOrEqual(0.025);
  });

  it('XRP static-fallback stop >= 2.5% default floor', async () => {
    const t = await computeAdaptiveThresholds('XRP');
    expect(t.stopLossPct).toBeGreaterThanOrEqual(0.025);
  });

  it('BTC static-fallback stop >= 2.5% base floor (no per-asset override)', async () => {
    const t = await computeAdaptiveThresholds('BTC');
    expect(t.stopLossPct).toBeGreaterThanOrEqual(0.025);
  });

  it('env override wins', async () => {
    process.env.PAPER_ASSET_STOP_FLOOR_PCT_DOGE = '0.025';
    const t = await computeAdaptiveThresholds('DOGE');
    expect(t.stopLossPct).toBeGreaterThanOrEqual(0.025);
  });
});
