/**
 * The Hedera pool's value history: the value holds between deposits, so a
 * window with no events still shows the pool's value, and a failed read is an
 * error, never an empty history.
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import { keccak256, toHex } from 'viem';
import { NextRequest } from 'next/server';

jest.mock('@/lib/utils/origin-cache', () => ({ withOriginCache: (_o: unknown, h: unknown) => h }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { GET } from '@/app/api/hedera/nav-history/route';

const DEPOSITED = keccak256(toHex('Deposited(address,uint256,uint256)'));
const word = (n: number) => BigInt(n * 1e6).toString(16).padStart(64, '0');
const deposit = (usd: number, at: number) => ({ data: `0x${word(usd)}${word(usd)}`, topics: [DEPOSITED], timestamp: `${at}.000000000`, transaction_hash: '0x' });
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);
const realFetch = global.fetch;
let pages: Array<{ status?: number; body?: unknown }> = [];

beforeEach(() => {
  global.fetch = jest.fn(async () => {
    const p = pages.shift()!;
    return new Response(JSON.stringify(p.body ?? {}), { status: p.status ?? 200 });
  }) as typeof fetch;
});
afterAll(() => { global.fetch = realFetch; });

const get = async (window: string) => {
  const r = await GET(new NextRequest(`http://x/api/hedera/nav-history?window=${window}`));
  return { status: r.status, body: (await r.json()) as { points: Array<{ t: string; navUsd: number }>; last?: { navUsd: number }; error?: string } };
};

describe('hedera nav history', () => {
  it('a month with no events shows the value carried from before it, up to now', async () => {
    pages = [{ body: { logs: [deposit(25, now - 60 * DAY), deposit(10_000, now - 50 * DAY)] } }];
    const { status, body } = await get('30d');
    expect(status).toBe(200);
    expect(body.points.map((p) => p.navUsd)).toEqual([10_025, 10_025]);
    expect(body.last?.navUsd).toBe(10_025);
    expect(Date.parse(body.points[0].t)).toBeGreaterThan((now - 31 * DAY) * 1000);
  });

  it('reads every page of events', async () => {
    pages = [
      { body: { logs: [deposit(25, now - 5 * DAY)], links: { next: '/api/v1/next-page' } } },
      { body: { logs: [deposit(75, now - 2 * DAY)], links: { next: null } } },
    ];
    const { body } = await get('all');
    expect(body.points.map((p) => p.navUsd)).toEqual([25, 100, 100]);
  });

  it('a failed read is an error, not an empty pool', async () => {
    pages = [{ status: 503 }];
    const { status, body } = await get('30d');
    expect(status).toBe(502);
    expect(body.error).toMatch(/could not read/);
  });
});
