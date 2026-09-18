/**
 * Discord digest for paper trader — buffer TRADE-level events, flush as
 * one summary message per hour or per N events. Halts + errors bypass
 * the digest and fire immediately.
 *
 * Opt-in via PAPER_TRADER_DISCORD_DIGEST=1. Default OFF preserves the
 * per-trade behavior operators are already used to.
 */

import { getCronStateOr, setCronState } from '@/lib/db/cron-state';
import { notifyDiscord, type NotifyLevel } from '@/lib/utils/discord-notify';
import { logger } from '@/lib/utils/logger';
import {
  PAPER_DISCORD_DIGEST_ENABLED,
  PAPER_DIGEST_FLUSH_MS,
  PAPER_DIGEST_FLUSH_MAX_EVENTS,
  KEY_DIGEST_BUFFER,
} from './config';

export interface DigestEvent {
  at: number;
  kind: 'open' | 'close';
  asset: string;
  side: string;
  notionalUsd: number;
  pnlUsd?: number;
  reason?: string;
}

/**
 * Route a paper-trader notification. TRADE-level events get buffered when
 * digest mode is on; everything else fires immediately.
 */
export async function notifyPaper(
  message: string,
  level: NotifyLevel,
  context: Record<string, unknown>,
  event?: DigestEvent,
): Promise<void> {
  const passThrough = !PAPER_DISCORD_DIGEST_ENABLED || level !== 'TRADE' || !event;
  if (passThrough) {
    void notifyDiscord(message, level, context).catch(() => undefined);
    return;
  }
  // Buffer for digest.
  try {
    const buf = await getCronStateOr<DigestEvent[]>(KEY_DIGEST_BUFFER, []);
    buf.push(event);
    await setCronState(KEY_DIGEST_BUFFER, buf);
  } catch (e) {
    // If buffering fails, fall back to immediate notify — better than losing the event.
    logger.warn('[PaperDigest] buffer append failed; sending immediately', {
      error: e instanceof Error ? e.message : String(e),
    });
    void notifyDiscord(message, level, context).catch(() => undefined);
  }
}

/**
 * Flush the digest buffer if either threshold met: age of oldest event >
 * PAPER_DIGEST_FLUSH_MS, OR total events >= PAPER_DIGEST_FLUSH_MAX_EVENTS.
 * Called at the top of every paper trader tick.
 */
export async function flushPaperDigestIfDue(now: number = Date.now()): Promise<void> {
  if (!PAPER_DISCORD_DIGEST_ENABLED) return;
  try {
    const buf = await getCronStateOr<DigestEvent[]>(KEY_DIGEST_BUFFER, []);
    if (buf.length === 0) return;
    const oldestAgeMs = now - buf[0].at;
    const shouldFlush =
      buf.length >= PAPER_DIGEST_FLUSH_MAX_EVENTS || oldestAgeMs >= PAPER_DIGEST_FLUSH_MS;
    if (!shouldFlush) return;

    const opens = buf.filter((e) => e.kind === 'open').length;
    const closes = buf.filter((e) => e.kind === 'close');
    const wins = closes.filter((e) => (e.pnlUsd ?? 0) > 0).length;
    const losses = closes.filter((e) => (e.pnlUsd ?? 0) < 0).length;
    const netPnl = closes.reduce((s, e) => s + (e.pnlUsd ?? 0), 0);
    const totalNotional = buf.reduce((s, e) => s + e.notionalUsd, 0);

    // Top 3 winners + losers for context.
    const sorted = [...closes].sort((a, b) => (b.pnlUsd ?? 0) - (a.pnlUsd ?? 0));
    const topWins = sorted
      .slice(0, 3)
      .filter((e) => (e.pnlUsd ?? 0) > 0)
      .map((e) => `${e.asset} ${e.side} +$${(e.pnlUsd ?? 0).toFixed(0)}`);
    const topLosses = sorted
      .slice(-3)
      .reverse()
      .filter((e) => (e.pnlUsd ?? 0) < 0)
      .map((e) => `${e.asset} ${e.side} $${(e.pnlUsd ?? 0).toFixed(0)}`);

    const windowHours = (oldestAgeMs / 3600_000).toFixed(1);
    const msg = [
      `Paper digest (${windowHours}h): ${opens} opens, ${closes.length} closes • net ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)} • ${wins}W/${losses}L`,
      topWins.length ? `  wins: ${topWins.join(', ')}` : '',
      topLosses.length ? `  losses: ${topLosses.join(', ')}` : '',
      `  total notional: $${(totalNotional / 1000).toFixed(0)}k`,
    ]
      .filter(Boolean)
      .join('\n');

    await notifyDiscord(msg, netPnl >= 0 ? 'INFO' : 'WARN', {
      source: 'paper-trader-digest',
      opens,
      closes: closes.length,
      wins,
      losses,
      netPnl,
      totalNotional,
      windowHours,
    }).catch(() => undefined);

    await setCronState(KEY_DIGEST_BUFFER, []);
  } catch (e) {
    logger.warn('[PaperDigest] flush failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
