/**
 * The funding the paper books pay or collect, as the venue they model actually
 * settled it: every hour, at that hour's rate. The books used to charge a flat
 * 11% a year, about twice what longs paid there from 2025-07 to 2026-10 (5.7%
 * BTC, 3.9% ETH), and never negative, which real funding is in about 15% of
 * hours. A 30-day average would not do either: on 2026-10-22 it read BTC 21%,
 * ETH 1.5%, SOL -47%, and applied to a position's whole hold it re-prices the
 * past every day.
 *
 * So a position is charged the sum of the hourly rates settled while it was
 * open, from the venue's history kept here for the last 90 days. The part of
 * a hold older than that is charged the kept window's average. A coin with no
 * history is charged FUNDING_APR.
 */
import { getCronStateStrict, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { setFundingHistory } from './simulated-executor';

const KEY = 'paper:funding-hours';
const KEEP_MS = 90 * 86_400_000;
const HOUR_MS = 3_600_000;
/** The venue's cap on one hour's rate; values beyond it are bad prints (seen at its launch). */
const HOURLY_CAP = 0.001;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SUI'];
const HISTORY_URL = 'https://api.sui-prod.bluefin.io/v1/exchange/fundingRateHistory';

/** Per coin: [settlement time ms, rate] in time order. A positive rate means longs pay. */
export type FundingHours = Record<string, Array<[number, number]>>;

export interface KeptFunding {
  /** When the venue was last read; read again an hour later. */
  checkedAt: number;
  hours: FundingHours;
}

/** The venue's hourly settlements for a coin up to `until`, newest 1000 (about 41 days). */
export async function venueHourlyFunding(coin: string, until: number): Promise<Array<[number, number]>> {
  const res = await fetch(`${HISTORY_URL}?symbol=${coin}-PERP&limit=1000&endTimeAtMillis=${until}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`funding history ${coin}: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ fundingRateE9?: string; fundingTimeAtMillis?: number }>;
  if (!Array.isArray(rows)) throw new Error(`funding history ${coin}: not a list`);
  return rows
    .map((r): [number, number] => [Number(r.fundingTimeAtMillis), Number(r.fundingRateE9) / 1e9])
    .filter(([t, r]) => Number.isFinite(t) && t <= until && Number.isFinite(r) && Math.abs(r) <= HOURLY_CAP);
}

/** Pure: merge new settlements into a coin's kept hours, one per hour, oldest dropped past the window. */
export function mergeHours(kept: Array<[number, number]>, fresh: Array<[number, number]>, now: number): Array<[number, number]> {
  const byHour = new Map<number, [number, number]>();
  for (const x of [...kept, ...fresh]) byHour.set(Math.round(x[0] / HOUR_MS), x);
  return [...byHour.values()].filter(([t]) => t >= now - KEEP_MS).sort((a, b) => a[0] - b[0]);
}

/**
 * Load the kept hours into the executor, reading the venue again an hour
 * after the last read. Throws only when the kept hours cannot be read.
 */
export async function loadFundingHistory(
  now: number = Date.now(),
  history: typeof venueHourlyFunding = venueHourlyFunding,
): Promise<KeptFunding> {
  const kept = (await getCronStateStrict<KeptFunding>(KEY)) ?? { checkedAt: 0, hours: {} };
  let next = kept;
  if (now - kept.checkedAt >= HOUR_MS) {
    const hours = { ...kept.hours };
    let read = 0;
    for (const coin of COINS) {
      try {
        const fresh = await history(coin, now);
        read++;
        if (fresh.length) hours[coin] = mergeHours(kept.hours[coin] ?? [], fresh, now);
      } catch (e) {
        logger.warn('[paper-funding] history unreadable; the coin keeps its kept hours', { coin, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Nothing read: keep the old check time so the next tick tries again.
    if (read > 0) {
      next = { checkedAt: now, hours };
      await setCronState(KEY, next);
    }
  }
  setFundingHistory(next.hours);
  return next;
}
