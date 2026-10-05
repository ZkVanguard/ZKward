/**
 * What the simulated books say on Discord.
 *
 * Rules, each from something that went wrong:
 *
 * 1. Every paper alert carries `chain: 'paper'`. The alert-response loop
 *    counts KILL alerts without a chain as the live SUI pool's, and three in
 *    an hour shrink that pool's spot. A simulated book halting itself must
 *    never count toward a decision about real funds.
 * 2. A trade is an event, not a warning. Losing closes used to post as WARN,
 *    which put simulated losses in the alert log the defense loop reads.
 * 3. A message answers three questions at a glance: which way is the market
 *    leaning, are we long or short, and are we making money. So a fill is a
 *    green (long) or red (short) card, a close is a green (profit) or red
 *    (loss) card with the result in dollars and bp, and the scoreboard shows
 *    the market per asset, every open position with its running result, and
 *    each book's profit from its rows. A win rate is never shown without the
 *    average trade: only together do they say whether a book makes money.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { bookOpenPositions, bookRowStats, type BookRowStats } from '@/lib/db/book-row-stats';
import { notifyDiscord, type DiscordEmbed, type NotifyLevel } from '@/lib/utils/discord-notify';
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
  PAPER_UNIVERSE,
} from './config';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_SCOREBOARD_POSTED = 'paper:scoreboard:last-posted';
const GREEN = 0x22c55e;
const RED = 0xef4444;
const GREY = 0x64748b;
export const MARKET_FIELD = 'Market · signal lean, price, 24 h change';

/** The books the scoreboard covers: label, portfolio id, and the cron_state keys that explain a quiet book. */
const BOOKS = [
  { label: 'PaperTrader', portfolioId: -3, skipKey: 'paper-trader:last-skip', restingKey: 'paper-trader:resting-entry' },
  { label: 'PaperGated', portfolioId: -4, skipKey: 'paper-gated-trader:last-skip', restingKey: 'paper-gated-trader:resting-entry' },
] as const;

/** Post a paper-book message. Trades and summaries post as a card; alerts keep their context. */
export async function notifyPaper(
  message: string,
  level: NotifyLevel,
  context: Record<string, unknown> = {},
  embed?: DiscordEmbed,
): Promise<void> {
  const routine = level === 'TRADE' || level === 'INFO';
  await notifyDiscord(message, level, routine ? { chain: 'paper' } : { ...context, chain: 'paper' }, embed).catch(() => undefined);
}

