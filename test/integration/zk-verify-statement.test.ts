/**
 * A proof is verified against the statement it was generated for, whatever
 * that statement's shape. The verify endpoint used to rebuild the statement
 * as {claim, public_inputs}, so a proof made for any other statement could
 * never be verified.
 *
 * Needs the Python prover (`python start.py`). Skips when it is not up; a
 * real run takes seconds, not milliseconds.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';

const ZK_API_URL = process.env.ZK_API_URL || process.env.NEXT_PUBLIC_ZK_API_URL || 'http://localhost:8000';
let up = false;

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${ZK_API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

async function generate(statement: Record<string, unknown>): Promise<Record<string, unknown>> {
  const g = await post('/api/zk/generate', { proof_type: 'settlement', data: { statement, witness: { secret_value: 42 } } });
  if (g.body.proof) return g.body.proof as Record<string, unknown>;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = (await (await fetch(`${ZK_API_URL}/api/zk/proof/${g.body.job_id}`)).json()) as Record<string, unknown>;
    if (s.status === 'completed' && s.proof) return s.proof as Record<string, unknown>;
    if (s.status === 'failed') throw new Error(String(s.error));
  }
  throw new Error('proof generation timed out');
}

beforeAll(async () => {
  up = await fetch(`${ZK_API_URL}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok).catch(() => false);
});

describe('verify against the statement the proof was made for', () => {
  const statement = { claim: 'portfolio risk is within the stated limit', threshold: 100, portfolio_id: 1 };

  it('accepts the statement itself and refuses a changed one', async () => {
    if (!up) return;
    const proof = await generate(statement);
    const same = await post('/api/zk/verify', { proof, statement });
    expect(same.body.valid).toBe(true);
    const changed = await post('/api/zk/verify', { proof, statement: { ...statement, threshold: 5 } });
    expect(changed.body.valid).toBe(false);
  }, 120000);

  it('the older claim-only form still works for a statement of that shape', async () => {
    if (!up) return;
    const proof = await generate({ claim: 'claim-only statement', public_inputs: [] });
    const r = await post('/api/zk/verify', { proof, claim: 'claim-only statement', public_inputs: [] });
    expect(r.body.valid).toBe(true);
  }, 120000);

  it('a request with neither a statement nor a claim is refused', async () => {
    if (!up) return;
    const proof = await generate(statement);
    const r = await post('/api/zk/verify', { proof });
    expect(r.status).toBe(400);
  }, 120000);
});
