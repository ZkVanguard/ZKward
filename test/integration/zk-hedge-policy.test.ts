/**
 * The proof server end to end: a hedge inside the rules proves and verifies,
 * one outside them cannot be proven, a proof is only valid under the
 * statement it was made for, and the TypeScript client reports "verified"
 * from its own verifier.
 *
 * Needs the Python prover (`python start.py`). Skips when it is not up; a
 * real run takes seconds, not milliseconds.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { proveHedgePolicy, proveRiskScore, riskScoreStatement, ProofRefusedError } from '@/zk/prover/ProofGenerator';
import { verifyBoundsProof, verifyHedgePolicyProof } from '@/zk/verifier/boundsStark';

const ZK_API_URL = (process.env.ZK_API_URL || '').trim() || 'http://localhost:8000';
let up = false;

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${ZK_API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};

// 0.5 BTC at $82,000 is $41,000 of exposure.
const hedge = {
  asset: 'BTC', side: 'LONG' as const, leverageX: 3, notionalValueUsdcCents: 4_100_000,
  sizeMilli: 500, entryPriceCents: 8_200_000, portfolioId: 2, timestampMs: 1_791_500_000_000,
};
const caps = { leverage_cap: 4, notional_cap_cents: 100_000_000 };

beforeAll(async () => {
  up = await fetch(`${ZK_API_URL}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
});

describe('hedge policy proof through the server', () => {
  it('a hedge inside the rules proves; the proof verifies for its commitment under its caps only', async () => {
    if (!up) return;
    const p = await post('/api/zk/hedge-policy/prove', { witness: hedge, public: caps });
    expect(p.status).toBe(200);
    expect(p.body.commitment).toMatch(/^[0-9a-f]{96}$/);
    expect(p.body.proof.commitment).toBe(p.body.commitment);
    // The public proof names no part of the hedge.
    expect(Object.keys(p.body.proof).sort()).toEqual(['commitment', 'final', 'fri_roots', 'nonce', 'ood', 'protocol', 'public', 'queries', 'quotient_root']);

    const ok = await post('/api/zk/hedge-policy/verify', { proof: p.body.proof, public: caps, commitment: p.body.commitment });
    expect(ok.body.valid).toBe(true);

    const lowerCap = await post('/api/zk/hedge-policy/verify', { proof: p.body.proof, public: { ...caps, leverage_cap: 2 } });
    expect(lowerCap.body.valid).toBe(false);

    const otherCommitment = await post('/api/zk/hedge-policy/verify', { proof: p.body.proof, public: caps, commitment: '00'.repeat(48) });
    expect(otherCommitment.body.valid).toBe(false);

    const edited = structuredClone(p.body.proof);
    edited.final = (edited.final[0] === '0' ? '1' : '0') + edited.final.slice(1);
    expect((await post('/api/zk/hedge-policy/verify', { proof: edited, public: caps })).body.valid).toBe(false);
  }, 120000);

  it('a hedge outside the rules cannot be proven', async () => {
    if (!up) return;
    const outside = [
      { ...hedge, leverageX: 5 },
      { ...hedge, leverageX: 1000 },
      { ...hedge, notionalValueUsdcCents: 100_000_001 },
      { ...hedge, asset: 'DOGE' },
      // A declared notional one cent below size times price.
      { ...hedge, notionalValueUsdcCents: 4_099_999 },
    ];
    for (const witness of outside) {
      const r = await post('/api/zk/hedge-policy/prove', { witness, public: caps });
      expect(r.status).toBe(422);
      expect(r.body.proof).toBeUndefined();
    }
  }, 120000);

  it('the old endpoints and the signing endpoint are gone', async () => {
    if (!up) return;
    for (const path of ['/api/zk/generate', '/api/zk/verify', '/api/zk/attest']) expect([404, 405]).toContain((await post(path, {})).status);
  });
});

describe('the TypeScript client', () => {
  it('proves a hedge and verifies it locally; the local verifier refuses other caps', async () => {
    if (!up) return;
    const proven = await proveHedgePolicy(hedge, caps);
    expect(proven.verified).toBe(true);
    expect(proven.proofHash).toBe(proven.commitment);
    expect(verifyHedgePolicyProof(proven.proof, caps, proven.commitment)).toBe(true);
    expect(verifyHedgePolicyProof(proven.proof, { ...caps, notional_cap_cents: 4_000_000 })).toBe(false);
    await expect(proveHedgePolicy({ ...hedge, leverageX: 9 }, caps)).rejects.toBeInstanceOf(ProofRefusedError);
  }, 120000);

  it('proves a risk score within its threshold, and cannot for a score over it', async () => {
    if (!up) return;
    const inputsHash = '0619fb3793c77deddf71250e684ad0074c8f9b08ec0fd218e780cc77d7235f2c';
    const proven = await proveRiskScore(63, 70, inputsHash);
    expect(proven.verified).toBe(true);
    expect(verifyBoundsProof(proven.proof, riskScoreStatement(70), proven.commitment)).toBe(true);
    expect(verifyBoundsProof(proven.proof, riskScoreStatement(60))).toBe(false);
    await expect(proveRiskScore(71, 70, inputsHash)).rejects.toBeInstanceOf(ProofRefusedError);
  }, 120000);
});
