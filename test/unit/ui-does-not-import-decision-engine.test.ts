/**
 * The browser never receives decision-engine code.
 *
 * Anything a UI file imports is bundled and shipped to every visitor. The
 * dashboard once imported the signal services directly, which published
 * that logic in the bundle and ran its upstream calls from the browser.
 * UI code takes types from `lib/types/` and data from the API.
 */
import { describe, it, expect } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = process.cwd();

const ENGINE = [
  '@/lib/services/market-data/',
  '@/lib/services/ai/',
  '@/lib/services/paper-trader/',
  '@/lib/services/trading/',
  '@/lib/services/hedging/',
  '@/lib/services/sui/cron/',
  '@/lib/services/agents/',
  '@/lib/services/alerting/',
  '@/agents/',
];

/** UI trees. */
const UI_DIRS = ['components', 'contexts', 'lib/hooks', 'lib/api', 'app'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).replace(/\\/g, '/');
    if (rel === 'app/api') continue; // server routes
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe('UI code does not import the decision engine', () => {
  const files = UI_DIRS.flatMap((d) => walk(join(ROOT, d)));

  it('scans the UI', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no static, dynamic or type import of an engine module', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      for (const m of src.matchAll(/(?:from|import\(|typeof import\()\s*['"]([^'"]+)['"]/g)) {
        if (ENGINE.some((p) => m[1].startsWith(p))) offenders.push(`${f} -> ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
