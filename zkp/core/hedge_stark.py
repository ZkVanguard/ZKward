"""
Hedge policy ZK-STARK.

Statement
---------
"The hedge committed as `commitment` has
   leverage  in [1, leverage_cap],
   notional  in [0, notional_cap_cents],
   asset     in [1, asset_count]   (the asset codes of hedge_canonical),
   side      in {0, 1}."
Public: the commitment and the caps. Private: the hedge.

The commitment IS the proof's trace commitment: the Merkle root of the
low-degree extension of the witness trace. Nothing has to tie a separate
hash to the trace, because there is no separate hash. An auditor given the
opening (`audit_opening`) recomputes the root and reads the hedge out of it.

What the proof does not say: that an order sent to a venue is this hedge, or
that the notional equals size times price (both are committed, neither
relation is proven). Those are checked by opening the commitment.

Protocol (ethSTARK 2021/582 with DEEP-FRI 2019/336)
--------------------------------------------------
  1. Trace: 17 columns over a domain H of N = 512 rows. Only 64 rows (the
     subgroup H' of order 64) carry the witness; the other 448 are random.
  2. Commit to the trace on a coset L of size 16 N, with salted leaves.
  3. Constraints, combined with random weights from the transcript, give the
     composition polynomial C. It is split into three chunks, each blinded.
  4. Commit to the chunks and to a random masking polynomial.
  5. Out-of-domain point z (in the extension field): the prover sends the
     trace at z and at w'z and the chunks at z. The verifier checks the
     constraint identity AT z. This is what ties the constraints to the
     committed trace.
  6. DEEP quotients of every trace column and chunk, plus the mask, are
     combined into one polynomial, and FRI proves it has degree < N. That is
     the low-degree test of the TRACE, not only of the composition.
  7. Grinding, then 40 queries. Every challenge is derived by the verifier.

Range checks use bits. For a value v in [lo, hi] the trace holds the bits of
u = v - lo and of g = hi - v, each with a running sum, and one constraint
says u + g = hi - lo. Both are below 2^62, so the sum cannot wrap around the
field, and the equality holds over the integers: lo <= v <= hi.

Zero knowledge (a design argument, not a formal proof)
-----------------------------------------------------
Every value the verifier sees from the trace is an evaluation outside H. A
column has 448 free random rows; the view depends on at most 4 * 40 + 4 = 164
field functionals of a column (the opened points, their w' shifts through
the composition, and the two out-of-domain points), so those values are
uniform whatever the witness is. Chunks are blinded with random polynomials
of degree < 128 (98 openings), the FRI layers by the masking polynomial, and
unopened leaves by per-leaf salts.

Soundness: challenges come from a field of about 2^128 elements. With rate
1/16 and 40 queries the query phase gives 80 bits by the proven bound and
160 by the conjectured one, plus 20 bits of grinding. This code has not been
reviewed by anyone outside the project; until it is, treat the numbers as the
design target, not as a guarantee.
"""
import hashlib
import json
import secrets
from typing import Any, Dict, List, Optional, Sequence, Tuple

from zkp.core.stark_core import (
    GENERATOR, P, K, K_ZERO, MerkleTree, Transcript,
    batch_inv, coset_evaluate, coset_interpolate, fold_layer, fold_pair, fp_poly_at_k, intt, inv,
    k_add, k_bytes, k_inv, k_mul, k_poly_at_fp, k_poly_at_k, k_pow, k_scale, k_sub,
    leaf_hash, merkle_verify, ntt, root_of_unity,
)

AIR_ID = 'zkward-hedge-policy'
AIR_VERSION = 3

# ── Parameters ───────────────────────────────────────────────────────
N = 512                      # trace rows
ACTIVE = 64                  # rows that carry the witness (the subgroup H')
STEP = N // ACTIVE
RANGE_BITS = 62              # every range-checked value is below 2^62
BLOWUP = 16                  # rate 1/16
M = N * BLOWUP               # size of the commitment domain L
LOG_M = M.bit_length() - 1
SHIFT = GENERATOR            # L = SHIFT * <omega_M>, disjoint from H
NUM_QUERIES = 40
GRINDING_BITS = 20
FRI_LAYERS = 6
FINAL_DEGREE = N >> FRI_LAYERS          # 8 coefficients sent in the clear
CHUNK = 3 * N // 4                      # composition chunk size
NUM_CHUNKS = 3
MASK = N - CHUNK                        # degree of each chunk's blinding polynomial

OMEGA_N = root_of_unity(N)
OMEGA_M = root_of_unity(M)
OMEGA_A = root_of_unity(ACTIVE)         # w': generator of H'
NEXT = M // ACTIVE                      # x -> w'x is an index shift of NEXT on L
LAST = inv(OMEGA_A)                     # w'^63, the last active row

