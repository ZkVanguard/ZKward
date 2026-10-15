/**
 * Paper trader — sizing math primitives.
 *
 * Pure functions that turn signal metadata into hold parameters.
 * Extracted from PaperTrader.ts to keep the trader file focused on
 * orchestration and to give sizing math a stable unit-test seam.
 */

import {
  PAPER_MAX_HOLD_MIN,
  PAPER_MAX_HOLD_EXTRA_MIN,
  PAPER_MAX_HOLD_CEILING_MIN,
} from './config';

/**
 * Confidence and consensus as one scalar in [0.4, 2.0]: 0.4 at the minimum
 * gate (55/50), 2.0 at 100/100. It plans the hold in adaptive mode. It does
 * not size a trade: confidence has measured no edge on the ledger.
 */
export function computeSignalScalar(confidence: number, consensus: number): number {
  const confN = Math.max(0, Math.min(1, (confidence - 55) / 45));
  const consN = Math.max(0, Math.min(1, (consensus - 50) / 50));
  const avg = (confN + consN) / 2;
  return 0.4 + avg * 1.6;
}

/**
 * Signal-strength-scaled max-hold minutes. Weak signals close at the base
 * PAPER_MAX_HOLD_MIN. Strong signals earn extra time (up to
 * PAPER_MAX_HOLD_EXTRA_MIN extra) so moves develop past fees.
 *
 * The optional `regimeMult` is the current regime's maxHoldMult from
 * getRegimeMultipliers — 0.75 in CHOP (cut short), 1.5 in TRENDING
 * (let winners run). Was defined in regime.ts but unwired until
 * 2026-09-22. Defaults to 1 (identity) so pure-signal callers stay
 * unchanged.
 */
export function computeMaxHoldMinutes(
  signalScalar: number,
  regimeMult: number = 1,
  ledgerHorizonMin?: number | null,
): number {
  // A measured horizon beats the confidence/regime heuristic.
  if (ledgerHorizonMin && ledgerHorizonMin > 0) {
    return Math.min(ledgerHorizonMin, PAPER_MAX_HOLD_CEILING_MIN);
  }
  const capped = Math.max(0.4, Math.min(2.0, signalScalar));
  const bonusRatio = (capped - 0.4) / 1.6; // 0.0 at min gate, 1.0 at max
  const base = PAPER_MAX_HOLD_MIN + bonusRatio * PAPER_MAX_HOLD_EXTRA_MIN;
  // Fix O (2026-09-27): hard ceiling. Signal-scaled × regime bonuses were
  // stretching holds to 186-224min while every hold bucket past 60min ran
  // net negative (see config PAPER_MAX_HOLD_CEILING_MIN).
  return Math.min(
    base * Math.max(0.25, Math.min(3, regimeMult)),
    PAPER_MAX_HOLD_CEILING_MIN,
  );
}

/** Reason-string tag for an open: `| hold 240m ledger 240m@61%`. Greppable in `hedges.reason`. */
export function holdPlanTag(maxHoldMin: number, horizonMin?: number | null, hitRate?: number | null): string {
  const ledger = horizonMin ? ` ledger ${horizonMin}m@${Math.round((hitRate ?? 0) * 100)}%` : '';
  return ` | hold ${Math.round(maxHoldMin)}m${ledger}`;
}

/** `metadata.holdPlan` on the hedges row — lets analyses group closes by the planned horizon. */
export function holdPlanMeta(maxHoldMin: number, horizonMin?: number | null, hitRate?: number | null) {
  return { maxHoldMin: Math.round(maxHoldMin), horizonMin: horizonMin ?? null, hitRate: hitRate ?? null };
}
