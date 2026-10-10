/**
 * The hedge policy STARK through the prover server: a hedge inside the rules
 * proves and verifies, one outside them cannot be proven, and a proof is
 * only valid under the caps it was made for.
 *
 * Needs the Python prover (`python start.py`). Skips when it is not up; a
 * real run takes seconds, not milliseconds.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';

const ZK_API_URL = process.env.ZK_API_URL || process.env.NEXT_PUBLIC_ZK_API_URL || 'http://localhost:8000';
let up = false;

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${ZK_API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
};

const hedge = {
  asset: 'BTC', side: 'LONG', leverageX: 3, notionalValueUsdcCents: 4_100_000,
  sizeUnits: 500, entryPriceUsdcCents: 8_200_000, portfolioId: 2, timestampMs: 1_791_500_000_000,
};
const caps = { leverage_cap: 4, notional_cap_cents: 100_000_000 };

beforeAll(async () => {
  up = await fetch(`${ZK_API_URL}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
});

describe('hedge policy proof', () => {
  it('a hedge inside the rules proves; the proof verifies for its commitment under its caps only', async () => {
    if (!up) return;
    const p = await post('/api/zk/hedge-policy/prove', { witness: hedge, public: caps });
    expect(p.status).toBe(200);
    expect(p.body.commitment).toMatch(/^[0-9a-f]{64}$/);
    expect(p.body.proof.commitment).toBe(p.body.commitment);
    // The public proof names no part of the hedge.
    expect(Object.keys(p.body.proof).sort()).toEqual(['commitment', 'final', 'fri_roots', 'nonce', 'ood', 'protocol', 'public', 'queries', 'quotient_root']);

    const ok = await post('/api/zk/hedge-policy/verify', { proof: p.body.proof, public: caps, commitment: p.body.commitment });
    expect(ok.body.valid).toBe(true);

    const lowerCap = await post('/api/zk/hedge-policy/verify', { proof: p.body.proof, public: { ...caps, leverage_cap: 2 } });
    expect(lowerCap.body.valid).toBe(false);

    const otherCommitment = await post('/api/zk/hedge-policy/verify', { proof: p.body.proof, public: caps, commitment: '00'.repeat(32) });
    expect(otherCommitment.body.valid).toBe(false);

    const edited = structuredClone(p.body.proof);
    edited.final = (edited.final[0] === '0' ? '1' : '0') + edited.final.slice(1);
    expect((await post('/api/zk/hedge-policy/verify', { proof: edited, public: caps })).body.valid).toBe(false);
  }, 120000);

  it('a hedge outside the rules cannot be proven', async () => {
    if (!up) return;
    for (const witness of [{ ...hedge, leverageX: 5 }, { ...hedge, leverageX: 1000 }, { ...hedge, notionalValueUsdcCents: 100_000_001 }, { ...hedge, asset: 'DOGE' }]) {
      const r = await post('/api/zk/hedge-policy/prove', { witness, public: caps });
      expect(r.status).toBe(422);
      expect(r.body.proof).toBeUndefined();
    }
  }, 120000);
});
