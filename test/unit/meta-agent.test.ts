/**
 * The tool-use chat runs on Meta's Muse Spark when its key is set, routes
 * paper-book questions to the one tool that can see simulated rows, and
 * that tool fails loudly instead of reporting an empty book.
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetModules();
  jest.dontMock('@/lib/db/postgres');
  jest.dontMock('@/lib/db/book-row-stats');
});

describe('provider choice', () => {
  it('prefers Meta when META_API_KEY is set', async () => {
    process.env.META_API_KEY = ' meta-key\r\n';
    process.env.ASI_API_KEY = 'asi-key';
    delete process.env.META_MODEL;
    delete process.env.META_API_URL;
    const { resolveProvider } = await import('@/lib/services/ai/tool-runner');
    const p = await resolveProvider();
    expect(p?.name).toBe('meta');
    expect(p?.model).toBe('muse-spark-1.3');
    expect((p?.client as unknown as { baseURL: string }).baseURL).toBe('https://api.meta.ai/v1');
  });

  it('falls back to ASI, then to nothing', async () => {
    delete process.env.META_API_KEY;
    process.env.ASI_API_KEY = 'asi-key';
    const { resolveProvider } = await import('@/lib/services/ai/tool-runner');
    expect((await resolveProvider())?.name).toBe('asi');
    delete process.env.ASI_API_KEY;
    expect(await resolveProvider()).toBeNull();
  });
});

describe('paper-book questions', () => {
  it.each([
    'how are the paper books doing?',
    'why did the floor book lose money',
    'is paper trading making anything',
    'what is the lead trader holding',
  ])('"%s" reaches get_paper_books', async (q) => {
    const { analyzeMessage } = await import('@/lib/services/ai/message-analyzer');
    const a = analyzeMessage(q);
    expect(a.intent).toBe('paper_books');
    expect(a.suggestedTools).toContain('get_paper_books');
  });

  it('is never served from the response cache', async () => {
    const { isCacheable } = await import('@/lib/db/chat-response-cache');
    expect(isCacheable('paper_books', false)).toBe(false);
  });
});

describe('get_paper_books', () => {
  const stats = { trades: 4, wins: 3, losses: 1, realizedUsd: -2.5, avgBp: -6, takeProfits: 3, stops: 1, timeLimits: 0 };

  it('reads each book from its rows, open positions included', async () => {
    jest.doMock('@/lib/db/postgres', () => ({
      query: async () => [{ portfolio_id: -8, n: 25, notional: 25000, pnl: -1992.58 }],
    }));
    jest.doMock('@/lib/db/book-row-stats', () => ({ bookRowStats: async () => stats }));
    const { getPaperBooks } = await import('@/lib/services/ai/tools/db-tools');
    const books = await getPaperBooks.execute({});
    const floor = books.find((b) => b.portfolioId === -8);
    expect(floor?.open).toEqual({ positions: 25, notionalUsd: 25000, openPnlUsd: -1992.58 });
    expect(floor?.closed.avgBp).toBe(-6);
    expect(books.find((b) => b.portfolioId === -3)?.open.positions).toBe(0);
  });

  it('throws when a book cannot be read, never reports it empty', async () => {
    jest.doMock('@/lib/db/postgres', () => ({ query: async () => [] }));
    jest.doMock('@/lib/db/book-row-stats', () => ({ bookRowStats: async () => null }));
    const { getPaperBooks } = await import('@/lib/services/ai/tools/db-tools');
    await expect(getPaperBooks.execute({})).rejects.toThrow(/could not read/);
  });
});
