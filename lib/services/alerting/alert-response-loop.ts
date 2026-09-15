/**
 * Alert Response Loop — turns Discord alerts into auto-remediation.
 *
 * ## Why
 *
 * Discord is a passive tap on the shoulder. Alerts fire, operator sees
 * them, operator decides. Real autonomy needs a closed loop: 3 KILL
 * alerts within 60 min → auto-shrink spot to 20% USDC target. Profit-lock
 * pinned to 0% risk tier for > 24h → auto-unwind spot. Phantom hedge
 * rate > 1% for > 1h → auto-halt trader and page.
 *
 * `bluefin-health.ts` already does this pattern for one narrow case
 * (3-strike venue de-risk); this module generalizes.
 */

export type AlertLevel = 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'KILL';

export interface AlertEntry {
  at: number; // epoch ms
  level: AlertLevel;
  message: string;
  category?: string;
  // Chain that emitted the alert. Undefined = legacy SUI (backfill-safe).
  // Rule 1 (SHRINK_SPOT via 3 KILLs) filters on this so a future Hedera /
  // Sepolia cron KILL cannot halt the SUI pool by cross-contamination.
  chain?: string;
}

export type AutoResponseType =
  | 'SHRINK_SPOT'        // reduce risk allocation immediately
  | 'UNWIND_ALL_SPOT'    // profit-lock 24h → sell everything to USDC
  | 'HALT_TRADER'        // stop autonomous perp trader
  | 'HALT_AUTOHEDGE';    // stop sui-community-pool auto-hedge

export interface AutoResponse {
  type: AutoResponseType;
  reason: string;
  triggeredBy: AlertEntry[];
}

export interface EvaluateInput {
  alertLog: AlertEntry[];
  now?: number;
  profitLockZeroSinceMs?: number; // when profit-lock crossed 0% risk (undefined = not there)
  phantomRatePctLastHour?: number;
  // Total closed-hedge sample size the pct was computed over. Rule 3 halts
  // trader + autohedge; a single $0-PnL close in a quiet hour gives a
  // legitimate rate=100% that would otherwise trip both. Gate below.
  phantomTotalLastHour?: number;
  // Count of active hedges older than 20 min never touched by the reconciler
  // — the in-flight blind spot the closed-hedge rate can't see for 15 min.
  // Any nonzero count trips HALT so trader can't fire 3+ ghost opens in a row.
  inFlightPhantomOpenCount?: number;
}

// Rate-based rule can only halt once at least this many closed hedges
// exist in the last hour. Below this, a single 0-PnL close (which can be
// a legitimate ~zero-move fill) reads as 100% phantom and false-halts.
export const PHANTOM_RATE_MIN_SAMPLE = 5;

export async function evaluateAutoResponse(input: EvaluateInput): Promise<AutoResponse[]> {
  const now = input.now ?? Date.now();
  const responses: AutoResponse[] = [];

  // Rule 1: ≥3 KILL alerts in last 60 min → SHRINK_SPOT
  // SUI-scoped: entries with chain === undefined are legacy SUI alerts,
  // entries with chain !== 'sui' are cross-chain and MUST NOT halt SUI.
  const hourAgo = now - 60 * 60 * 1000;
  const recentKills = input.alertLog.filter(
    (a) => a.level === 'KILL' && a.at >= hourAgo && (a.chain ?? 'sui') === 'sui',
  );
  if (recentKills.length >= 3) {
    responses.push({
      type: 'SHRINK_SPOT',
      reason: `${recentKills.length} KILL alerts in last 60 min — automatic risk reduction`,
      triggeredBy: recentKills,
    });
  }

  // Rule 2: profit-lock zero-tier for > 24h → UNWIND_ALL_SPOT
  if (input.profitLockZeroSinceMs && now - input.profitLockZeroSinceMs > 24 * 60 * 60 * 1000) {
    responses.push({
      type: 'UNWIND_ALL_SPOT',
      reason: `profit-lock at 0% risk continuous for > 24h`,
      triggeredBy: [],
    });
  }

  // Rule 3: phantom rate > 1% for > 1h AND sample >= PHANTOM_RATE_MIN_SAMPLE.
  // Sample gate added 2026-09-15 after a single legitimate ~zero-move SOL
  // close in a quiet hour tripped rate=100% and false-halted both trader
  // and autohedge for 24h. Rule 4 still covers real breaches: in-flight
  // phantom opens halt at count>=1 with no sample gate.
  const phantomTotal = input.phantomTotalLastHour ?? 0;
  const phantomRatePct = input.phantomRatePctLastHour ?? 0;
  if (phantomRatePct > 1 && phantomTotal >= PHANTOM_RATE_MIN_SAMPLE) {
    responses.push({
      type: 'HALT_TRADER',
      reason: `phantom hedge rate ${phantomRatePct.toFixed(2)}% > 1% threshold (${phantomTotal} closes) — exchange fills unreliable`,
      triggeredBy: [],
    });
    responses.push({
      type: 'HALT_AUTOHEDGE',
      reason: `phantom hedge rate ${phantomRatePct.toFixed(2)}% > 1% threshold (${phantomTotal} closes) — exchange fills unreliable`,
      triggeredBy: [],
    });
  }

  // Rule 4: in-flight phantom opens (any) — closes the 15-min blind spot
  // where the closed-rate above stays 0% while trader fires ghost orders.
  // Any active hedge > 20 min old with no reconciler touch = trader's
  // openHedge succeeded on paper (orderHash) but engine dropped it.
  const inFlight = input.inFlightPhantomOpenCount ?? 0;
  if (inFlight >= 1) {
    responses.push({
      type: 'HALT_TRADER',
      reason: `${inFlight} in-flight phantom open(s) — active hedge(s) never touched by reconciler after 20 min`,
      triggeredBy: [],
    });
    responses.push({
      type: 'HALT_AUTOHEDGE',
      reason: `${inFlight} in-flight phantom open(s) — active hedge(s) never touched by reconciler after 20 min`,
      triggeredBy: [],
    });
  }

  return responses;
}
