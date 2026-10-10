/**
 * Verifier for the hedge policy ZK-STARK, in TypeScript.
 *
 * A second implementation of the verifier in `zkp/core/hedge_stark.py`,
 * written from the protocol, not translated line by line. Two verifiers that
 * agree on every accept and every reject are evidence that neither has a
 * slip in its transcript, its encodings or its arithmetic; and this one lets
 * a server or a script check a proof without the Python prover.
 *
 * Statement: "the hedge committed as `commitment` has leverage in
 * [1, leverage_cap], notional in [0, notional_cap_cents], asset in
 * [1, asset_count] and side in {0, 1}". The caps come from the caller.
 *
 * Protocol: Goldilocks field with challenges in its quadratic extension,
 * SHA-256 Merkle commitments, a Fiat-Shamir transcript re-run here, an
 * out-of-domain check of the constraints, and FRI on the DEEP quotients.
 * No setup of any kind.
 */
import { createHash } from 'node:crypto';

// ── Field ────────────────────────────────────────────────────────────
const P = 0xffffffff00000001n; // 2^64 - 2^32 + 1
const GENERATOR = 7n;
const NONRESIDUE = 7n; // the extension is Fp[u] / (u^2 - 7)

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

type K = readonly [bigint, bigint];
const K_ZERO: K = [0n, 0n];
const K_ONE: K = [1n, 0n];
const kAdd = (a: K, b: K): K => [mod(a[0] + b[0]), mod(a[1] + b[1])];
const kSub = (a: K, b: K): K => [mod(a[0] - b[0]), mod(a[1] - b[1])];
const kMul = (a: K, b: K): K => [mod(a[0] * b[0] + NONRESIDUE * a[1] * b[1]), mod(a[0] * b[1] + a[1] * b[0])];
const kScale = (a: K, s: bigint): K => [mod(a[0] * s), mod(a[1] * s)];
const kEq = (a: K, b: K): boolean => a[0] === b[0] && a[1] === b[1];

function kInv(a: K): K {
  const n = inv(a[0] * a[0] - NONRESIDUE * a[1] * a[1]);
  return [mod(a[0] * n), mod(-a[1] * n)];
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
    acc = [mod(m[0] + coeffs[i]), m[1]];
  }
  return acc;
}

/** A polynomial with extension coefficients at a base-field point. */
function kPolyAtFp(coeffs: readonly K[], x: bigint): K {
  let re = 0n;
  let im = 0n;
  for (let i = coeffs.length - 1; i >= 0; i--) {
    re = mod(re * x + coeffs[i][0]);
    im = mod(im * x + coeffs[i][1]);
  }
  return [re, im];
}

// ── Parameters (must equal zkp/core/hedge_stark.py) ──────────────────
const PROTOCOL = 'zkward-hedge-policy-v3';
const N = 512;
const ACTIVE = 64;
const RANGE_BITS = 62;
const BLOWUP = 16;
const M = N * BLOWUP;
const LOG_M = 13;
const SHIFT = GENERATOR;
const NUM_QUERIES = 40;
const GRINDING_BITS = 20;
const FRI_LAYERS = 6;
const FINAL_DEGREE = N >> FRI_LAYERS;
const CHUNK = (3 * N) / 4;
const NUM_CHUNKS = 3;
const NUM_QUANTITIES = 4; // leverage, notional, asset, side
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
  | { kind: 'sum'; a1: number; a2: number; quantity: number };

/** The constraints in the order their random weights are drawn. */
const CONSTRAINTS: Constraint[] = (() => {
  const out: Constraint[] = [];
  for (let k = 0; k < NUM_QUANTITIES; k++) {
    for (const [b, a] of [[4 * k, 4 * k + 1], [4 * k + 2, 4 * k + 3]]) {
      out.push({ kind: 'bool', b }, { kind: 'acc', a, b }, { kind: 'init', a, b });
    }
  }
  for (let k = 0; k < NUM_QUANTITIES; k++) out.push({ kind: 'sum', a1: 4 * k + 1, a2: 4 * k + 3, quantity: k });
  return out;
})();

// ── Public inputs ────────────────────────────────────────────────────
export interface HedgePolicyPublic {
  leverage_cap: number | bigint | string;
  notional_cap_cents: number | bigint | string;
  asset_count?: number | bigint | string;
}

