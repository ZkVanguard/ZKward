/**
 * A condition that persists is posted when it starts and then once per
 * cool-down with the count of repeats it replaced — not on every cron tick.
 * Trades and summaries always post. Every occurrence still reaches the alert
 * log, because the defense loop counts them.
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';

let store: Record<string, any> = {};
const mockGet = jest.fn<any>(async (k: string) => store[k] ?? null);
const mockSet = jest.fn<any>(async (k: string, v: unknown) => { store[k] = v; });
jest.mock('@/lib/db/cron-state', () => ({
  getCronState: (...a: any[]) => mockGet(...a),
  setCronState: (...a: any[]) => mockSet(...a),
}));

import { notifyDiscord, repeatDecision, repeatFingerprint, type RepeatState } from '@/lib/utils/discord-notify';

const HOUR = 60 * 60 * 1000;
const posts: string[] = [];
const realFetch = global.fetch;

beforeEach(() => {
  store = {};
  posts.length = 0;
  mockGet.mockImplementation(async (k: string) => store[k] ?? null);
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/webhook';
  delete process.env.CRON_STATE_REDIS_READ;
  global.fetch = jest.fn(async (_url: any, init: any) => {
    posts.push(JSON.parse(init.body).content);
    return { ok: true, status: 204 } as Response;
  }) as any;
});
afterAll(() => {
  global.fetch = realFetch;
  delete process.env.DISCORD_WEBHOOK_URL;
});

describe('repeatFingerprint', () => {
  it('the same alert with different numbers is the same alert', () => {
    expect(repeatFingerprint('WARN', 'Profit-lock ACTIVE: NAV $13.93 is 15.9% below peak $16.56.'))
      .toBe(repeatFingerprint('WARN', 'Profit-lock ACTIVE: NAV $13.71 is 17.2% below peak $16.56.'));
  });
  it('a different asset, level or wording is a different alert', () => {
    expect(repeatFingerprint('WARN', '1 stale hedge: #5 SUI LONG age=124.2d')).not.toBe(repeatFingerprint('WARN', '1 stale hedge: #9 ETH LONG age=3.0d'));
    expect(repeatFingerprint('WARN', 'x failed')).not.toBe(repeatFingerprint('ERROR', 'x failed'));
  });
});

describe('repeatDecision', () => {
  it('posts the first time, holds repeats inside the cool-down and counts them', () => {
    let state: RepeatState = {};
    const first = repeatDecision(state, 'k', 1000, 6 * HOUR);
    expect(first).toMatchObject({ post: true, held: 0 });
    state = first.next;
    for (let i = 1; i <= 3; i++) {
      const d = repeatDecision(state, 'k', 1000 + i * 300_000, 6 * HOUR);
      expect(d).toMatchObject({ post: false, held: i });
      state = d.next;
    }
    const after = repeatDecision(state, 'k', 1000 + 6 * HOUR, 6 * HOUR);
    expect(after).toMatchObject({ post: true, held: 3 });
    expect(after.next.k).toEqual({ sentAt: 1000 + 6 * HOUR, held: 0 });
  });

  it('keys are independent and entries older than a day are forgotten', () => {
    const state: RepeatState = { old: { sentAt: 0, held: 9 }, a: { sentAt: 25 * HOUR, held: 0 } };
    const d = repeatDecision(state, 'b', 25 * HOUR + 1, 6 * HOUR);
    expect(d.post).toBe(true);
    expect(Object.keys(d.next).sort()).toEqual(['a', 'b']);
  });
});

describe('notifyDiscord', () => {
  it('a repeating WARN reaches Discord once, and the alert log every time', async () => {
    for (let i = 0; i < 5; i++) await notifyDiscord(`2 stale hedge(s) detected [auto-closing]: #5 SUI LONG age=${124 + i}.2d`, 'WARN');
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(1);
    expect(store['discord:repeat-state'][repeatFingerprint('WARN', '2 stale hedge(s) detected [auto-closing]: #5 SUI LONG age=124.2d')].held).toBe(4);
    expect(store['alert-log:ring-buffer']).toHaveLength(5);
  });

  it('the post after the cool-down says how many repeats were held', async () => {
    const key = repeatFingerprint('ERROR', 'RPC provider a failed');
    store['discord:repeat-state'] = { [key]: { sentAt: Date.now() - 7 * HOUR, held: 41 } };
    await notifyDiscord('RPC provider a failed', 'ERROR');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('41 repeats of this alert since the last post');
  });

  it('trades and summaries are events: identical ones all post', async () => {
    for (let i = 0; i < 3; i++) await notifyDiscord('PaperGated closed BTC LONG · take-profit · +16.4 bp', 'TRADE');
    await notifyDiscord('scoreboard', 'INFO');
    await notifyDiscord('scoreboard', 'INFO');
    expect(posts).toHaveLength(5);
  });

  it('posts anyway when the repeat state cannot be read', async () => {
    mockGet.mockImplementation(async (k: string) => { if (k === 'discord:repeat-state') throw new Error('db down'); return store[k] ?? null; });
    await notifyDiscord('something is wrong', 'KILL');
    await notifyDiscord('something is wrong', 'KILL');
    expect(posts).toHaveLength(2);
  });

  it('shows the context but not the routing tag', async () => {
    await notifyDiscord('halted', 'KILL', { chain: 'paper', lossCount: 3 });
    await notifyDiscord('opened', 'TRADE', { chain: 'paper' });
    expect(posts[0]).toContain('"lossCount": 3');
    expect(posts[0]).not.toContain('chain');
    expect(posts[1]).not.toContain('```');
  });
});
