/**
 * Browser-side pieces that keep the dashboard fluid and debuggable: the data
 * kept across a reload, the error reporter and the crash strings.
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { QueryClient } from '@tanstack/react-query';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { MAX_AGE_MS, PERSISTED_KEYS, restoreQueries, saveQueries } from '@/lib/utils/query-persist';
import { _resetReporterForTest, admit, isForeignSource } from '@/lib/utils/client-error-reporter';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

describe('query persistence', () => {
  it('keeps pool-wide reads and nothing keyed by a wallet', () => {
    const a = client();
    a.setQueryData(['solana-pool-status'], { members: 3 });
    a.setQueryData(['nav-history', 'sui', '30d', 'hour'], [1, 2]);
    a.setQueryData(['positions', '0xabc'], [{ secret: true }]);
    a.setQueryData(['unified-portfolio', '0xabc'], { total: 1 });
    const store = memory();
    saveQueries(a, store);
    expect([...store.m.values()].join('')).not.toContain('0xabc');

    const b = client();
    expect(restoreQueries(b, store)).toBe(2);
    expect(b.getQueryData(['solana-pool-status'])).toEqual({ members: 3 });
    expect(b.getQueryData(['nav-history', 'sui', '30d', 'hour'])).toEqual([1, 2]);
    expect(b.getQueryData(['positions', '0xabc'])).toBeUndefined();
  });

  it('does not restore what is older than the limit', () => {
    const a = client();
    a.setQueryData(['paper-trader-status'], { ok: true });
    const store = memory();
    saveQueries(a, store);
    const b = client();
    expect(restoreQueries(b, store, Date.now() + MAX_AGE_MS + 1000)).toBe(0);
    expect(b.getQueryData(['paper-trader-status'])).toBeUndefined();
  });

  it('a restored read keeps its real age, so it is refetched', () => {
    const a = client();
    a.setQueryData(['per-asset-signals'], { BTC: 1 }, { updatedAt: Date.now() - 5 * 60_000 });
    const store = memory();
    saveQueries(a, store);
    const b = client();
    restoreQueries(b, store);
    expect(Date.now() - b.getQueryState(['per-asset-signals'])!.dataUpdatedAt).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it('never overwrites data already fetched, and survives a broken store', () => {
    const a = client();
    a.setQueryData(['leaderboard'], ['old']);
    const store = memory();
    saveQueries(a, store);
    const b = client();
    b.setQueryData(['leaderboard'], ['fresh']);
    restoreQueries(b, store);
    expect(b.getQueryData(['leaderboard'])).toEqual(['fresh']);
    expect(restoreQueries(client(), { getItem: () => '{not json' })).toBe(0);
    expect(() => saveQueries(a, { setItem: () => { throw new Error('quota'); } })).not.toThrow();
  });

  it('the persisted list holds no per-wallet key', () => {
    for (const key of ['positions', 'hedges', 'unified-portfolio', 'sui-admin-wallet']) expect(PERSISTED_KEYS).not.toContain(key);
  });
});

describe('client error reporter', () => {
  beforeEach(() => _resetReporterForTest());

  it('sends the same error once and stops after ten per page load', () => {
    expect(admit({ kind: 'error', message: 'boom' })).toBe(true);
    expect(admit({ kind: 'error', message: 'boom' })).toBe(false);
    for (let i = 0; i < 9; i++) expect(admit({ kind: 'error', message: `e${i}` })).toBe(true);
    expect(admit({ kind: 'error', message: 'one too many' })).toBe(false);
  });

  it('the same failing endpoint is one report per path', () => {
    expect(admit({ kind: 'api', message: '/api/x answered 500', apiPath: '/api/x?a=1' })).toBe(true);
    expect(admit({ kind: 'api', message: '/api/x answered 500', apiPath: '/api/x?a=2' })).toBe(true);
    expect(admit({ kind: 'api', message: '/api/x answered 500', apiPath: '/api/x?a=1' })).toBe(false);
  });

  it('ignores errors thrown by a browser extension', () => {
    expect(isForeignSource('chrome-extension://abc/contentscript.js')).toBe(true);
    expect(isForeignSource('moz-extension://abc/x.js')).toBe(true);
    expect(isForeignSource('https://www.zkward.com/_next/static/chunks/1.js')).toBe(false);
    expect(isForeignSource(undefined)).toBe(false);
  });
});

describe('crash screen strings', () => {
  it('every locale has the four strings, with the reference placeholder', () => {
    const dir = join(process.cwd(), 'messages');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(13);
    for (const f of files) {
      const crash = JSON.parse(readFileSync(join(dir, f), 'utf8')).crash;
      expect(Object.keys(crash).sort()).toEqual(['body', 'reference', 'retry', 'title']);
      expect(crash.reference).toContain('{id}');
    }
  });
});
