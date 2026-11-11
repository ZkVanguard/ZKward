/**
 * Source keys: rolling-title markets collapse to one key, so the ledger
 * judges the source rather than each market.
 */
import { describe, it, expect } from '@jest/globals';
import { normalizeSourceKey } from '@/lib/services/ai/source-keys';

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
