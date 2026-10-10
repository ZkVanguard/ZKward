/**
 * Prover for the bounds ZK-STARK, in TypeScript.
 *
 * The same protocol as `zkp/core/bounds_stark.py`, so a proof made here is
 * accepted by the Python verifier and one made there by the verifier in
 * `zk/verifier/boundsStark.ts`. It exists so the application can prove
 * without a second service. Field, hash, transcript, statement and
 * constraint list all come from the verifier module.
 *
 * Hiding depends on this file's randomness, all of it from the operating
 * system: the 448 rows of each trace column that carry no witness, the leaf
 * salts, the two polynomials that blind the composition chunks, and the
 * masking polynomial.
 *
 * Server only: it sees the witness. Proving is a few seconds of CPU; the
 * work yields to the event loop between phases.
 */
import { randomBytes } from 'node:crypto';
import { starkInternals as S, type BoundsStatement, type K, type Statement } from '../verifier/boundsStark';

const { P, mod, inv, powMod, rootOfUnity, kAdd, kSub, kMul, kScale, kInv } = S;
const { N, ACTIVE, M, SHIFT, WIDTH, DEGREE, NUM_CHUNKS, CHUNK, NUM_QUANTITIES, FRI_LAYERS, FINAL_DEGREE } = S;
const STEP = N / ACTIVE;
const NEXT = M / ACTIVE; // x -> w'x is this index shift on the commitment domain
const MASK = N - CHUNK;
const PAYLOAD = 4 * NUM_QUANTITIES;
const OMEGA_N = rootOfUnity(N);

type Int = number | bigint | string;

export interface BoundsWitness {
  /** One private integer per bound of the statement, in order. */
  values: Int[];
  /** Further private integers below 2^62, committed but not constrained. */
  payload?: Int[];
}

export interface LocalProof {
  proof: Record<string, unknown>;
  commitment: string;
  /** The prover's secret: the trace polynomials and the leaf salts. */
  opening: Record<string, unknown>;
}

/** The witness is outside the statement, or malformed: there is nothing to prove. */
export class WitnessError extends Error {}

const pause = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── Randomness ───────────────────────────────────────────────────────
/** Uniform field elements, by rejection from 64 random bits. */
function randomFieldElements(count: number): bigint[] {
  const out: bigint[] = [];
  while (out.length < count) {
    const buf = randomBytes(8 * (count - out.length) + 64);
    for (let i = 0; i + 8 <= buf.length && out.length < count; i += 8) {
      const v = buf.readBigUInt64LE(i);
      if (v < P) out.push(v);
    }
  }
  return out;
}

// ── Transforms (the conventions of stark_core.py) ────────────────────
function ntt(values: readonly bigint[], omega: bigint): bigint[] {
  const a = values.slice();
  const n = a.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j |= bit;
    if (i < j) [a[i], a[j]] = [a[j], a[i]];
  }
  for (let length = 2; length <= n; length <<= 1) {
    const step = powMod(omega, BigInt(n / length));
    const half = length >> 1;
    for (let start = 0; start < n; start += length) {
      let w = 1n;
      for (let k = start; k < start + half; k++) {
        const u = a[k];
        const v = (a[k + half] * w) % P;
        a[k] = (u + v) % P;
        a[k + half] = (u - v + P) % P;
        w = (w * step) % P;
      }
    }
  }
  return a;
}

function intt(values: readonly bigint[], omega: bigint): bigint[] {
  const nInv = inv(BigInt(values.length));
  return ntt(values, inv(omega)).map((v) => (v * nInv) % P);
}

/** Values of a polynomial on the coset shift * <omega_size>. */
function cosetEvaluate(coeffs: readonly bigint[], size: number, shift: bigint): bigint[] {
  const scaled: bigint[] = new Array(size).fill(0n);
  let s = 1n;
  for (let i = 0; i < coeffs.length; i++) {
    scaled[i] = (coeffs[i] * s) % P;
    s = (s * shift) % P;
  }
  return ntt(scaled, rootOfUnity(size));
}

/** Coefficients of the polynomial with these values on shift * <omega>. */
function cosetInterpolate(values: readonly bigint[], shift: bigint): bigint[] {
  const coeffs = intt(values, rootOfUnity(values.length));
  const sInv = inv(shift);
  let s = 1n;
  for (let i = 0; i < coeffs.length; i++) {
    coeffs[i] = (coeffs[i] * s) % P;
    s = (s * sInv) % P;
  }
  return coeffs;
}

