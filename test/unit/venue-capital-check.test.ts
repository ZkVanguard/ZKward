/**
 * The daily venue check: the account must equal capital in, plus the
 * recorded baseline, plus trade results since it, within $0.50.
 */
import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({ getCronStateStrict: jest.fn(async (k: string) => state.get(k) ?? null) }));
const query = jest.fn(async (sql: string) => (sql.includes('venue_capital') ? [{ net: '66.765557' }] : [{ realized: '-1.20', open: '0.30' }]));
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string) => query(sql) }));

import { compareVenue, checkVenueCapital, VENUE_GAP_TOLERANCE_USD } from '@/lib/services/sui/venue-capital-check';

describe('venue capital check', () => {
  it('matches the account recorded with the baseline on 2026-10-16', () => {
    const v = compareVenue(16.519514587, { netCapitalUsd: 66.765557, baselineUsd: -50.246042, realizedSinceUsd: 0, openUsd: 0 });
    expect(v.ok).toBe(true);
    expect(Math.abs(v.gapUsd)).toBeLessThan(1e-6);
  });

  it('flags money no record explains, beyond the tolerance either way', () => {
    const parts = { netCapitalUsd: 66.77, baselineUsd: -50.25, realizedSinceUsd: 0, openUsd: 0 };
    expect(compareVenue(16.52 - VENUE_GAP_TOLERANCE_USD - 0.01, parts).ok).toBe(false);
    expect(compareVenue(16.52 + 3, parts).ok).toBe(false);
    expect(compareVenue(16.52 + 0.4, parts).ok).toBe(true);
  });

  it('adds results since the baseline: realized closes and the open mark', async () => {
    state.set('venue-check:baseline', { usd: -50.246042, atMs: Date.parse('2026-10-16T23:00:00Z') });
    const v = await checkVenueCapital(16.519514587 - 1.2 + 0.3);
    expect(v?.ok).toBe(true);
    expect(v?.parts).toEqual({ netCapitalUsd: 66.765557, baselineUsd: -50.246042, realizedSinceUsd: -1.2, openUsd: 0.3 });
  });

  it('with no baseline there is nothing to compare, and an unreadable account is an error', async () => {
    state.clear();
    expect(await checkVenueCapital(16.5)).toBeNull();
    await expect(checkVenueCapital(NaN)).rejects.toThrow('unreadable');
  });
});

describe('decision log prune', () => {
  it('deletes only decision rows older than 30 days', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/services/sui/cron/step-9-log-decision.ts'), 'utf8');
    expect(src).toContain("DELETE FROM community_pool_transactions WHERE type = 'AI_DECISION' AND created_at < NOW() - INTERVAL '30 days'");
  });
});
