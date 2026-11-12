/**
 * The hourly watchdog. Its deploy alarm must ask about the repository that
 * exists and treat a refused answer as an error, and its integrity check
 * removes dust flags whose hedge is closed instead of warning about them on
 * every run.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const state = new Map<string, unknown>();
const deleted: string[] = [];
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateOr: jest.fn(async (k: string, d: unknown) => (state.has(k) ? state.get(k) : d)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
  getCronStateByPrefix: jest.fn(async (p: string) => new Map([...state].filter(([k]) => k.startsWith(p)))),
  deleteCronState: jest.fn(async (k: string) => { deleted.push(k); state.delete(k); }),
}));
const active = jest.fn<() => Promise<Array<{ id: number }>>>();
jest.mock('@/lib/db/hedges', () => ({ getActiveHedges: () => active() }));
const notify = jest.fn(async (..._args: unknown[]) => {});
jest.mock('@/lib/utils/discord-notify', () => ({ notifyDiscord: (...args: unknown[]) => notify(...args) }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { runWatchdogChecks } from '@/lib/services/deploy-watchdog/run';

const SHA = '0abe2142aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const urls: string[] = [];
let githubStatus = 200;

beforeEach(() => {
  jest.clearAllMocks();
  state.clear();
  deleted.length = 0;
  urls.length = 0;
  githubStatus = 200;
  active.mockResolvedValue([]);
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify({ commit: { sha: SHA, commit: { committer: { date: new Date().toISOString() } } } }), { status: githubStatus });
    }
    return new Response(JSON.stringify({ build: { commit: SHA } }), { status: 200 });
  }) as unknown as typeof fetch;
});

const warned = () => notify.mock.calls.filter(([msg]) => String(msg).includes('State-integrity'));

describe('deploy alarm', () => {
  it('asks GitHub about the repository that exists', async () => {
    const r = await runWatchdogChecks();
    expect(urls.some((u) => u.includes('/repos/ZkVanguard/ZKward/branches/main'))).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.drifted).toBe(false);
  });

  it('a refused answer is an error, not a quiet pass', async () => {
    githubStatus = 404;
    const r = await runWatchdogChecks();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GitHub answered 404/);
  });
});

describe('integrity check', () => {
  it('removes the dust flag of a closed hedge and keeps the one on an open hedge, without a warning', async () => {
    const now = Date.now();
    state.set('stale-dust-flag:190', now - 30 * 86_400_000);
    state.set('stale-dust-flag:7', now - 60_000);
    active.mockResolvedValue([{ id: 7 }]);
    const r = await runWatchdogChecks(now);
    expect(deleted).toEqual(['stale-dust-flag:190']);
    expect(state.has('stale-dust-flag:7')).toBe(true);
    expect(r.integrityViolations).toBe(0);
    expect(warned()).toHaveLength(0);
  });

  it('still warns about drift that is not a leftover flag', async () => {
    const now = Date.now();
    state.set('stale-dust-flag:7', 1); // a flag on an open hedge that never aged out
    active.mockResolvedValue([{ id: 7 }]);
    const r = await runWatchdogChecks(now);
    expect(r.integrityViolations).toBe(1);
    expect(warned()).toHaveLength(1);
    expect(deleted).toEqual([]);
  });

  it('an unread hedges table removes nothing and is reported as an error', async () => {
    state.set('stale-dust-flag:7', Date.now());
    active.mockRejectedValue(new Error('db down'));
    const r = await runWatchdogChecks();
    expect(deleted).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/integrity: db down/);
  });
});
