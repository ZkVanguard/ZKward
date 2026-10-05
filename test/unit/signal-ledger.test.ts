/**
 * Signal ledger (root-audit Pillar 2) — the fixed-horizon evidence engine.
 *
 * Covers:
 *   • buildSnapshotRows — one row per directional source per horizon,
 *     plus the 'aggregate' row; NEUTRAL and unpriced assets excluded
 *   • resolveExpiredSignals — label honesty: rows resolved too long after
 *     window close are VOIDED, never scored; per-asset exit prices;
 *     price outage leaves rows pending
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('@/lib/db/postgres', () => ({
  query: jest.fn(async () => []),
}));
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getMultiSourceValidatedPrice: jest.fn(async () => ({ price: 0 })),
}));

import { query } from '@/lib/db/postgres';
import { getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';
import { buildSnapshotRows, gateSource, SHADOW_SOURCE } from '@/lib/services/market-data/signal-ledger';
import { resolveExpiredSignals } from '@/lib/db/signal-outcomes';

const mockQuery = query as jest.MockedFunction<typeof query>;
const mockPrice = getMultiSourceValidatedPrice as jest.MockedFunction<typeof getMultiSourceValidatedPrice>;

const NOW = 1_790_000_000_000;
const identityKey = (name: string, type: string) => `${type || 'x'}:${name}`;

describe('buildSnapshotRows', () => {
  const scanAll = {
    BTC: {
      direction: 'UP' as const,
      confidence: 72,
      probability: 64,
      sources: [
        { name: 'fundingA', type: 'on_chain', direction: 'UP' as const, confidence: 70, probability: 60 },
        { name: 'noisy', type: 'sentiment', direction: 'NEUTRAL' as const, confidence: 50 },
        { name: 'bearish', type: 'short_term', direction: 'DOWN' as const, confidence: 55, probability: 58 },
      ],
    },
    ETH: {
      direction: 'NEUTRAL' as const,
      confidence: 40,
      sources: [
        { name: 'fundingB', type: 'on_chain', direction: 'DOWN' as const, confidence: 61 },
      ],
    },
  };

  it('emits one row per directional source per horizon + the aggregate row', () => {
    const prices = new Map([['BTC', 65_000], ['ETH', 3_000]]);
    const rows = buildSnapshotRows(scanAll, prices, NOW, identityKey, [30, 60]);
    // BTC: 2 directional sources + aggregate = 3 rows × 2 horizons = 6
    // ETH: 1 directional source, NO aggregate row (NEUTRAL) = 1 × 2 = 2
    expect(rows).toHaveLength(8);
    const btcAgg = rows.filter((r) => r.asset === 'BTC' && r.source === 'aggregate');
    expect(btcAgg).toHaveLength(2);
    expect(btcAgg[0].direction).toBe('UP');
    expect(btcAgg[0].windowEndTime).toBe(NOW + 30 * 60_000);
    expect(btcAgg[1].windowEndTime).toBe(NOW + 60 * 60_000);
    // NEUTRAL source never becomes a row.
    expect(rows.find((r) => r.source.includes('noisy'))).toBeUndefined();
    // Every row carries the entry anchor.
    expect(rows.every((r) => r.entryPrice === 65_000 || r.entryPrice === 3_000)).toBe(true);
  });

  describe('with the feedback loop\'s extras', () => {
    const prices = new Map([['BTC', 65_000], ['ETH', 3_000]]);
    const src = (r: { source: string }) => r.source;

    it('records the raw votes, so a source the weighting removed is still measured', () => {
      const rawSources = { BTC: [...scanAll.BTC.sources, { name: 'removed', type: 'short_term', direction: 'DOWN' as const, confidence: 60 }] };
      const rows = buildSnapshotRows(scanAll, prices, NOW, identityKey, [60], { rawSources });
      expect(rows.filter((r) => r.asset === 'BTC').map(src)).toContain('short_term:removed');
      // A coin with no raw votes on hand falls back to the weighted list.
      expect(rows.filter((r) => r.asset === 'ETH').map(src)).toEqual(['on_chain:fundingB']);
    });

    it('records the shadow vote beside the live one, and not when it has no direction', () => {
      const shadow = { BTC: { direction: 'DOWN' as const, confidence: 61, probability: 55 }, ETH: { direction: 'NEUTRAL' as const, confidence: 30 } };
      const rows = buildSnapshotRows(scanAll, prices, NOW, identityKey, [60], { shadow });
      const v2 = rows.filter((r) => r.source === SHADOW_SOURCE);
      expect(v2).toHaveLength(1);
      expect(v2[0]).toMatchObject({ asset: 'BTC', direction: 'DOWN', confidence: 61, entryPrice: 65_000 });
      expect(rows.find((r) => r.asset === 'BTC' && r.source === 'aggregate')?.direction).toBe('UP');
    });

    it('a gate row carries the direction of the signal it refused', () => {
      const rows = buildSnapshotRows(scanAll, prices, NOW, identityKey, [60], { gateRefusals: { BTC: ['low-volatility', 'majority'], ETH: ['majority'] } });
      const gates = rows.filter((r) => r.source.startsWith('gate:'));
      expect(gates.map(src)).toEqual([gateSource('low-volatility'), gateSource('majority')]);
      expect(gates.every((r) => r.asset === 'BTC' && r.direction === 'UP')).toBe(true);
      // ETH has no directional signal: there is nothing for a gate to refuse.
    });

    it('shadow and gate rows stop at four hours; the day-long horizon keeps only what it had', () => {
      const extras = { shadow: { BTC: { direction: 'UP' as const, confidence: 70 } }, gateRefusals: { BTC: ['majority'] } };
      const rows = buildSnapshotRows(scanAll, prices, NOW, identityKey, [240, 1440], extras);
      const extra = rows.filter((r) => r.source === SHADOW_SOURCE || r.source.startsWith('gate:'));
      expect(extra.map((r) => r.horizonMin)).toEqual([240, 240]);
      expect(rows.some((r) => r.horizonMin === 1440 && r.source === 'aggregate')).toBe(true);
    });
  });

  it('skips assets without a validated price entirely', () => {
    const prices = new Map([['BTC', 65_000]]); // no ETH price
    const rows = buildSnapshotRows(scanAll, prices, NOW, identityKey, [30]);
    expect(rows.every((r) => r.asset === 'BTC')).toBe(true);
  });
});

describe('resolveExpiredSignals — label honesty + multi-asset', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockPrice.mockReset();
  });

  function pendingRows(rows: unknown[]) {
    // First query() call is ensureTable (DDL), second is the pending SELECT,
    // rest are UPDATEs. Route by SQL shape instead of call order.
    mockQuery.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes('SELECT id, asset, direction')) return rows as never;
      return [] as never;
    });
  }

  it('voids rows resolved past the honesty window instead of scoring them', async () => {
    pendingRows([
      { id: 1, asset: 'BTC', direction: 'UP', entry_price: 60_000, window_end_time: NOW - 60 * 60_000 },
    ]);
    const r = await resolveExpiredSignals({ now: NOW });
    expect(r.voided).toBe(1);
    expect(r.resolved).toBe(0);
    const voidUpdate = mockQuery.mock.calls.find((c) => String(c[0]).includes("status = 'void'"));
    expect(voidUpdate).toBeTruthy();
    expect(String((voidUpdate![1] as unknown[])[0])).toMatch(/late/);
    // Never fetched a price for a row it refused to score.
    expect(mockPrice).not.toHaveBeenCalled();
  });

  it('scores fresh rows against per-asset exit prices', async () => {
    pendingRows([
      { id: 1, asset: 'BTC', direction: 'UP', entry_price: 60_000, window_end_time: NOW - 60_000 },
      { id: 2, asset: 'ETH', direction: 'UP', entry_price: 3_000, window_end_time: NOW - 60_000 },
    ]);
    mockPrice.mockImplementation(async (asset: string) =>
      ({ price: asset === 'BTC' ? 61_000 : 2_900 }) as never);
    const r = await resolveExpiredSignals({ now: NOW });
    expect(r.resolved).toBe(2);
    expect(r.correct).toBe(1);   // BTC UP → 61k ≥ 60k ✓
    expect(r.incorrect).toBe(1); // ETH UP → 2.9k < 3k ✗
  });

  it('leaves rows pending when the price fetch fails (retry next tick)', async () => {
    pendingRows([
      { id: 1, asset: 'BTC', direction: 'UP', entry_price: 60_000, window_end_time: NOW - 60_000 },
    ]);
    mockPrice.mockRejectedValue(new Error('all providers down'));
    const r = await resolveExpiredSignals({ now: NOW });
    expect(r.resolved).toBe(0);
    expect(r.voided).toBe(0);
    const resolvedUpdate = mockQuery.mock.calls.find((c) => String(c[0]).includes("status = 'resolved'"));
    expect(resolvedUpdate).toBeUndefined();
  });
});
