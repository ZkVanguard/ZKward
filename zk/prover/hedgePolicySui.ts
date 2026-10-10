/**
 * Byte encodings SUI's built-in Groth16 verifier expects, from the JSON the
 * prover produces. No dependencies: BN254 coordinates in, bytes out.
 *
 * `sui::groth16` reads the compressed point format of the arkworks
 * libraries. A field element is 32 bytes little-endian. A G1 point is its x
 * coordinate, with two flags in the top bits of the last byte: 0x80 when y
 * is the larger of the two roots (y > p - y), 0x40 for the point at
 * infinity. A G2 point is x.c0 then x.c1, flags on the last byte of x.c1,
 * and "larger" compares c1 first, then c0.
 *
 * The Move tests in contracts/sui/tests verify a real proof encoded by this
 * file; that test, not this comment, is the authority on the format.
 */

/** BN254 base field modulus. */
const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
/** BN254 scalar field modulus: every public input must be below it. */
export const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

const FLAG_Y_LARGER = 0x80;
const FLAG_INFINITY = 0x40;

type Fp = string | bigint;
/** Projective coordinates as the prover writes them: [x, y, z]. */
export type G1Json = readonly [Fp, Fp, Fp];
export type G2Json = readonly [readonly [Fp, Fp], readonly [Fp, Fp], readonly [Fp, Fp]];

export interface Groth16ProofJson {
  pi_a: G1Json;
  pi_b: G2Json;
  pi_c: G1Json;
}

export interface Groth16VerifyingKeyJson {
  vk_alpha_1: G1Json;
  vk_beta_2: G2Json;
  vk_gamma_2: G2Json;
  vk_delta_2: G2Json;
  IC: readonly G1Json[];
}

/** 32 bytes little-endian. Throws when the value does not fit. */
export function le32(value: Fp): Uint8Array {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << 256n) throw new RangeError('value does not fit 32 bytes');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function g1Compressed(point: G1Json): Uint8Array {
  const [x, y, z] = point.map((c) => BigInt(c));
  const out = le32(z === 0n ? 0n : x);
  if (z === 0n) out[31] |= FLAG_INFINITY;
  else if (y > P - y) out[31] |= FLAG_Y_LARGER;
  return out;
}

export function g2Compressed(point: G2Json): Uint8Array {
  const [[x0, x1], [y0, y1], [z0, z1]] = point.map((c) => [BigInt(c[0]), BigInt(c[1])]);
  const infinity = z0 === 0n && z1 === 0n;
  const out = concat([le32(infinity ? 0n : x0), le32(infinity ? 0n : x1)]);
  if (infinity) {
    out[63] |= FLAG_INFINITY;
    return out;
  }
  // y > -y, comparing the c1 parts first and the c0 parts on a tie.
  const neg0 = (P - y0) % P;
  const neg1 = (P - y1) % P;
  if (y1 > neg1 || (y1 === neg1 && y0 > neg0)) out[63] |= FLAG_Y_LARGER;
  return out;
}

/** The verifying key as `sui::groth16::prepare_verifying_key` takes it. */
export function verifyingKeyBytes(vk: Groth16VerifyingKeyJson): Uint8Array {
  const count = new Uint8Array(8);
  new DataView(count.buffer).setBigUint64(0, BigInt(vk.IC.length), true);
  return concat([
    g1Compressed(vk.vk_alpha_1),
    g2Compressed(vk.vk_beta_2),
    g2Compressed(vk.vk_gamma_2),
    g2Compressed(vk.vk_delta_2),
    count,
    ...vk.IC.map(g1Compressed),
  ]);
}

/** The proof as `sui::groth16::proof_points_from_bytes` takes it: A, B, C. */
export function proofPointsBytes(proof: Groth16ProofJson): Uint8Array {
  return concat([g1Compressed(proof.pi_a), g2Compressed(proof.pi_b), g1Compressed(proof.pi_c)]);
}

/** Public inputs as `sui::groth16::public_proof_inputs_from_bytes` takes them. */
export function publicInputsBytes(signals: readonly Fp[]): Uint8Array {
  return concat(
    signals.map((s) => {
      if (BigInt(s) >= BN254_SCALAR_FIELD) throw new RangeError('public input is not a field element');
      return le32(s);
    }),
  );
}

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
