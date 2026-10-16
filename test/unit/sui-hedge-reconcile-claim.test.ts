/**
 * The hedge-state reconcile changes on-chain state, so it claims its run
 * before anything else after auth, and resets only on drift seen by two runs
 * in a row: one reading can be a venue blip between a close and its record.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.resolve(__dirname, '../../app/api/cron/sui-hedge-reconcile/route.ts'), 'utf8');
const at = (s: string) => src.indexOf(s);

describe('sui-hedge-reconcile', () => {
  it('authenticates, then claims its run, before any other work; an unclaimed run does nothing', () => {
    const auth = at("verifyCronRequest(request, 'SuiHedgeReconcile')");
    const claim = at('tryClaimCronRun(CLAIM_ID, CLAIM_MS, Date.now())');
    expect(auth).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(auth);
    expect(claim).toBeLessThan(at('runWatchdogChecks()'));
    expect(src.slice(claim, claim + 300)).toContain('if (!claim.claimed)');
    expect(src).not.toContain("setCronState('cron:lastRun:sui-hedge-reconcile'");
  });

  it('resets only when the previous run saw the drift too, and clears the mark when in sync', () => {
    const confirm = at('const confirmed = seenAt > 0 && Date.now() - seenAt <= DRIFT_CONFIRM_MS;');
    const reset = at('::admin_reset_hedge_state`');
    expect(confirm).toBeGreaterThan(0);
    expect(reset).toBeGreaterThan(confirm);
    expect(src.slice(confirm, confirm + 300)).toContain('if (!confirmed) {');
    expect(src).toContain('getCronStateStrict<number>(KEY_DRIFT_SEEN)');
    const inSync = at('if (!driftDetected) {');
    expect(src.slice(inSync, inSync + 120)).toContain('setCronState(KEY_DRIFT_SEEN, null)');
  });
});