assert pow(OMEGA_N, STEP, P) == OMEGA_A and pow(OMEGA_M, NEXT, P) == OMEGA_A
assert NUM_CHUNKS * CHUNK >= 2 * N and MASK >= 2 * NUM_QUERIES + 2
assert N - ACTIVE >= 4 * NUM_QUERIES + 4

# Bit j of a value weighs 2^j; rows 62 and 63 weigh nothing, which is what
# keeps every value below 2^62 without a constraint per unused bit.
WEIGHTS = [(1 << j) if j < RANGE_BITS else 0 for j in range(ACTIVE)]
WEIGHT_POLY = intt(WEIGHTS, OMEGA_A)    # degree < 64, equals WEIGHTS on H'

# ── Trace layout ─────────────────────────────────────────────────────
QUANTITIES = ('leverage', 'notional', 'asset', 'side')
# Per quantity k: bits of (v - lo), their running sum, bits of (hi - v), their running sum.
BU, AU, BG, AG = 0, 1, 2, 3
PAYLOAD = 4 * len(QUANTITIES)           # committed, unconstrained: size, price, portfolio, time
WIDTH = PAYLOAD + 1
PAYLOAD_FIELDS = ('sizeUnits', 'entryPriceUsdcCents', 'portfolioId', 'timestampMs')
LOWER = {'leverage': 1, 'notional': 0, 'asset': 1, 'side': 0}


def col(k: int, part: int) -> int:
    return 4 * k + part


# The constraints, in the fixed order their random weights are drawn in.
#   ('bool', b)           b^2 - b = 0                          on H'
#   ('acc',  a, b)        a(w'x) - a(x) - b(w'x) W(w'x) = 0    on H' except the last row
#   ('init', a, b)        a - b W = 0                          at row 0
#   ('sum',  a1, a2, k)   a1 + a2 - (hi_k - lo_k) = 0          at the last row
CONSTRAINTS: List[tuple] = []
for _k in range(len(QUANTITIES)):
    for _b, _a in ((col(_k, BU), col(_k, AU)), (col(_k, BG), col(_k, AG))):
        CONSTRAINTS += [('bool', _b), ('acc', _a, _b), ('init', _a, _b)]
for _k in range(len(QUANTITIES)):
    CONSTRAINTS.append(('sum', col(_k, AU), col(_k, AG), _k))


class HedgeProofError(ValueError):
    """The witness does not satisfy the statement, or the inputs are malformed."""


# ── Public inputs ────────────────────────────────────────────────────

def normalize_public(public: Dict[str, Any]) -> Dict[str, int]:
    out = {
        'leverage_cap': int(public['leverage_cap']),
        'notional_cap_cents': int(public['notional_cap_cents']),
        'asset_count': int(public.get('asset_count', 3)),
    }
    if not 1 <= out['leverage_cap'] < (1 << RANGE_BITS):
        raise HedgeProofError('leverage_cap out of range')
    if not 0 <= out['notional_cap_cents'] < (1 << RANGE_BITS):
        raise HedgeProofError('notional_cap_cents out of range')
    if not 1 <= out['asset_count'] < (1 << RANGE_BITS):
        raise HedgeProofError('asset_count out of range')
    return out


def _upper(public: Dict[str, int]) -> Dict[str, int]:
    return {'leverage': public['leverage_cap'], 'notional': public['notional_cap_cents'], 'asset': public['asset_count'], 'side': 1}


def _span(public: Dict[str, int], k: int) -> int:
    q = QUANTITIES[k]
    return _upper(public)[q] - LOWER[q]


def statement_bytes(public: Dict[str, int]) -> bytes:
    """Everything both sides agree on before the first message, bound into every challenge."""
    return json.dumps({
        'air': AIR_ID, 'version': AIR_VERSION, 'field': 'goldilocks-quadratic', 'hash': 'sha256',
        'n': N, 'active': ACTIVE, 'blowup': BLOWUP, 'queries': NUM_QUERIES, 'grinding': GRINDING_BITS,
        'fri_layers': FRI_LAYERS, 'public': public,
    }, sort_keys=True, separators=(',', ':')).encode()


# ── Constraints ──────────────────────────────────────────────────────

class _FpOps:
    @staticmethod
    def add(a, b): return (a + b) % P
    @staticmethod
    def sub(a, b): return (a - b) % P
    @staticmethod
    def mul(a, b): return a * b % P
    @staticmethod
    def const(c): return c % P


class _KOps:
    add = staticmethod(k_add)
    sub = staticmethod(k_sub)
    mul = staticmethod(k_mul)
    @staticmethod
    def const(c): return (c % P, 0)


