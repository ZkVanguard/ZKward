/**
 * What the simulated books say on Discord.
 *
 * Three rules, each from something that went wrong:
 *
 * 1. Every paper alert carries `chain: 'paper'`. The alert-response loop
 *    counts KILL alerts without a chain as the live SUI pool's, and three in
 *    an hour shrink that pool's spot. A simulated book halting itself must
 *    never count toward a decision about real funds.
 * 2. A trade is an event, not a warning. Losing closes used to post as WARN,
 *    which put simulated losses in the alert log the defense loop reads.
 * 3. A message has to answer "how is the book doing" on its own: the result
 *    in bp and dollars, how it closed, and the book's last 24 h from its rows
 *    (win rate AND average trade, which only mean something together). A
 *    scoreboard every few hours says the same for both books, including why
 *    a book is quiet.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { bookOpenPositions, bookRowStats, type BookRowStats } from '@/lib/db/book-row-stats';
import { notifyDiscord, type NotifyLevel } from '@/lib/utils/discord-notify';
import { logger } from '@/lib/utils/logger';
import { categorizeCloseReason } from './close-pipeline';
import type { SimulatedCloseResult, SimulatedPosition } from './simulated-executor';
import {
  KEY_SESSION_STARTED_AT,
  PAPER_EXECUTION,
  PAPER_EXIT_MODE,
  PAPER_SCOREBOARD_HOURS,
  PAPER_TARGET_MAX_HOLD_MIN,
  PAPER_TARGET_STOP_BP,
  PAPER_TARGET_TP_BP,
} from './config';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_SCOREBOARD_POSTED = 'paper:scoreboard:last-posted';

/** The books the scoreboard covers: label, portfolio id, and the cron_state keys that explain a quiet book. */
const BOOKS = [
  { label: 'PaperTrader', portfolioId: -3, skipKey: 'paper-trader:last-skip', restingKey: 'paper-trader:resting-entry' },
  { label: 'PaperGated', portfolioId: -4, skipKey: 'paper-gated-trader:last-skip', restingKey: 'paper-gated-trader:resting-entry' },
] as const;

/** Post a paper-book message. Trades and summaries post as one line; alerts keep their context. */
export async function notifyPaper(
  message: string,
  level: NotifyLevel,
  context: Record<string, unknown> = {},
): Promise<void> {
  const routine = level === 'TRADE' || level === 'INFO';
  await notifyDiscord(message, level, routine ? { chain: 'paper' } : { ...context, chain: 'paper' }).catch(() => undefined);
}

