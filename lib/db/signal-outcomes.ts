/**
 * Signal Outcomes Ledger — fixed-horizon ground truth for every signal source.
 *
 * Root-fix centerpiece (see docs/_ops/PAPER_TRADER_ROOT_AUDIT_2026-09-27.md).
 * Built 2026-08 for a BTC-only 5-min experiment and never wired (0 rows,
 * 0 write call sites found in the 2026-09-27 audit). Generalized to
 * multi-asset / multi-horizon and wired into the paper-fast-tick via
 * lib/services/market-data/signal-ledger.ts.
 *
 * Why it exists — two root defects it fixes:
 *   1. Credit assignment was policy-entangled: sources were labeled
 *      correct/incorrect by TRADE exits (variable 4min-5h windows set by
 *      the exit policy). Here a signal is scored against the price at a
 *      FIXED horizon, independent of any trade.
 *   2. Statistical starvation: trades supply ~5-40 observations/day;
 *      snapshots supply thousands. Detecting a 53%-vs-50% edge needs
 *      ~1,050 observations per cell — only the ledger gets there.
 *
 * Lifecycle:
 *   recordSignal(...)          — one row per (source, asset, horizon, window)
 *   resolveExpiredSignals(...) — resolves pending rows whose window closed,
 *                                fetching one validated price per asset.
 *                                Rows discovered too long after expiry are
 *                                voided, never guessed (label honesty).
 *   getSignalStats(...)        — per-source aggregates for admission logic.
 */

import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';

let tableReady = false;