def _quotients(ops, public: Dict[str, int], cur: Sequence, nxt: Sequence, w_cur, w_nxt, x_minus_last, inv_zh, inv_x_minus_1, inv_x_minus_last) -> List:
    """
    Each constraint divided by the polynomial that vanishes where it must
    hold, at one point. `cur` and `nxt` are the trace at x and at w'x. One
    definition serves the prover (over Fp, on L) and the verifier (over K, at
    z), so the two cannot drift apart.
    """
    out = []
    for c in CONSTRAINTS:
        kind = c[0]
        if kind == 'bool':
            b = cur[c[1]]
            out.append(ops.mul(ops.sub(ops.mul(b, b), b), inv_zh))
        elif kind == 'acc':
            a, b = c[1], c[2]
            num = ops.sub(ops.sub(nxt[a], cur[a]), ops.mul(nxt[b], w_nxt))
            out.append(ops.mul(ops.mul(num, x_minus_last), inv_zh))
        elif kind == 'init':
            a, b = c[1], c[2]
            out.append(ops.mul(ops.sub(cur[a], ops.mul(cur[b], w_cur)), inv_x_minus_1))
        else:  # 'sum'
            total = ops.sub(ops.add(cur[c[1]], cur[c[2]]), ops.const(_span(public, c[3])))
            out.append(ops.mul(total, inv_x_minus_last))
    return out


def _constraints_at_k(public: Dict[str, int], z: K, cur: Sequence[K], nxt: Sequence[K]) -> List[K]:
    """The quotients at an extension-field point, from the trace values claimed there."""
    zn = k_scale(z, OMEGA_A)
    one = (1, 0)
    return _quotients(
        _KOps, public, cur, nxt,
        fp_poly_at_k(WEIGHT_POLY, z), fp_poly_at_k(WEIGHT_POLY, zn),
        k_sub(z, (LAST, 0)),
        k_inv(k_sub(k_pow(z, ACTIVE), one)),
        k_inv(k_sub(z, one)),
        k_inv(k_sub(z, (LAST, 0))),
    )


# ── Witness and trace ────────────────────────────────────────────────

def _values(witness: Dict[str, Any]) -> Dict[str, int]:
    from zkp.core.hedge_canonical import ASSET_CODE, SIDE_CODE
    asset = witness.get('asset')
    side = witness.get('side')
    asset_code = ASSET_CODE.get(str(asset).upper()) if not isinstance(asset, int) else asset
    side_code = SIDE_CODE.get(str(side).upper()) if not isinstance(side, int) else side
    if asset_code is None or side_code is None:
        raise HedgeProofError(f'unsupported asset or side: {asset!r} {side!r}')
    return {
        'leverage': int(witness['leverageX']),
        'notional': int(witness['notionalValueUsdcCents']),
        'asset': int(asset_code),
        'side': int(side_code),
    }


def _bits_column(value: int) -> Tuple[List[int], List[int]]:
    bits = [(value >> j) & 1 if j < RANGE_BITS else 0 for j in range(ACTIVE)]
    acc, total = [], 0
    for j in range(ACTIVE):
        total = (total + bits[j] * WEIGHTS[j]) % P
        acc.append(total)
    return bits, acc


def build_trace(witness: Dict[str, Any], public: Dict[str, int], *, check: bool = True) -> List[List[int]]:
    values = _values(witness)
    upper = _upper(public)
    cols = [[secrets.randbelow(P) for _ in range(N)] for _ in range(WIDTH)]
    for k, q in enumerate(QUANTITIES):
        v, lo, hi = values[q], LOWER[q], upper[q]
        if check and not lo <= v <= hi:
            raise HedgeProofError(f'{q} {v} is outside [{lo}, {hi}]')
        # Out of range only when `check` is off: the trace then cannot satisfy the constraints.
        for part_bits, part_acc, amount in ((BU, AU, v - lo), (BG, AG, hi - v)):
            bits, acc = _bits_column(amount % (1 << RANGE_BITS))
            for j in range(ACTIVE):
                cols[col(k, part_bits)][j * STEP] = bits[j]
                cols[col(k, part_acc)][j * STEP] = acc[j]
    for j in range(ACTIVE):
        cols[PAYLOAD][j * STEP] = 0
    for j, name in enumerate(PAYLOAD_FIELDS):
        value = int(witness.get(name, 0))
        if not 0 <= value < (1 << RANGE_BITS):
            raise HedgeProofError(f'{name} out of range')
        cols[PAYLOAD][j * STEP] = value
    if check:
        _assert_trace(cols, public)
    return cols