/** Signed number; a value that rounds to zero carries no sign. */
const signed = (v: number, digits: number): string => {
  const shown = Math.abs(v).toFixed(digits);
  return Number(shown) === 0 ? shown : `${v > 0 ? '+' : '−'}${shown}`;
};
const usd = (v: number): string => `${v >= 0 ? '+' : '−'}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const price = (v: number): string => {
  const digits = v >= 100 ? 2 : 4;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
const sideMark = (side: string): string => (side === 'LONG' ? '🟢 LONG' : '🔴 SHORT');
/** Move from `from` to `to` in bp, counted in the position's favour. */
const favourBp = (side: string, from: number, to: number): number => (from > 0 ? ((to - from) / from) * 10_000 * (side === 'LONG' ? 1 : -1) : 0);

/** `12 trades · 83% wins · avg −3.1 bp` plus the exit mix on a second line. */
export function statsLine(s: BookRowStats): string {
  if (s.trades === 0) return 'no closed trades';
  const other = s.trades - s.takeProfits - s.stops - s.timeLimits;
  const exits = `${s.takeProfits} target / ${s.stops} stop / ${s.timeLimits} time${other > 0 ? ` / ${other} other` : ''}`;
  return `${s.trades} trade${s.trades === 1 ? '' : 's'} · ${Math.round((100 * s.wins) / s.trades)}% wins · avg ${signed(s.avgBp, 1)} bp\nexits: ${exits}`;
}

/** Profit first, then the record behind it. */
function profitBlock(s: BookRowStats | null): string {
  if (!s) return 'rows unavailable';
  if (s.trades === 0) return 'no closed trades';
  return `${s.realizedUsd > 0 ? '🟢' : s.realizedUsd < 0 ? '🔴' : '⚪'} **${usd(s.realizedUsd)}**\n${statsLine(s)}`;
}

/** A fill: green for long, red for short. */
export function openEmbed(book: string, pos: SimulatedPosition, resting: boolean): DiscordEmbed {
  const level = (name: string, p?: number) =>
    p ? [{ name, value: `${price(p)} (${signed(favourBp(pos.side, pos.entryPrice, p), 0)} bp)`, inline: true }] : [];
  return {
    title: `${sideMark(pos.side)} ${pos.asset}`,
    color: pos.side === 'LONG' ? GREEN : RED,
    fields: [
      { name: 'Entry', value: price(pos.entryPrice), inline: true },
      { name: 'Size', value: `$${Math.round(pos.notionalUsd).toLocaleString('en-US')}`, inline: true },
      { name: 'Fill', value: resting ? 'resting order' : 'market order', inline: true },
      ...level('Target', pos.takeProfitPrice),
      ...level('Stop', pos.stopLossPrice),
      ...(pos.entryConfidence
        ? [{ name: 'Signal', value: `${pos.side === 'LONG' ? '▲ up' : '▼ down'} · ${Math.round(pos.entryConfidence)}% confidence`, inline: true }]
        : []),
    ],
    footer: { text: `${book} · simulated` },
    timestamp: new Date(pos.openedAt).toISOString(),
  };
}

/** A close: green for a profit, red for a loss, with the book's last 24 h from its rows. */
export function closeEmbed(
  book: string,
  result: SimulatedCloseResult,
  reason: string,
  last24h: BookRowStats | null,
  now: number,
): DiscordEmbed {
  const won = result.realizedPnlUsd > 0;
  const bp = result.notionalUsd > 0 ? (result.realizedPnlUsd / result.notionalUsd) * 10_000 : 0;
  return {
    title: `${won ? '✅' : '🔻'} ${usd(result.realizedPnlUsd)} · ${result.asset} ${result.side} closed`,
    color: won ? GREEN : RED,
    fields: [
      { name: 'Result', value: `${signed(bp, 1)} bp after costs`, inline: true },
      { name: 'Exit', value: categorizeCloseReason(reason), inline: true },
      { name: 'Held', value: `${Math.round(result.holdSeconds / 60)} min`, inline: true },
      { name: 'Price', value: `${price(result.entryPrice)} → ${price(result.exitPrice)}`, inline: false },
      ...(last24h && last24h.trades > 0 ? [{ name: `${book} · last 24 h`, value: profitBlock(last24h), inline: false }] : []),
    ],
    footer: { text: `${book} · simulated` },
    timestamp: new Date(now).toISOString(),
  };
}

/** Announce a fill. Never throws. */
export async function notifyPaperOpen(book: string, pos: SimulatedPosition, resting: boolean): Promise<void> {
  await notifyPaper(`${book} opened ${pos.asset} ${pos.side}`, 'TRADE', {}, openEmbed(book, pos, resting));
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
  await notifyPaper(`${book} closed ${result.asset} ${result.side} ${usd(result.realizedPnlUsd)}`, 'TRADE', {}, closeEmbed(book, result, reason, last24h, now));
}

function policyLine(): string {
  const exits = PAPER_EXIT_MODE === 'target'
    ? `target +${PAPER_TARGET_TP_BP} bp / stop −${PAPER_TARGET_STOP_BP} bp / ${Math.round(PAPER_TARGET_MAX_HOLD_MIN / 60)} h limit`
    : 'adaptive exits';
  return `${exits} · ${PAPER_EXECUTION} orders`;
}

export interface MarketRow {
  asset: string;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence: number;
  price?: number;
  /** 24-hour price change in percent. */
  change24hPct?: number;
}

export interface OpenRow {
  book: string;
  asset: string;
  side: string;
  ageMin: number;
  entryPrice: number;
  notionalUsd: number;
  /** Live mark; absent when no fresh price was available. */
  markPrice?: number;
}

export interface ScoreboardBook {
  label: string;
  day: BookRowStats | null;
  /** The longer window: seven days, or since the session start when a NAV reset is more recent. */
  long: BookRowStats | null;
  resting: { asset: string; side: string; limitPrice: number } | null;
  lastSkip: { at: number; reason: string } | null;
}

export interface Scoreboard {
  market: MarketRow[] | null;
  open: OpenRow[];
  books: ScoreboardBook[];
  longLabel: string;
  /** What the signal ledger has shown so far, in one line; absent when no judgment is stored. */
  evidence?: string | null;
}

export const EVIDENCE_FIELD = 'Signal evidence (ledger)';

/** One line for the scoreboard from the feedback loop's stored judgment. */
export function evidenceLine(s: { day: string; counts: { cellsJudged: number; familiesJudged: number; proven: number; wrongWay: number; pending: number } }): string {
  const { cellsJudged, familiesJudged, proven, wrongWay, pending } = s.counts;
  const held = proven + wrongWay === 0 ? 'nothing proven either way' : `${proven} proven · ${wrongWay} wrong-way`;
  return `${cellsJudged + familiesJudged} judged · ${held}${pending ? ` · ${pending} pending` : ''} · as of ${s.day}`;
}

function marketLine(m: MarketRow): string {
  const lean = m.direction === 'UP' ? `🟢 ▲ up ${m.confidence}%` : m.direction === 'DOWN' ? `🔴 ▼ down ${m.confidence}%` : '⚪ no lean';
  const px = m.price ? ` · ${price(m.price)}` : '';
  const chg = m.change24hPct !== undefined ? ` (${signed(m.change24hPct, 2)}% 24 h)` : '';
  return `**${m.asset}** ${lean}${px}${chg}`;
}

function openLine(p: OpenRow): string {
  const head = `${sideMark(p.side)} **${p.asset}** at ${price(p.entryPrice)}`;
  if (!p.markPrice) return `${head} · ${p.ageMin} min · ${p.book}`;
  const bp = favourBp(p.side, p.entryPrice, p.markPrice);
  return `${head} → ${price(p.markPrice)} · **${signed(bp, 0)} bp** (${usd((p.notionalUsd * bp) / 10_000)}) · ${p.ageMin} min · ${p.book}`;
}

/** Market lean per asset, open positions with their running result, and each book's profit. */
export function scoreboardEmbed(s: Scoreboard, now: number): DiscordEmbed {
  const dayNet = s.books.reduce((sum, b) => sum + (b.day?.realizedUsd ?? 0), 0);
  const ups = s.market?.filter((m) => m.direction === 'UP').length ?? 0;
  const downs = s.market?.filter((m) => m.direction === 'DOWN').length ?? 0;
  const lean = !s.market ? '' : ups > downs ? ' · market leaning up' : downs > ups ? ' · market leaning down' : ' · market mixed';

  const openLines = s.open.map(openLine);
  for (const b of s.books) {
    if (b.resting) openLines.push(`⏳ ${b.resting.side} **${b.resting.asset}** resting at ${price(b.resting.limitPrice)} · ${b.label}`);
  }

  const fields: NonNullable<DiscordEmbed['fields']> = [
    { name: MARKET_FIELD, value: s.market?.length ? s.market.map(marketLine).join('\n') : 'signals unavailable', inline: false },
    { name: 'Open positions (running, before exit costs)', value: openLines.length ? openLines.slice(0, 10).join('\n') : 'none', inline: false },
  ];
  for (const b of s.books) {
    const flat = !s.open.some((p) => p.book === b.label) && !b.resting && b.lastSkip
      ? `\nflat · last skip ${Math.max(0, Math.round((now - b.lastSkip.at) / 60_000))} min ago: ${b.lastSkip.reason.slice(0, 120)}`
      : '';
    fields.push({ name: `${b.label} · 24 h`, value: `${profitBlock(b.day)}${flat}`.slice(0, 1024), inline: true });
  }
  for (const b of s.books) {
    if (b.long && b.long.trades > (b.day?.trades ?? 0)) fields.push({ name: `${b.label} · ${s.longLabel}`, value: profitBlock(b.long), inline: true });
  }
  if (s.evidence) fields.push({ name: EVIDENCE_FIELD, value: s.evidence, inline: false });

  return {
    title: `📊 Paper books ${usd(dayNet)} in 24 h${lean}`,
    color: dayNet > 0 ? GREEN : dayNet < 0 ? RED : GREY,
    description: policyLine(),
    fields,
    footer: { text: 'simulated · all trading costs included' },
    timestamp: new Date(now).toISOString(),
  };
}

/** Live lean and price per asset. Null when the signals cannot be read: the scoreboard says so instead of guessing. */
async function readMarket(): Promise<{ rows: MarketRow[] | null; marks: Map<string, number> }> {
  const marks = new Map<string, number>();
  try {
    const [{ getLiveAssetSignals }, { getLivePrice, getUnifiedPriceProvider }] = await Promise.all([
      import('@/lib/services/market-data/live-signals'),
      import('@/lib/services/market-data/unified-price-provider'),
    ]);
    const signals = await getLiveAssetSignals(6000);
    const rows: MarketRow[] = [];
    for (const asset of PAPER_UNIVERSE) {
      const px = await getLivePrice(asset).catch(() => 0);
      if (px > 0) marks.set(asset, px);
      // The venue reports the 24 h change as a ratio.
      const change = getUnifiedPriceProvider().getPrice(asset)?.change24h;
      const sig = signals[asset];
      rows.push({
        asset,
        direction: sig?.direction ?? 'NEUTRAL',
        confidence: sig?.confidence ?? 0,
        ...(px > 0 ? { price: px } : {}),
        ...(px > 0 && Number.isFinite(change) ? { change24hPct: (change as number) * 100 } : {}),
      });
    }
    return { rows: Object.keys(signals).length ? rows : null, marks };
  } catch (e) {
    logger.warn('[PaperNotify] market read failed', { error: e instanceof Error ? e.message : String(e) });
    return { rows: null, marks };
  }
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

    const [positions, market] = await Promise.all([bookOpenPositions(BOOKS.map((b) => b.portfolioId)), readMarket()]);
    const books: ScoreboardBook[] = await Promise.all(
      BOOKS.map(async (b) => {
        const [day, long, skip, resting] = await Promise.all([
          bookRowStats(b.portfolioId, now - DAY_MS),
          bookRowStats(b.portfolioId, longSince),
          getCronState<{ at: number; reason: string }>(b.skipKey).catch(() => null),
          getCronState<{ plan?: { asset: string; side: string }; limitPrice?: number; expiresAt?: number }>(b.restingKey).catch(() => null),
        ]);
        return {
          label: b.label,
          day,
          long,
          resting: resting?.plan && (resting.expiresAt ?? 0) > now
            ? { asset: resting.plan.asset, side: resting.plan.side, limitPrice: Number(resting.limitPrice) || 0 }
            : null,
          lastSkip: skip?.reason ? { at: Number(skip.at) || now, reason: skip.reason } : null,
        };
      }),
    );
    const open: OpenRow[] = positions.map((p) => ({
      book: BOOKS.find((b) => b.portfolioId === p.portfolioId)?.label ?? String(p.portfolioId),
      asset: p.asset,
      side: p.side,
      ageMin: Math.round((now - p.openedAtMs) / 60_000),
      entryPrice: p.entryPrice,
      notionalUsd: p.notionalUsd,
      ...(market.marks.has(p.asset) ? { markPrice: market.marks.get(p.asset) } : {}),
    }));
    const loop = await import('@/lib/services/market-data/feedback-loop').then((m) => m.getLoopState()).catch(() => null);
    const evidence = loop ? evidenceLine(loop) : null;
    await notifyPaper('Paper books scoreboard', 'INFO', {}, scoreboardEmbed({ market: market.rows, open, books, longLabel, evidence }, now));
  } catch (e) {
    logger.warn('[PaperNotify] scoreboard failed', { error: e instanceof Error ? e.message : String(e) });
  }
}