function batchInv(values: readonly bigint[]): bigint[] {
  const prefix: bigint[] = new Array(values.length + 1);
  prefix[0] = 1n;
  for (let i = 0; i < values.length; i++) prefix[i + 1] = (prefix[i] * values[i]) % P;
  let acc = inv(prefix[values.length]);
  const out: bigint[] = new Array(values.length);
  for (let i = values.length - 1; i >= 0; i--) {
    out[i] = (acc * prefix[i]) % P;
    acc = (acc * values[i]) % P;
  }
  return out;
}

// ── Encoding and trees ───────────────────────────────────────────────
function fieldBytes(values: readonly bigint[]): Buffer {
  const out = Buffer.alloc(8 * values.length);
  for (let i = 0; i < values.length; i++) out.writeBigUInt64LE(values[i], 8 * i);
  return out;
}

const kBytes = (values: readonly K[]): Buffer => fieldBytes(values.flat());

class MerkleTree {
  private readonly layers: Buffer[][];

  constructor(leaves: Buffer[]) {
    this.layers = [leaves];
    while (this.layers[this.layers.length - 1].length > 1) {
      const prev = this.layers[this.layers.length - 1];
      const next: Buffer[] = new Array(prev.length / 2);
      for (let i = 0; i < next.length; i++) next[i] = S.hash(Buffer.from([1]), prev[2 * i], prev[2 * i + 1]);
      this.layers.push(next);
    }
  }

  get root(): Buffer {
    return this.layers[this.layers.length - 1][0];
  }

  open(index: number): string[] {
    const path: string[] = [];
    let i = index;
    for (let l = 0; l < this.layers.length - 1; l++) {
      path.push(this.layers[l][i ^ 1].toString('hex'));
      i >>= 1;
    }
    return path;
  }
}

// ── Witness and trace ────────────────────────────────────────────────
/** Bits of `amount` on the active rows, and their running sum with the public weights. */
function bitsColumn(amount: bigint): [bigint[], bigint[]] {
  const bits: bigint[] = [];
  const acc: bigint[] = [];
  let total = 0n;
  for (let j = 0; j < ACTIVE; j++) {
    const bit = j < S.RANGE_BITS ? (amount >> BigInt(j)) & 1n : 0n;
    total = (total + (j < S.RANGE_BITS ? bit << BigInt(j) : 0n)) % P;
    bits.push(bit);
    acc.push(total);
  }
  return [bits, acc];
}

/** The trace on H: the witness on the 64 active rows, uniform values on the other 448. */
function buildTrace(witness: BoundsWitness, st: Statement): bigint[][] {
  let values: bigint[];
  let payload: bigint[];
  try {
    values = witness.values.map((v) => BigInt(v));
    payload = (witness.payload ?? []).map((v) => BigInt(v));
  } catch {
    throw new WitnessError('the witness is not a list of integers');
  }
  if (values.length > NUM_QUANTITIES || payload.length > ACTIVE) throw new WitnessError('too many values or payload entries');
  for (let k = values.length; k < NUM_QUANTITIES; k++) values.push(st.bounds[k][0]);
  if (payload.some((v) => v < 0n || v >= S.LIMIT)) throw new WitnessError('a payload entry is outside 0 <= v < 2^62');
  values.forEach((v, k) => {
    const [lo, hi] = st.bounds[k];
    if (v < lo || v > hi) throw new WitnessError(`value ${k} is outside its bounds`);
  });
  if (st.product && S.PROD_SCALE * values[S.PROD_SCALED] !== values[S.PROD_A] * values[S.PROD_B] + values[S.PROD_SLACK]) {
    throw new WitnessError('the product relation does not hold');
  }

  const random = randomFieldElements(WIDTH * N);
  const cols: bigint[][] = Array.from({ length: WIDTH }, (_, c) => random.slice(c * N, (c + 1) * N));
  values.forEach((v, k) => {
    const [lo, hi] = st.bounds[k];
    const parts: Array<[number, bigint]> = [[4 * k, v - lo], [4 * k + 2, hi - v]];
    for (const [bitCol, amount] of parts) {
      const [bits, acc] = bitsColumn(amount);
      for (let j = 0; j < ACTIVE; j++) {
        cols[bitCol][j * STEP] = bits[j];
        cols[bitCol + 1][j * STEP] = acc[j];
      }
    }
  });
  for (let j = 0; j < ACTIVE; j++) cols[PAYLOAD][j * STEP] = j < payload.length ? payload[j] : 0n;
  return cols;
}

