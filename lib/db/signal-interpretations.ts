/**
 * Signal Interpretations — persistence for the fine-tuned Signal Interpreter's
 * self-reflective output. Closes the compounding-capability loop the model's
 * constitution names: novelty / improvement_ask / generalization_note are
 * useless if we log them and throw them away.
 *
 * ## What this stores
 *
 * One row per unique market slug the Signal Interpreter parsed. Includes
 * the structured fields (asset/direction/threshold/horizon) AND the model's
 * self-reflection on that parse (novelty, ask, note).
 *
 * ## What it enables
 *
 *   Phase 2: link to realized trade PnL via linkOutcome(slug, pnl)
 *   Phase 3: postmortem generator joins (interpretation, outcome) into
 *            training examples for the next fine-tune
 *   Phase 4: active-learning cron pulls top-novelty rows into raw.jsonl
 *
 * ## Not a decision surface
 *
 * Nothing here trades. Read paths are analytical only. Writes are fire-
 * and-forget — a DB outage never blocks poly-discover-tick.
 */

import { query } from '@/lib/db/postgres';
import { logger } from '@/lib/utils/logger';

let tableReady = false;

export async function ensureSignalInterpretationsTable(): Promise<void> {
  if (tableReady) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS signal_interpretations (
        slug                  VARCHAR(255) PRIMARY KEY,
        title                 TEXT NOT NULL,
        asset                 VARCHAR(16),
        direction             VARCHAR(16),
        threshold             DECIMAL(20, 6),
        horizon               VARCHAR(16),
        horizon_end           TIMESTAMPTZ,
        confidence            DECIMAL(4, 3),
        novelty               DECIMAL(4, 3),
        improvement_ask       TEXT,
        generalization_note   TEXT,
        source                VARCHAR(32) NOT NULL,
        reasoning             TEXT,
        entry_price_usd       DECIMAL(20, 6),
        exit_price_usd        DECIMAL(20, 6),
        outcome_correct       BOOLEAN,
        interpreted_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        retrospective_pnl_usd DECIMAL(20, 6),
        outcome_linked_at     TIMESTAMPTZ
      );
      ALTER TABLE signal_interpretations ADD COLUMN IF NOT EXISTS entry_price_usd DECIMAL(20, 6);
      ALTER TABLE signal_interpretations ADD COLUMN IF NOT EXISTS exit_price_usd DECIMAL(20, 6);
      ALTER TABLE signal_interpretations ADD COLUMN IF NOT EXISTS outcome_correct BOOLEAN;
      CREATE INDEX IF NOT EXISTS idx_signal_interp_novelty
        ON signal_interpretations(novelty DESC)
        WHERE novelty IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_signal_interp_asset_time
        ON signal_interpretations(asset, interpreted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_signal_interp_outcome
        ON signal_interpretations(outcome_linked_at)
        WHERE retrospective_pnl_usd IS NOT NULL;
    `);
    tableReady = true;
  } catch (err) {
    logger.warn('[SignalInterp] ensureTable failed', {
      error: err instanceof Error ? err.message : err,
    });
    tableReady = true;
  }
}

export interface RecordInterpretationArgs {
  slug: string;
  title: string;
  asset: string | null;
  direction: string;
  threshold: number | null;
  horizon: string;
  horizonEnd: string | null;
  confidence: number;
  novelty: number;
  improvementAsk: string;
  generalizationNote: string;
  source: 'model' | 'regex-fallback';
  reasoning?: string;
  entryPriceUsd?: number | null;
}

/** Upsert one interpretation. Re-interpreting a slug (e.g. after a model
 *  upgrade) overwrites the prior row — we always want the freshest read. */
export async function recordInterpretation(args: RecordInterpretationArgs): Promise<void> {
  await ensureSignalInterpretationsTable();
  try {
    await query(
      `INSERT INTO signal_interpretations
        (slug, title, asset, direction, threshold, horizon, horizon_end,
         confidence, novelty, improvement_ask, generalization_note,
         source, reasoning, entry_price_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         asset = EXCLUDED.asset,
         direction = EXCLUDED.direction,
         threshold = EXCLUDED.threshold,
         horizon = EXCLUDED.horizon,
         horizon_end = EXCLUDED.horizon_end,
         confidence = EXCLUDED.confidence,
         novelty = EXCLUDED.novelty,
         improvement_ask = EXCLUDED.improvement_ask,
         generalization_note = EXCLUDED.generalization_note,
         source = EXCLUDED.source,
         reasoning = EXCLUDED.reasoning,
         entry_price_usd = COALESCE(EXCLUDED.entry_price_usd, signal_interpretations.entry_price_usd),
         interpreted_at = CURRENT_TIMESTAMP`,
      [
        args.slug,
        args.title,
        args.asset,
        args.direction,
        args.threshold,
        args.horizon,
        args.horizonEnd,
        args.confidence,
        args.novelty,
        args.improvementAsk.slice(0, 500),
        args.generalizationNote.slice(0, 500),
        args.source,
        args.reasoning?.slice(0, 500) ?? null,
        args.entryPriceUsd ?? null,
      ],
    );
  } catch (err) {
    logger.warn('[SignalInterp] recordInterpretation failed', {
      slug: args.slug,
      error: err instanceof Error ? err.message : err,
    });
  }
}

/** Attach realized PnL when a trade derived from this signal closes.
 *  Called from hedge-reconcile / trade-close paths. Idempotent —
 *  re-linking overwrites with the freshest number. */
export async function linkOutcome(slug: string, realizedPnlUsd: number): Promise<void> {
  await ensureSignalInterpretationsTable();
  try {
    await query(
      `UPDATE signal_interpretations
       SET retrospective_pnl_usd = $1, outcome_linked_at = CURRENT_TIMESTAMP
       WHERE slug = $2`,
      [realizedPnlUsd, slug],
    );
  } catch (err) {
    logger.warn('[SignalInterp] linkOutcome failed', {
      slug,
      error: err instanceof Error ? err.message : err,
    });
  }
}

export interface InterpretationRow {
  slug: string;
  title: string;
  asset: string | null;
  direction: string;
  threshold: number | null;
  horizon: string;
  horizon_end: string | null;
  confidence: number;
  novelty: number | null;
  improvement_ask: string | null;
  generalization_note: string | null;
  source: string;
  reasoning: string | null;
  entry_price_usd: number | null;
  exit_price_usd: number | null;
  outcome_correct: boolean | null;
  interpreted_at: string;
  retrospective_pnl_usd: number | null;
  outcome_linked_at: string | null;
}

/** Rows whose horizon has passed and can be judged against a spot price.
 *  Only directional interpretations with an entry price are resolvable —
 *  binary market propositions need Polymarket's own resolution oracle. */
export async function unresolvedDirectionalPastHorizon(
  limit = 200,
): Promise<InterpretationRow[]> {
  await ensureSignalInterpretationsTable();
  try {
    return await query<InterpretationRow>(
      `SELECT * FROM signal_interpretations
       WHERE outcome_correct IS NULL
         AND direction IN ('UP', 'DOWN')
         AND asset IS NOT NULL
         AND entry_price_usd IS NOT NULL
         AND horizon_end IS NOT NULL
         AND horizon_end < CURRENT_TIMESTAMP
       ORDER BY horizon_end ASC
       LIMIT $1`,
      [limit],
    );
  } catch (err) {
    logger.warn('[SignalInterp] unresolvedDirectionalPastHorizon failed', {
      error: err instanceof Error ? err.message : err,
    });
    return [];
  }
}

/** Judge a directional interpretation against realized price. Records
 *  exit price + boolean correctness + signed delta (as retrospective_pnl_usd
 *  so the postmortem pipeline reads it uniformly with trade-linked outcomes).
 *  Signed delta = (exit - entry) × (direction === 'UP' ? +1 : -1). */
export async function resolveDirectional(
  slug: string,
  direction: 'UP' | 'DOWN',
  entryPriceUsd: number,
  exitPriceUsd: number,
): Promise<{ correct: boolean; signedDelta: number }> {
  await ensureSignalInterpretationsTable();
  const raw = exitPriceUsd - entryPriceUsd;
  const signedDelta = direction === 'UP' ? raw : -raw;
  const correct = signedDelta > 0;
  try {
    await query(
      `UPDATE signal_interpretations
       SET exit_price_usd = $1,
           outcome_correct = $2,
           retrospective_pnl_usd = $3,
           outcome_linked_at = CURRENT_TIMESTAMP
       WHERE slug = $4`,
      [exitPriceUsd, correct, signedDelta, slug],
    );
  } catch (err) {
    logger.warn('[SignalInterp] resolveDirectional failed', {
      slug,
      error: err instanceof Error ? err.message : err,
    });
  }
  return { correct, signedDelta };
}

/** Top-K rows by novelty since some cutoff, unresolved outcomes preferred.
 *  Feeds the active-learning cron: high novelty + no linked outcome ==
 *  the frontier the next training round should focus on. */
export async function topNovelSince(
  sinceMs: number,
  limit = 100,
): Promise<InterpretationRow[]> {
  await ensureSignalInterpretationsTable();
  try {
    return await query<InterpretationRow>(
      `SELECT * FROM signal_interpretations
       WHERE interpreted_at >= to_timestamp($1 / 1000.0)
         AND novelty IS NOT NULL
       ORDER BY novelty DESC, interpreted_at DESC
       LIMIT $2`,
      [sinceMs, limit],
    );
  } catch (err) {
    logger.warn('[SignalInterp] topNovelSince failed', {
      error: err instanceof Error ? err.message : err,
    });
    return [];
  }
}

/** Interpretations that have a linked PnL — the postmortem input set. */
export async function resolvedInterpretations(
  sinceMs: number,
  limit = 200,
): Promise<InterpretationRow[]> {
  await ensureSignalInterpretationsTable();
  try {
    return await query<InterpretationRow>(
      `SELECT * FROM signal_interpretations
       WHERE outcome_linked_at IS NOT NULL
         AND outcome_linked_at >= to_timestamp($1 / 1000.0)
       ORDER BY outcome_linked_at DESC
       LIMIT $2`,
      [sinceMs, limit],
    );
  } catch (err) {
    logger.warn('[SignalInterp] resolvedInterpretations failed', {
      error: err instanceof Error ? err.message : err,
    });
    return [];
  }
}