const signed = (v: number, digits: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
const usd = (v: number): string => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`;
const price = (v: number): string => `$${v >= 100 ? v.toFixed(2) : v.toFixed(4)}`;

/** `12 trades · 83% wins · avg −3.1 bp · net −$4.20 · exits: 10 target / 1 stop / 1 time` */
export function statsLine(s: BookRowStats): string {
  if (s.trades === 0) return 'no closed trades';
  const other = s.trades - s.takeProfits - s.stops - s.timeLimits;
  const exits = `${s.takeProfits} target / ${s.stops} stop / ${s.timeLimits} time${other > 0 ? ` / ${other} other` : ''}`;
  return `${s.trades} trade${s.trades === 1 ? '' : 's'} · ${Math.round((100 * s.wins) / s.trades)}% wins · avg ${signed(s.avgBp, 1)} bp · net ${usd(s.realizedUsd)} · exits: ${exits}`;
}

export function openMessage(book: string, pos: SimulatedPosition, resting: boolean): string {
  const levels = pos.takeProfitPrice && pos.stopLossPrice
    ? ` · target ${price(pos.takeProfitPrice)} / stop ${price(pos.stopLossPrice)}`
    : pos.stopLossPrice ? ` · stop ${price(pos.stopLossPrice)}` : '';
  return `${book} opened ${pos.asset} ${pos.side} at ${price(pos.entryPrice)} · $${Math.round(pos.notionalUsd)} · ${resting ? 'resting entry filled' : 'market entry'}${levels}`;
}

export function closeMessage(book: string, result: SimulatedCloseResult, reason: string, last24h: BookRowStats | null): string {
  const bp = result.notionalUsd > 0 ? (result.realizedPnlUsd / result.notionalUsd) * 10_000 : 0;
  const head = `${result.realizedPnlUsd > 0 ? '✅' : '🔻'} ${book} closed ${result.asset} ${result.side} · ${categorizeCloseReason(reason)} · ${signed(bp, 1)} bp (${usd(result.realizedPnlUsd)}) · held ${Math.round(result.holdSeconds / 60)} min`;
  return last24h && last24h.trades > 0 ? `${head}\n${book} last 24 h: ${statsLine(last24h)}` : head;
}

/** Announce a fill. Never throws. */
export async function notifyPaperOpen(book: string, pos: SimulatedPosition, resting: boolean): Promise<void> {
  await notifyPaper(openMessage(book, pos, resting), 'TRADE');
}

/** Announce a close with the book's last 24 h from its rows (the row for this close is already settled). Never throws. */
export async function notifyPaperClose(
  book: string,
  portfolioId: number,
  result: SimulatedCloseResult,
  reason: string,
  now: number,
): Promise<void> {
  const last24h = await bookRowStats(portfolioId, now - DAY_MS);
  await notifyPaper(closeMessage(book, result, reason, last24h), 'TRADE');
}

function policyLine(): string {
  const exits = PAPER_EXIT_MODE === 'target'
    ? `target +${PAPER_TARGET_TP_BP} bp / stop −${PAPER_TARGET_STOP_BP} bp / ${Math.round(PAPER_TARGET_MAX_HOLD_MIN / 60)} h limit`
    : 'adaptive exits';
  return `${exits} · ${PAPER_EXECUTION} orders`;
}

export interface ScoreboardBook {
  label: string;
  day: BookRowStats | null;
  week: BookRowStats | null;
  open: Array<{ asset: string; side: string; ageMin: number }>;
  resting: { asset: string; side: string } | null;
  lastSkip: { at: number; reason: string } | null;
}

/** `longLabel` names the longer window: '7 d', or the session start when a NAV reset is more recent than that. */
export function scoreboardMessage(books: ScoreboardBook[], now: number, longLabel: string = '7 d'): string {
  const lines = [`📊 **Paper books** (${policyLine()})`];
  for (const b of books) {
    lines.push(`**${b.label}** 24 h: ${b.day ? statsLine(b.day) : 'rows unavailable'}`);
    if (b.week && b.week.trades > (b.day?.trades ?? 0)) lines.push(`> ${longLabel}: ${statsLine(b.week)}`);
    const open = b.open.map((p) => `${p.asset} ${p.side} (${p.ageMin} min)`);
    if (b.resting) open.push(`${b.resting.asset} ${b.resting.side} (resting entry)`);
    if (open.length) lines.push(`> open: ${open.join(', ')}`);
    else if (b.lastSkip) lines.push(`> flat · last skip ${Math.round((now - b.lastSkip.at) / 60_000)} min ago: ${b.lastSkip.reason.slice(0, 140)}`);
    else lines.push('> flat');
  }
  return lines.join('\n');
}

/**
 * Post the scoreboard once every PAPER_SCOREBOARD_HOURS (0 = never). Called
 * from the book's tick; never throws.
 */
export async function postPaperScoreboardIfDue(now: number = Date.now()): Promise<void> {
  if (!(PAPER_SCOREBOARD_HOURS > 0)) return;
  try {
    const last = Number(await getCronState<number>(KEY_SCOREBOARD_POSTED)) || 0;
    if (now - last < PAPER_SCOREBOARD_HOURS * 60 * 60 * 1000) return;
    await setCronState(KEY_SCOREBOARD_POSTED, now);

    // Rows keep their portfolio id across a NAV reset, so the longer window
    // stops at the session start: older rows belong to a different book.
    const sessionStart = Number(await getCronState<number>(KEY_SESSION_STARTED_AT).catch(() => 0)) || 0;
    const longSince = Math.max(now - 7 * DAY_MS, sessionStart);
    const longLabel = longSince > now - 7 * DAY_MS ? `since ${new Date(longSince).toISOString().slice(0, 10)}` : '7 d';

    const positions = await bookOpenPositions(BOOKS.map((b) => b.portfolioId));
    const books: ScoreboardBook[] = await Promise.all(
      BOOKS.map(async (b) => {
        const [day, week, skip, resting] = await Promise.all([
          bookRowStats(b.portfolioId, now - DAY_MS),
          bookRowStats(b.portfolioId, longSince),
          getCronState<{ at: number; reason: string }>(b.skipKey).catch(() => null),
          getCronState<{ plan?: { asset: string; side: string }; expiresAt?: number }>(b.restingKey).catch(() => null),
        ]);
        return {
          label: b.label,
          day,
          week,
          open: positions.filter((p) => p.portfolioId === b.portfolioId).map((p) => ({ asset: p.asset, side: p.side, ageMin: Math.round((now - p.openedAtMs) / 60_000) })),
          resting: resting?.plan && (resting.expiresAt ?? 0) > now ? { asset: resting.plan.asset, side: resting.plan.side } : null,
          lastSkip: skip?.reason ? { at: Number(skip.at) || now, reason: skip.reason } : null,
        };
      }),
    );
    await notifyPaper(scoreboardMessage(books, now, longLabel), 'INFO');
  } catch (e) {
    logger.warn('[PaperNotify] scoreboard failed', { error: e instanceof Error ? e.message : String(e) });
  }
}