export async function ensureSignalOutcomesTable(): Promise<void> {
  if (tableReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS signal_outcomes (
        id SERIAL PRIMARY KEY,
        source VARCHAR(64) NOT NULL,
        market_id VARCHAR(255),
        window_end_time BIGINT NOT NULL,
        observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        direction VARCHAR(8) NOT NULL,
        probability DECIMAL(8, 6) NOT NULL,
        confidence DECIMAL(8, 4),
        signal_strength VARCHAR(16),
        volume DECIMAL(20, 2),
        liquidity DECIMAL(20, 2),
        entry_price DECIMAL(20, 6),
        exit_price DECIMAL(20, 6),
        actual_direction VARCHAR(8),
        correct BOOLEAN,
        resolved_at TIMESTAMP,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        notes TEXT
      );
      ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS asset VARCHAR(16);
      ALTER TABLE signal_outcomes ADD COLUMN IF NOT EXISTS horizon_min INT;
      -- The original UNIQUE(source, window_end_time) collides across assets
      -- and horizons snapshotted in the same tick. Table was empty in prod
      -- when this shipped (2026-09-27), so the swap is safe.
      ALTER TABLE signal_outcomes DROP CONSTRAINT IF EXISTS signal_outcomes_source_window_end_time_key;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_outcomes_uniq
        ON signal_outcomes(source, COALESCE(asset, ''), COALESCE(horizon_min, 0), window_end_time);
      CREATE INDEX IF NOT EXISTS idx_signal_outcomes_status ON signal_outcomes(status);
      CREATE INDEX IF NOT EXISTS idx_signal_outcomes_window ON signal_outcomes(window_end_time);
      CREATE INDEX IF NOT EXISTS idx_signal_outcomes_source_asset
        ON signal_outcomes(source, asset, horizon_min) WHERE status = 'resolved';
    `);
    tableReady = true;
  } catch (err) {
    logger.warn('[SignalOutcomes] ensureTable failed', { error: err instanceof Error ? err.message : err });
    tableReady = true; // avoid retry storm
  }
}

export interface RecordSignalArgs {
  source: string;          // normalized source key (source-calibrator.normalizeSourceKey)
  asset: string;           // BTC / ETH / SOL / XRP / DOGE
  horizonMin: number;      // fixed evaluation horizon in minutes (30 / 60 / 240)
  marketId?: string;
  windowEndTime: number;   // ms epoch when this prediction window resolves
  direction: 'UP' | 'DOWN';
  probability: number;     // 0..1
  confidence?: number;     // 0..100
  signalStrength?: 'STRONG' | 'MODERATE' | 'WEAK';
  volume?: number;
  liquidity?: number;
  entryPrice?: number;     // asset price observed when signal was recorded
}

/** Record a new signal observation. No-op on duplicate (source, asset, horizon, window). */
export async function recordSignal(args: RecordSignalArgs): Promise<void> {
  await ensureSignalOutcomesTable();
  try {
    await query(
      `INSERT INTO signal_outcomes
        (source, asset, horizon_min, market_id, window_end_time, direction, probability,
         confidence, signal_strength, volume, liquidity, entry_price, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending')
       ON CONFLICT DO NOTHING`,
      [
        args.source,
        args.asset.toUpperCase(),
        Math.round(args.horizonMin),
        args.marketId ?? null,
        args.windowEndTime,
        args.direction,
        args.probability,
        args.confidence ?? null,
        args.signalStrength ?? null,
        args.volume ?? null,
        args.liquidity ?? null,
        args.entryPrice ?? null,
      ],
    );
  } catch (err) {
    logger.warn('[SignalOutcomes] recordSignal failed', { error: err instanceof Error ? err.message : err });
  }
}

/**
 * A pending row resolved more than this long after its window closed gets
 * VOIDED, not scored — the price "now" is no longer the price "at horizon",
 * and a mislabeled outcome is worse than a missing one. With the ledger
 * resolver running on the 60s fast-tick, healthy operation resolves within
 * ~1-2 minutes of expiry; anything older means an outage window.
 */
const RESOLVE_STALE_MAX_MS = Number(process.env.SIGNAL_LEDGER_RESOLVE_STALE_MAX_MIN || 15) * 60_000;

/**
 * Resolve pending signals whose windows have closed, across ALL assets.
 * Fetches one multi-source validated price per distinct asset in the batch.
 * Price-fetch failure for an asset leaves its rows pending (retried next
 * tick, voided by the staleness rule if the outage outlives the cap).
 */
export async function resolveExpiredSignals(
  options: { maxBatch?: number; now?: number } = {},
): Promise<{ resolved: number; correct: number; incorrect: number; voided: number }> {
  await ensureSignalOutcomesTable();
  const maxBatch = options.maxBatch ?? 200;
  const now = options.now ?? Date.now();
  const zero = { resolved: 0, correct: 0, incorrect: 0, voided: 0 };

  let pending: Array<{
    id: number;
    asset: string | null;
    direction: 'UP' | 'DOWN';
    entry_price: number | null;
    window_end_time: string | number;
  }> = [];
  try {
    pending = await query(
      `SELECT id, asset, direction, entry_price, window_end_time
       FROM signal_outcomes
       WHERE status = 'pending' AND window_end_time <= $1
       ORDER BY window_end_time ASC
       LIMIT $2`,
      [now, maxBatch],
    );
  } catch (err) {
    logger.warn('[SignalOutcomes] resolveExpired query failed', { error: err instanceof Error ? err.message : err });
    return zero;
  }
  if (pending.length === 0) return zero;

  let voided = 0;
  const scorable: typeof pending = [];
  for (const row of pending) {
    const lateMs = now - Number(row.window_end_time);
    if (lateMs > RESOLVE_STALE_MAX_MS || !row.asset) {
      try {
        await query(
          `UPDATE signal_outcomes SET status = 'void', resolved_at = CURRENT_TIMESTAMP,
           notes = $1 WHERE id = $2`,
          [!row.asset ? 'no asset (legacy row)' : `resolved ${Math.round(lateMs / 60_000)}min late — outside honesty window`, row.id],
        );
        voided++;
      } catch { /* ignore */ }
      continue;
    }
    scorable.push(row);
  }
  if (scorable.length === 0) return { ...zero, voided };

  // One validated price per distinct asset.
  const assets = Array.from(new Set(scorable.map((r) => r.asset as string)));
  const priceByAsset = new Map<string, number>();
  const { getMultiSourceValidatedPrice } = await import('@/lib/services/market-data/unified-price-provider');
  await Promise.allSettled(
    assets.map(async (a) => {
      const v = await getMultiSourceValidatedPrice(a, { minSources: 2, maxDeviationPercent: 2, timeout: 8000 });
      if (Number.isFinite(v.price) && v.price > 0) priceByAsset.set(a, v.price);
    }),
  );

  let correct = 0;
  let incorrect = 0;
  for (const row of scorable) {
    const exitPrice = priceByAsset.get(row.asset as string);
    if (!exitPrice) continue; // price outage → stay pending, retry next tick
    const entry = Number(row.entry_price ?? 0);
    if (!Number.isFinite(entry) || entry <= 0) {
      try {
        await query(
          `UPDATE signal_outcomes SET status = 'void', resolved_at = CURRENT_TIMESTAMP,
           exit_price = $1, notes = 'no entry_price recorded' WHERE id = $2`,
          [exitPrice, row.id],
        );
        voided++;
      } catch { /* ignore */ }
      continue;
    }
    const actualDir: 'UP' | 'DOWN' = exitPrice >= entry ? 'UP' : 'DOWN';
    const isCorrect = actualDir === row.direction;
    if (isCorrect) correct++; else incorrect++;
    try {
      await query(
        `UPDATE signal_outcomes
         SET status = 'resolved', actual_direction = $1, exit_price = $2,
             correct = $3, resolved_at = CURRENT_TIMESTAMP
         WHERE id = $4`,
        [actualDir, exitPrice, isCorrect, row.id],
      );
    } catch (err) {
      logger.warn('[SignalOutcomes] resolve update failed', { id: row.id, error: err instanceof Error ? err.message : err });
    }
  }

  return { resolved: correct + incorrect, correct, incorrect, voided };
}

export interface SignalStats {
  total: number;
  resolved: number;
  pending: number;
  correct: number;
  incorrect: number;
  winRate: number;          // correct / resolved (0..1)
  avgConfidence: number;
  byStrength: Record<string, { resolved: number; correct: number; winRate: number }>;
}

export async function getSignalStats(windowDays = 7, source = 'polymarket-5min'): Promise<SignalStats> {
  await ensureSignalOutcomesTable();
  const sinceMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  try {
    const all = await query<{
      status: string;
      correct: boolean | null;
      confidence: string | null;
      signal_strength: string | null;
    }>(
      `SELECT status, correct, confidence, signal_strength
       FROM signal_outcomes
       WHERE source = $1 AND window_end_time >= $2`,
      [source, sinceMs],
    );

    const total = all.length;
    const resolved = all.filter(r => r.status === 'resolved').length;
    const pending = all.filter(r => r.status === 'pending').length;
    const correct = all.filter(r => r.correct === true).length;
    const incorrect = all.filter(r => r.correct === false).length;
    const winRate = resolved > 0 ? correct / resolved : 0;

    const confSum = all.reduce((acc, r) => acc + (r.confidence ? Number(r.confidence) : 0), 0);
    const avgConfidence = total > 0 ? confSum / total : 0;

    const byStrength: SignalStats['byStrength'] = {};
    for (const r of all) {
      if (r.status !== 'resolved' || !r.signal_strength) continue;
      const k = r.signal_strength;
      byStrength[k] ??= { resolved: 0, correct: 0, winRate: 0 };
      byStrength[k].resolved++;
      if (r.correct === true) byStrength[k].correct++;
    }
    for (const k of Object.keys(byStrength)) {
      const b = byStrength[k];
      b.winRate = b.resolved > 0 ? b.correct / b.resolved : 0;
    }

    return { total, resolved, pending, correct, incorrect, winRate, avgConfidence, byStrength };
  } catch (err) {
    logger.warn('[SignalOutcomes] getSignalStats failed', { error: err instanceof Error ? err.message : err });
    return { total: 0, resolved: 0, pending: 0, correct: 0, incorrect: 0, winRate: 0, avgConfidence: 0, byStrength: {} };
  }
}

/**
 * Per-(source, asset, horizon) hit rates — the admission-decision read.
 * Only resolved rows count. Used by the (upcoming) proof-based source
 * admission gate: a source trades only where its ledger cell shows
 * hit ≥ threshold with enough samples.
 */
export async function getLedgerHitRates(options: {
  windowDays?: number;
  minN?: number;
  /** Never read rows before this (the signal definitions changed). */
  sinceMs?: number;
} = {}): Promise<Array<{ source: string; asset: string; horizonMin: number; n: number; hitRate: number }>> {
  await ensureSignalOutcomesTable();
  const windowDays = options.windowDays ?? 30;
  const minN = options.minN ?? 50;
  const sinceMs = Math.max(Date.now() - windowDays * 24 * 60 * 60 * 1000, options.sinceMs ?? 0);
  try {
    const rows = await query<{
      source: string; asset: string; horizon_min: number; n: string; hits: string;
    }>(
      `SELECT source, asset, horizon_min, COUNT(*)::text AS n,
              SUM(CASE WHEN correct THEN 1 ELSE 0 END)::text AS hits
       FROM signal_outcomes
       WHERE status = 'resolved' AND window_end_time >= $1 AND asset IS NOT NULL
       GROUP BY source, asset, horizon_min
       HAVING COUNT(*) >= $2`,
      [sinceMs, minN],
    );
    return rows.map((r) => ({
      source: r.source,
      asset: r.asset,
      horizonMin: Number(r.horizon_min),
      n: Number(r.n),
      hitRate: Number(r.n) > 0 ? Number(r.hits) / Number(r.n) : 0,
    }));
  } catch (err) {
    logger.warn('[SignalOutcomes] getLedgerHitRates failed', { error: err instanceof Error ? err.message : err });
    return [];
  }
}

/** Prune terminal rows older than the retention window. Returns rows deleted. */
export async function pruneOldSignalOutcomes(retentionDays = 90): Promise<number> {
  await ensureSignalOutcomesTable();
  try {
    const r = await query<{ id: number }>(
      `DELETE FROM signal_outcomes
       WHERE status IN ('resolved', 'void')
         AND window_end_time < $1
       RETURNING id`,
      [Date.now() - retentionDays * 24 * 60 * 60 * 1000],
    );
    return r.length;
  } catch (err) {
    logger.warn('[SignalOutcomes] prune failed', { error: err instanceof Error ? err.message : err });
    return 0;
  }
}
