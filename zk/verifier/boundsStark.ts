/**
 * Verifier for the bounds ZK-STARK, in TypeScript.
 *
 * A second implementation of the verifier in `zkp/core/bounds_stark.py`,
 * written from the protocol, not translated line by line. Two verifiers that
 * agree on every accept and every reject are evidence that neither has a
 * slip in its transcript, its encodings or its arithmetic; and this one lets
 * a server or a script check a proof without the Python prover.
 *
 * Statement: "the commitment opens to up to seven private integers, each
 * within its public bounds, and (when the statement says so) to the product
 * relation 1000 * v1 = v4 * v5 + v6". The bounds come from the caller. The
 * hedge policy is one such statement (`hedgePolicyStatement`).
 *
 * Protocol: Goldilocks field with challenges in its quintic extension,
 * SHA-384 Merkle commitments, a Fiat-Shamir transcript re-run here, an
 * out-of-domain check of the constraints, and FRI on the DEEP quotients.
 * No setup of any kind.
 */
import { createHash } from 'node:crypto';

// ── Field ────────────────────────────────────────────────────────────
const P = 0xffffffff00000001n; // 2^64 - 2^32 + 1
const GENERATOR = 7n;
const NONRESIDUE = 3n; // the extension is Fp[u] / (u^5 - 3), about 2^320 elements

const mod = (a: bigint): bigint => ((a % P) + P) % P;

function powMod(base: bigint, exp: bigint): bigint {
  let b = mod(base);
  let e = exp;
  let out = 1n;
  while (e > 0n) {
    if (e & 1n) out = (out * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return out;
}

function inv(a: bigint): bigint {
  const v = mod(a);
  if (v === 0n) throw new Error('inverse of zero');
  return powMod(v, P - 2n);
}

const rootOfUnity = (n: number): bigint => powMod(GENERATOR, (P - 1n) / BigInt(n));

type K = readonly [bigint, bigint, bigint, bigint, bigint]; // a0 + a1 u + ... + a4 u^4
const DEGREE = 5;
const K_BYTES = 8 * DEGREE;
const K_ZERO: K = [0n, 0n, 0n, 0n, 0n];
const K_ONE: K = [1n, 0n, 0n, 0n, 0n];
const kFrom = (x: bigint): K => [mod(x), 0n, 0n, 0n, 0n];
const kAdd = (a: K, b: K): K => [mod(a[0] + b[0]), mod(a[1] + b[1]), mod(a[2] + b[2]), mod(a[3] + b[3]), mod(a[4] + b[4])];
const kSub = (a: K, b: K): K => [mod(a[0] - b[0]), mod(a[1] - b[1]), mod(a[2] - b[2]), mod(a[3] - b[3]), mod(a[4] - b[4])];
const kMul = (a: K, b: K): K => [
  mod(a[0] * b[0] + NONRESIDUE * (a[1] * b[4] + a[2] * b[3] + a[3] * b[2] + a[4] * b[1])),
  mod(a[0] * b[1] + a[1] * b[0] + NONRESIDUE * (a[2] * b[4] + a[3] * b[3] + a[4] * b[2])),
  mod(a[0] * b[2] + a[1] * b[1] + a[2] * b[0] + NONRESIDUE * (a[3] * b[4] + a[4] * b[3])),
  mod(a[0] * b[3] + a[1] * b[2] + a[2] * b[1] + a[3] * b[0] + NONRESIDUE * a[4] * b[4]),
  mod(a[0] * b[4] + a[1] * b[3] + a[2] * b[2] + a[3] * b[1] + a[4] * b[0]),
];
const kScale = (a: K, s: bigint): K => [mod(a[0] * s), mod(a[1] * s), mod(a[2] * s), mod(a[3] * s), mod(a[4] * s)];
const kEq = (a: K, b: K): boolean => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4];

// u^p = ZETA * u with ZETA a primitive fifth root of unity, so the i-th conjugate scales coordinate d by ZETA^(i d).
const ZETA = powMod(NONRESIDUE, (P - 1n) / 5n);
const kFrobenius = (a: K, i: number): K => {
  const f = powMod(ZETA, BigInt(i));
  const f2 = mod(f * f);
  return [a[0], mod(a[1] * f), mod(a[2] * f2), mod(a[3] * f2 * f), mod(a[4] * f2 * f2)];
};

/** 1/a = c / N(a): c is the product of the four other conjugates of a, and the norm N(a) = a c is in Fp. */
function kInv(a: K): K {
  const c = kMul(kMul(kFrobenius(a, 1), kFrobenius(a, 2)), kMul(kFrobenius(a, 3), kFrobenius(a, 4)));
  return kScale(c, inv(kMul(a, c)[0]));
}

function kPow(a: K, e: number): K {
  let out: K = K_ONE;
  let b = a;
  for (let k = e; k > 0; k = Math.floor(k / 2)) {
    if (k % 2 === 1) out = kMul(out, b);
    b = kMul(b, b);
  }
  return out;
}

/** A polynomial with base-field coefficients at an extension point. */
function polyAtK(coeffs: readonly bigint[], x: K): K {
  let acc: K = K_ZERO;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    const m = kMul(acc, x);
    acc = [mod(m[0] + coeffs[i]), m[1], m[2], m[3], m[4]];
  }
  return acc;
}

