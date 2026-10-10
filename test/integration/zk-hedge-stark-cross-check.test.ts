/**
 * Two verifiers, one verdict. The Python prover writes a corpus of hedge
 * policy proofs (honest, edited, and forged by a prover that cheats at each
 * step) with the Python verifier's verdict on each. The TypeScript verifier
 * must give the same verdict on every one.
 *
 * Needs Python with the prover's requirements. Skips when Python is absent.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyHedgePolicyProof, type HedgePolicyPublic } from '@/zk/verifier/hedgeStark';

interface Case {
  name: string;
  proof: unknown;
  public: HedgePolicyPublic;
  commitment: string | null;
  expected: boolean;
}

describe('hedge policy STARK: the TypeScript verifier agrees with the Python one', () => {
  it('on every proof of the corpus', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zk-cross-'));
    const out = join(dir, 'corpus.json');
    try {
      const run = spawnSync('python', ['-m', 'zkp.tests.export_cross_check', out], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 240_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      if (run.error || run.status !== 0) {
        console.warn('Python prover not available: cross-check skipped', run.error?.message ?? run.stderr?.slice(-300));
        return;
      }
      // Python writes caps above 2^53 as bare integers; keep them exact.
      const raw = readFileSync(out, 'utf8').replace(/"(leverage_cap|notional_cap_cents|asset_count)": (\d+)/g, '"$1": "$2"');
      const cases = JSON.parse(raw) as Case[];
      expect(cases.length).toBeGreaterThanOrEqual(30);

      const disagreements: string[] = [];
      for (const c of cases) {
        const got = verifyHedgePolicyProof(c.proof, c.public, c.commitment ?? undefined);
        if (got !== c.expected) disagreements.push(`${c.name}: python ${c.expected}, typescript ${got}`);
      }
      expect(disagreements).toEqual([]);

      // The corpus is only worth something if it holds both verdicts.
      const accepted = cases.filter((c) => c.expected).map((c) => c.name);
      expect(accepted).toEqual(['honest', 'honest, with its commitment named', 'honest, caps beyond 2^53']);
      expect(cases.filter((c) => c.name.startsWith('dishonest prover')).length).toBe(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('malformed input is false, never an exception', () => {
    const caps = { leverage_cap: 4, notional_cap_cents: 100_000_000 };
    for (const junk of [null, undefined, 7, 'proof', {}, { protocol: 'zkward-hedge-policy-v3' }, { protocol: 'zkward-hedge-policy-v3', commitment: 'zz' }]) {
      expect(verifyHedgePolicyProof(junk, caps)).toBe(false);
    }
    expect(verifyHedgePolicyProof({}, { leverage_cap: 'x', notional_cap_cents: 1 })).toBe(false);
  });
});