def _assert_trace(cols: List[List[int]], public: Dict[str, int]) -> None:
    """The prover's own check that the trace satisfies every constraint on H'."""
    for j in range(ACTIVE):
        cur = [c[j * STEP] for c in cols]
        nxt = [c[((j + 1) % ACTIVE) * STEP] for c in cols]
        for c in CONSTRAINTS:
            kind = c[0]
            if kind == 'bool':
                ok = (cur[c[1]] * cur[c[1]] - cur[c[1]]) % P == 0
            elif kind == 'acc':
                ok = j == ACTIVE - 1 or (nxt[c[1]] - cur[c[1]] - nxt[c[2]] * WEIGHTS[j + 1]) % P == 0
            elif kind == 'init':
                ok = j != 0 or (cur[c[1]] - cur[c[2]] * WEIGHTS[0]) % P == 0
            else:
                ok = j != ACTIVE - 1 or (cur[c[1]] + cur[c[2]] - _span(public, c[3])) % P == 0
            if not ok:
                raise HedgeProofError(f'trace violates constraint {c} at row {j}')


# ── Shared helpers ───────────────────────────────────────────────────

def _row_bytes(values: Sequence[int]) -> bytes:
    return b''.join(v.to_bytes(8, 'little') for v in values)


def _k_list_bytes(values: Sequence[K]) -> bytes:
    return b''.join(k_bytes(v) for v in values)


def _k_from_bytes(data: bytes) -> List[K]:
    if len(data) % 16:
        raise ValueError('bad extension-field encoding')
    out = []
    for i in range(0, len(data), 16):
        a = int.from_bytes(data[i:i + 8], 'little')
        b = int.from_bytes(data[i + 8:i + 16], 'little')
        if a >= P or b >= P:
            raise ValueError('non-canonical field element')
        out.append((a, b))
    return out


def _fp_from_bytes(data: bytes) -> List[int]:
    if len(data) % 8:
        raise ValueError('bad field encoding')
    out = [int.from_bytes(data[i:i + 8], 'little') for i in range(0, len(data), 8)]
    if any(v >= P for v in out):
        raise ValueError('non-canonical field element')
    return out


def _draw_ood_point(t: Transcript) -> K:
    """A point of K outside Fp: it is then outside H and L, and no denominator can vanish."""
    while True:
        z = t.draw_k()
        if z[1] != 0:
            return z


def _deep_value(x: int, row: Sequence[int], chunks: Sequence[K], mask: K, z: K, zn: K,
                trace_z: Sequence[K], trace_zn: Sequence[K], chunks_z: Sequence[K],
                g1: Sequence[K], g2: Sequence[K], g3: Sequence[K]) -> K:
    """
    The DEEP combination at one point x of L:
        sum g1_c (T_c(x) - T_c(z)) / (x - z)  +  sum g2_c (T_c(x) - T_c(w'z)) / (x - w'z)
      + sum g3_j (h_j(x) - h_j(z)) / (x - z)  +  mask(x)
    It is a polynomial of degree < N exactly when the claimed out-of-domain
    values are the true ones and every part has degree < N.
    """
    a = K_ZERO
    b = K_ZERO
    for c in range(WIDTH):
        a = k_add(a, k_mul(g1[c], k_sub((row[c], 0), trace_z[c])))
        b = k_add(b, k_mul(g2[c], k_sub((row[c], 0), trace_zn[c])))
    for j in range(NUM_CHUNKS):
        a = k_add(a, k_mul(g3[j], k_sub(chunks[j], chunks_z[j])))
    inv1 = k_inv(((x - z[0]) % P, (-z[1]) % P))
    inv2 = k_inv(((x - zn[0]) % P, (-zn[1]) % P))
    return k_add(k_add(k_mul(a, inv1), k_mul(b, inv2)), mask)


def _composition_at_z(z: K, chunks_z: Sequence[K]) -> K:
    """C(z) from its chunks: sum z^(j * CHUNK) h_j(z)."""
    step = k_pow(z, CHUNK)
    acc, power = K_ZERO, (1, 0)
    for j in range(NUM_CHUNKS):
        acc = k_add(acc, k_mul(power, chunks_z[j]))
        power = k_mul(power, step)
    return acc


def _layer_shift(k: int) -> int:
    return pow(SHIFT, 1 << k, P)


# ── Prover ───────────────────────────────────────────────────────────

