/**
 * Paper-book messages: tagged so they can never count toward the live pool's
 * defense rules, a trade is never a warning, and every card answers at a
 * glance which way the market leans, whether the book is long or short, and
 * whether it is making money (win rate always with the average trade).
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
const mockSignals = jest.fn<any>();
jest.mock('@/lib/services/market-data/live-signals', () => ({ getLiveAssetSignals: (...a: any[]) => mockSignals(...a) }));
const PRICES: Record<string, { price: number; change24h: number }> = {
  BTC: { price: 84_496.28, change24h: -0.0015 },
  ETH: { price: 2_655.2, change24h: 0.0123 },
};
jest.mock('@/lib/services/market-data/unified-price-provider', () => ({
  getLivePrice: jest.fn(async (a: string) => PRICES[a]?.price ?? 0),
  getUnifiedPriceProvider: () => ({ getPrice: (a: string) => PRICES[a] ?? null }),
}));

import {
  closeEmbed,
  MARKET_FIELD,
  notifyPaper,
  notifyPaperClose,
  notifyPaperOpen,
  openEmbed,
  postPaperScoreboardIfDue,
  scoreboardEmbed,
  evidenceLine,
  EVIDENCE_FIELD,
  statsLine,
  type Scoreboard,
} from '@/lib/services/paper-trader/notifications';
import { PAPER_SCOREBOARD_HOURS } from '@/lib/services/paper-trader/config';
import { evaluateAutoResponse } from '@/lib/services/alerting/alert-response-loop';
import type { BookRowStats } from '@/lib/db/book-row-stats';
import type { SimulatedCloseResult, SimulatedPosition } from '@/lib/services/paper-trader/simulated-executor';

const GREEN = 0x22c55e;
const RED = 0xef4444;
const NOW = 1_790_000_000_000;
const HOUR = 60 * 60 * 1000;
const stats = (over: Partial<BookRowStats> = {}): BookRowStats =>
  ({ trades: 12, wins: 10, losses: 2, realizedUsd: -4.2, avgBp: -3.1, takeProfits: 10, stops: 1, timeLimits: 1, ...over });
const closed = (over: Partial<SimulatedCloseResult> = {}): SimulatedCloseResult => ({
  asset: 'BTC', side: 'LONG', entryPrice: 84_173.25, exitPrice: 84_383.68, notionalUsd: 3660, size: 0.0435, holdSeconds: 69 * 60,
  grossPnlUsd: 9.15, openFeeUsd: 2.38, closeFeeUsd: 0.37, slippageUsd: 0.37, fundingUsd: -0.02, realizedPnlUsd: 6.01, ...over,
});
const position = (over: Partial<SimulatedPosition> = {}): SimulatedPosition => ({
  asset: 'BTC', side: 'LONG', entryPrice: 84_173.25, size: 0.0435, notionalUsd: 3660.4, leverage: 1, openedAt: NOW, openFeeUsd: 0.37,
  takeProfitPrice: 84_383.68, stopLossPrice: 82_489.79, entryConfidence: 80.9, ...over,
});
const field = (embed: { fields?: Array<{ name: string; value: string }> }, name: string) => embed.fields?.find((f) => f.name === name)?.value;

beforeEach(() => {
  jest.clearAllMocks();
  store = {};
  mockStats.mockResolvedValue(stats());
  mockOpen.mockResolvedValue([]);
  mockSignals.mockResolvedValue({ BTC: { direction: 'UP', confidence: 72, recommendation: 'HEDGE_LONG' }, ETH: { direction: 'DOWN', confidence: 75, recommendation: 'HEDGE_SHORT' } });
});

describe('notifyPaper', () => {
  it('tags every level with chain "paper"', async () => {
    await notifyPaper('halted', 'KILL', { lossCount: 3 });
    await notifyPaper('opened', 'TRADE', { asset: 'BTC' });
    expect(mockNotify.mock.calls[0].slice(0, 3)).toEqual(['halted', 'KILL', { lossCount: 3, chain: 'paper' }]);
    expect(mockNotify.mock.calls[1].slice(0, 3)).toEqual(['opened', 'TRADE', { chain: 'paper' }]);
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

describe('a fill', () => {
  it('a long is a green card, a short a red one, named by side and asset', () => {
    expect(openEmbed('PaperGated', position(), true)).toMatchObject({ title: '🟢 LONG BTC', color: GREEN });
    expect(openEmbed('PaperGated', position({ side: 'SHORT', asset: 'ETH' }), true)).toMatchObject({ title: '🔴 SHORT ETH', color: RED });
  });

  it('shows entry, size, how it filled, where it will close and the signal behind it', () => {
    const e = openEmbed('PaperGated', position(), true);
    expect(field(e, 'Entry')).toBe('$84,173.25');
    expect(field(e, 'Size')).toBe('$3,660');
    expect(field(e, 'Fill')).toBe('resting order');
    expect(field(e, 'Target')).toBe('$84,383.68 (+25 bp)');
    expect(field(e, 'Stop')).toBe('$82,489.79 (−200 bp)');
    expect(field(e, 'Signal')).toBe('▲ up · 81% confidence');
    expect(e.footer?.text).toBe('PaperGated · simulated');
  });

  it('target and stop of a short are counted in its favour; a position without a target shows none', () => {
    const e = openEmbed('PaperTrader', position({ side: 'SHORT', entryPrice: 100, takeProfitPrice: 99.75, stopLossPrice: 102, entryConfidence: undefined }), false);
    expect(field(e, 'Target')).toBe('$99.7500 (+25 bp)');
    expect(field(e, 'Stop')).toBe('$102.00 (−200 bp)');
    expect(field(e, 'Fill')).toBe('market order');
    expect(field(e, 'Signal')).toBeUndefined();
    expect(field(openEmbed('PaperTrader', position({ takeProfitPrice: undefined }), false), 'Target')).toBeUndefined();
  });

  it('posts as a TRADE card', async () => {
    await notifyPaperOpen('PaperGated', position(), true);
    const [message, level, context, embed] = mockNotify.mock.calls[0];
    expect([message, level, context]).toEqual(['PaperGated opened BTC LONG', 'TRADE', { chain: 'paper' }]);
    expect(embed.title).toBe('🟢 LONG BTC');
  });
});

describe('a close', () => {
  it('a profit is a green card that leads with the money', () => {
    const e = closeEmbed('PaperGated', closed(), 'take-profit: mark $84410.2200 reached $84383.6830', stats(), NOW);
    expect(e).toMatchObject({ title: '✅ +$6.01 · BTC LONG closed', color: GREEN });
    expect(field(e, 'Result')).toBe('+16.4 bp after costs');
    expect(field(e, 'Exit')).toBe('take-profit');
    expect(field(e, 'Held')).toBe('69 min');
    expect(field(e, 'Price')).toBe('$84,173.25 → $84,383.68');
    expect(field(e, 'PaperGated · last 24 h')).toBe('🔴 **−$4.20**\n12 trades · 83% wins · avg −3.1 bp\nexits: 10 target / 1 stop / 1 time');
  });

  it('a loss is a red card and reads the same way', () => {
    const e = closeEmbed('PaperTrader', closed({ realizedPnlUsd: -78.5, exitPrice: 82_489 }), 'stop-loss: mark crossed', null, NOW);
    expect(e).toMatchObject({ title: '🔻 −$78.50 · BTC LONG closed', color: RED });
    expect(field(e, 'Result')).toBe('−214.5 bp after costs');
    expect(field(e, 'PaperTrader · last 24 h')).toBeUndefined();
  });

  it('posts as a TRADE whether it won or lost, with the book record from rows', async () => {
    await notifyPaperClose('PaperTrader', -3, closed({ realizedPnlUsd: -78.5 }), 'stop-loss: x', NOW);
    expect(mockNotify.mock.calls[0][1]).toBe('TRADE');
    expect(mockNotify.mock.calls[0][3].color).toBe(RED);
    expect(mockStats).toHaveBeenCalledWith(-3, NOW - 24 * HOUR);
  });

  it('the stats line never shows a win rate without the average trade', () => {
    expect(statsLine(stats())).toMatch(/83% wins · avg −3\.1 bp/);
    expect(statsLine(stats({ trades: 0 }))).toBe('no closed trades');
    expect(statsLine(stats({ trades: 13 }))).toContain('/ 1 other');
  });
});

describe('scoreboard', () => {
  const board = (over: Partial<Scoreboard> = {}): Scoreboard => ({
    market: [
      { asset: 'BTC', direction: 'UP', confidence: 72, price: 84_496.28, change24hPct: -0.15 },
      { asset: 'ETH', direction: 'DOWN', confidence: 75, price: 2_655.2, change24hPct: 1.23 },
      { asset: 'SOL', direction: 'DOWN', confidence: 90 },
      { asset: 'XRP', direction: 'NEUTRAL', confidence: 0 },
    ],
    open: [{ book: 'PaperGated', asset: 'ETH', side: 'SHORT', ageMin: 14, entryPrice: 2_661.14, notionalUsd: 1000, markPrice: 2_655.2 }],
    books: [
      { label: 'PaperTrader', day: stats({ realizedUsd: 12.5 }), long: stats({ trades: 49, wins: 19, avgBp: -11.8, realizedUsd: -26.51 }), resting: { asset: 'XRP', side: 'SHORT', limitPrice: 1.4731 }, lastSkip: null },
      { label: 'PaperGated', day: stats({ trades: 0, realizedUsd: 0 }), long: null, resting: null, lastSkip: { at: NOW - 7 * 60_000, reason: 'no edge above gates' } },
    ],
    longLabel: 'since 2026-09-27',
    ...over,
  });

  it('shows what the ledger has proven only when a judgment is stored', () => {
    const counts = { cellsJudged: 50, familiesJudged: 12, proven: 0, wrongWay: 0, pending: 1 };
    expect(evidenceLine({ day: '2026-10-06', counts })).toBe('62 judged · nothing proven either way · 1 pending · as of 2026-10-06');
    expect(evidenceLine({ day: '2026-10-06', counts: { ...counts, proven: 2, wrongWay: 1, pending: 0 } })).toBe('62 judged · 2 proven · 1 wrong-way · as of 2026-10-06');
    expect(field(scoreboardEmbed(board({ evidence: 'x' }), NOW), EVIDENCE_FIELD)).toBe('x');
    expect(field(scoreboardEmbed(board(), NOW), EVIDENCE_FIELD)).toBeUndefined();
  });

  it('the title leads with the profit and the market lean; the colour follows the profit', () => {
    const e = scoreboardEmbed(board(), NOW);
    expect(e.title).toBe('📊 Paper books +$12.50 in 24 h · open +$2.23 · market leaning down');
    expect(e.color).toBe(GREEN);
    // Booked profit with a larger open loss is a red board.
    const under = board();
    under.open = under.open.map((p) => ({ ...p, markPrice: p.entryPrice * (p.side === 'LONG' ? 0.9 : 1.1) }));
    expect(scoreboardEmbed(under, NOW).color).toBe(RED);
    expect(scoreboardEmbed(board(), NOW).description).toContain('break-even 91% wins before costs');
    expect(scoreboardEmbed(board({ books: [{ label: 'PaperTrader', day: stats(), long: null, resting: null, lastSkip: null }] }), NOW).color).toBe(RED);
  });

  it('shows which way each asset leans, with price and 24 h change when known', () => {
    expect(field(scoreboardEmbed(board(), NOW), MARKET_FIELD)).toBe(
      '**BTC** 🟢 ▲ up 72% · $84,496.28 (−0.15% 24 h)\n'
      + '**ETH** 🔴 ▼ down 75% · $2,655.20 (+1.23% 24 h)\n'
      + '**SOL** 🔴 ▼ down 90%\n'
      + '**XRP** ⚪ no lean',
    );
    expect(field(scoreboardEmbed(board({ market: null }), NOW), MARKET_FIELD)).toBe('signals unavailable');
  });

  it('shows every open position as long or short with its running result, and resting entries', () => {
    expect(field(scoreboardEmbed(board(), NOW), 'Open positions (running, before exit costs)')).toBe(
      '🔴 SHORT **ETH** at $2,661.14 → $2,655.20 · **+22 bp** (+$2.23) · 14 min · PaperGated\n'
      + '⏳ SHORT **XRP** resting at $1.4731 · PaperTrader',
    );
    expect(field(scoreboardEmbed(board({ open: [], books: [{ label: 'PaperGated', day: null, long: null, resting: null, lastSkip: null }] }), NOW), 'Open positions (running, before exit costs)')).toBe('none');
  });

  it('a running result that rounds to zero carries no sign', () => {
    const flat = board({ open: [{ book: 'PaperGated', asset: 'ETH', side: 'SHORT', ageMin: 3, entryPrice: 2_661.14, notionalUsd: 1000, markPrice: 2_661.15 }] });
    expect(field(scoreboardEmbed(flat, NOW), 'Open positions (running, before exit costs)')).toContain('**0 bp**');
  });

  it('shows each book profit first, the longer window, and why a flat book is flat', () => {
    const e = scoreboardEmbed(board({ open: [] }), NOW);
    expect(field(e, 'PaperTrader · 24 h')).toBe('🟢 **+$12.50**\n12 trades · 83% wins · avg −3.1 bp\nexits: 10 target / 1 stop / 1 time');
    expect(field(e, 'PaperTrader · since 2026-09-27')).toContain('🔴 **−$26.51**\n49 trades · 39% wins · avg −11.8 bp');
    expect(field(e, 'PaperGated · 24 h')).toBe('no closed trades\nflat · last skip 7 min ago: no edge above gates');
  });

  it(`posts once per interval (${PAPER_SCOREBOARD_HOURS} h), from rows and live marks`, async () => {
    mockOpen.mockResolvedValue([{ portfolioId: -4, asset: 'ETH', side: 'SHORT', openedAtMs: NOW - 14 * 60_000, entryPrice: 2_661.14, notionalUsd: 1000 }]);
    await postPaperScoreboardIfDue(NOW);
    await postPaperScoreboardIfDue(NOW + 5 * 60_000);
    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [, level, , embed] = mockNotify.mock.calls[0];
    expect(level).toBe('INFO');
    expect(field(embed, MARKET_FIELD)).toContain('**BTC** 🟢 ▲ up 72% · $84,496.28 (−0.15% 24 h)');
    expect(field(embed, 'Open positions (running, before exit costs)')).toContain('🔴 SHORT **ETH** at $2,661.14 → $2,655.20 · **+22 bp**');
    await postPaperScoreboardIfDue(NOW + PAPER_SCOREBOARD_HOURS * HOUR);
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });

  it('the longer window stops at the session start: rows from before a NAV reset are another book', async () => {
    store['paper-trader:session-started-at'] = NOW - 3 * 24 * HOUR;
    mockStats.mockImplementation(async (_id: number, since: number) => stats({ trades: since === NOW - 24 * HOUR ? 12 : 30 }));
    await postPaperScoreboardIfDue(NOW);
    expect(mockStats).toHaveBeenCalledWith(-3, NOW - 3 * 24 * HOUR);
    expect(mockStats).not.toHaveBeenCalledWith(-3, NOW - 7 * 24 * HOUR);
    const label = `PaperTrader · since ${new Date(NOW - 3 * 24 * HOUR).toISOString().slice(0, 10)}`;
    expect(field(mockNotify.mock.calls[0][3], label)).toContain('30 trades');
  });

  it('still posts when the signals cannot be read, and says so', async () => {
    mockSignals.mockRejectedValue(new Error('aggregator down'));
    await postPaperScoreboardIfDue(NOW);
    expect(field(mockNotify.mock.calls[0][3], MARKET_FIELD)).toBe('signals unavailable');
  });

  it('a failed read of the rows posts nothing and does not throw', async () => {
    mockOpen.mockRejectedValue(new Error('db down'));
    await expect(postPaperScoreboardIfDue(NOW)).resolves.toBeUndefined();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
