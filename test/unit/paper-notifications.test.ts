/**
 * Paper-book messages: tagged so they can never count toward the live pool's
 * defense rules, a trade is never a warning, and each message carries the
 * numbers that say how the book is doing (win rate together with the average
 * trade).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const mockNotify = jest.fn<any>(async () => undefined);
jest.mock('@/lib/utils/discord-notify', () => ({ notifyDiscord: (...a: any[]) => mockNotify(...a) }));
let store: Record<string, any> = {};
jest.mock('@/lib/db/cron-state', () => ({
  getCronState: jest.fn(async (k: string) => store[k] ?? null),
  setCronState: jest.fn(async (k: string, v: unknown) => { store[k] = v; }),
}));
const mockStats = jest.fn<any>();
const mockOpen = jest.fn<any>(async () => []);
jest.mock('@/lib/db/book-row-stats', () => ({
  bookRowStats: (...a: any[]) => mockStats(...a),
  bookOpenPositions: (...a: any[]) => mockOpen(...a),
}));

import {
  closeMessage,
  notifyPaper,
  notifyPaperClose,
  openMessage,
  postPaperScoreboardIfDue,
  scoreboardMessage,
  statsLine,
} from '@/lib/services/paper-trader/notifications';
import { evaluateAutoResponse } from '@/lib/services/alerting/alert-response-loop';
import type { BookRowStats } from '@/lib/db/book-row-stats';
import type { SimulatedCloseResult, SimulatedPosition } from '@/lib/services/paper-trader/simulated-executor';

const NOW = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;
const stats = (over: Partial<BookRowStats> = {}): BookRowStats =>
  ({ trades: 12, wins: 10, losses: 2, realizedUsd: -4.2, avgBp: -3.1, takeProfits: 10, stops: 1, timeLimits: 1, ...over });
const closed = (over: Partial<SimulatedCloseResult> = {}): SimulatedCloseResult => ({
  asset: 'BTC', side: 'LONG', entryPrice: 84_173.25, exitPrice: 84_383.68, notionalUsd: 3660, size: 0.0435, holdSeconds: 69 * 60,
  grossPnlUsd: 9.15, openFeeUsd: 2.38, closeFeeUsd: 0.37, slippageUsd: 0.37, fundingUsd: -0.02, realizedPnlUsd: 6.01, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  store = {};
  mockStats.mockResolvedValue(stats());
  mockOpen.mockResolvedValue([]);
});

describe('notifyPaper', () => {
  it('tags every level with chain "paper"', async () => {
    await notifyPaper('halted', 'KILL', { lossCount: 3 });
    await notifyPaper('opened', 'TRADE', { asset: 'BTC' });
    expect(mockNotify.mock.calls[0]).toEqual(['halted', 'KILL', { lossCount: 3, chain: 'paper' }]);
    expect(mockNotify.mock.calls[1]).toEqual(['opened', 'TRADE', { chain: 'paper' }]);
  });

  it('three paper KILL alerts in an hour do not shrink the live pool; three untagged ones do', async () => {
    const kills = (chain?: string) => [1, 2, 3].map((i) => ({ at: NOW - i * 60_000, level: 'KILL' as const, message: 'Paper HALT', chain }));
    expect(await evaluateAutoResponse({ alertLog: kills('paper'), now: NOW })).toEqual([]);
    expect((await evaluateAutoResponse({ alertLog: kills(undefined), now: NOW })).map((r) => r.type)).toContain('SHRINK_SPOT');
  });

  it('nothing in the paper-trader folder posts to Discord except through this module', () => {
    const dir = path.join(process.cwd(), 'lib/services/paper-trader');
    const direct = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && f !== 'notifications.ts')
      .filter((f) => /discord-notify/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(direct).toEqual([]);
  });
});

describe('messages', () => {
  it('a close says what it made in bp and dollars, how it closed, how long it took, and the book record', () => {
    const msg = closeMessage('PaperGated', closed(), 'take-profit: mark $84410.2200 reached $84383.6830', stats());
    expect(msg).toBe(
      '✅ PaperGated closed BTC LONG · take-profit · +16.4 bp (+$6.01) · held 69 min\n'
      + 'PaperGated last 24 h: 12 trades · 83% wins · avg −3.1 bp · net −$4.20 · exits: 10 target / 1 stop / 1 time',
    );
  });

  it('a loss is marked as a loss and still reads the same way', () => {
    const msg = closeMessage('PaperTrader', closed({ realizedPnlUsd: -78.5, exitPrice: 82_489 }), 'stop-loss: mark crossed', null);
    expect(msg).toBe('🔻 PaperTrader closed BTC LONG · stop-loss · −214.5 bp (−$78.50) · held 69 min');
  });

  it('a close posts as a TRADE whether it won or lost', async () => {
    await notifyPaperClose('PaperTrader', -3, closed({ realizedPnlUsd: -78.5 }), 'stop-loss: x', NOW);
    expect(mockNotify.mock.calls[0][1]).toBe('TRADE');
    expect(mockStats).toHaveBeenCalledWith(-3, NOW - 24 * HOUR);
  });

  it('an open says where, how big, how it filled and where it will close', () => {
    const pos = { asset: 'BTC', side: 'LONG', entryPrice: 84_173.25, notionalUsd: 3660.4, takeProfitPrice: 84_383.68, stopLossPrice: 82_489.79 } as SimulatedPosition;
    expect(openMessage('PaperGated', pos, true)).toBe('PaperGated opened BTC LONG at $84173.25 · $3660 · resting entry filled · target $84383.68 / stop $82489.79');
    expect(openMessage('PaperGated', { ...pos, takeProfitPrice: undefined } as SimulatedPosition, false)).toContain('market entry · stop $82489.79');
  });

  it('the stats line never shows a win rate without the average trade', () => {
    expect(statsLine(stats())).toMatch(/83% wins · avg −3\.1 bp/);
    expect(statsLine(stats({ trades: 0 }))).toBe('no closed trades');
    expect(statsLine(stats({ trades: 13 }))).toContain('/ 1 other');
  });
});

describe('scoreboard', () => {
  it('shows both books, what is open, and why a flat book is flat', () => {
    const msg = scoreboardMessage([
      { label: 'PaperTrader', day: stats(), week: stats({ trades: 49, wins: 19, avgBp: -11.8, realizedUsd: -26.51, takeProfits: 12, stops: 3, timeLimits: 30 }), open: [], resting: null, lastSkip: { at: NOW - 7 * 60_000, reason: 'no edge above gates' } },
      { label: 'PaperGated', day: stats({ trades: 0 }), week: null, open: [{ asset: 'BTC', side: 'LONG', ageMin: 22 }], resting: { asset: 'ETH', side: 'SHORT' }, lastSkip: null },
    ], NOW);
    expect(msg).toContain('**PaperTrader** 24 h: 12 trades · 83% wins · avg −3.1 bp');
    expect(msg).toContain('7 d: 49 trades · 39% wins · avg −11.8 bp');
    expect(msg).toContain('flat · last skip 7 min ago: no edge above gates');
    expect(msg).toContain('**PaperGated** 24 h: no closed trades');
    expect(msg).toContain('open: BTC LONG (22 min), ETH SHORT (resting entry)');
  });

  it('posts once per interval, from rows', async () => {
    mockOpen.mockResolvedValue([{ portfolioId: -4, asset: 'BTC', side: 'LONG', openedAtMs: NOW - 22 * 60_000 }]);
    await postPaperScoreboardIfDue(NOW);
    await postPaperScoreboardIfDue(NOW + 5 * 60_000);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify.mock.calls[0][1]).toBe('INFO');
    expect(mockNotify.mock.calls[0][0]).toContain('open: BTC LONG (22 min)');
    await postPaperScoreboardIfDue(NOW + 6 * HOUR);
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });

  it('the longer window stops at the session start: rows from before a NAV reset are another book', async () => {
    store['paper-trader:session-started-at'] = NOW - 3 * 24 * HOUR;
    mockStats.mockImplementation(async (_id: number, since: number) => stats({ trades: since === NOW - 24 * HOUR ? 12 : 30 }));
    await postPaperScoreboardIfDue(NOW);
    expect(mockStats).toHaveBeenCalledWith(-3, NOW - 3 * 24 * HOUR);
    expect(mockStats).not.toHaveBeenCalledWith(-3, NOW - 7 * 24 * HOUR);
    expect(mockNotify.mock.calls[0][0]).toContain(`since ${new Date(NOW - 3 * 24 * HOUR).toISOString().slice(0, 10)}: 30 trades`);
  });

  it('a failed read posts nothing and does not throw', async () => {
    mockOpen.mockRejectedValue(new Error('db down'));
    await expect(postPaperScoreboardIfDue(NOW)).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
