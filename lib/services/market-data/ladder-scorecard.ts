/**
 * The daily ladder's forecasts against what happened.
 *
 * About a day before a BTC or ETH ladder resolves, each undecided strike's
 * price for "ends above" is recorded once. After it resolves, the market's own
 * settled result is written next to it. The scorecard groups the forecasts by
 * the chance they gave and shows how often each group ended above: a forecast
 * of 70% should come true about 70% of the time.
 *
 * Runs from the paper fast tick, never from a page view.
 */
import { query } from '@/lib/db/postgres';
import type { Scorecard } from '@/lib/types/market-signals';
import { fetchLadders, readLadder, LADDER_ASSETS } from './StrikeLadderService';

/** The forecast is taken once, inside this window before resolution. */
const RECORD_FROM_H = 20;
const RECORD_TO_H = 28;
/** A ladder is read for its result this long after it resolves (settlement takes a while). */
const SETTLE_AFTER_MS = 60 * 60_000;
const KEEP_DAYS = 730;

let ready = false;
async function ensureTable(): Promise<void> {
  if (ready) return;
  await query(`
    CREATE TABLE IF NOT EXISTS ladder_forecasts (
      asset        VARCHAR(8) NOT NULL,
      resolves_at  TIMESTAMPTZ NOT NULL,
      strike       DOUBLE PRECISION NOT NULL,
      above_p      DOUBLE PRECISION NOT NULL CHECK (above_p >= 0 AND above_p <= 1),
      recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_above  BOOLEAN,
      PRIMARY KEY (asset, resolves_at, strike)
    )
  `);
  ready = true;
}

/** Record the forecast of each ladder now inside the window, once. Returns rows written. */
export async function recordLadderForecasts(now: number = Date.now()): Promise<number> {
  await ensureTable();
  let written = 0;
  for (const asset of LADDER_ASSETS) {
    for (const l of await fetchLadders(asset, false)) {
      const hoursAhead = (l.resolvesAtMs - now) / 3_600_000;
      if (hoursAhead < RECORD_FROM_H || hoursAhead > RECORD_TO_H) continue;
      const reading = readLadder(l.strikes);
      if (!reading) continue;
      for (const s of reading.ladder) {
        const rows = await query(
          `INSERT INTO ladder_forecasts (asset, resolves_at, strike, above_p) VALUES ($1, $2, $3, $4)
           ON CONFLICT (asset, resolves_at, strike) DO NOTHING RETURNING 1`,
          [asset, new Date(l.resolvesAtMs).toISOString(), s.price, s.above],
        );
        written += rows.length;
      }
    }
  }
  await query(`DELETE FROM ladder_forecasts WHERE resolves_at < NOW() - INTERVAL '${KEEP_DAYS} days'`);
  return written;
}

/** Write the settled result next to each recorded forecast whose ladder has resolved. Returns rows settled. */
export async function settleLadderForecasts(now: number = Date.now()): Promise<number> {
  await ensureTable();
  const open = await query<{ asset: string; resolves_at: Date }>(
    `SELECT DISTINCT asset, resolves_at FROM ladder_forecasts
      WHERE ended_above IS NULL AND resolves_at < $1`,
    [new Date(now - SETTLE_AFTER_MS).toISOString()],
  );
  let settled = 0;
  for (const asset of new Set(open.map((o) => o.asset))) {
    const closed = await fetchLadders(asset, true);
    for (const o of open.filter((x) => x.asset === asset)) {
      const ladder = closed.find((l) => l.resolvesAtMs === new Date(o.resolves_at).getTime());
      if (!ladder) continue;
      for (const s of ladder.strikes) {
        // Only a settled market counts: 1 ended above, 0 did not.
        if (s.yes !== 1 && s.yes !== 0) continue;
        const upd = await query(
          `UPDATE ladder_forecasts SET ended_above = $4
            WHERE asset = $1 AND resolves_at = $2 AND strike = $3 AND ended_above IS NULL RETURNING 1`,
          [asset, new Date(o.resolves_at).toISOString(), s.strike, s.yes === 1],
        );
        settled += upd.length;
      }
    }
  }
  return settled;
}

/** Every settled forecast, grouped into ten bands by the chance it gave. */
export async function getLadderScorecard(): Promise<Scorecard> {
  // A page view never creates the table: before the first recording there is simply nothing yet.
  const exists = await query<{ t: string | null }>(`SELECT to_regclass('ladder_forecasts')::text AS t`);
  if (!exists[0]?.t) return { forecasts: 0, ladders: 0, brier: null, buckets: [] };
  const rows = await query<{ band: number; n: string; mean_p: string; hit: string }>(
    `SELECT LEAST(FLOOR(above_p * 10), 9)::int AS band, COUNT(*)::text AS n,
            AVG(above_p)::text AS mean_p, AVG(CASE WHEN ended_above THEN 1 ELSE 0 END)::text AS hit
       FROM ladder_forecasts WHERE ended_above IS NOT NULL GROUP BY 1 ORDER BY 1`,
  );
  const totals = await query<{ n: string; ladders: string; brier: string | null }>(
    `SELECT COUNT(*)::text AS n, COUNT(DISTINCT (asset, resolves_at))::text AS ladders,
            AVG(POWER(above_p - CASE WHEN ended_above THEN 1 ELSE 0 END, 2))::text AS brier
       FROM ladder_forecasts WHERE ended_above IS NOT NULL`,
  );
  const t = totals[0];
  return {
    forecasts: Number(t?.n ?? 0),
    ladders: Number(t?.ladders ?? 0),
    brier: t?.brier === null || t?.brier === undefined ? null : Number(t.brier),
    buckets: rows.map((r) => ({
      fromPct: r.band * 10,
      forecasts: Number(r.n),
      meanForecastPct: Math.round(Number(r.mean_p) * 1000) / 10,
      endedAbovePct: Math.round(Number(r.hit) * 1000) / 10,
    })),
  };
}
