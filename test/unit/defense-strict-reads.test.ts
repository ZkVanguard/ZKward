/**
 * A defense read that fails is not "no drawdown", "no cap" or "no alerts".
 * Each site below reads strictly and falls to its own safe side: no new
 * hedge, no capital step this run, no overwritten alert log, a worker that
 * stays in standby.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');
const PEAK_OR = "getCronStateOr<number>(CronKeys.poolNavPeak('community-pool')";

describe('defense reads fail safe', () => {
  it.each([
    'lib/services/sui/cron/step-8-auto-hedge.ts',
    'lib/services/sui/cron/step-4-nav-defense.ts',
    'app/api/cron/agent-signal-tick/route.ts',
  ])('%s reads the NAV peak strictly', (f) => {
    const src = read(f);
    expect(src).not.toContain(PEAK_OR);
    expect(src).toContain("getCronStateStrict<number>(CronKeys.poolNavPeak('community-pool'))");
  });

  it('step 8: a failed drawdown check skips auto-hedge this tick', () => {
    const src = read('lib/services/sui/cron/step-8-auto-hedge.ts');
    const c = src.indexOf('} catch (haltErr) {');
    expect(src.slice(c, c + 200)).toContain('drawdownHalted = true;');
  });

  it('step 4: a failed profit-lock or override read skips the capital steps, never forces a sell', () => {
    const src = read('lib/services/sui/cron/step-4-nav-defense.ts');
    expect(src).not.toContain("getCronStateOr<number | null>('profit-lock:zero-since'");
    expect(src).toContain("getCronStateStrict<{ capPct: number; reason: string; expiresAtMs: number }>(");
    const c = src.indexOf('} catch (lockErr) {');
    expect(src.slice(c, c + 200)).toContain('defenseReadFailed = true;');
    expect(src).toContain('return { navUsd, sharePriceUsd, aboveSafetyCeiling, defenseReadFailed };');
  });

  it('the alert log is never rewritten from a failed read', () => {
    const src = read('lib/utils/discord-notify.ts');
    expect(src).not.toMatch(/getCronState<AlertLogEntry\[\]>\(ALERT_LOG_KEY\)\.catch/);
    expect(src.match(/getCronStateStrict<AlertLogEntry\[\]>\(ALERT_LOG_KEY\)/g)).toHaveLength(2);
  });

  it('the paper worker stays in standby when it cannot read the fast tick heartbeat', () => {
    const src = read('scripts/paper-trader-worker.ts');
    expect(src).toContain("getCronStateStrict<number>('cron:lastRun:paper-fast-tick').then((v) => Number(v) || 0, () => Infinity)");
    expect(src).toContain('if (lastFastTick === Infinity || Date.now() - lastFastTick < standbyMs) {');
  });
});
