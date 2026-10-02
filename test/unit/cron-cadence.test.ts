/**
 * One definition of "is this a job, and when is it stale" shared by the
 * heartbeat monitor (alerts) and the dashboard (job health).
 */
import { describe, it, expect } from '@jest/globals';
import { EXPECTED_CADENCE_MIN, STALE_MULTIPLIER, isLiveJob, staleLimitMin } from '@/lib/services/alerting/cron-cadence';

describe('cron cadence', () => {
  it('retired routes are not jobs', () => {
    for (const name of ['hedge-monitor', 'health-monitor', 'lead-cycle', 'resolve-outcomes']) {
      expect(EXPECTED_CADENCE_MIN[name]).toBe(0);
      expect(isLiveJob(name)).toBe(false);
    }
  });

  it('claim markers and sub-task keys are not jobs', () => {
    expect(isLiveJob('paper-fast-tick-claim')).toBe(false);
    expect(isLiveJob('solana-pool:tick-claim')).toBe(false);
    expect(isLiveJob('solana-pool:nav-snapshot')).toBe(false);
  });

  it('scheduled jobs count, including ones without a table entry', () => {
    for (const name of ['sui-community-pool', 'solana-pool', 'agent-signal-tick', 'paper-fast-tick', 'paper-gated-trader']) {
      expect(isLiveJob(name)).toBe(true);
    }
  });

  it('agent-signal-tick is judged on its 15 min claim window, not 2 min', () => {
    // It only writes a heartbeat on a claimed run; a 6 min limit raised a false KILL.
    expect(EXPECTED_CADENCE_MIN['agent-signal-tick']).toBe(15);
    expect(staleLimitMin('agent-signal-tick')).toBe(15 * STALE_MULTIPLIER);
  });

  it('a job without a known cadence is stale after 20 min', () => {
    expect(staleLimitMin('paper-fast-tick')).toBe(20);
    expect(staleLimitMin('polymarket-edge-trader')).toBe(20);
  });
});
