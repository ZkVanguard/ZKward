/**
 * Runner: deploy-drift + state-integrity checks in one call.
 *
 * Executes the two "silent-drift watchdog" checks and emits Discord
 * alerts on drift. Best-effort — throws are caught and logged so this
 * can piggyback on capital-critical crons without blocking them.
 *
 * Currently invoked from sui-hedge-reconcile (hourly) because all 10
 * QStash schedule slots are used by capital-critical crons and this
 * pair is pure observability — safe to attach to an existing cadence.
 */
import { logger } from '@/lib/utils/logger';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { getCronStateOr, setCronState, getCronStateByPrefix } from '@/lib/db/cron-state';
import { decideAlert, DRIFT_GRACE_MS } from '@/lib/services/deploy-watchdog/decide';
import { findIntegrityViolations } from '@/lib/services/state-integrity/checks';
import { getActiveHedges } from '@/lib/db/hedges';

const CRON_KEY_LAST_DRIFT_SHA = 'deploy-watchdog:last-drift-sha';
const CRON_KEY_LAST_ALERT = 'deploy-watchdog:last-alert-ms';

const PROD_URL = (process.env.PROD_URL || 'https://www.zkward.com').replace(/\/$/, '');
const REPO = (process.env.DEPLOY_WATCHDOG_REPO || 'ZKward/ZKward').trim();

export interface WatchdogResult {
  ok: boolean;
  runningSha?: string;
  originSha?: string;
  drifted?: boolean;
  isFreshPush?: boolean;
  deployAlertLevel?: 'INFO' | 'WARN' | 'KILL' | null;
  integrityViolations: number;
  error?: string;
}

async function runDeployDriftCheck(now: number): Promise<Pick<WatchdogResult, 'runningSha' | 'originSha' | 'drifted' | 'isFreshPush' | 'deployAlertLevel'>> {
  const [healthRes, ghRes] = await Promise.all([
    fetch(`${PROD_URL}/api/health/production`, {
      signal: AbortSignal.timeout(15_000),
      cache: 'no-store',
    }),
    fetch(`https://api.github.com/repos/${REPO}/branches/main`, {
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': 'zkvanguard-deploy-watchdog' },
      cache: 'no-store',
    }),
  ]);
  const health = (await healthRes.json()) as { build?: { commit?: string } };
  const gh = (await ghRes.json()) as {
    commit?: { sha?: string; commit?: { committer?: { date?: string } } };
  };
  const runningSha = String(health?.build?.commit || '').slice(0, 8);
  const originSha = String(gh?.commit?.sha || '').slice(0, 8);
  const originCommitDate = gh?.commit?.commit?.committer?.date;
  const originAgeMs = originCommitDate ? now - new Date(originCommitDate).getTime() : 0;
  if (!runningSha || !originSha) {
    return { runningSha, originSha, deployAlertLevel: null };
  }
  const prevDriftSha = await getCronStateOr<string | null>(CRON_KEY_LAST_DRIFT_SHA, null);
  const lastAlertMs = await getCronStateOr<number>(CRON_KEY_LAST_ALERT, 0);
  const decision = decideAlert({
    runningSha, originSha, originAgeMs, prevDriftSha, lastAlertMs, now,
  }, REPO);
  if (decision.alertLevel && decision.alertMsg) {
    await notifyDiscord(decision.alertMsg, decision.alertLevel, {
      runningSha, originSha, originAgeMinutes: Math.round(originAgeMs / 60_000),
    }).catch(() => {});
  }
  await Promise.all([
    setCronState(CRON_KEY_LAST_DRIFT_SHA, decision.nextDriftSha).catch(() => {}),
    setCronState(CRON_KEY_LAST_ALERT, decision.nextLastAlert).catch(() => {}),
  ]);
  return {
    runningSha, originSha,
    drifted: runningSha !== originSha,
    isFreshPush: originAgeMs < DRIFT_GRACE_MS,
    deployAlertLevel: decision.alertLevel,
  };
}

async function runStateIntegrityCheck(now: number): Promise<number> {
  const [halts, directives, peaks, dustFlags, activeHedges] = await Promise.all([
    getCronStateByPrefix('cron:haltUntil:'),
    getCronStateByPrefix('alert-response:'),
    getCronStateByPrefix('poolNav:peak:'),
    getCronStateByPrefix('stale-dust-flag:'),
    getActiveHedges(undefined, 'sui').catch(() => []),
  ]);
  const activeIds = new Set<number | string>(activeHedges.map((h) => h.id));
  const entries = [
    ...[...halts.entries()].map(([key, value]) => ({ key, value })),
    ...[...directives.entries()].map(([key, value]) => ({ key, value })),
    ...[...peaks.entries()].map(([key, value]) => ({ key, value })),
    ...[...dustFlags.entries()].map(([key, value]) => ({ key, value })),
  ];
  const violations = findIntegrityViolations(entries, activeIds, now);
  if (violations.length > 0) {
    const grouped: Record<string, number> = {};
    for (const v of violations) grouped[v.category] = (grouped[v.category] || 0) + 1;
    const groupSummary = Object.entries(grouped).map(([c, n]) => `${c}:${n}`).join(', ');
    const first = violations.slice(0, 3).map((v) => `${v.key} — ${v.detail}`).join(' | ');
    await notifyDiscord(
      `⚠️ State-integrity drift: ${violations.length} violation(s) [${groupSummary}]. First 3: ${first}`,
      'WARN', { violations },
    ).catch(() => {});
  }
  return violations.length;
}

/**
 * Run both watchdog checks. Any exception in EITHER check is caught +
 * logged; caller's execution continues. Returns a result summary for
 * observability but callers can ignore it.
 */
export async function runWatchdogChecks(now = Date.now()): Promise<WatchdogResult> {
  let deployPart: Awaited<ReturnType<typeof runDeployDriftCheck>> = { deployAlertLevel: null };
  let integrityViolations = 0;
  let error: string | undefined;
  try {
    deployPart = await runDeployDriftCheck(now);
  } catch (e) {
    error = `deploy: ${e instanceof Error ? e.message : String(e)}`;
    logger.warn('[watchdog] deploy-drift check failed (non-critical)', { error });
  }
  try {
    integrityViolations = await runStateIntegrityCheck(now);
  } catch (e) {
    const msg = `integrity: ${e instanceof Error ? e.message : String(e)}`;
    error = error ? `${error}; ${msg}` : msg;
    logger.warn('[watchdog] state-integrity check failed (non-critical)', { error: msg });
  }
  return {
    ok: !error,
    ...deployPart,
    integrityViolations,
    error,
  };
}
