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

describe('a turn that only promises to act', () => {
  it('is nudged once, so the model calls the tool and answers', async () => {
    const { runWithTools } = await import('@/lib/services/ai/tool-runner');
    const replies = [
      { finish_reason: 'stop', message: { content: "I'll pull the paper records now." } },
      { finish_reason: 'tool_calls', message: { content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'echo', arguments: '{}' } }] } },
      { finish_reason: 'stop', message: { content: 'Every book lost money.' } },
    ];
    const sent: unknown[][] = [];
    const client = { chat: { completions: { create: async (p: { messages: unknown[] }) => { sent.push([...p.messages]); return { choices: [replies.shift()!] }; } } } };
    const tool = { name: 'echo', description: 'test', parameters: { type: 'object', properties: {} }, execute: async () => ({ ok: 1 }) };
    const r = await runWithTools({ systemPrompt: 's', userPrompt: 'how are the books', tools: [tool as never], maxIterations: 2, client: client as never });
    expect(r.finalText).toBe('Every book lost money.');
    expect(r.invocations.map((i) => i.tool)).toEqual(['echo']);
    expect(JSON.stringify(sent[1])).toContain('Do it now');
  });

  it('is left alone when no tools were offered', async () => {
    const { isPromiseToAct } = await import('@/lib/services/ai/tool-runner');
    expect(isPromiseToAct("I'll check that.", 0)).toBe(false);
    expect(isPromiseToAct('Every book lost money after costs.', 3)).toBe(false);
  });
});

describe('paper-book questions', () => {
  it.each([
    'how are the paper books doing?',
    'why did the floor book lose money',
    'is paper trading making anything',
    'what is the lead trader holding',
    'which book should I copy to make money?',
  ])('"%s" reaches get_paper_books', async (q) => {
    const { analyzeMessage } = await import('@/lib/services/ai/message-analyzer');
    const a = analyzeMessage(q);
    expect(a.intent).toBe('paper_books');
    expect(a.suggestedTools).toContain('get_paper_books');
  });

  it('leaves order-book questions to the market tools', async () => {
    const { analyzeMessage } = await import('@/lib/services/ai/message-analyzer');
    expect(analyzeMessage('what does the BTC order book look like').intent).not.toBe('paper_books');
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

  it.each([
    'how is the pool doing?',
    'what is the state of the SUI pool',
    'how much is in the community pool',
    'what is the pool share price',
  ])('"%s" reaches get_pools, not a coin lookup', async (q) => {
    const { analyzeMessage } = await import('@/lib/services/ai/message-analyzer');
    expect(analyzeMessage(q).suggestedTools[0]).toBe('get_pools');
  });

  it('get_pools reads both pools and fails loudly when a snapshot is missing', async () => {
    const row = { at: '2026-11-03T16:56:57Z', sp: 0.2724, nav: 20.18, members: 3 };
    jest.doMock('@/lib/db/postgres', () => ({
      query: async (sql: string) =>
        sql.includes('community_pool_shares') ? [{ usd: 60.8 }]
          : sql.includes('solana') ? [{ ...row, sp: 0.9994, nav: 10.37 }] : [row],
    }));
    const { getPools } = await import('@/lib/services/ai/tools/db-tools');
    const pools = await getPools.execute({});
    expect(pools.map((p) => [p.network, p.now.navUsd])).toEqual([['SUI mainnet', 20.18], ['Solana devnet', 10.37]]);
    expect(pools[0].membersPaidInUsd).toBe(60.8);
    expect(pools[1].money).toMatch(/no real money/);

    jest.resetModules();
    jest.doMock('@/lib/db/postgres', () => ({ query: async () => [] }));
    const fresh = await import('@/lib/services/ai/tools/db-tools');
    await expect(fresh.getPools.execute({})).rejects.toThrow(/could not read the SUI pool/);
  });

  it('throws when a book cannot be read, never reports it empty', async () => {
    jest.doMock('@/lib/db/postgres', () => ({ query: async () => [] }));
    jest.doMock('@/lib/db/book-row-stats', () => ({ bookRowStats: async () => null }));
    const { getPaperBooks } = await import('@/lib/services/ai/tools/db-tools');
    await expect(getPaperBooks.execute({})).rejects.toThrow(/could not read/);
  });
});