interface Caps {
  leverageCap: bigint;
  notionalCap: bigint;
  assetCount: bigint;
}

function normalizePublic(pub: HedgePolicyPublic): Caps {
  const caps: Caps = {
    leverageCap: BigInt(pub.leverage_cap),
    notionalCap: BigInt(pub.notional_cap_cents),
    assetCount: BigInt(pub.asset_count ?? 3),
  };
  const limit = 1n << BigInt(RANGE_BITS);
  if (caps.leverageCap < 1n || caps.leverageCap >= limit) throw new Error('leverage_cap out of range');
  if (caps.notionalCap < 0n || caps.notionalCap >= limit) throw new Error('notional_cap_cents out of range');
  if (caps.assetCount < 1n || caps.assetCount >= limit) throw new Error('asset_count out of range');
  return caps;
}

/** hi - lo for each bounded quantity: leverage [1, cap], notional [0, cap], asset [1, count], side [0, 1]. */
const span = (caps: Caps, quantity: number): bigint =>
  [caps.leverageCap - 1n, caps.notionalCap, caps.assetCount - 1n, 1n][quantity];

/** What both sides agree on before the first message; every challenge depends on it. */
function statementBytes(caps: Caps): Buffer {
  return Buffer.from(
    `{"active":${ACTIVE},"air":"zkward-hedge-policy","blowup":${BLOWUP},"field":"goldilocks-quadratic",` +
      `"fri_layers":${FRI_LAYERS},"grinding":${GRINDING_BITS},"hash":"sha256","n":${N},` +
      `"public":{"asset_count":${caps.assetCount},"leverage_cap":${caps.leverageCap},"notional_cap_cents":${caps.notionalCap}},` +
      `"queries":${NUM_QUERIES},"version":3}`,
    'utf8',
  );
}

// ── Hashing, Merkle, transcript ──────────────────────────────────────
const sha256 = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

const u64le = (v: number | bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
};

const leafHash = (index: number, data: Uint8Array): Buffer => sha256(Buffer.from([0]), u64le(index), data);

/** True when `leaf` is at `index` under `root`. The side of each sibling comes from the index. */
function merkleVerify(root: Buffer, index: number, leaf: Buffer, path: Buffer[], depth: number): boolean {
  if (path.length !== depth || index < 0 || index >= 2 ** depth) return false;
  let node = leaf;
  let i = index;
  for (const sibling of path) {
    if (sibling.length !== 32) return false;
    node = i % 2 === 1 ? sha256(Buffer.from([1]), sibling, node) : sha256(Buffer.from([1]), node, sibling);
    i = Math.floor(i / 2);
  }
  return node.equals(root);
}

class Transcript {
  private state: Buffer;

  constructor(statement: Uint8Array) {
    this.state = sha256(Buffer.from('zkward-stark-3\0', 'latin1'), statement);
  }

  absorb(label: string, data: Uint8Array): void {
    const l = Buffer.from(label, 'latin1');
    const len = Buffer.alloc(2);
    len.writeUInt16LE(l.length);
    this.state = sha256(this.state, Buffer.from([1]), len, l, u64le(data.length), data);
  }

  private draw(): Buffer {
    this.state = sha256(this.state, Buffer.from([2]));
    return sha256(this.state, Buffer.from([3]));
  }

  drawFp(): bigint {
    for (;;) {
      const v = this.draw().readBigUInt64LE(0);
      if (v < P) return v;
    }
  }

  drawK(): K {
    const re = this.drawFp();
    return [re, this.drawFp()];
  }

  drawIndex(bound: number): number {
    return Number(this.draw().readBigUInt64LE(0) & BigInt(bound - 1));
  }