/** A polynomial with extension coefficients at a base-field point. */
function kPolyAtFp(coeffs: readonly K[], x: bigint): K {
  let acc: K = K_ZERO;
  for (let i = coeffs.length - 1; i >= 0; i--) acc = kAdd(kScale(acc, x), coeffs[i]);
  return acc;
}

// ── Parameters (must equal zkp/core/bounds_stark.py) ──────────────────
const PROTOCOL = 'zkward-bounds-v6';
const N = 512;
const ACTIVE = 64;
const RANGE_BITS = 62;
const BLOWUP = 16;
const M = N * BLOWUP;
const LOG_M = 13;
const SHIFT = GENERATOR;
const NUM_QUERIES = 64;
const GRINDING_BITS = 20;
const FRI_LAYERS = 6;
const FINAL_DEGREE = N >> FRI_LAYERS;
const CHUNK = (11 * N) / 16;
const SALT_BYTES = 32;
const NUM_CHUNKS = 3;
const NUM_QUANTITIES = 7;
const LIMIT = 1n << BigInt(RANGE_BITS);
// The product relation: PROD_SCALE * v[1] = v[4] * v[5] + v[6].
const PROD_SCALED = 1;
const PROD_A = 4;
const PROD_B = 5;
const PROD_SLACK = 6;
const PROD_SCALE = 1000n;
const WIDTH = 4 * NUM_QUANTITIES + 1;

const OMEGA_M = rootOfUnity(M);
const OMEGA_A = rootOfUnity(ACTIVE);
const LAST = inv(OMEGA_A);
const INV2 = inv(2n);

/** The polynomial that is 2^j on active row j (j < 62) and 0 on the last two rows. */
const WEIGHT_POLY: bigint[] = (() => {
  const weights = Array.from({ length: ACTIVE }, (_, j) => (j < RANGE_BITS ? 1n << BigInt(j) : 0n));
  const wInv = inv(OMEGA_A);
  const nInv = inv(BigInt(ACTIVE));
  return Array.from({ length: ACTIVE }, (_, k) => {
    let sum = 0n;
    let w = 1n;
    const step = powMod(wInv, BigInt(k));
    for (let j = 0; j < ACTIVE; j++) {
      sum = mod(sum + weights[j] * w);
      w = mod(w * step);
    }
    return mod(sum * nInv);
  });
})();

type Constraint =
  | { kind: 'bool'; b: number }
  | { kind: 'acc'; a: number; b: number }
  | { kind: 'init'; a: number; b: number }
  | { kind: 'sum'; a1: number; a2: number; quantity: number }
  | { kind: 'prod' };

