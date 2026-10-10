/**
 * The proof entry points: what they refuse before any proving, and the
 * small helpers around them. Real proofs are made in
 * `test/integration/zk-hedge-policy.test.ts`.
 */
import { describe, it, expect } from '@jest/globals';
import { hashToLimbs, proofSystemInfo, proveBounds, proveHedgePolicy, ProofRefusedError } from '@/zk/prover/ProofGenerator';

const HEDGE = { asset: 'BTC', side: 'LONG' as const, leverageX: 3, notionalValueUsdcCents: 4_100_000, sizeMilli: 500, entryPriceCents: 8_200_000 };
const CAPS = { leverage_cap: 4, notional_cap_cents: 100_000_000 };

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

describe('what cannot be proven is refused, with no proof', () => {
  it('a value outside its bounds, a malformed statement, a malformed witness', async () => {
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: [71] })).rejects.toBeInstanceOf(ProofRefusedError);
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: [-1] })).rejects.toBeInstanceOf(ProofRefusedError);
    await expect(proveBounds({ kind: 'has space', bounds: [[0, 70]] }, { values: [5] })).rejects.toBeInstanceOf(ProofRefusedError);
    await expect(proveBounds({ kind: 'k', bounds: [[5, 4]] }, { values: [5] })).rejects.toBeInstanceOf(ProofRefusedError);
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: ['x'] })).rejects.toBeInstanceOf(ProofRefusedError);
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: [5], payload: [-3] })).rejects.toBeInstanceOf(ProofRefusedError);
    await expect(proveBounds({ kind: 'k', bounds: [[0, 70]] }, { values: [1, 2] })).rejects.toBeInstanceOf(ProofRefusedError);
  });

  it('a hedge outside the rules', async () => {
    const outside = [
      { ...HEDGE, leverageX: 5 },
      { ...HEDGE, leverageX: 1000 },
      { ...HEDGE, leverageX: 2.5 },
      { ...HEDGE, notionalValueUsdcCents: 100_000_001 },
      { ...HEDGE, asset: 'DOGE' },
      { ...HEDGE, side: 'SIDEWAYS' as never },
      // A declared notional one cent below size times price.
      { ...HEDGE, notionalValueUsdcCents: 4_099_999 },
      { ...HEDGE, sizeMilli: 2 ** 31 },
      { ...HEDGE, portfolioId: -2 },
    ];
    for (const hedge of outside) await expect(proveHedgePolicy(hedge, CAPS)).rejects.toBeInstanceOf(ProofRefusedError);
    await expect(proveHedgePolicy(HEDGE, { leverage_cap: 0, notional_cap_cents: 1 })).rejects.toBeInstanceOf(ProofRefusedError);
    await expect(proveHedgePolicy(HEDGE, { leverage_cap: 'x', notional_cap_cents: 1 })).rejects.toBeInstanceOf(ProofRefusedError);
  });
});

describe('proofSystemInfo', () => {
  it('names a transparent proof system that runs in this process', () => {
    const info = proofSystemInfo();
    expect(info.trusted_setup).toBe(false);
    expect(info.in_process).toBe(true);
    expect(info.protocol).toMatch(/^zkward-bounds-v\d+$/);
  });
});