  /** Accepts the nonce only if its hash with the state has `bits` leading zero bits, then absorbs it. */
  checkGrind(nonce: bigint, bits: number): boolean {
    const digest = sha256(this.state, Buffer.from([4]), u64le(nonce));
    if (BigInt('0x' + digest.toString('hex')) >> BigInt(256 - bits) !== 0n) return false;
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
  if (flat.length % 2 !== 0) throw new Error('bad extension-field encoding');
  const out: K[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

// ── The statement's constraints at the out-of-domain point ───────────
function quotientsAt(caps: Caps, z: K, cur: readonly K[], nxt: readonly K[]): K[] {
  const zn = kScale(z, OMEGA_A);
  const wCur = polyAtK(WEIGHT_POLY, z);
  const wNxt = polyAtK(WEIGHT_POLY, zn);
  const zMinusLast = kSub(z, [LAST, 0n]);
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
      case 'sum':
        return kMul(kSub(kAdd(cur[c.a1], cur[c.a2]), [mod(span(caps, c.quantity)), 0n]), invLast);
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
 * True only when `proof` proves the hedge policy under `pub` for its
 * commitment (and for `commitment`, when the caller names the one it
 * expects). Malformed input is `false`, never an exception.
 */
export function verifyHedgePolicyProof(proof: unknown, pub: HedgePolicyPublic, commitment?: string): boolean {
  try {
    return verify(proof as Record<string, any>, normalizePublic(pub), commitment);
  } catch {
    return false;
  }
}

function verify(proof: Record<string, any>, caps: Caps, commitment?: string): boolean {
  if (!proof || proof.protocol !== PROTOCOL) return false;
  const traceRoot = bytes(proof.commitment, 32);
  if (commitment !== undefined && commitment.toLowerCase() !== String(proof.commitment).toLowerCase()) return false;
  const quotientRoot = bytes(proof.quotient_root, 32);
  if (!Array.isArray(proof.fri_roots) || proof.fri_roots.length !== FRI_LAYERS - 1) return false;
  const friRoots: Buffer[] = proof.fri_roots.map((r: unknown) => bytes(r, 32));
  const traceZBytes = bytes(proof.ood.trace_z, 16 * WIDTH);
  const traceZnBytes = bytes(proof.ood.trace_zn, 16 * WIDTH);
  const chunksZBytes = bytes(proof.ood.chunks_z, 16 * NUM_CHUNKS);
  const finalBytes = bytes(proof.final, 16 * FINAL_DEGREE); // the length IS the degree bound
  const traceZ = kList(traceZBytes);
  const traceZn = kList(traceZnBytes);
  const chunksZ = kList(chunksZBytes);
  const final = kList(finalBytes);
  if (!Array.isArray(proof.queries) || proof.queries.length !== NUM_QUERIES) return false;
  if (typeof proof.nonce !== 'number' || !Number.isSafeInteger(proof.nonce) || proof.nonce < 0) return false;

  // The transcript, replayed. Every challenge below is this verifier's own.
  const t = new Transcript(statementBytes(caps));
  t.absorb('trace', traceRoot);
  const alphas = CONSTRAINTS.map(() => t.drawK());
  t.absorb('quotient', quotientRoot);
  let z = t.drawK();
  while (z[1] === 0n) z = t.drawK();
  const zn = kScale(z, OMEGA_A);
  t.absorb('ood', Buffer.concat([traceZBytes, traceZnBytes, chunksZBytes]));

  // 1. The constraints hold at z: composition(z) = sum of weighted quotients.
  let expected: K = K_ZERO;
  quotientsAt(caps, z, traceZ, traceZn).forEach((q, i) => {
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
      a = kAdd(a, kMul(g1[c], kSub([row[c], 0n], traceZ[c])));
      b = kAdd(b, kMul(g2[c], kSub([row[c], 0n], traceZn[c])));
    }
    for (let j = 0; j < NUM_CHUNKS; j++) a = kAdd(a, kMul(g3[j], kSub(opened[j], chunksZ[j])));
    const inv1 = kInv([mod(x - z[0]), mod(-z[1])]);
    const inv2 = kInv([mod(x - zn[0]), mod(-zn[1])]);
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
      const salt = bytes(query.trace[s].salt, 16);
      if (!merkleVerify(traceRoot, i, leafHash(i, Buffer.concat([rowBytes, salt])), query.trace[s].path.map((h: unknown) => bytes(h)), LOG_M)) return false;
      const openedBytes = bytes(query.quotient[s].values, 16 * (NUM_CHUNKS + 1));
      const qSalt = bytes(query.quotient[s].salt, 16);
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
        const valueBytes = bytes(pair[s].value, 16);
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