/** The constraints in the order their random weights are drawn. */
const CONSTRAINTS: Constraint[] = (() => {
  const out: Constraint[] = [];
  for (let k = 0; k < NUM_QUANTITIES; k++) {
    for (const [b, a] of [[4 * k, 4 * k + 1], [4 * k + 2, 4 * k + 3]]) {
      out.push({ kind: 'bool', b }, { kind: 'acc', a, b }, { kind: 'init', a, b });
    }
  }
  for (let k = 0; k < NUM_QUANTITIES; k++) out.push({ kind: 'sum', a1: 4 * k + 1, a2: 4 * k + 3, quantity: k });
  out.push({ kind: 'prod' });
  return out;
})();

// ── Public inputs ────────────────────────────────────────────────────
type Int = number | bigint | string;

/** What is being proven: a label, up to seven [lo, hi] bounds, and whether the product relation applies. */
export interface BoundsStatement {
  kind: string;
  bounds: ReadonlyArray<readonly [Int, Int]>;
  product?: boolean;
}

export interface HedgePolicyCaps {
  leverage_cap: Int;
  notional_cap_cents: Int;
  asset_count?: Int;
}

interface Statement {
  kind: string;
  bounds: Array<[bigint, bigint]>;
  product: boolean;
}

function normalizeStatement(st: BoundsStatement): Statement {
  if (typeof st.kind !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(st.kind)) throw new Error('bad kind');
  if (!Array.isArray(st.bounds) || st.bounds.length > NUM_QUANTITIES) throw new Error('bad bounds');
  const bounds: Array<[bigint, bigint]> = st.bounds.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] === 'boolean' || typeof pair[1] === 'boolean') throw new Error('bad bound');
    const lo = BigInt(pair[0]);
    const hi = BigInt(pair[1]);
    if (lo < 0n || lo > hi || hi >= LIMIT) throw new Error('a bound is outside 0 <= lo <= hi < 2^62');
    return [lo, hi];
  });
  while (bounds.length < NUM_QUANTITIES) bounds.push([0n, 0n]);
  const product = st.product ?? false;
  if (typeof product !== 'boolean') throw new Error('product must be a boolean');
  if (product && (bounds[PROD_SCALED][1] * PROD_SCALE >= LIMIT || bounds[PROD_A][1] * bounds[PROD_B][1] >= LIMIT)) {
    throw new Error('the bounds let the product relation exceed 2^62');
  }
  return { kind: st.kind, bounds, product };
}

/** The hedge policy as a bounds statement: leverage, notional, asset, side, size, price, slack. */
export function hedgePolicyStatement(caps: HedgePolicyCaps): BoundsStatement {
  const leverageCap = BigInt(caps.leverage_cap);
  const notionalCap = BigInt(caps.notional_cap_cents);
  const assetCount = BigInt(caps.asset_count ?? 3);
  if (leverageCap < 1n || assetCount < 1n || notionalCap < 0n) throw new Error('caps out of range');
  const sizePriceLimit = (1n << 31n) - 1n;
  return {
    kind: 'hedge-policy',
    bounds: [[1n, leverageCap], [0n, notionalCap], [1n, assetCount], [0n, 1n], [0n, sizePriceLimit], [0n, sizePriceLimit], [0n, LIMIT - 1n]],
    product: true,
  };
}

/** What both sides agree on before the first message; every challenge depends on it. */
function statementBytes(st: Statement): Buffer {
  return Buffer.from(
    `{"active":${ACTIVE},"air":"zkward-bounds","blowup":${BLOWUP},` +
      `"bounds":[${st.bounds.map(([lo, hi]) => `[${lo},${hi}]`).join(',')}],"field":"goldilocks-quintic",` +
      `"fri_layers":${FRI_LAYERS},"grinding":${GRINDING_BITS},"hash":"sha384","kind":"${st.kind}","n":${N},` +
      `"product":${st.product},"queries":${NUM_QUERIES},"version":6}`,
    'utf8',
  );
}

