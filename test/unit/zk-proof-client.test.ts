/**
 * The proof client: what it sends to the prover, and that "verified" is the
 * local verifier's verdict, never the prover's word.
 */
import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { hashToLimbs, proveBounds, proveHedgePolicy, ProofRefusedError, ProverUnavailableError } from '@/zk/prover/ProofGenerator';

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

function answer(status: number, body: unknown) {
  const calls: Array<{ url: string; body: string }> = [];
  global.fetch = jest.fn(async (url: unknown, init?: { body?: unknown }) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return calls;
}

const NOT_A_PROOF = { proof: { protocol: 'zkward-bounds-v6', verified: true }, commitment: 'ab'.repeat(32), opening: {}, valid: true };

describe('hashToLimbs', () => {
  it('splits a digest into five integers below 2^52 that rebuild it', () => {
    const hex = 'f619fb3793c77deddf71250e684ad0074c8f9b08ec0fd218e780cc77d7235f2c';
    const limbs = hashToLimbs(hex);
    expect(limbs).toHaveLength(5);
    for (const limb of limbs) expect(limb < 1n << 52n).toBe(true);
    expect(limbs.reduce((acc, limb) => (acc << 52n) | limb, 0n)).toBe(BigInt(`0x${hex}`));
    expect(hashToLimbs(`0x${hex}`)).toEqual(limbs);
  });

  it('refuses anything that is not a 32-byte digest', () => {
    for (const bad of ['', 'abc', 'zz'.repeat(32), 'ab'.repeat(33)]) expect(() => hashToLimbs(bad)).toThrow();
  });
});

describe('proof client', () => {
  it('writes integers beyond 2^53 as bare JSON numbers, exactly', async () => {
    const calls = answer(200, NOT_A_PROOF);
    const big = (1n << 61n) + 12345n;
    await proveBounds({ kind: 'k', bounds: [[0, big]] }, { values: [big - 1n], payload: [7] });
    expect(calls[0].url).toMatch(/\/api\/zk\/bounds\/prove$/);
    expect(calls[0].body).toContain(`"bounds":[[0,${big}]]`);
    expect(calls[0].body).toContain(`"values":[${big - 1n}]`);
    expect(calls[0].body).toContain('"payload":[7]');
  });

  it('reports a proof as verified only when the local verifier accepts it', async () => {
    answer(200, NOT_A_PROOF);
    const bounds = await proveBounds({ kind: 'k', bounds: [[0, 10]] }, { values: [5] });
    expect(bounds.verified).toBe(false);
    expect(bounds.commitment).toBe('ab'.repeat(32));

    answer(200, NOT_A_PROOF);
    const hedge = await proveHedgePolicy(
      { asset: 'BTC', side: 'LONG', leverageX: 3, notionalValueUsdcCents: 4_100_000, sizeMilli: 500, entryPriceCents: 8_200_000 },
      { leverage_cap: 4, notional_cap_cents: 100_000_000 },
    );
    expect(hedge.verified).toBe(false);
  });

  it('a refusal and an outage are different errors, and neither yields a proof', async () => {
    answer(422, { detail: 'cannot prove: value 0 (71) is outside [0, 70]' });
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: [71] })).rejects.toBeInstanceOf(ProofRefusedError);

    answer(530, {});
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: [5] })).rejects.toBeInstanceOf(ProverUnavailableError);

    answer(200, { commitment: 'ab'.repeat(32) });
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: [5] })).rejects.toBeInstanceOf(ProverUnavailableError);

    global.fetch = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: [5] })).rejects.toBeInstanceOf(ProverUnavailableError);
  });
});