/** Each constraint over its vanishing polynomial at one point of the commitment domain, in the base field. */
function quotientsOnDomain(
  st: Statement, cur: readonly bigint[], nxt: readonly bigint[], wCur: bigint, wNxt: bigint,
  xMinusLast: bigint, invVanishing: bigint, invFirst: bigint, invLast: bigint,
): bigint[] {
  return S.CONSTRAINTS.map((c) => {
    switch (c.kind) {
      case 'bool':
        return mod((cur[c.b] * cur[c.b] - cur[c.b]) % P * invVanishing);
      case 'acc':
        return mod(mod(nxt[c.a] - cur[c.a] - nxt[c.b] * wNxt) * xMinusLast % P * invVanishing);
      case 'init':
        return mod(mod(cur[c.a] - cur[c.b] * wCur) * invFirst);
      case 'sum': {
        const [lo, hi] = st.bounds[c.quantity];
        return mod(mod(cur[c.a1] + cur[c.a2] - (hi - lo)) * invLast);
      }
      case 'prod': {
        if (!st.product) return 0n;
        const value = (k: number): bigint => cur[4 * k + 1] + st.bounds[k][0];
        return mod(mod(S.PROD_SCALE * value(S.PROD_SCALED) - value(S.PROD_A) * value(S.PROD_B) - value(S.PROD_SLACK)) * invLast);
      }
    }
  });
}

/** A polynomial with extension coefficients (given per coordinate) at an extension point. */
function kPolyAtK(parts: readonly bigint[][], length: number, x: K): K {
  let acc: K = S.K_ZERO;
  for (let i = length - 1; i >= 0; i--) {
    acc = kAdd(kMul(acc, x), [parts[0][i], parts[1][i], parts[2][i], parts[3][i], parts[4][i]]);
  }
  return acc;
}

const kAt = (parts: readonly bigint[][], i: number): K => [parts[0][i], parts[1][i], parts[2][i], parts[3][i], parts[4][i]];

// ── Prove ────────────────────────────────────────────────────────────
/**
 * Prove `statement` for `witness`. Throws `WitnessError` when the witness
 * is outside the statement. The caller should still run the verifier on the
 * result before calling it verified.
 */
