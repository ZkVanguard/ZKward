/**
 * Expected cadence per cron heartbeat, in minutes — the one definition of
 * "stale" shared by the heartbeat monitor (alerts) and the dashboard (job
 * health). 0 = known-dormant: not scheduled, never alerted, never counted
 * as a job.
 */
export const EXPECTED_CADENCE_MIN: Record<string, number> = {
  // Self-debounced to SIGNAL_TICK_INTERVAL_MS (15 min) since 2026-08-04 and
  // only writes its heartbeat on a claimed run. The old 2 min expectation
  // raised a false KILL whenever the claim window outlasted 6 min.
  'agent-signal-tick':       15,
  'polymarket-edge-trader':   5,
  'bluefin-health':           5,
  'paper-trader':             5,   // piggybacks on polymarket-edge-trader
  'liquidation-guard':       10,
  'pool-nav-monitor':        15,
  'bluefin-db-reconcile':    15,
  'alert-response-loop':     15,
  'heartbeat-monitor':        5,   // watches itself
  'sui-community-pool':      30,
  'sui-hedge-reconcile':     60,
  'sui-collect-fees':      1440,   // daily
  'poly-discover':           60,   // best-guess; adjust when schedule confirmed
  'solana-pool':              1,   // 60s schedule; enabled at prod go-live 2026-09-29
  // Known-dormant — don't alert, don't count:
  'hedge-monitor':            0,
  'health-monitor':           0,
  'lead-cycle':               0,
  'resolve-outcomes':         0,   // piggybacked inside polymarket-edge-trader
};

/** Stale = no heartbeat for more than cadence × this. */
export const STALE_MULTIPLIER = 3;

/**
 * Is this `cron:lastRun:<name>` key a scheduled job? Claim markers
 * (`*-claim`), sub-task keys (`a:b`) and retired routes share the prefix
 * but are not jobs anyone should see in a health count.
 */
export function isLiveJob(name: string): boolean {
  if (name.includes(':') || name.endsWith('-claim')) return false;
  const cadence = EXPECTED_CADENCE_MIN[name];
  return cadence === undefined || cadence > 0;
}

/** Minutes without a heartbeat after which a job counts as stale. */
export function staleLimitMin(name: string): number {
  return Math.max(20, (EXPECTED_CADENCE_MIN[name] ?? 0) * STALE_MULTIPLIER);
}