def prove(witness: Dict[str, Any], public: Dict[str, Any], *, skip_checks_for_tests: bool = False,
          attack_hooks_for_tests: Optional[Dict[str, Any]] = None) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Prove the hedge policy for `witness`. Returns (proof, opening). The proof
    is public; its `commitment` is the hedge commitment. The opening is the
    prover's secret: it is what an auditor needs to read the hedge back.

    `skip_checks_for_tests` makes this a dishonest prover: it proves whatever
    it is given, without checking the witness or its own polynomials.
    `attack_hooks_for_tests` lets a test replace what such a prover sends at
    each step (see `_commit_phase`). Both exist so the tests can show that
    the VERIFIER rejects, whatever the prover does.
    """
    state = _commit_phase(witness, normalize_public(public), not skip_checks_for_tests, attack_hooks_for_tests or {})
    nonce = state['transcript'].grind(GRINDING_BITS)
    return _query_phase(state, nonce), state['opening']


def _commit_phase(witness: Dict[str, Any], public: Dict[str, int], honest: bool, hooks: Dict[str, Any]) -> Dict[str, Any]:
    """
    Everything the prover sends before the queries are known. Hooks, used
    only by tests acting as a malicious prover:
      'lde'       (lde) -> lde                       replace the committed trace
      'ood'       (context) -> (trace_z, trace_zn, chunks_z)   lie about the out-of-domain values
      'fri_layer' (k, layer) -> layer                commit to something other than the true fold
      'final'     (last_layer, shift) -> coefficients          choose the final polynomial freely
    """
    cols = build_trace(witness, public, check=honest)

    # 1. Trace polynomials and their commitment on L.
    coeffs = [intt(c, OMEGA_N) for c in cols]
    lde = [coset_evaluate(c, M, SHIFT) for c in coeffs]
    if 'lde' in hooks:
        lde = hooks['lde'](lde)
    trace_salts = [secrets.token_bytes(16) for _ in range(M)]
    trace_tree = MerkleTree([leaf_hash(i, _row_bytes([lde[c][i] for c in range(WIDTH)]) + trace_salts[i]) for i in range(M)])

    t = Transcript(statement_bytes(public))
    t.absorb(b'trace', trace_tree.root)
    alphas = [t.draw_k() for _ in CONSTRAINTS]

    # 2. Composition polynomial on L.
    xs = [0] * M
    x = SHIFT
    for i in range(M):
        xs[i] = x
        x = x * OMEGA_M % P
    period = M // ACTIVE
    zh_period = batch_inv([(pow(xs[i], ACTIVE, P) - 1) % P for i in range(period)])
    inv_xm1 = batch_inv([(v - 1) % P for v in xs])
    inv_xml = batch_inv([(v - LAST) % P for v in xs])
    weights = coset_evaluate(WEIGHT_POLY, M, SHIFT)
    comp_re = [0] * M
    comp_im = [0] * M
    for i in range(M):
        j = (i + NEXT) % M
        q = _quotients(
            _FpOps, public,
            [lde[c][i] for c in range(WIDTH)], [lde[c][j] for c in range(WIDTH)],
            weights[i], weights[j], (xs[i] - LAST) % P, zh_period[i % period], inv_xm1[i], inv_xml[i],
        )
        re = im = 0
        for a, v in zip(alphas, q):
            re += a[0] * v
            im += a[1] * v
        comp_re[i] = re % P
        comp_im[i] = im % P
    c_re = coset_interpolate(comp_re, SHIFT)
    c_im = coset_interpolate(comp_im, SHIFT)
    if honest and (any(c_re[2 * N:]) or any(c_im[2 * N:])):
        raise HedgeProofError('composition is not a polynomial of the expected degree: the trace breaks a constraint')

    # 3. Three chunks of degree < CHUNK, each blinded so that an opened
    #    chunk value says nothing: h0 + x^CHUNK r0, h1 - r0 + x^CHUNK r1, h2 - r1.
    def base(j: int) -> List[K]:
        return [(c_re[i], c_im[i]) for i in range(j * CHUNK, (j + 1) * CHUNK)]
    r0 = [(secrets.randbelow(P), secrets.randbelow(P)) for _ in range(MASK)]
    r1 = [(secrets.randbelow(P), secrets.randbelow(P)) for _ in range(MASK)]
    h0, h1, h2 = base(0), base(1), base(2)
    chunk_coeffs = [
        h0 + r0,
        [k_sub(h1[i], r0[i]) if i < MASK else h1[i] for i in range(CHUNK)] + r1,
        [k_sub(h2[i], r1[i]) if i < MASK else h2[i] for i in range(CHUNK)],
    ]
    mask_coeffs = [(secrets.randbelow(P), secrets.randbelow(P)) for _ in range(N)]

    def k_lde(poly: List[K]) -> List[K]:
        re = coset_evaluate([c[0] for c in poly], M, SHIFT)
        im = coset_evaluate([c[1] for c in poly], M, SHIFT)
        return list(zip(re, im))
    chunk_lde = [k_lde(p) for p in chunk_coeffs]
    mask_lde = k_lde(mask_coeffs)
    quotient_salts = [secrets.token_bytes(16) for _ in range(M)]
    quotient_tree = MerkleTree([
        leaf_hash(i, _k_list_bytes([chunk_lde[j][i] for j in range(NUM_CHUNKS)] + [mask_lde[i]]) + quotient_salts[i])
        for i in range(M)
    ])
    t.absorb(b'quotient', quotient_tree.root)

    # 4. Out-of-domain evaluations.
    z = _draw_ood_point(t)
    zn = k_scale(z, OMEGA_A)
    trace_z = [fp_poly_at_k(c, z) for c in coeffs]
    trace_zn = [fp_poly_at_k(c, zn) for c in coeffs]
    chunks_z = [k_poly_at_k(p, z) for p in chunk_coeffs]
    if 'ood' in hooks:
        trace_z, trace_zn, chunks_z = hooks['ood']({
            'z': z, 'zn': zn, 'alphas': alphas, 'public': public,
            'trace_z': trace_z, 'trace_zn': trace_zn, 'chunks_z': chunks_z,
        })
    t.absorb(b'ood', _k_list_bytes(trace_z + trace_zn + chunks_z))

    # 5. DEEP combination, then FRI.
    g1 = [t.draw_k() for _ in range(WIDTH)]
    g2 = [t.draw_k() for _ in range(WIDTH)]
    g3 = [t.draw_k() for _ in range(NUM_CHUNKS)]
    layer = [
        _deep_value(xs[i], [lde[c][i] for c in range(WIDTH)], [chunk_lde[j][i] for j in range(NUM_CHUNKS)], mask_lde[i],
                    z, zn, trace_z, trace_zn, chunks_z, g1, g2, g3)
        for i in range(M)
    ]
    beta = t.draw_k()
    fri_layers: List[List[K]] = []
    fri_trees: List[MerkleTree] = []
    for k in range(FRI_LAYERS):
        layer = fold_layer(layer, beta, _layer_shift(k))
        if k + 1 < FRI_LAYERS:
            if 'fri_layer' in hooks:
                layer = hooks['fri_layer'](k + 1, layer)
            tree = MerkleTree([leaf_hash(i, k_bytes(v)) for i, v in enumerate(layer)])
            fri_layers.append(layer)
            fri_trees.append(tree)
            t.absorb(b'fri', tree.root)
            beta = t.draw_k()
    final_shift = _layer_shift(FRI_LAYERS)
    if 'final' in hooks:
        final = hooks['final'](layer, final_shift)
    else:
        final_re = coset_interpolate([v[0] for v in layer], final_shift)
        final_im = coset_interpolate([v[1] for v in layer], final_shift)
        if honest and (any(final_re[FINAL_DEGREE:]) or any(final_im[FINAL_DEGREE:])):
            raise HedgeProofError('FRI did not reach a low-degree final polynomial')
        final = list(zip(final_re[:FINAL_DEGREE], final_im[:FINAL_DEGREE]))
    t.absorb(b'final', _k_list_bytes(final))

    return {
        'transcript': t, 'public': public, 'lde': lde, 'trace_salts': trace_salts, 'trace_tree': trace_tree,
        'chunk_lde': chunk_lde, 'mask_lde': mask_lde, 'quotient_salts': quotient_salts, 'quotient_tree': quotient_tree,
        'trace_z': trace_z, 'trace_zn': trace_zn, 'chunks_z': chunks_z,
        'fri_layers': fri_layers, 'fri_trees': fri_trees, 'final': final,
        'opening': {
            'protocol': f'{AIR_ID}-v{AIR_VERSION}',
            'commitment': trace_tree.root.hex(),
            'columns': [_row_bytes(c).hex() for c in coeffs],
            'salts': b''.join(trace_salts).hex(),
        },
    }


def _query_phase(state: Dict[str, Any], nonce: int) -> Dict[str, Any]:
    """Draw the query positions from the transcript (after the grinding nonce) and open them."""
    t = state['transcript']
    lde, chunk_lde, mask_lde = state['lde'], state['chunk_lde'], state['mask_lde']
    trace_tree, quotient_tree = state['trace_tree'], state['quotient_tree']
    positions = [t.draw_index(M // 2) for _ in range(NUM_QUERIES)]
    queries = []
    for p in positions:
        pair = (p, p + M // 2)
        fri_open = []
        idx = p
        for k in range(1, FRI_LAYERS):
            size = M >> k
            lo = idx % (size // 2)
            tree, values = state['fri_trees'][k - 1], state['fri_layers'][k - 1]
            fri_open.append([
                {'value': k_bytes(values[i]).hex(), 'path': [h.hex() for h in tree.open(i)]}
                for i in (lo, lo + size // 2)
            ])
            idx = lo
        queries.append({
            'trace': [
                {'row': _row_bytes([lde[c][i] for c in range(WIDTH)]).hex(), 'salt': state['trace_salts'][i].hex(),
                 'path': [h.hex() for h in trace_tree.open(i)]}
                for i in pair
            ],
            'quotient': [
                {'values': _k_list_bytes([chunk_lde[j][i] for j in range(NUM_CHUNKS)] + [mask_lde[i]]).hex(),
                 'salt': state['quotient_salts'][i].hex(), 'path': [h.hex() for h in quotient_tree.open(i)]}
                for i in pair
            ],
            'fri': fri_open,
        })
    return {
        'protocol': f'{AIR_ID}-v{AIR_VERSION}',
        'public': state['public'],
        'commitment': trace_tree.root.hex(),
        'quotient_root': quotient_tree.root.hex(),
        'ood': {
            'trace_z': _k_list_bytes(state['trace_z']).hex(),
            'trace_zn': _k_list_bytes(state['trace_zn']).hex(),
            'chunks_z': _k_list_bytes(state['chunks_z']).hex(),
        },
        'fri_roots': [tree.root.hex() for tree in state['fri_trees']],
        'final': _k_list_bytes(state['final']).hex(),
        'nonce': nonce,
        'queries': queries,
    }


# ── Verifier ─────────────────────────────────────────────────────────

def verify(proof: Dict[str, Any], public: Dict[str, Any], commitment: Optional[str] = None) -> bool:
    """
    True only when `proof` proves the hedge policy under `public` for its
    commitment (and for `commitment`, when the caller names the one it
    expects). The caps come from the caller, never from the proof.
    """
    try:
        return _verify(proof, normalize_public(public), commitment)
    except (KeyError, ValueError, TypeError, IndexError, AttributeError, ZeroDivisionError, OverflowError):
        return False


def _verify(proof: Dict[str, Any], public: Dict[str, int], commitment: Optional[str]) -> bool:
    if proof.get('protocol') != f'{AIR_ID}-v{AIR_VERSION}':
        return False
    trace_root = bytes.fromhex(proof['commitment'])
    if len(trace_root) != 32 or (commitment is not None and commitment.lower() != proof['commitment'].lower()):
        return False
    quotient_root = bytes.fromhex(proof['quotient_root'])
    fri_roots = [bytes.fromhex(r) for r in proof['fri_roots']]
    if len(quotient_root) != 32 or len(fri_roots) != FRI_LAYERS - 1 or any(len(r) != 32 for r in fri_roots):
        return False
    trace_z = _k_from_bytes(bytes.fromhex(proof['ood']['trace_z']))
    trace_zn = _k_from_bytes(bytes.fromhex(proof['ood']['trace_zn']))
    chunks_z = _k_from_bytes(bytes.fromhex(proof['ood']['chunks_z']))
    final = _k_from_bytes(bytes.fromhex(proof['final']))
    queries = proof['queries']
    nonce = proof['nonce']
    # Exact shapes: a shorter list would be a weaker proof, a longer final a higher degree.
    if len(trace_z) != WIDTH or len(trace_zn) != WIDTH or len(chunks_z) != NUM_CHUNKS:
        return False
    if len(final) != FINAL_DEGREE or len(queries) != NUM_QUERIES:
        return False
    if not isinstance(nonce, int) or isinstance(nonce, bool) or not 0 <= nonce < (1 << 64):
        return False

    # The same transcript the prover ran, over the same messages.
    t = Transcript(statement_bytes(public))
    t.absorb(b'trace', trace_root)
    alphas = [t.draw_k() for _ in CONSTRAINTS]
    t.absorb(b'quotient', quotient_root)
    z = _draw_ood_point(t)
    zn = k_scale(z, OMEGA_A)
    t.absorb(b'ood', _k_list_bytes(trace_z + trace_zn + chunks_z))

    # The constraint identity at z: composition(z) = sum alpha_k * quotient_k(z).
    expected = K_ZERO
    for a, q in zip(alphas, _constraints_at_k(public, z, trace_z, trace_zn)):
        expected = k_add(expected, k_mul(a, q))
    if _composition_at_z(z, chunks_z) != expected:
        return False

    g1 = [t.draw_k() for _ in range(WIDTH)]
    g2 = [t.draw_k() for _ in range(WIDTH)]
    g3 = [t.draw_k() for _ in range(NUM_CHUNKS)]
    betas = [t.draw_k()]
    for root in fri_roots:
        t.absorb(b'fri', root)
        betas.append(t.draw_k())
    t.absorb(b'final', _k_list_bytes(final))
    if not t.check_grind(nonce, GRINDING_BITS):
        return False
    positions = [t.draw_index(M // 2) for _ in range(NUM_QUERIES)]

    for p, query in zip(positions, queries):
        pair = (p, p + M // 2)
        if len(query['trace']) != 2 or len(query['quotient']) != 2 or len(query['fri']) != FRI_LAYERS - 1:
            return False
        values: List[K] = []
        for i, t_open, q_open in zip(pair, query['trace'], query['quotient']):
            row_bytes = bytes.fromhex(t_open['row'])
            salt = bytes.fromhex(t_open['salt'])
            if len(row_bytes) != 8 * WIDTH or len(salt) != 16:
                return False
            if not merkle_verify(trace_root, i, leaf_hash(i, row_bytes + salt), [bytes.fromhex(h) for h in t_open['path']], LOG_M):
                return False
            q_bytes = bytes.fromhex(q_open['values'])
            q_salt = bytes.fromhex(q_open['salt'])
            if len(q_bytes) != 16 * (NUM_CHUNKS + 1) or len(q_salt) != 16:
                return False
            if not merkle_verify(quotient_root, i, leaf_hash(i, q_bytes + q_salt), [bytes.fromhex(h) for h in q_open['path']], LOG_M):
                return False
            row = _fp_from_bytes(row_bytes)
            opened = _k_from_bytes(q_bytes)
            x = SHIFT * pow(OMEGA_M, i, P) % P
            values.append(_deep_value(x, row, opened[:NUM_CHUNKS], opened[NUM_CHUNKS], z, zn, trace_z, trace_zn, chunks_z, g1, g2, g3))

        # Layer 0 is not committed: the verifier computed it from the trace itself.
        idx = p
        folded = fold_pair(values[0], values[1], betas[0], SHIFT * pow(OMEGA_M, p, P) % P)
        for k in range(1, FRI_LAYERS):
            size = M >> k
            depth = LOG_M - k
            lo = idx % (size // 2)
            opened_pair = query['fri'][k - 1]
            if len(opened_pair) != 2:
                return False
            pair_values: List[K] = []
            for i, o in zip((lo, lo + size // 2), opened_pair):
                v_bytes = bytes.fromhex(o['value'])
                if len(v_bytes) != 16:
                    return False
                if not merkle_verify(fri_roots[k - 1], i, leaf_hash(i, v_bytes), [bytes.fromhex(h) for h in o['path']], depth):
                    return False
                pair_values.append(_k_from_bytes(v_bytes)[0])
            # The value folded from the layer above must be the one committed here.
            if pair_values[0 if idx == lo else 1] != folded:
                return False
            x = _layer_shift(k) * pow(root_of_unity(size), lo, P) % P
            folded = fold_pair(pair_values[0], pair_values[1], betas[k], x)
            idx = lo
        # The last fold must land on the final polynomial, whose degree is fixed by its length.
        x_final = _layer_shift(FRI_LAYERS) * pow(root_of_unity(M >> FRI_LAYERS), idx, P) % P
        if k_poly_at_fp(final, x_final) != folded:
            return False
    return True


# ── Audit: read a hedge back out of its commitment ───────────────────

def audit_opening(opening: Dict[str, Any], commitment: str) -> Optional[Dict[str, int]]:
    """
    Recompute the commitment from an opening and return the hedge it commits
    to, or None when the opening is not for this commitment. This is how a
    committed hedge is compared with the order that was actually sent.
    """
    try:
        coeffs = [_fp_from_bytes(bytes.fromhex(c)) for c in opening['columns']]
        salts = bytes.fromhex(opening['salts'])
        if len(coeffs) != WIDTH or any(len(c) != N for c in coeffs) or len(salts) != 16 * M:
            return None
        lde = [coset_evaluate(c, M, SHIFT) for c in coeffs]
        root = MerkleTree([
            leaf_hash(i, _row_bytes([lde[c][i] for c in range(WIDTH)]) + salts[16 * i:16 * i + 16]) for i in range(M)
        ]).root
        if root.hex() != commitment.lower():
            return None
        trace = [ntt(c, OMEGA_N) for c in coeffs]
        last = (ACTIVE - 1) * STEP
        out = {q: LOWER[q] + trace[col(k, AU)][last] for k, q in enumerate(QUANTITIES)}
        for j, name in enumerate(PAYLOAD_FIELDS):
            out[name] = trace[PAYLOAD][j * STEP]
        return out
    except (KeyError, ValueError, TypeError):
        return None


def proof_size_bytes(proof: Dict[str, Any]) -> int:
    return len(json.dumps(proof, separators=(',', ':')))


def proof_digest(proof: Dict[str, Any]) -> str:
    """A stable identifier for a proof, for storing next to a hedge."""
    return hashlib.sha256(json.dumps(proof, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
