/**
 * Live execution for the Solana pool's sleeve: the same open and close the
 * simulation models, sent to a real perp venue.
 *
 * Off unless `SOLANA_SLEEVE_LIVE_ENABLED` is set AND the venue account and
 * signer are configured. The sleeve's own gate still applies first: it only
 * asks for an entry on a coin whose signal the ledger has proven.
 *
 * What counts as truth here:
 *   - an accepted order is not a fill: a fill is the account's position
 *     changing, read back from the venue;
 *   - a trade's result is the change in the account's equity between two
 *     moments when it holds no position (before the open, after the close),
 *     which carries fees and funding exactly as the venue charged them.
 * That second rule is why the account must be used by this sleeve alone,
 * and why a deposit or withdrawal while a position is open would be read
 * as profit or loss.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { envFlag } from '@/lib/utils/env-flag';
import { logger } from '@/lib/utils/logger';
import {
  getAccount,
  getMarket,
  getMarkPrice,
  getPositions,
  perpNetwork,
  perpVenueConfigured,
  sizeForNotional,
  submitMarketOrder,
  type PerpPosition,
  type PerpSide,
} from './perp-venue';

const KEY_GUARD = 'solana-pool:sleeve-live-guard';
const FILL_POLLS = 10;
const FILL_POLL_MS = 800;

const usdEnv = (name: string, def: number): number => {
  const v = Number((process.env[name] || '').trim());
  return Number.isFinite(v) && v > 0 ? v : def;
};

export const sleeveLiveEnabled = (): boolean => envFlag('SOLANA_SLEEVE_LIVE_ENABLED') && perpVenueConfigured();

/** Largest live position, in dollars. Small by default: the first live trades are a test of the plumbing. */
export const liveMaxNotionalUsd = (): number => usdEnv('SOLANA_SLEEVE_LIVE_MAX_NOTIONAL_USD', 100);
const dailyLossCapUsd = (): number => usdEnv('SOLANA_SLEEVE_LIVE_DAILY_LOSS_USD', 20);
const MAX_CONSECUTIVE_LOSSES = 3;
const HALT_MS = 24 * 60 * 60_000;

