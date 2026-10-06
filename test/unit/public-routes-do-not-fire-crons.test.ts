/**
 * A cron route runs when the scheduler, or an operator with the credential,
 * says so. Until 2026-10 a helper called from the public price route fetched
 * five cron routes with the server's own secret, so anonymous traffic decided
 * when the pool's monitoring and hedging ran, once per warm instance, with no
 * claim. This fails if any route outside cron/ and admin/ builds a cron URL.
 */
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

const ROOT = process.cwd();
const API = join(ROOT, 'app', 'api');

// The one sanctioned caller: an action that checks the service credential first.
const ALLOWED = new Set(['app/api/sui/community-pool/handlers/admin-actions.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);

describe('only the scheduler and operators fire cron routes', () => {
  const files = walk(API)
    .map((p) => relative(ROOT, p).split(sep).join('/'))
    .filter((p) => !p.startsWith('app/api/cron/') && !p.startsWith('app/api/admin/'));

  it('scans the public API tree', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no route outside cron/ and admin/ builds a cron route URL', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (ALLOWED.has(file)) continue;
      readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/).forEach((line, i) => {
        if (!isComment(line) && line.includes('/api/cron/')) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the sanctioned caller authenticates before it builds the URL', () => {
    const src = readFileSync(join(ROOT, 'app/api/sui/community-pool/handlers/admin-actions.ts'), 'utf8');
    const url = src.indexOf('/api/cron/');
    const fn = src.lastIndexOf('export async function', url);
    const body = src.slice(fn, url);
    expect(body).toContain('verifyCronRequest(');
  });

  it('the price route has no side channel into the pool', () => {
    const src = readFileSync(join(ROOT, 'app/api/prices/route.ts'), 'utf8');
    for (const s of ['CRON_SECRET', 'recordPriceUpdate', 'PriceAlertWebhook']) expect(src).not.toContain(s);
  });
});
