/**
 * Solana vertical boundary test — the fence goes up before the animal arrives.
 *
 * Independence contract (docs/_ops plan §1d, enforced per §1e):
 *   1. Nothing outside the Solana vertical may import from lib/services/solana.
 *   2. The vertical writes no cron_state key outside the 'solana-pool:' namespace.
 *
 * Grep-based like wiring-manifest.test.ts: violations fail CI, not code review.
 * This test passes on an empty vertical (commit #1 ships it before any Solana
 * module exists).
 */
import { describe, it, expect } from '@jest/globals';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

const VERTICAL_PREFIXES = [
  'lib/services/solana/',
  'lib/db/solana-pool',
  'app/api/solana-pool/',
  'app/api/cron/solana-pool/',
  'app/[locale]/solana/',
  'components/solana/',
  'test/',
];

function gitGrep(pattern: string): string[] {
  try {
    const out = execSync(`git grep -l -E "${pattern}" -- "*.ts" "*.tsx"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return []; // git grep exits 1 on zero matches
  }
}

function insideVertical(file: string): boolean {
  const norm = file.replace(/\\/g, '/');
  return VERTICAL_PREFIXES.some((p) => norm.startsWith(p));
}

describe('solana vertical boundary', () => {
  it('nothing outside the vertical imports lib/services/solana or lib/db/solana-pool', () => {
    const importers = gitGrep("from '@/lib/(services/solana|db/solana-pool)|import\\(.@/lib/(services/solana|db/solana-pool)");
    const violations = importers.filter((f) => !insideVertical(f));
    expect(violations).toEqual([]);
  });

  it('the vertical only touches solana-pool:* cron_state keys', () => {
    const dirs = ['lib/services/solana', 'app/api/solana-pool', 'app/api/cron/solana-pool'].map(
      (d) => path.join(ROOT, d),
    );
    const offenders: string[] = [];
    const keyCall = /(?:setCronState|getCronState|getCronStateOr|tryClaimCronRun)\s*(?:<[^>]*>)?\s*\(\s*(['"`])([^'"`]+)\1/g;
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      const walk = (d: string): string[] =>
        fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)],
        );
      for (const file of walk(dir).filter((f) => /\.(ts|tsx)$/.test(f))) {
        const src = fs.readFileSync(file, 'utf8');
        let m: RegExpExecArray | null;
        while ((m = keyCall.exec(src)) !== null) {
          const key = m[2];
          // cron:lastRun:solana-pool is the standard heartbeat namespace — allowed.
          if (!key.startsWith('solana-pool:') && !key.startsWith('cron:lastRun:solana-pool')) {
            offenders.push(`${path.relative(ROOT, file)} → "${key}"`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