export const liveStatus = (): { enabled: boolean; network: string } => ({ enabled: sleeveLiveEnabled(), network: perpNetwork() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The account's position on one market, or null when it holds none. A failed read throws. */
async function positionOn(symbol: string): Promise<PerpPosition | null> {
  return (await getPositions()).find((p) => p.symbol === symbol && p.size > 0) ?? null;
}

/** Whether the account still holds a position on this market. A failed read throws. */
export const liveHasPosition = async (symbol: string): Promise<boolean> => (await positionOn(symbol)) !== null;

// ── Guard: when live trading stops itself ────────────────────────────

interface LiveGuard {
  day: string;
  dayPnlUsd: number;
  consecutiveLosses: number;
  haltUntil: number;
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);

async function readGuard(now: number): Promise<LiveGuard> {
  const g = (await getCronState<LiveGuard>(KEY_GUARD)) ?? { day: utcDay(now), dayPnlUsd: 0, consecutiveLosses: 0, haltUntil: 0 };
  return g.day === utcDay(now) ? g : { ...g, day: utcDay(now), dayPnlUsd: 0 };
}

/**
 * Why no new live position may open right now, or null. Both stops release
 * on their own: the daily cap at the next UTC day, the loss streak after a
 * day. Open positions are managed regardless.
 */
export async function liveEntryBlock(now: number): Promise<string | null> {
  const g = await readGuard(now);
  if (g.haltUntil > now) return `live halt after ${MAX_CONSECUTIVE_LOSSES} losses in a row (${Math.round((g.haltUntil - now) / 60_000)} min left)`;
  if (g.dayPnlUsd <= -dailyLossCapUsd()) return `live daily loss cap reached ($${g.dayPnlUsd.toFixed(2)})`;
  return null;
}

/** Count one closed live trade toward the daily cap and the loss streak. Returns the halt it caused, if any. */
export async function recordLiveOutcome(realizedUsd: number, now: number): Promise<{ halted: boolean }> {
  const g = await readGuard(now);
  g.dayPnlUsd += realizedUsd;
  g.consecutiveLosses = realizedUsd > 0 ? 0 : g.consecutiveLosses + 1;
  const halted = g.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES;
  if (halted) {
    g.haltUntil = now + HALT_MS;
    g.consecutiveLosses = 0;
  }
  await setCronState(KEY_GUARD, g);
  return { halted };
}

// ── Open ─────────────────────────────────────────────────────────────

export type LiveOpenResult =
  | { ok: true; size: number; entryPrice: number; equityBeforeUsd: number }
  /** `sent` true means an order reached the venue and its outcome is not known. */
  | { ok: false; reason: string; sent: boolean };

export async function openLive(args: { asset: string; side: PerpSide; notionalUsd: number; orderId: string }): Promise<LiveOpenResult> {
  const notional = Math.min(args.notionalUsd, liveMaxNotionalUsd());
  const [market, mark, account, existing] = await Promise.all([
    getMarket(args.asset),
    getMarkPrice(args.asset),
    getAccount(),
    positionOn(args.asset),
  ]);
  if (existing) return { ok: false, sent: false, reason: `the venue already holds a ${args.asset} position` };

  const size = sizeForNotional(notional, mark, market.lotSize);
  if (size * mark < market.minOrderUsd) {
    return { ok: false, sent: false, reason: `$${notional.toFixed(2)} is under the venue's $${market.minOrderUsd} minimum order` };
  }
  // The sleeve is 1x: the position must be fully covered by free collateral.
  if (account.availableToSpendUsd < size * mark) {
    return { ok: false, sent: false, reason: `venue collateral $${account.availableToSpendUsd.toFixed(2)} does not cover $${(size * mark).toFixed(2)}` };
  }

  await submitMarketOrder({ symbol: args.asset, side: args.side, size, reduceOnly: false, orderId: args.orderId });

  for (let i = 0; i < FILL_POLLS; i++) {
    await sleep(FILL_POLL_MS);
    // The order is already sent: a failed read must not end the check.
    const pos = await positionOn(args.asset).catch(() => null);
    if (pos && pos.side === args.side && pos.size >= size * 0.99) {
      return { ok: true, size: pos.size, entryPrice: pos.entryPrice, equityBeforeUsd: account.equityUsd };
    }
  }
  return { ok: false, sent: true, reason: `${args.asset} order was accepted but no position appeared` };
}

// ── Close ────────────────────────────────────────────────────────────

export type LiveCloseResult =
  | { ok: true; realizedUsd: number; exitPrice: number }
  | { ok: false; reason: string };

/**
 * Result of a position that is no longer on the venue: equity now, with
 * nothing open, against equity before it was opened.
 */
export async function settledResult(asset: string, equityBeforeUsd: number): Promise<{ realizedUsd: number; exitPrice: number }> {
  const [account, exitPrice] = await Promise.all([getAccount(), getMarkPrice(asset)]);
  return { realizedUsd: account.equityUsd - equityBeforeUsd, exitPrice };
}

export async function closeLive(args: {
  asset: string;
  side: PerpSide;
  orderId: string;
  equityBeforeUsd: number;
  now: number;
}): Promise<LiveCloseResult> {
  const pos = await positionOn(args.asset);
  if (pos) {
    await submitMarketOrder({
      symbol: args.asset,
      side: pos.side === 'LONG' ? 'SHORT' : 'LONG',
      size: pos.size,
      reduceOnly: true,
      // One id per minute: a retry on the next tick is a new request, a retry within this one is not.
      orderId: `${args.orderId}:close:${Math.floor(args.now / 60_000)}`,
    });
    let gone = false;
    for (let i = 0; i < FILL_POLLS && !gone; i++) {
      await sleep(FILL_POLL_MS);
      gone = (await positionOn(args.asset).then((p) => p === null).catch(() => false));
    }
    if (!gone) return { ok: false, reason: `${args.asset} close was accepted but the position is still on the venue` };
  }
  return { ok: true, ...(await settledResult(args.asset, args.equityBeforeUsd)) };
}

/**
 * A position on the venue that the sleeve has no record of (an open whose
 * fill arrived after the check gave up). An unmanaged position has no stop,
 * so it is closed at once; the caller alerts either way.
 */
export async function flattenUntracked(assets: readonly string[], now: number): Promise<string[]> {
  const found = (await getPositions()).filter((p) => assets.includes(p.symbol) && p.size > 0);
  for (const p of found) {
    try {
      await submitMarketOrder({
        symbol: p.symbol,
        side: p.side === 'LONG' ? 'SHORT' : 'LONG',
        size: p.size,
        reduceOnly: true,
        orderId: `untracked:${p.symbol}:${Math.floor(now / 60_000)}`,
      });
    } catch (e) {
      logger.error('[SolanaSleeve] could not close an untracked venue position', { symbol: p.symbol, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return found.map((p) => `${p.symbol} ${p.side} ${p.size}`);
}
