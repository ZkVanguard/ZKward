/**
 * Two verifiers, one verdict. The Python prover writes a corpus of proofs
 * (honest, edited, and forged by a prover that cheats at each step) with the
 * Python verifier's verdict on each. The TypeScript verifier must give the
 * same verdict on every one.
 *
 * Needs Python (standard library only). Skips when Python is absent, unless
 * ZK_REQUIRE_PYTHON is set.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyBoundsProof, verifyHedgePolicyProof, type BoundsStatement } from '@/zk/verifier/boundsStark';

interface Case {
  name: string;
  proof: unknown;
  public: BoundsStatement;
  commitment: string | null;
  expected: boolean;
}

describe('bounds STARK: the TypeScript verifier agrees with the Python one', () => {
  it('on every proof of the corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zk-cross-'));
    const out = join(dir, 'corpus.json');
    try {
      const run = spawnSync('python', ['-m', 'zkp.tests.export_cross_check', out], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 280_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      if (run.error || run.status !== 0) {
        // Where the prover is expected (the CI prover job), a missing corpus is a failure, not a skip.
        if (process.env.ZK_REQUIRE_PYTHON) throw new Error(`corpus export failed: ${run.error?.message ?? run.stderr?.slice(-300)}`);
        console.warn('Python prover not available: cross-check skipped', run.error?.message ?? run.stderr?.slice(-300));
        return;
      }
      // Bounds go up to 2^62; a bare JSON number above 2^53 would be rounded. Keep every bound exact as a string.
      const raw = readFileSync(out, 'utf8').replace(/"bounds": (\[\[.*?\]\])/g, (_m, list: string) => `"bounds": ${list.replace(/\d+/g, '"$&"')}`);
      const cases = JSON.parse(raw) as Case[];
      expect(cases.length).toBeGreaterThanOrEqual(35);

      const disagreements: string[] = [];
      for (const c of cases) {
        const got = verifyBoundsProof(c.proof, c.public, c.commitment ?? undefined);
        if (got !== c.expected) disagreements.push(`${c.name}: python ${c.expected}, typescript ${got}`);
      }
      expect(disagreements).toEqual([]);

      // The corpus is only worth something if it holds both verdicts.
      const accepted = cases.filter((c) => c.expected).map((c) => c.name);
      expect(accepted).toEqual(['honest', 'honest, with its commitment named', 'honest, another kind, bounds beyond 2^53']);
      expect(cases.filter((c) => c.name.startsWith('dishonest prover')).length).toBe(6);

      // The hedge wrapper builds the same statement from the caps.
      const honest = cases[0];
      expect(verifyHedgePolicyProof(honest.proof, { leverage_cap: 4, notional_cap_cents: 100_000_000 })).toBe(true);
      expect(verifyHedgePolicyProof(honest.proof, { leverage_cap: 3, notional_cap_cents: 100_000_000 })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('malformed input is false, never an exception', () => {
    const statement: BoundsStatement = { kind: 'k', bounds: [[0, 4]] };
    for (const junk of [null, undefined, 7, 'proof', {}, { protocol: 'zkward-bounds-v4' }, { protocol: 'zkward-bounds-v4', commitment: 'zz' }]) {
      expect(verifyBoundsProof(junk, statement)).toBe(false);
    }
    for (const bad of [
      { kind: '', bounds: [] }, { kind: 'has space', bounds: [] }, { kind: 'k', bounds: [[5, 4]] },
      { kind: 'k', bounds: [[0, (1n << 62n).toString()]] }, { kind: 'k', bounds: Array(8).fill([0, 1]) },
      { kind: 'k', bounds: [[0, 0], [0, (1n << 55n).toString()]], product: true },
    ] as BoundsStatement[]) {
      expect(verifyBoundsProof({}, bad)).toBe(false);
    }
    expect(verifyHedgePolicyProof({}, { leverage_cap: 'x', notional_cap_cents: 1 })).toBe(false);
  });
});