// ── Hashing, Merkle, transcript ──────────────────────────────────────
const HASH_BYTES = 48; // SHA-384
const hash = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha384');
  for (const p of parts) h.update(p);
  return h.digest();
};

const u64le = (v: number | bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

const leafHash = (index: number, data: Uint8Array): Buffer => hash(Buffer.from([0]), u64le(index), data);

/** True when `leaf` is at `index` under `root`. The side of each sibling comes from the index. */
function merkleVerify(root: Buffer, index: number, leaf: Buffer, path: Buffer[], depth: number): boolean {
  if (path.length !== depth || index < 0 || index >= 2 ** depth) return false;
  let node = leaf;
  let i = index;
  for (const sibling of path) {
    if (sibling.length !== HASH_BYTES) return false;
    node = i % 2 === 1 ? hash(Buffer.from([1]), sibling, node) : hash(Buffer.from([1]), node, sibling);
    i = Math.floor(i / 2);
  }
  return node.equals(root);
}

class Transcript {
  private state: Buffer;

  constructor(statement: Uint8Array) {
    this.state = hash(Buffer.from('zkward-stark-6\0', 'latin1'), statement);
  }

  absorb(label: string, data: Uint8Array): void {
    const l = Buffer.from(label, 'latin1');
    const len = Buffer.alloc(2);
    len.writeUInt16LE(l.length);
    this.state = hash(this.state, Buffer.from([1]), len, l, u64le(data.length), data);
  }

  private draw(): Buffer {
    this.state = hash(this.state, Buffer.from([2]));
    return hash(this.state, Buffer.from([3]));
  }

  drawFp(): bigint {
    for (;;) {
      const v = this.draw().readBigUInt64LE(0);
      if (v < P) return v;
    }
  }

  drawK(): K {
    const a0 = this.drawFp();
    const a1 = this.drawFp();
    const a2 = this.drawFp();
    const a3 = this.drawFp();
    return [a0, a1, a2, a3, this.drawFp()];
  }

  drawIndex(bound: number): number {
    return Number(this.draw().readBigUInt64LE(0) & BigInt(bound - 1));
  }

  /** Prover side of `checkGrind`: finds the smallest nonce that passes, absorbs it and returns it. */
  grind(bits: number): number {
    const prefix = Buffer.concat([this.state, Buffer.from([4])]);
    const limit = BigInt(8 * HASH_BYTES - bits);
    for (let nonce = 0; ; nonce++) {
      const digest = hash(prefix, u64le(nonce));
      if (BigInt('0x' + digest.toString('hex')) >> limit === 0n) {
        this.absorb('pow', u64le(nonce));
        return nonce;
      }
    }
  }

  /** Accepts the nonce only if its hash with the state has `bits` leading zero bits, then absorbs it. */
  checkGrind(nonce: bigint, bits: number): boolean {
    const digest = hash(this.state, Buffer.from([4]), u64le(nonce));
    if (BigInt('0x' + digest.toString('hex')) >> BigInt(8 * HASH_BYTES - bits) !== 0n) return false;
    this.absorb('pow', u64le(nonce));
    return true;
  }
}

// ── Decoding ─────────────────────────────────────────────────────────
function bytes(hex: unknown, length?: number): Buffer {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('not hex');
  const out = Buffer.from(hex, 'hex');
  if (length !== undefined && out.length !== length) throw new Error('wrong length');
  return out;
}

function fpList(data: Buffer): bigint[] {
  if (data.length % 8 !== 0) throw new Error('bad field encoding');
  const out: bigint[] = [];
  for (let i = 0; i < data.length; i += 8) {
    const v = data.readBigUInt64LE(i);
    if (v >= P) throw new Error('non-canonical field element');
    out.push(v);
  }
  return out;
}

function kList(data: Buffer): K[] {
  const flat = fpList(data);
  if (flat.length % DEGREE !== 0) throw new Error('bad extension-field encoding');
  const out: K[] = [];
  for (let i = 0; i < flat.length; i += DEGREE) out.push([flat[i], flat[i + 1], flat[i + 2], flat[i + 3], flat[i + 4]]);
  return out;
}

// ── The statement's constraints at the out-of-domain point ───────────
function quotientsAt(st: Statement, z: K, cur: readonly K[], nxt: readonly K[]): K[] {
  const zn = kScale(z, OMEGA_A);
  const wCur = polyAtK(WEIGHT_POLY, z);
  const wNxt = polyAtK(WEIGHT_POLY, zn);
  const zMinusLast = kSub(z, kFrom(LAST));
  const invVanishing = kInv(kSub(kPow(z, ACTIVE), K_ONE)); // 1 / (z^64 - 1)
  const invFirst = kInv(kSub(z, K_ONE));
  const invLast = kInv(zMinusLast);
  return CONSTRAINTS.map((c) => {
    switch (c.kind) {
      case 'bool':
        return kMul(kSub(kMul(cur[c.b], cur[c.b]), cur[c.b]), invVanishing);
      case 'acc':
        return kMul(kMul(kSub(kSub(nxt[c.a], cur[c.a]), kMul(nxt[c.b], wNxt)), zMinusLast), invVanishing);
      case 'init':
        return kMul(kSub(cur[c.a], kMul(cur[c.b], wCur)), invFirst);
      case 'sum': {
        const [lo, hi] = st.bounds[c.quantity];
        return kMul(kSub(kAdd(cur[c.a1], cur[c.a2]), kFrom(hi - lo)), invLast);
      }
      case 'prod': {
        if (!st.product) return K_ZERO;
        // Each value is its lower bound plus the final running sum of (v - lo).
        const value = (k: number): K => kAdd(cur[4 * k + 1], kFrom(st.bounds[k][0]));
        const expr = kSub(kSub(kScale(value(PROD_SCALED), PROD_SCALE), kMul(value(PROD_A), value(PROD_B))), value(PROD_SLACK));
        return kMul(expr, invLast);
      }
    }
  });
}

/** One FRI fold: from f(x) and f(-x) to the folded value at x^2. */
function foldPair(a: K, b: K, beta: K, x: bigint): K {
  const even = kScale(kAdd(a, b), INV2);
  const odd = kScale(kSub(a, b), mod(INV2 * inv(x)));
  return kAdd(even, kMul(beta, odd));
}

const layerShift = (k: number): bigint => powMod(SHIFT, 1n << BigInt(k));

// ── Verify ───────────────────────────────────────────────────────────
/**
 * True only when `proof` proves `statement` for its commitment (and for
 * `commitment`, when the caller names the one it expects). Malformed input
 * is `false`, never an exception.
 */
export function verifyBoundsProof(proof: unknown, statement: BoundsStatement, commitment?: string): boolean {
  try {
    return verify(proof as Record<string, any>, normalizeStatement(statement), commitment);
  } catch {
    return false;
  }
}

/** The hedge policy under the CALLER's caps. */
export function verifyHedgePolicyProof(proof: unknown, caps: HedgePolicyCaps, commitment?: string): boolean {
  try {
    return verifyBoundsProof(proof, hedgePolicyStatement(caps), commitment);
  } catch {
    return false;
  }
}

function verify(proof: Record<string, any>, st: Statement, commitment?: string): boolean {
  if (!proof || proof.protocol !== PROTOCOL) return false;
  const traceRoot = bytes(proof.commitment, HASH_BYTES);
  if (commitment !== undefined && commitment.toLowerCase() !== String(proof.commitment).toLowerCase()) return false;
  const quotientRoot = bytes(proof.quotient_root, HASH_BYTES);
  if (!Array.isArray(proof.fri_roots) || proof.fri_roots.length !== FRI_LAYERS - 1) return false;
  const friRoots: Buffer[] = proof.fri_roots.map((r: unknown) => bytes(r, HASH_BYTES));
  const traceZBytes = bytes(proof.ood.trace_z, K_BYTES * WIDTH);
  const traceZnBytes = bytes(proof.ood.trace_zn, K_BYTES * WIDTH);
  const chunksZBytes = bytes(proof.ood.chunks_z, K_BYTES * NUM_CHUNKS);
  const finalBytes = bytes(proof.final, K_BYTES * FINAL_DEGREE); // the length IS the degree bound
  const traceZ = kList(traceZBytes);
  const traceZn = kList(traceZnBytes);
  const chunksZ = kList(chunksZBytes);
  const final = kList(finalBytes);
  if (!Array.isArray(proof.queries) || proof.queries.length !== NUM_QUERIES) return false;
  if (typeof proof.nonce !== 'number' || !Number.isSafeInteger(proof.nonce) || proof.nonce < 0) return false;

  // The transcript, replayed. Every challenge below is this verifier's own.
  const t = new Transcript(statementBytes(st));
  t.absorb('trace', traceRoot);
  const alphas = CONSTRAINTS.map(() => t.drawK());
  t.absorb('quotient', quotientRoot);
  let z = t.drawK();
  // Outside Fp, the only proper subfield of K, as the prover draws it.
  while (z[1] === 0n && z[2] === 0n && z[3] === 0n && z[4] === 0n) z = t.drawK();
  const zn = kScale(z, OMEGA_A);
  t.absorb('ood', Buffer.concat([traceZBytes, traceZnBytes, chunksZBytes]));

  // 1. The constraints hold at z: composition(z) = sum of weighted quotients.
  let expected: K = K_ZERO;
  quotientsAt(st, z, traceZ, traceZn).forEach((q, i) => {
    expected = kAdd(expected, kMul(alphas[i], q));
  });
  const zStep = kPow(z, CHUNK);
  let composition: K = K_ZERO;
  let power: K = K_ONE;
  for (let j = 0; j < NUM_CHUNKS; j++) {
    composition = kAdd(composition, kMul(power, chunksZ[j]));
    power = kMul(power, zStep);
  }
  if (!kEq(composition, expected)) return false;

  const g1 = Array.from({ length: WIDTH }, () => t.drawK());
  const g2 = Array.from({ length: WIDTH }, () => t.drawK());
  const g3 = Array.from({ length: NUM_CHUNKS }, () => t.drawK());
  const betas: K[] = [t.drawK()];
  for (const root of friRoots) {
    t.absorb('fri', root);
    betas.push(t.drawK());
  }
  t.absorb('final', finalBytes);
  if (!t.checkGrind(BigInt(proof.nonce), GRINDING_BITS)) return false;
  const positions = Array.from({ length: NUM_QUERIES }, () => t.drawIndex(M / 2));

  /** The DEEP combination at one opened point, from the opened row and the claimed out-of-domain values. */
  const deepValue = (x: bigint, row: bigint[], opened: K[]): K => {
    let a: K = K_ZERO;
    let b: K = K_ZERO;
    for (let c = 0; c < WIDTH; c++) {
      a = kAdd(a, kMul(g1[c], kSub(kFrom(row[c]), traceZ[c])));
      b = kAdd(b, kMul(g2[c], kSub(kFrom(row[c]), traceZn[c])));
    }
    for (let j = 0; j < NUM_CHUNKS; j++) a = kAdd(a, kMul(g3[j], kSub(opened[j], chunksZ[j])));
    const inv1 = kInv(kSub(kFrom(x), z));
    const inv2 = kInv(kSub(kFrom(x), zn));
    return kAdd(kAdd(kMul(a, inv1), kMul(b, inv2)), opened[NUM_CHUNKS]);
  };

  // 2. Every query: the openings are in the trees, and the folds line up down to the final polynomial.
  for (let q = 0; q < NUM_QUERIES; q++) {
    const p = positions[q];
    const query = proof.queries[q];
    if (!query || query.trace?.length !== 2 || query.quotient?.length !== 2 || query.fri?.length !== FRI_LAYERS - 1) return false;
    const values: K[] = [];
    for (let s = 0; s < 2; s++) {
      const i = p + s * (M / 2);
      const rowBytes = bytes(query.trace[s].row, 8 * WIDTH);
      const salt = bytes(query.trace[s].salt, SALT_BYTES);
      if (!merkleVerify(traceRoot, i, leafHash(i, Buffer.concat([rowBytes, salt])), query.trace[s].path.map((h: unknown) => bytes(h)), LOG_M)) return false;
      const openedBytes = bytes(query.quotient[s].values, K_BYTES * (NUM_CHUNKS + 1));
      const qSalt = bytes(query.quotient[s].salt, SALT_BYTES);
      if (!merkleVerify(quotientRoot, i, leafHash(i, Buffer.concat([openedBytes, qSalt])), query.quotient[s].path.map((h: unknown) => bytes(h)), LOG_M)) return false;
      const x = mod(SHIFT * powMod(OMEGA_M, BigInt(i)));
      values.push(deepValue(x, fpList(rowBytes), kList(openedBytes)));
    }
    let idx = p;
    let folded = foldPair(values[0], values[1], betas[0], mod(SHIFT * powMod(OMEGA_M, BigInt(p))));
    for (let k = 1; k < FRI_LAYERS; k++) {
      const size = M >> k;
      const lo = idx % (size / 2);
      const pair = query.fri[k - 1];
      if (!Array.isArray(pair) || pair.length !== 2) return false;
      const opened: K[] = [];
      for (let s = 0; s < 2; s++) {
        const i = lo + s * (size / 2);
        const valueBytes = bytes(pair[s].value, K_BYTES);
        if (!merkleVerify(friRoots[k - 1], i, leafHash(i, valueBytes), pair[s].path.map((h: unknown) => bytes(h)), LOG_M - k)) return false;
        opened.push(kList(valueBytes)[0]);
      }
      if (!kEq(opened[idx === lo ? 0 : 1], folded)) return false;
      folded = foldPair(opened[0], opened[1], betas[k], mod(layerShift(k) * powMod(rootOfUnity(size), BigInt(lo))));
      idx = lo;
    }
    const xFinal = mod(layerShift(FRI_LAYERS) * powMod(rootOfUnity(M >> FRI_LAYERS), BigInt(idx)));
    if (!kEq(kPolyAtFp(final, xFinal), folded)) return false;
  }
  return true;
}

// ── Shared with the prover ───────────────────────────────────────────
/**
 * What `zk/prover/boundsProver.ts` builds a proof from. The prover has no
 * field, hash, transcript, statement or constraint list of its own, so it
 * cannot drift from what this file verifies.
 */
export type { K, Statement };
export const starkInternals = {
  P, mod, powMod, inv, rootOfUnity,
  K_ZERO, K_ONE, DEGREE, kFrom, kAdd, kSub, kMul, kScale, kInv, kPow, polyAtK,
  PROTOCOL, N, ACTIVE, RANGE_BITS, M, SHIFT, NUM_QUERIES, GRINDING_BITS, FRI_LAYERS, FINAL_DEGREE, CHUNK, SALT_BYTES,
  NUM_CHUNKS, NUM_QUANTITIES, LIMIT, PROD_SCALED, PROD_A, PROD_B, PROD_SLACK, PROD_SCALE, WIDTH,
  OMEGA_M, OMEGA_A, LAST, INV2, WEIGHT_POLY, CONSTRAINTS,
  normalizeStatement, statementBytes, hash, u64le, leafHash, Transcript, quotientsAt, layerShift,
};
