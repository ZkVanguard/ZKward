/**
 * Every paper book in one read, for the chat, the paper page and the scoreboard:
 * all books listed, the off switch shown, open rows and interest read, a failed
 * read an error (never a table of zeros), and every book described in all 13 locales.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const query = jest.fn<(sql: string, params: unknown[]) => Promise<unknown[]>>();
jest.mock('@/lib/db/postgres', () => ({ query: (sql: string, p: unknown[]) => query(sql, p) }));
const bookRowStats = jest.fn<(id: number, since: number) => Promise<unknown>>();
jest.mock('@/lib/db/book-row-stats', () => ({ bookRowStats: (id: number, since: number) => bookRowStats(id, since) }));
const state: Record<string, unknown> = {};
jest.mock('@/lib/db/cron-state', () => ({ getCronStateStrict: async (k: string) => state[k] ?? null }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { PAPER_BOOKS, bookRunning, readPaperBooks } from '@/lib/services/paper-trader/books-summary';
import { GET } from '@/app/api/paper-trader/books/route';

const NOW = Date.parse('2026-11-13T18:00:00Z');
const stats = (realizedUsd: number) => ({ trades: 3, wins: 1, losses: 2, realizedUsd, avgBp: -5, takeProfits: 0, stops: 0, timeLimits: 3 });

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(state)) delete state[k];
  query.mockResolvedValue([{ portfolio_id: -12, n: 28, notional: 28_000, pnl: -27.4 }]);
  bookRowStats.mockImplementation(async (id: number) => stats(id === -8 ? -5_241.47 : 0));
  state['core-trader:state'] = { interestUsd: 21.2 };
  state['short-trader:state'] = { interestUsd: 0.04 };
});
afterEach(() => { delete process.env.FLOOR_TRADER_DISABLE; });

describe('readPaperBooks', () => {
  it('lists every book with its closed trades, open rows and, where it has one, its interest', async () => {
    const books = await readPaperBooks(720, NOW);
    expect(books.map((b) => b.portfolioId)).toEqual([-3, -4, -5, -6, -7, -8, -9, -10, -11, -12]);
    expect(bookRowStats).toHaveBeenCalledWith(-8, NOW - 720 * 3_600_000);
    const short = books.find((b) => b.name === 'ShortTrader')!;
    expect(short.open).toEqual({ positions: 28, notionalUsd: 28_000, openPnlUsd: -27.4 });
    expect(short.interestUsd).toBe(0.04);
    expect(books.find((b) => b.name === 'CoreTrader')!.interestUsd).toBe(21.2);
    expect(books.find((b) => b.name === 'FloorTrader')!.interestUsd).toBeUndefined();
    expect(books.find((b) => b.name === 'FloorTrader')!.closed.realizedUsd).toBe(-5_241.47);
  });

  it('a book whose off switch is set reads as off; a book without a switch always runs', async () => {
    process.env.FLOOR_TRADER_DISABLE = '1';
    const books = await readPaperBooks(720, NOW);
    expect(books.find((b) => b.portfolioId === -8)!.running).toBe(false);
    expect(books.find((b) => b.portfolioId === -12)!.running).toBe(true);
    expect(bookRunning({ id: -3, name: 'x', tests: '' }, { FLOOR_TRADER_DISABLE: '1' })).toBe(true);
  });

  it('an unread record is an error, never a book with zero trades', async () => {
    bookRowStats.mockImplementation(async (id: number) => (id === -11 ? null : stats(0)));
    await expect(readPaperBooks(720, NOW)).rejects.toThrow('book -11');
  });
});

describe('GET /api/paper-trader/books', () => {
  it('answers the books with a CDN cache header', async () => {
    const res = await GET(new Request('https://example.test/api/paper-trader/books'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=60');
    const body = (await res.json()) as { success: boolean; books: unknown[]; windowHours: number };
    expect(body.success).toBe(true);
    expect(body.windowHours).toBe(720);
    expect(body.books).toHaveLength(PAPER_BOOKS.length);
  });

  it('a failed read is a 500 that says it failed', async () => {
    query.mockRejectedValue(new Error('db down'));
    const res = await GET(new Request('https://example.test/api/paper-trader/books'));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, error: 'db down' });
  });
});

describe('the paper books table strings', () => {
  const dir = path.join(process.cwd(), 'messages');
  const locales = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const keysOf = (o: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keysOf(v as Record<string, unknown>, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')).paperBooks;

  it('has every book described in English', () => {
    for (const b of PAPER_BOOKS) expect(typeof en.tests[`b${-b.id}`]).toBe('string');
  });

  it('every locale carries the same keys, with the placeholders intact', () => {
    expect(locales).toHaveLength(13);
    for (const file of locales) {
      const t = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).paperBooks;
      expect(keysOf(t).sort()).toEqual(keysOf(en).sort());
      expect(t.openOn).toContain('{notional}');
      expect(t.error).toContain('{error}');
    }
  });
});