export async function proveBoundsLocally(statement: BoundsStatement, witness: BoundsWitness): Promise<LocalProof> {
  let st: Statement;
  try {
    st = S.normalizeStatement(statement);
  } catch (e) {
    throw new WitnessError(e instanceof Error ? e.message : 'malformed statement');
  }
  const cols = buildTrace(witness, st);

  // 1. Trace polynomials and their commitment on L.
  const coeffs = cols.map((c) => intt(c, OMEGA_N));
  const lde = coeffs.map((c) => cosetEvaluate(c, M, SHIFT));
  await pause();
  const traceSalts = randomBytes(S.SALT_BYTES * M);
  const salt = (salts: Buffer, i: number): Buffer => salts.subarray(S.SALT_BYTES * i, S.SALT_BYTES * (i + 1));
  const rowBytes = (i: number): Buffer => fieldBytes(lde.map((col) => col[i]));
  const traceTree = new MerkleTree(Array.from({ length: M }, (_, i) => S.leafHash(i, Buffer.concat([rowBytes(i), salt(traceSalts, i)]))));

  const t = new S.Transcript(S.statementBytes(st));
  t.absorb('trace', traceTree.root);
  const alphas = S.CONSTRAINTS.map(() => t.drawK());
  await pause();

  // 2. Composition polynomial on L.
  const xs: bigint[] = new Array(M);
  for (let i = 0, x = SHIFT; i < M; i++, x = (x * S.OMEGA_M) % P) xs[i] = x;
  const invVanishing = batchInv(Array.from({ length: NEXT }, (_, i) => mod(powMod(xs[i], BigInt(ACTIVE)) - 1n)));
  const invFirst = batchInv(xs.map((x) => mod(x - 1n)));
  const invLast = batchInv(xs.map((x) => mod(x - S.LAST)));
  const weights = cosetEvaluate(S.WEIGHT_POLY, M, SHIFT);
  const comp: bigint[][] = Array.from({ length: DEGREE }, () => new Array<bigint>(M));
  for (let i = 0; i < M; i++) {
    const j = (i + NEXT) % M;
    const q = quotientsOnDomain(
      st, lde.map((col) => col[i]), lde.map((col) => col[j]), weights[i], weights[j],
      mod(xs[i] - S.LAST), invVanishing[i % NEXT], invFirst[i], invLast[i],
    );
    for (let d = 0; d < DEGREE; d++) {
      let sum = 0n;
      for (let k = 0; k < q.length; k++) sum += alphas[k][d] * q[k];
      comp[d][i] = sum % P;
    }
    if (i % 1024 === 1023) await pause();
  }
  const cParts = comp.map((part) => cosetInterpolate(part, SHIFT));
  if (cParts.some((part) => part.slice(2 * N).some((v) => v !== 0n))) {
    throw new Error('the composition is not a polynomial of the expected degree');
  }

  // 3. Three chunks, each blinded: h0 + x^CHUNK r0, h1 - r0 + x^CHUNK r1, h2 - r1.
  const blind = (): bigint[][] => Array.from({ length: DEGREE }, () => randomFieldElements(MASK));
  const r0 = blind();
  const r1 = blind();
  const chunkCoeffs: bigint[][][] = [0, 1, 2].map((j) =>
    Array.from({ length: DEGREE }, (_, d) => {
      const h = cParts[d].slice(j * CHUNK, (j + 1) * CHUNK);
      if (j > 0) for (let i = 0; i < MASK; i++) h[i] = mod(h[i] - (j === 1 ? r0 : r1)[d][i]);
      return j < 2 ? h.concat((j === 0 ? r0 : r1)[d]) : h;
    }),
  );
  const maskCoeffs: bigint[][] = Array.from({ length: DEGREE }, () => randomFieldElements(N));
  const chunkLde = chunkCoeffs.map((parts) => parts.map((part) => cosetEvaluate(part, M, SHIFT)));
  const maskLde = maskCoeffs.map((part) => cosetEvaluate(part, M, SHIFT));
  await pause();
  const quotientSalts = randomBytes(S.SALT_BYTES * M);
  const quotientValues = (i: number): Buffer => kBytes([kAt(chunkLde[0], i), kAt(chunkLde[1], i), kAt(chunkLde[2], i), kAt(maskLde, i)]);
  const quotientTree = new MerkleTree(Array.from({ length: M }, (_, i) => S.leafHash(i, Buffer.concat([quotientValues(i), salt(quotientSalts, i)]))));
  t.absorb('quotient', quotientTree.root);

  // 4. Out-of-domain evaluations.
  let z = t.drawK();
  while (z[1] === 0n && z[2] === 0n && z[3] === 0n && z[4] === 0n) z = t.drawK();
  const zn = kScale(z, S.OMEGA_A);
  const traceZ = coeffs.map((c) => S.polyAtK(c, z));
  const traceZn = coeffs.map((c) => S.polyAtK(c, zn));
  const chunksZ = chunkCoeffs.map((parts) => kPolyAtK(parts, parts[0].length, z));
  t.absorb('ood', kBytes([...traceZ, ...traceZn, ...chunksZ]));
  await pause();

  // 5. DEEP combination, then FRI.
  const g1 = Array.from({ length: WIDTH }, () => t.drawK());
  const g2 = Array.from({ length: WIDTH }, () => t.drawK());
  const g3 = Array.from({ length: NUM_CHUNKS }, () => t.drawK());
  let constA: K = S.K_ZERO;
  let constB: K = S.K_ZERO;
  for (let c = 0; c < WIDTH; c++) {
    constA = kAdd(constA, kMul(g1[c], traceZ[c]));
    constB = kAdd(constB, kMul(g2[c], traceZn[c]));
  }
  for (let j = 0; j < NUM_CHUNKS; j++) constA = kAdd(constA, kMul(g3[j], chunksZ[j]));
  let layer: K[] = new Array(M);
  for (let i = 0; i < M; i++) {
    // sum g_c T_c(x) is a base-field scaling of each g_c, coordinate by coordinate.
    const a: bigint[] = [0n, 0n, 0n, 0n, 0n];
    const b: bigint[] = [0n, 0n, 0n, 0n, 0n];
    for (let c = 0; c < WIDTH; c++) {
      const v = lde[c][i];
      for (let d = 0; d < DEGREE; d++) {
        a[d] += g1[c][d] * v;
        b[d] += g2[c][d] * v;
      }
    }
    let top: K = [a[0] % P, a[1] % P, a[2] % P, a[3] % P, a[4] % P];
    for (let j = 0; j < NUM_CHUNKS; j++) top = kAdd(top, kMul(g3[j], kAt(chunkLde[j], i)));
    const first = kMul(kSub(top, constA), kInv(kSub(S.kFrom(xs[i]), z)));
    const second = kMul(kSub([b[0] % P, b[1] % P, b[2] % P, b[3] % P, b[4] % P], constB), kInv(kSub(S.kFrom(xs[i]), zn)));
    layer[i] = kAdd(kAdd(first, second), kAt(maskLde, i));
    if (i % 512 === 511) await pause();
  }

  let beta = t.drawK();
  const friLayers: K[][] = [];
  const friTrees: MerkleTree[] = [];
  for (let k = 0; k < FRI_LAYERS; k++) {
    const half = layer.length / 2;
    const omegaInv = inv(rootOfUnity(layer.length));
    const folded: K[] = new Array(half);
    for (let i = 0, xInv = inv(S.layerShift(k)); i < half; i++, xInv = (xInv * omegaInv) % P) {
      const even = kScale(kAdd(layer[i], layer[i + half]), S.INV2);
      const odd = kScale(kSub(layer[i], layer[i + half]), (S.INV2 * xInv) % P);
      folded[i] = kAdd(even, kMul(beta, odd));
    }
    layer = folded;
    if (k + 1 < FRI_LAYERS) {
      const tree = new MerkleTree(layer.map((v, i) => S.leafHash(i, kBytes([v]))));
      friLayers.push(layer);
      friTrees.push(tree);
      t.absorb('fri', tree.root);
      beta = t.drawK();
    }
  }
  const finalParts = Array.from({ length: DEGREE }, (_, d) => cosetInterpolate(layer.map((v) => v[d]), S.layerShift(FRI_LAYERS)));
  if (finalParts.some((part) => part.slice(FINAL_DEGREE).some((v) => v !== 0n))) {
    throw new Error('FRI did not reach a low-degree final polynomial');
  }
  const final: K[] = Array.from({ length: FINAL_DEGREE }, (_, i) => kAt(finalParts, i));
  t.absorb('final', kBytes(final));
  await pause();

  // 6. Grinding, then the queries the transcript asks for.
  const nonce = t.grind(S.GRINDING_BITS);
  const queries = Array.from({ length: S.NUM_QUERIES }, () => t.drawIndex(M / 2)).map((p) => {
    const pair = [p, p + M / 2];
    const fri = [];
    let idx = p;
    for (let k = 1; k < FRI_LAYERS; k++) {
      const size = M >> k;
      const lo = idx % (size / 2);
      fri.push([lo, lo + size / 2].map((i) => ({ value: kBytes([friLayers[k - 1][i]]).toString('hex'), path: friTrees[k - 1].open(i) })));
      idx = lo;
    }
    return {
      trace: pair.map((i) => ({ row: rowBytes(i).toString('hex'), salt: salt(traceSalts, i).toString('hex'), path: traceTree.open(i) })),
      quotient: pair.map((i) => ({ values: quotientValues(i).toString('hex'), salt: salt(quotientSalts, i).toString('hex'), path: quotientTree.open(i) })),
      fri,
    };
  });

  const commitment = traceTree.root.toString('hex');
  return {
    commitment,
    proof: {
      protocol: S.PROTOCOL,
      public: { kind: st.kind, bounds: st.bounds.map(([lo, hi]) => [lo.toString(), hi.toString()]), product: st.product },
      commitment,
      quotient_root: quotientTree.root.toString('hex'),
      ood: { trace_z: kBytes(traceZ).toString('hex'), trace_zn: kBytes(traceZn).toString('hex'), chunks_z: kBytes(chunksZ).toString('hex') },
      fri_roots: friTrees.map((tree) => tree.root.toString('hex')),
      final: kBytes(final).toString('hex'),
      nonce,
      queries,
    },
    opening: {
      protocol: S.PROTOCOL,
      commitment,
      columns: coeffs.map((c) => fieldBytes(c).toString('hex')),
      salts: traceSalts.toString('hex'),
    },
  };
}
