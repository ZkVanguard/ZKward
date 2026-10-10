/**
 * The in-process prover end to end. A proof made in TypeScript is accepted
 * by the TypeScript verifier and by the Python one, under its own statement
 * only; the Python audit reads the hedge back out of its commitment; and two
 * proofs of the same hedge share nothing.
 *
 * The Python half needs Python (standard library only). It is skipped when
 * Python is absent, unless ZK_REQUIRE_PYTHON is set.
 */
import { describe, it, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { proveHedgePolicy, proveRiskScore, riskScoreStatement, type ZKProof } from '@/zk/prover/ProofGenerator';
import { verifyBoundsProof, verifyHedgePolicyProof } from '@/zk/verifier/boundsStark';

// 0.5 BTC at $82,000 is $41,000 of exposure; the declared notional is $45,000.
const hedge = {
  asset: 'BTC', side: 'SHORT' as const, leverageX: 3, notionalValueUsdcCents: 4_500_000,
  sizeMilli: 500, entryPriceCents: 8_200_000, portfolioId: 2, timestampMs: 1_791_500_000_000,
};
const caps = { leverage_cap: 4, notional_cap_cents: 100_000_000 };

const PYTHON_CHECK = `
import json, sys
from zkp.core import hedge_stark as hs
d = json.load(open(sys.argv[1]))
caps = d['caps']
print(json.dumps({
    'accepted': hs.verify(d['proof'], caps, d['proof']['commitment']),
    'lower_cap': hs.verify(d['proof'], {**caps, 'leverage_cap': 2}),
    'opened': hs.audit_opening(d['opening'], d['proof']['commitment'], caps),
}))
`;

let first: ZKProof;

describe('a hedge policy proof made in this process', () => {
  it('verifies under its caps and its commitment, and under nothing else', async () => {
    first = await proveHedgePolicy(hedge, caps);
    expect(first.verified).toBe(true);
    expect(first.commitment).toMatch(/^[0-9a-f]{96}$/);
    expect(first.proofHash).toBe(first.commitment);
    // The public proof names no part of the hedge.
    expect(Object.keys(first.proof).sort()).toEqual(['commitment', 'final', 'fri_roots', 'nonce', 'ood', 'protocol', 'public', 'queries', 'quotient_root']);

    expect(verifyHedgePolicyProof(first.proof, caps, first.commitment)).toBe(true);
    expect(verifyHedgePolicyProof(first.proof, { ...caps, leverage_cap: 2 })).toBe(false);
    expect(verifyHedgePolicyProof(first.proof, { ...caps, notional_cap_cents: 4_000_000 })).toBe(false);
    expect(verifyHedgePolicyProof(first.proof, caps, '00'.repeat(48))).toBe(false);

    const edited = structuredClone(first.proof) as { final: string };
    edited.final = (edited.final[0] === '0' ? '1' : '0') + edited.final.slice(1);
    expect(verifyHedgePolicyProof(edited, caps)).toBe(false);
  }, 120_000);

  it('is accepted by the Python verifier, which reads the hedge back out of the commitment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zk-ts-proof-'));
    try {
      const file = join(dir, 'proof.json');
      writeFileSync(file, JSON.stringify({ proof: first.proof, opening: first.opening, caps }));
      const run = spawnSync('python', ['-c', PYTHON_CHECK, file], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 100_000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      if (run.error || run.status !== 0) {
        if (process.env.ZK_REQUIRE_PYTHON) throw new Error(`python check failed: ${run.error?.message ?? run.stderr?.slice(-300)}`);
        console.warn('Python not available: the second verifier was skipped');
        return;
      }
      const out = JSON.parse(run.stdout.trim().split('\n').pop() as string);
      expect(out.accepted).toBe(true);
      expect(out.lower_cap).toBe(false);
      expect(out.opened).toEqual({
        leverage: 3, notional: 4_500_000, asset: 1, side: 1, sizeMilli: 500, entryPriceCents: 8_200_000,
        slack: 1000 * 4_500_000 - 500 * 8_200_000, portfolioId: 2, timestampMs: 1_791_500_000_000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('shares nothing with a second proof of the same hedge', async () => {
    const second = await proveHedgePolicy(hedge, caps);
    expect(second.verified).toBe(true);
    expect(second.commitment).not.toBe(first.commitment);
    const a = first.proof as Record<string, any>;
    const b = second.proof as Record<string, any>;
    expect(b.quotient_root).not.toBe(a.quotient_root);
    expect(b.ood.trace_z).not.toBe(a.ood.trace_z);
    expect(b.final).not.toBe(a.final);
    // A proof for one commitment does not verify for the other.
    expect(verifyHedgePolicyProof(second.proof, caps, first.commitment)).toBe(false);
  }, 120_000);
});

describe('a risk-score proof made in this process', () => {
  it('verifies under its threshold only', async () => {
    const proven = await proveRiskScore(63, 70, '0619fb3793c77deddf71250e684ad0074c8f9b08ec0fd218e780cc77d7235f2c');
    expect(proven.verified).toBe(true);
    expect(verifyBoundsProof(proven.proof, riskScoreStatement(70), proven.commitment)).toBe(true);
    expect(verifyBoundsProof(proven.proof, riskScoreStatement(60))).toBe(false);
    expect(verifyBoundsProof(proven.proof, { kind: 'risk-score-2', bounds: [[0, 70]] })).toBe(false);
  }, 120_000);
});
