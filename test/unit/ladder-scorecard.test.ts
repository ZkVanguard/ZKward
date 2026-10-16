/**
 * The ladder scorecard records each forecast once, about a day ahead, and
 * grades it only by the market's own settled result.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const query = jest.fn(async (_sql: string, _p?: unknown[]) => [] as unknown[]);
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, p?: unknown[]) => query(sql, p) }));

const NOW = Date.parse('2026-10-16T12:00:00Z');
const HOUR = 3_600_000;
const open: Array<{ resolvesAtMs: number; strikes: Array<{ strike: number; yes: number }> }> = [];
const closed: typeof open = [];
jest.mock('@/lib/services/market-data/StrikeLadderService', () => {
  const real = jest.requireActual('@/lib/services/market-data/StrikeLadderService') as Record<string, unknown>;
  return { ...real, LADDER_ASSETS: ['BTC'], fetchLadders: async (_a: string, isClosed: boolean) => (isClosed ? closed : open) };
});

import { recordLadderForecasts, settleLadderForecasts } from '@/lib/services/market-data/ladder-scorecard';

// A readable ladder: even odds near 83,700, undecided strikes in the middle.
const strikes = [78_000, 80_000, 82_000, 84_000, 86_000, 88_000].map((strike, i) => ({ strike, yes: [0.99, 0.9, 0.7, 0.4, 0.12, 0.02][i] }));
const inserts = () => query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO ladder_forecasts'));

beforeEach(() => {
  query.mockClear();
  query.mockImplementation(async () => []);
  open.length = 0;
  closed.length = 0;
});

describe('recordLadderForecasts', () => {
  it('records only a ladder about a day ahead, and only its undecided strikes', async () => {
    open.push({ resolvesAtMs: NOW + 4 * HOUR, strikes }, { resolvesAtMs: NOW + 24 * HOUR, strikes }, { resolvesAtMs: NOW + 48 * HOUR, strikes });
    await recordLadderForecasts(NOW);
    const rows = inserts();
    expect(rows.map(([, p]) => (p as unknown[])[1])).toEqual(Array(4).fill(new Date(NOW + 24 * HOUR).toISOString()));
    expect(rows.map(([, p]) => (p as unknown[])[2])).toEqual([80_000, 82_000, 84_000, 86_000]);
    expect(rows[0][0]).toContain('ON CONFLICT (asset, resolves_at, strike) DO NOTHING');
  });

  it('prunes what is older than two years', async () => {
    await recordLadderForecasts(NOW);
    expect(query.mock.calls.some(([sql]) => sql.includes("DELETE FROM ladder_forecasts WHERE resolves_at < NOW() - INTERVAL '730 days'"))).toBe(true);
  });
});

describe('settleLadderForecasts', () => {
  it('writes the settled result for each strike, and skips a strike that has not settled', async () => {
    const resolvesAt = new Date(NOW - 3 * HOUR);
    query.mockImplementation(async (sql: string) => (sql.includes('SELECT DISTINCT') ? [{ asset: 'BTC', resolves_at: resolvesAt }] : [1]));
    closed.push({ resolvesAtMs: resolvesAt.getTime(), strikes: [{ strike: 82_000, yes: 1 }, { strike: 84_000, yes: 0 }, { strike: 86_000, yes: 0.5 }] });
    expect(await settleLadderForecasts(NOW)).toBe(2);
    const updates = query.mock.calls.filter(([sql]) => sql.includes('UPDATE ladder_forecasts'));
    expect(updates.map(([, p]) => [(p as unknown[])[2], (p as unknown[])[3]])).toEqual([[82_000, true], [84_000, false]]);
  });
});

describe('the scorecard on the board', () => {
  it('every locale has its strings', () => {
    const root = path.resolve(__dirname, '../..');
    for (const f of fs.readdirSync(path.join(root, 'messages')).filter((x) => x.endsWith('.json'))) {
      const mb = JSON.parse(fs.readFileSync(path.join(root, 'messages', f), 'utf8')).dashboard.marketBoard;
      const missing = ['scorecardTitle', 'scorecardEmpty', 'scorecardSummary', 'scorecardBand', 'scorecardHappened', 'scorecardCount'].filter((k) => !mb[k]);
      expect({ f, missing }).toEqual({ f, missing: [] });
      expect(String(mb.scorecardBand)).toContain('{from}');
      expect(String(mb.scorecardHappened)).toContain('{pct}');
    }
  });
});
