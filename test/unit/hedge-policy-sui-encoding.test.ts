/**
 * The byte encodings handed to SUI's Groth16 verifier. The Move test in
 * contracts/sui/tests verifies a real proof encoded this way; these pin the
 * rules of the format so a change here fails before it reaches a chain.
 */
import { describe, it, expect } from '@jest/globals';
import {
  BN254_SCALAR_FIELD,
  g1Compressed,
  g2Compressed,
  le32,
  proofPointsBytes,
  publicInputsBytes,
  toHex,
  verifyingKeyBytes,
} from '@/zk/prover/hedgePolicySui';

const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
// The BN254 generators: (1, 2) on G1, and the standard G2 generator.
const G1 = ['1', '2', '1'] as const;
const G2 = [
  ['10857046999023057135944570762232829481370756359578518086990519993285655852781', '11559732032986387107991004021392285783925812861821192530917403151452391805634'],
  ['8495653923123431417604973247489272438418190587263600148770280649306958101930', '4082367875863433681332203403145435568316851327593401208105741076214120093531'],
  ['1', '0'],
] as const;

describe('field elements', () => {
  it('are 32 bytes little-endian', () => {
    const b = le32(0x0102n);
    expect(b).toHaveLength(32);
    expect([b[0], b[1], b[2]]).toEqual([2, 1, 0]);
    expect(() => le32(-1n)).toThrow(RangeError);
    expect(() => le32(1n << 256n)).toThrow(RangeError);
  });

  it('a public input at or above the scalar field is refused', () => {
    expect(publicInputsBytes(['1', '4', '100000000'])).toHaveLength(96);
    expect(() => publicInputsBytes([BN254_SCALAR_FIELD])).toThrow(/not a field element/);
  });
});

describe('G1 points', () => {
  it('carry x, and flag the larger of the two y roots', () => {
    const low = g1Compressed(G1); // y = 2 is the smaller root
    expect(low).toHaveLength(32);
    expect(low[0]).toBe(1);
    expect(low[31] & 0x80).toBe(0);
    const high = g1Compressed(['1', (P - 2n).toString(), '1']);
    expect(high[31] & 0x80).toBe(0x80);
    expect(toHex(high.slice(0, 31))).toBe(toHex(low.slice(0, 31)));
  });

  it('flag the point at infinity and carry no coordinate', () => {
    const inf = g1Compressed(['0', '1', '0']);
    expect(inf[31]).toBe(0x40);
    expect(inf.slice(0, 31).every((x) => x === 0)).toBe(true);
  });
});

describe('G2 points', () => {
  it('are x.c0 then x.c1, and a point and its negation differ only in the flag', () => {
    const p = g2Compressed(G2);
    expect(p).toHaveLength(64);
    expect(toHex(p.slice(0, 32))).toBe(toHex(le32(G2[0][0])));
    const negated = g2Compressed([G2[0], [(P - BigInt(G2[1][0])).toString(), (P - BigInt(G2[1][1])).toString()], G2[2]]);
    expect(toHex(negated.slice(0, 63))).toBe(toHex(p.slice(0, 63)));
    expect((p[63] ^ negated[63]) & 0x80).toBe(0x80);
  });
});

describe('keys and proofs', () => {
  it('a proof is A, B, C: 128 bytes', () => {
    expect(proofPointsBytes({ pi_a: G1, pi_b: G2, pi_c: G1 })).toHaveLength(128);
  });

  it('a verifying key is alpha, beta, gamma, delta, a count, then one G1 point per public input plus one', () => {
    const vk = verifyingKeyBytes({ vk_alpha_1: G1, vk_beta_2: G2, vk_gamma_2: G2, vk_delta_2: G2, IC: [G1, G1, G1, G1] });
    expect(vk).toHaveLength(32 + 64 * 3 + 8 + 32 * 4);
    expect(Number(new DataView(vk.buffer).getBigUint64(32 + 64 * 3, true))).toBe(4);
  });
});
