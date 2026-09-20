/**
 * Pure decision function for the deploy-watchdog cron.
 *
 * Kept in a route-free module so unit tests can import without pulling
 * @upstash/qstash and other server-only deps that Jest can't ESM-load.
 */
export const DRIFT_GRACE_MS = 15 * 60 * 1000;      // wait 15min after a push before treating drift as a fail
export const KILL_ESCALATE_MS = 60 * 60 * 1000;    // escalate WARN → KILL after 60min of continuous drift

export interface DriftAlertInput {
  runningSha: string;
  originSha: string;
  originAgeMs: number;
  prevDriftSha: string | null;
  lastAlertMs: number;
  now: number;
}

export interface DriftAlertDecision {
  alertLevel: 'INFO' | 'WARN' | 'KILL' | null;
  alertMsg: string | null;
  nextDriftSha: string | null;
  nextLastAlert: number;
}

/**
 * State machine:
 *   drifted=false + prevDriftSha=null   → no-op (steady green)
 *   drifted=false + prevDriftSha=X      → INFO recovery
 *   drifted=true  + isFreshPush         → wait (< DRIFT_GRACE_MS)
 *   drifted=true  + prevDriftSha!=sha   → WARN (first tick for this sha)
 *   drifted=true  + stuckMs >= 60min    → KILL (re-alert; resets clock)
 *   drifted=true  + otherwise           → no-op (WARN already fired, KILL cooldown)
 */
export function decideAlert(input: DriftAlertInput, repo = 'ZKward/ZKward'): DriftAlertDecision {
  const { runningSha, originSha, originAgeMs, prevDriftSha, lastAlertMs, now } = input;
  const drifted = runningSha !== originSha;
  const isFreshPush = originAgeMs < DRIFT_GRACE_MS;
  const stuckMs = prevDriftSha === originSha && lastAlertMs > 0 ? now - lastAlertMs : 0;
  const ageMin = Math.round(originAgeMs / 60_000);

  if (!drifted) {
    if (prevDriftSha) {
      return {
        alertLevel: 'INFO',
        alertMsg: `✅ Deploy caught up: prod now running ${runningSha}.`,
        nextDriftSha: null, nextLastAlert: 0,
      };
    }
    return { alertLevel: null, alertMsg: null, nextDriftSha: prevDriftSha, nextLastAlert: lastAlertMs };
  }
  if (isFreshPush) {
    return { alertLevel: null, alertMsg: null, nextDriftSha: prevDriftSha, nextLastAlert: lastAlertMs };
  }
  const isNewDrift = prevDriftSha !== originSha;
  if (isNewDrift) {
    return {
      alertLevel: 'WARN',
      alertMsg: `⚠️ Deploy drift: origin/main @ ${originSha} committed ${ageMin}min ago, prod still running ${runningSha}. Check Vercel deployment status — silent build failure likely.`,
      nextDriftSha: originSha, nextLastAlert: now,
    };
  }
  if (stuckMs >= KILL_ESCALATE_MS) {
    return {
      alertLevel: 'KILL',
      alertMsg: `🚨 Deploy STUCK ${ageMin}min: origin/main @ ${originSha} still not deployed. Prod on ${runningSha}. Run: gh api "repos/${repo}/deployments?environment=Production&per_page=1" to inspect.`,
      nextDriftSha: prevDriftSha, nextLastAlert: now,
    };
  }
  return { alertLevel: null, alertMsg: null, nextDriftSha: prevDriftSha, nextLastAlert: lastAlertMs };
}
