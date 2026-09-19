/**
 * Regret-weighted conviction gate + full halt (2026-07-15).
 *
 * Extracted from polymarket-edge-trader/route.ts on 2026-09-18 as part of
 * the P1-F declutter. Pure — no notifyDiscord, no recordSkip, no
 * NextResponse. Caller wires side effects when halt fires.
 *
 * Two independent uses of the same regret data:
 *   1. Multiplier (0.25-1.0) → caller adjusts MIN_CONFIDENCE + stake sizing.
 *   2. Raw score (-1..+1) → halt the tick when < -0.3 (bad streak).
 *
 * Env gates:
 *   REGRET_TRACKER_DISABLE=1        → skip query, multiplier stays 1.0
 *   REGRET_CONVICTION_GATE_DISABLE=1 → keep raw multiplier at 1.0
 *   TRADER_REGRET_HALT_DISABLE=1    → halt never fires (score still returned)
 */
import { query } from '@/lib/db/postgres';
import { HEDGES_REAL_ONLY_SQL } from '@/lib/db/hedges-scope';
import { computeSizeMultiplier, computeRegretScore } from '@/lib/services/ai/regret-tracker';
import { regretBasedHalt } from '@/lib/services/trading/trade-quality-gates';
import { envFlag } from '@/lib/utils/env-flag';

export interface RegretHaltInfo {
  reason: string;
  threshold: number;
}

export interface RegretGateResult {
  /** Size multiplier in [0.25, 1.0]. 1.0 when disabled or insufficient data. */
  multiplier: number;
  /** Raw regret score in [-1, +1]. 0 when disabled or insufficient data. */
  score: number;
  /** Non-null when regret-halt would fire. Caller wires notifyDiscord +
   *  recordSkip + returns short-circuit response. */
  halt: RegretHaltInfo | null;
}

/**
 * Load the last 200 closed real hedges from the past 30 days and derive
 * the regret multiplier + halt decision. `simulation_mode = false` (via
 * HEDGES_REAL_ONLY_SQL) — paper trades would otherwise poison the score.
 */
export async function computeRegretGate(): Promise<RegretGateResult> {
  let multiplier = 1;
  let score = 0;

  if ((process.env.REGRET_TRACKER_DISABLE ?? '') !== '1') {
    try {
      const rows = await query<{
        open_confidence: number;
        realized_pnl: number;
        created_at: Date;
      }>(
        `SELECT COALESCE(open_confidence, 60) as open_confidence,
                COALESCE(realized_pnl, 0)::float as realized_pnl,
                created_at
         FROM hedges
         WHERE status='closed'
           AND ${HEDGES_REAL_ONLY_SQL}
           AND created_at > NOW() - INTERVAL '30 days'
         ORDER BY created_at DESC LIMIT 200`
      ).catch(() => []);
      if (rows.length > 0) {
        const decisions = rows.map((r) => ({
          openConfidence: Number(r.open_confidence),
          realizedPnl: Number(r.realized_pnl),
          openedAt: new Date(r.created_at),
        }));
        multiplier = envFlag('REGRET_CONVICTION_GATE_DISABLE')
          ? 1
          : await computeSizeMultiplier({ recentDecisions: decisions });
        score = computeRegretScore(decisions);
      }
    } catch {
      /* best-effort — regret data is optional context, never a blocker */
    }
  }

  let halt: RegretHaltInfo | null = null;
  if ((process.env.TRADER_REGRET_HALT_DISABLE ?? '') !== '1') {
    const decision = regretBasedHalt({ regretScore: score });
    if (decision.halt) {
      halt = { reason: decision.reason, threshold: decision.threshold };
    }
  }

  return { multiplier, score, halt };
}
