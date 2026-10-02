/**
 * Lightweight Discord webhook notifier.
 *
 * Reads `DISCORD_WEBHOOK_URL` from env. If the env var is not set the
 * function silently no-ops — making this safe to call from any code path
 * without breaking environments where Discord isn't configured.
 *
 * Failures are swallowed (logged at debug) — alerting must never break
 * the surrounding workflow.
 */

import { logger } from './logger';
import { envFlag } from './env-flag';

export type NotifyLevel = 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'KILL';

/** A Discord card. Colour and fields make a message readable at a glance. */
export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

const LEVEL_COLOR: Record<NotifyLevel, number> = {
  INFO: 0x3b82f6,
  WARN: 0xf59e0b,
  ERROR: 0xef4444,
  TRADE: 0x22c55e,
  KILL: 0x991b1b,
};

const LEVEL_PREFIX: Record<NotifyLevel, string> = {
  INFO: 'ℹ️',
  WARN: '⚠️',
  ERROR: '❌',
  TRADE: '💱',
  KILL: '🛑',
};

/**
 * Alert levels report a condition, and a condition that persists used to be
 * re-posted on every cron tick: one evening the channel took the same four
 * messages (a profit-lock, an auto-response, two stale hedges, an RPC
 * failover) about fifty times an hour, which buried everything else. A
 * repeat of the same alert is now held back for a cool-down, and the next
 * post says how many were held. TRADE and INFO are events and always post.
 * The alert log below still records every occurrence: the defense loop
 * counts them.
 */
const REPEAT_STATE_KEY = 'discord:repeat-state';
const REPEAT_FORGET_MS = 24 * 60 * 60 * 1000;
const repeatCooldownMs = (level: NotifyLevel): number => {
  if (level === 'TRADE' || level === 'INFO') return 0;
  if (level === 'KILL') return 60 * 60 * 1000;
  return (Number((process.env.DISCORD_REPEAT_COOLDOWN_MIN || '').trim()) || 360) * 60 * 1000;
};

export type RepeatState = Record<string, { sentAt: number; held: number }>;

/** Same alert = same level and same text once the numbers are taken out. */
export function repeatFingerprint(level: NotifyLevel, message: string): string {
  return `${level}|${message.replace(/\d[\d,.]*/g, '#').slice(0, 200)}`;
}

/** Whether to post now, how many repeats were held since the last post, and the state to store. */
export function repeatDecision(
  state: RepeatState,
  key: string,
  now: number,
  cooldownMs: number,
): { post: boolean; held: number; next: RepeatState } {
  const next: RepeatState = {};
  for (const [k, v] of Object.entries(state)) if (now - v.sentAt < REPEAT_FORGET_MS) next[k] = v;
  const entry = next[key];
  if (entry && now - entry.sentAt < cooldownMs) {
    next[key] = { sentAt: entry.sentAt, held: entry.held + 1 };
    return { post: false, held: entry.held + 1, next };
  }
  next[key] = { sentAt: now, held: 0 };
  return { post: true, held: entry?.held ?? 0, next };
}

export async function notifyDiscord(
  message: string,
  level: NotifyLevel = 'INFO',
  context?: Record<string, unknown>,
  /** A ready-made card. Without one the message is posted as a card in the level's colour. */
  embed?: DiscordEmbed,
): Promise<void> {
  // Gap 8: also append to cron_state ring buffer so alert-response-loop
  // can act on patterns (3 KILL/hr → auto-shrink spot). Fire-and-forget
  // so a DB blip never breaks the Discord path or its caller.
  // Chain tag: if context.chain is a string, propagate it so the
  // response loop can scope halt rules to the emitting chain. Absent =
  // legacy SUI (backfill-safe).
  if (level === 'KILL' || level === 'ERROR' || level === 'WARN') {
    const chain = typeof context?.chain === 'string' ? context.chain : undefined;
    void appendAlertLog({ at: Date.now(), level, message, chain }).catch(() => {});
  }

  const url = (process.env.DISCORD_WEBHOOK_URL || '').trim();
  if (!url) return;

  let held = 0;
  const cooldownMs = repeatCooldownMs(level);
  if (cooldownMs > 0) {
    try {
      const { getCronState, setCronState } = await import('@/lib/db/cron-state');
      const state = (await getCronState<RepeatState>(REPEAT_STATE_KEY)) ?? {};
      const decision = repeatDecision(state, repeatFingerprint(level, message), Date.now(), cooldownMs);
      await setCronState(REPEAT_STATE_KEY, decision.next);
      if (!decision.post) return;
      held = decision.held;
    } catch {
      // State unavailable: post. A duplicate is better than a silent alert.
    }
  }

  // `chain` routes the alert-response rules; it is not information for a reader.
  const { chain: _chain, ...shown } = context ?? {};
  const ctx = Object.keys(shown).length
    ? '\n```\n' + JSON.stringify(shown, null, 2).slice(0, 1500) + '\n```'
    : '';
  const repeats = held > 0 ? `\n_still active: ${held} repeat${held === 1 ? '' : 's'} of this alert since the last post_` : '';
  const card: DiscordEmbed = embed
    ? { ...embed, color: embed.color ?? LEVEL_COLOR[level] }
    : {
        title: `${LEVEL_PREFIX[level]} ${level}`,
        description: `${message}${repeats}${ctx}`.slice(0, 3900),
        color: LEVEL_COLOR[level],
      };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [card] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.debug('[notifyDiscord] webhook returned non-2xx', { status: res.status });
    }
  } catch (e) {
    logger.debug('[notifyDiscord] post failed (non-fatal)', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

const ALERT_LOG_KEY = 'alert-log:ring-buffer';
const ALERT_LOG_MAX = 200;

interface AlertLogEntry {
  at: number;
  level: NotifyLevel;
  message: string;
  chain?: string;
}

async function appendAlertLog(entry: AlertLogEntry): Promise<void> {
  // Redis LIST-native path (CRON_STATE_REDIS_READ=1): LPUSH + LTRIM is
  // O(1) instead of the O(n) read-modify-write pattern the Postgres impl
  // needs. Ring buffer cutover for the Aiven retirement.
  if (envFlag('CRON_STATE_REDIS_READ')) {
    const { appendAlertLogRedis } = await import('@/lib/db/cron-state-redis');
    await appendAlertLogRedis(entry).catch(() => {});
    return;
  }
  const { getCronState, setCronState } = await import('@/lib/db/cron-state');
  const existing = (await getCronState<AlertLogEntry[]>(ALERT_LOG_KEY).catch(() => null)) || [];
  const trimmed = [...existing, entry].slice(-ALERT_LOG_MAX);
  await setCronState(ALERT_LOG_KEY, trimmed);
}

export async function readAlertLog(): Promise<AlertLogEntry[]> {
  if (envFlag('CRON_STATE_REDIS_READ')) {
    const { readAlertLogRedis } = await import('@/lib/db/cron-state-redis');
    return readAlertLogRedis<AlertLogEntry>();
  }
  const { getCronState } = await import('@/lib/db/cron-state');
  return (await getCronState<AlertLogEntry[]>(ALERT_LOG_KEY).catch(() => null)) || [];
}
