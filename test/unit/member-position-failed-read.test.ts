/**
 * A member's share balance decides whether the site lets them withdraw.
 * Until 2026-10 the read went to one rate-limited endpoint and turned every
 * failure into "zero shares", so a member could be shown an empty position.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(join(process.cwd(), 'lib/services/sui/SuiUsdcPoolService.ts'), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('async getMemberPosition(address: string)');
const body = src.slice(start, src.indexOf('\n  /** Get all members of the USDC pool', start));

describe('getMemberPosition', () => {
  it('is found', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body.length).toBeGreaterThan(500);
  });

  it('reads through the failover client, not the single configured endpoint', () => {
    expect(body).toContain('createFailoverSuiClient(this.network).getDynamicFieldObject(');
    expect(body).not.toContain('suiFetchWithTimeout(this.config.rpcUrl');
  });

  it('only "no such entry" means not a member; every other failure throws', () => {
    expect(body).toContain("if (res.error.code === 'dynamicFieldNotFound') return defaultPosition;");
    expect(body).toContain('throw new Error(`member read failed: ${res.error.code}`);');
  });

  it('a failure is never turned into a zero position on the way out', () => {
    expect(body).not.toMatch(/\.catch\(\(\) => defaultPosition\)/);
  });
});
