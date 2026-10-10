"""
Evidence that the hedge policy STARK does what the theory says, beyond
"a tampered proof fails".

  1. The parameters are the standard ones (checked against published constants).
  2. Completeness and soundness on random inputs.
  3. A malicious prover attacking each step of the protocol in turn: lying
     about the out-of-domain values so the constraint identity holds, opening
     one trace while claiming another, committing a trace that is not low
     degree, committing a FRI layer that is not the fold of the one above.
  4. THE MEASUREMENT: with the verifier cut down to ONE query and no
     grinding, the best attack on FRI's query phase succeeds at the rate the
     theory predicts (the code rate, 1/16), not more. Forty queries then give
     (1/16)^40 = 2^-160 against this attack, before grinding.
  5. Hiding, by linear algebra: every trace value the verifier's view depends
     on is an independent functional of the random rows, so those values are
     exactly uniform whatever the witness is.

Run:  python -m pytest zkp/tests/test_hedge_stark_soundness.py -q
"""
import os
import random
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from zkp.core import hedge_stark as hs  # noqa: E402
from zkp.core import stark_core as sc  # noqa: E402

P = sc.P
HEDGE = {
    'asset': 'BTC', 'side': 'LONG', 'leverageX': 3, 'notionalValueUsdcCents': 4_100_000,
    'sizeUnits': 500, 'entryPriceUsdcCents': 8_200_000, 'portfolioId': 2, 'timestampMs': 1_791_500_000_000,
}
ILLEGAL = {**HEDGE, 'leverageX': 1000}
PUBLIC = {'leverage_cap': 4, 'notional_cap_cents': 100_000_000}
NORMAL = hs.normalize_public(PUBLIC)


# ── helpers a malicious prover needs ─────────────────────────────────

def solve_first_chunk(ctx, trace_z=None, trace_zn=None):
    """
    Out-of-domain values for which the verifier's constraint identity HOLDS,
    whatever the committed trace is: keep the claimed trace values, then
    choose the first chunk's value so the two sides are equal.
    """
    trace_z = trace_z or ctx['trace_z']
    trace_zn = trace_zn or ctx['trace_zn']
    z, chunks = ctx['z'], list(ctx['chunks_z'])
    target = sc.K_ZERO
    for a, q in zip(ctx['alphas'], hs._constraints_at_k(ctx['public'], z, trace_z, trace_zn)):
        target = sc.k_add(target, sc.k_mul(a, q))
    step = sc.k_pow(z, hs.CHUNK)
    rest, power = sc.K_ZERO, step
    for j in range(1, hs.NUM_CHUNKS):
        rest = sc.k_add(rest, sc.k_mul(power, chunks[j]))
        power = sc.k_mul(power, step)
    chunks[0] = sc.k_sub(target, rest)
    return trace_z, trace_zn, chunks


def identity_holds(proof, public=NORMAL) -> bool:
    """The verifier's out-of-domain check alone, so a test can show an attack got past it."""
    t = sc.Transcript(hs.statement_bytes(public))
    t.absorb(b'trace', bytes.fromhex(proof['commitment']))
    alphas = [t.draw_k() for _ in hs.CONSTRAINTS]
    t.absorb(b'quotient', bytes.fromhex(proof['quotient_root']))
    z = hs._draw_ood_point(t)
    tz = hs._k_from_bytes(bytes.fromhex(proof['ood']['trace_z']))
    tzn = hs._k_from_bytes(bytes.fromhex(proof['ood']['trace_zn']))
    cz = hs._k_from_bytes(bytes.fromhex(proof['ood']['chunks_z']))
    expected = sc.K_ZERO
    for a, q in zip(alphas, hs._constraints_at_k(public, z, tz, tzn)):
        expected = sc.k_add(expected, sc.k_mul(a, q))
    return hs._composition_at_z(z, cz) == expected


def interpolate_k(points, values):
    """Coefficients of the polynomial through (points[i], values[i]); points in Fp, values in K."""
    n = len(points)
    coeffs = [sc.K_ZERO] * n
    for i in range(n):
        basis = [1]
        denom = 1
        for j in range(n):
            if i == j:
                continue
            denom = denom * (points[i] - points[j]) % P
            nxt = [0] * (len(basis) + 1)
            for d, c in enumerate(basis):
                nxt[d] = (nxt[d] - c * points[j]) % P
                nxt[d + 1] = (nxt[d + 1] + c) % P
            basis = nxt
        scale = sc.inv(denom)
        for d, c in enumerate(basis):
            coeffs[d] = sc.k_add(coeffs[d], sc.k_scale(values[i], c * scale % P))
    return coeffs


# ── 1. standard parameters ───────────────────────────────────────────

class TestParameters:
    def test_goldilocks_and_its_published_constants(self):
        assert P == 2**64 - 2**32 + 1
        # 7 generates the multiplicative group: 7^((p-1)/q) != 1 for every prime q dividing p - 1.
        for q in (2, 3, 5, 17, 257, 65537):
            assert (P - 1) % q == 0 and pow(7, (P - 1) // q, P) != 1
        # The 2^32-th root of unity that 7 gives is the constant published for this field.
        assert sc.root_of_unity(1 << 32) == 1753635133440165772
        assert pow(sc.root_of_unity(1 << 32), 1 << 31, P) == P - 1

    def test_the_extension_is_a_field_of_about_2_128_elements(self):
        # x^2 - 7 has no root in Fp, so Fp[u]/(u^2 - 7) is a field with p^2 elements.
        assert pow(7, (P - 1) // 2, P) == P - 1
        assert (P * P).bit_length() == 128
        rng = random.Random(1)
        for _ in range(200):
            a = (rng.randrange(P), rng.randrange(P))
            b = (rng.randrange(P), rng.randrange(P))
            c = (rng.randrange(P), rng.randrange(P))
            assert sc.k_mul(a, sc.k_add(b, c)) == sc.k_add(sc.k_mul(a, b), sc.k_mul(a, c))
            assert sc.k_mul(sc.k_mul(a, b), c) == sc.k_mul(a, sc.k_mul(b, c))
            if a != sc.K_ZERO:
                assert sc.k_mul(a, sc.k_inv(a)) == sc.K_ONE
        # Frobenius: a^p is the conjugate, so a^(p^2) = a.
        a = (123, 456)
        assert sc.k_pow(a, P) == (123, P - 456)

    def test_the_domains_are_what_the_protocol_assumes(self):
        h = {pow(hs.OMEGA_N, i, P) for i in range(hs.N)}
        active = {pow(hs.OMEGA_A, j, P) for j in range(hs.ACTIVE)}
        assert len(h) == hs.N and len(active) == hs.ACTIVE and active <= h
        assert pow(hs.OMEGA_M, hs.M, P) == 1 and pow(hs.OMEGA_M, hs.M // 2, P) == P - 1
        # The commitment domain is a coset that never meets the trace domain.
        assert pow(hs.SHIFT, hs.M, P) != 1
        # The weight polynomial is 2^j on the active rows and 0 on the last two.
        for j in (0, 1, 5, 61, 62, 63):
            at = sum(c * pow(pow(hs.OMEGA_A, j, P), i, P) for i, c in enumerate(hs.WEIGHT_POLY)) % P
            assert at == ((1 << j) if j < 62 else 0)

    def test_the_rate_and_the_stated_security(self):
        # FRI proves degree < N on a domain of 16 N: rate 1/16 at every layer.
        assert hs.M // hs.N == 16 and (hs.M >> hs.FRI_LAYERS) // hs.FINAL_DEGREE == 16
        bits_per_query = 4                       # log2(1/rate): the best known attack
        assert hs.NUM_QUERIES * bits_per_query + hs.GRINDING_BITS == 180
        assert hs.NUM_QUERIES * bits_per_query // 2 + hs.GRINDING_BITS == 100   # the proven (Johnson-radius) figure


# ── 2. random inputs ─────────────────────────────────────────────────

class TestRandomInputs:
    def test_random_valid_hedges_all_verify(self):
        rng = random.Random(20261010)
        for _ in range(6):
            lev_cap = rng.randrange(1, 60)
            cap = rng.randrange(1, 1 << 50)
            public = {'leverage_cap': lev_cap, 'notional_cap_cents': cap}
            w = {
                'asset': rng.choice(['BTC', 'ETH', 'SUI']), 'side': rng.choice(['LONG', 'SHORT']),
                'leverageX': rng.randrange(1, lev_cap + 1), 'notionalValueUsdcCents': rng.randrange(0, cap + 1),
                'sizeUnits': rng.randrange(1 << 40), 'entryPriceUsdcCents': rng.randrange(1 << 40),
                'portfolioId': rng.randrange(1 << 20), 'timestampMs': rng.randrange(1 << 41),
            }
            proof, opening = hs.prove(w, public)
            assert hs.verify(proof, public)
            got = hs.audit_opening(opening, proof['commitment'])
            assert got['leverage'] == w['leverageX'] and got['notional'] == w['notionalValueUsdcCents']

    def test_random_invalid_hedges_from_a_dishonest_prover_are_all_rejected(self):
        rng = random.Random(7)
        for _ in range(6):
            which = rng.randrange(4)
            w = dict(HEDGE)
            if which == 0:
                w['leverageX'] = rng.randrange(5, 1 << 40)
            elif which == 1:
                w['notionalValueUsdcCents'] = rng.randrange(100_000_001, 1 << 60)
            elif which == 2:
                w['asset'] = rng.randrange(4, 1 << 30)
            else:
                w['side'] = rng.randrange(2, 1 << 30)
            proof, _ = hs.prove(w, PUBLIC, skip_checks_for_tests=True)
            assert not hs.verify(proof, PUBLIC), w


# ── 3. one attack per step of the protocol ───────────────────────────

class TestStepAttacks:
    def test_lying_about_the_out_of_domain_values_gets_past_the_identity_and_is_caught_by_fri(self):
        proof, _ = hs.prove(ILLEGAL, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={'ood': solve_first_chunk})
        assert identity_holds(proof)             # the attack really did defeat the first check
        assert not hs.verify(proof, PUBLIC)      # the low-degree test of the DEEP quotients catches it

    def test_without_that_lie_the_identity_itself_fails(self):
        proof, _ = hs.prove(ILLEGAL, PUBLIC, skip_checks_for_tests=True)
        assert not identity_holds(proof)

    def test_committing_one_trace_and_claiming_the_values_of_another(self):
        # Commit to the illegal hedge, but answer the out-of-domain questions with a LEGAL trace's values.
        legal_cols = hs.build_trace(HEDGE, NORMAL)
        legal = [sc.intt(c, hs.OMEGA_N) for c in legal_cols]

        def swap(ctx):
            tz = [sc.fp_poly_at_k(c, ctx['z']) for c in legal]
            tzn = [sc.fp_poly_at_k(c, ctx['zn']) for c in legal]
            return solve_first_chunk(ctx, tz, tzn)
        proof, _ = hs.prove(ILLEGAL, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={'ood': swap})
        assert identity_holds(proof)
        assert not hs.verify(proof, PUBLIC)

    def test_a_committed_trace_that_is_not_low_degree(self):
        rng = random.Random(3)

        def garbage(lde):
            out = [list(c) for c in lde]
            out[hs.col(0, hs.AU)] = [rng.randrange(P) for _ in range(hs.M)]
            return out
        proof, _ = hs.prove(HEDGE, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={'lde': garbage, 'ood': solve_first_chunk})
        assert identity_holds(proof)
        assert not hs.verify(proof, PUBLIC)

    def test_a_trace_changed_at_a_few_points_only(self):
        # Close to a valid codeword, but not one: 5% of one column's positions overwritten.
        rng = random.Random(4)

        def nudge(lde):
            out = [list(c) for c in lde]
            for i in rng.sample(range(hs.M), hs.M // 20):
                out[hs.col(1, hs.BU)][i] = rng.randrange(P)
            return out
        proof, _ = hs.prove(HEDGE, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={'lde': nudge, 'ood': solve_first_chunk})
        assert not hs.verify(proof, PUBLIC)

    def test_a_fri_layer_that_is_not_the_fold_of_the_one_above(self):
        rng = random.Random(5)
        for target in (1, 3, 5):
            def fake(k, layer, target=target):
                return [(rng.randrange(P), rng.randrange(P)) for _ in layer] if k == target else layer
            proof, _ = hs.prove(HEDGE, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={'fri_layer': fake})
            assert not hs.verify(proof, PUBLIC), target

    def test_a_final_polynomial_chosen_by_the_prover(self):
        rng = random.Random(6)
        free = lambda layer, shift: [(rng.randrange(P), rng.randrange(P)) for _ in range(hs.FINAL_DEGREE)]  # noqa: E731
        proof, _ = hs.prove(HEDGE, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={'final': free})
        assert not hs.verify(proof, PUBLIC)


# ── 4. the measured error of the query phase ─────────────────────────

class TestMeasuredSoundness:
    """
    The strongest attack on FRI's query phase: get past every earlier check,
    then send a final polynomial that agrees with the true last layer on as
    many points as a polynomial of that degree can (8 of 128). A query then
    passes exactly when it lands on one of those points: probability 8/128,
    the code rate. If the verifier were weaker than the theory says, this
    attack would succeed more often than that.
    """

    def _forged_state(self):
        agree = list(range(0, 128, 16))          # 8 positions of the last layer

        def best_final(layer, shift):
            w = sc.root_of_unity(len(layer))
            return interpolate_k([shift * pow(w, i, P) % P for i in agree], [layer[i] for i in agree])
        state = hs._commit_phase(ILLEGAL, NORMAL, False, {'ood': solve_first_chunk, 'final': best_final})
        return state, set(agree)

    def _acceptance(self, state, trials):
        t = state['transcript']
        saved = t.state
        accepted = 0
        for nonce in range(trials):
            t.state = saved
            t.absorb(b'pow', nonce.to_bytes(8, 'little'))
            if hs.verify(hs._query_phase(state, nonce), PUBLIC):
                accepted += 1
        return accepted / trials

    def test_one_query_is_fooled_at_the_code_rate_and_no_more(self, monkeypatch):
        monkeypatch.setattr(hs, 'NUM_QUERIES', 1)
        monkeypatch.setattr(hs, 'GRINDING_BITS', 0)
        state, _ = self._forged_state()
        rate = self._acceptance(state, 4000)
        # Theory: 8/128 = 0.0625. 4000 trials put the estimate within about +-0.012 (three standard errors).
        assert 0.0625 - 0.013 < rate < 0.0625 + 0.013, rate

    def test_two_queries_square_it(self, monkeypatch):
        monkeypatch.setattr(hs, 'NUM_QUERIES', 2)
        monkeypatch.setattr(hs, 'GRINDING_BITS', 0)
        state, _ = self._forged_state()
        rate = self._acceptance(state, 6000)
        # Theory: (1/16)^2 = 0.0039. Anything near the one-query rate would mean the queries are not independent.
        assert rate < 0.0095, rate

    def test_the_real_parameters_reject_the_same_forgery_every_time(self):
        state, _ = self._forged_state()
        t = state['transcript']
        nonce = t.grind(hs.GRINDING_BITS)
        assert not hs.verify(hs._query_phase(state, nonce), PUBLIC)

    def test_an_honest_proof_passes_under_the_reduced_parameters_too(self, monkeypatch):
        # The control: the low acceptance above is the attack failing, not the reduced verifier rejecting everything.
        monkeypatch.setattr(hs, 'NUM_QUERIES', 1)
        monkeypatch.setattr(hs, 'GRINDING_BITS', 0)
        state = hs._commit_phase(HEDGE, NORMAL, True, {})
        t = state['transcript']
        saved = t.state
        for nonce in range(300):
            t.state = saved
            t.absorb(b'pow', nonce.to_bytes(8, 'little'))
            assert hs.verify(hs._query_phase(state, nonce), PUBLIC)


# ── 5. hiding, by linear algebra ─────────────────────────────────────

def _rank(rows):
    """Rank of a matrix over Fp (Gaussian elimination)."""
    rows = [list(r) for r in rows]
    rank, ncols = 0, len(rows[0])
    for c in range(ncols):
        pivot = next((r for r in range(rank, len(rows)) if rows[r][c]), None)
        if pivot is None:
            continue
        rows[rank], rows[pivot] = rows[pivot], rows[rank]
        inv_p = sc.inv(rows[rank][c])
        rows[rank] = [v * inv_p % P for v in rows[rank]]
        for r in range(len(rows)):
            if r != rank and rows[r][c]:
                f = rows[r][c]
                rows[r] = [(a - f * b) % P for a, b in zip(rows[r], rows[rank])]
        rank += 1
        if rank == len(rows):
            break
    return rank


class TestHidingByLinearAlgebra:
    def test_what_the_verifier_sees_of_a_column_is_independent_of_the_witness(self):
        """
        A trace column is a polynomial of degree < 512 fixed on the 64 active
        rows and uniformly random on the other 448. Everything the verifier's
        view depends on, for one column, is a list of linear functionals of
        it: its values at the opened points, at their w'-shifts (through the
        composition), and at the two out-of-domain points (two field elements
        each). If those functionals are linearly independent as functions of
        the 448 random rows, their values are exactly uniform, whatever the
        active rows hold. This computes that rank for a real proof.
        """
        proof, _ = hs.prove(HEDGE, PUBLIC)
        # Re-run the verifier's transcript to learn z and the query positions.
        t = sc.Transcript(hs.statement_bytes(NORMAL))
        t.absorb(b'trace', bytes.fromhex(proof['commitment']))
        for _ in hs.CONSTRAINTS:
            t.draw_k()
        t.absorb(b'quotient', bytes.fromhex(proof['quotient_root']))
        z = hs._draw_ood_point(t)
        t.absorb(b'ood', bytes.fromhex(proof['ood']['trace_z'] + proof['ood']['trace_zn'] + proof['ood']['chunks_z']))
        for _ in range(2 * hs.WIDTH + hs.NUM_CHUNKS + 1):
            t.draw_k()
        for root in proof['fri_roots']:
            t.absorb(b'fri', bytes.fromhex(root))
            t.draw_k()
        t.absorb(b'final', bytes.fromhex(proof['final']))
        assert t.check_grind(proof['nonce'], hs.GRINDING_BITS)
        positions = [t.draw_index(hs.M // 2) for _ in range(hs.NUM_QUERIES)]

        indices = set()
        for p in positions:
            for i in (p, p + hs.M // 2):
                indices.add(i)
                indices.add((i + hs.NEXT) % hs.M)
        points = [hs.SHIFT * pow(hs.OMEGA_M, i, P) % P for i in sorted(indices)]
        free_rows = [r for r in range(hs.N) if r % hs.STEP]
        assert len(free_rows) == hs.N - hs.ACTIVE == 448
        roots = [pow(hs.OMEGA_N, r, P) for r in free_rows]
        n_inv = sc.inv(hs.N)

        # Lagrange basis of row r at a point x: w^r (x^N - 1) / (N (x - w^r)).
        matrix = []
        for x in points:
            zh = (pow(x, hs.N, P) - 1) * n_inv % P
            matrix.append([w * zh % P * sc.inv(x - w) % P for w in roots])
        for point in (z, sc.k_scale(z, hs.OMEGA_A)):
            zh = sc.k_scale(sc.k_sub(sc.k_pow(point, hs.N), sc.K_ONE), n_inv)
            vals = [sc.k_scale(sc.k_mul(zh, sc.k_inv(sc.k_sub(point, (w, 0)))), w) for w in roots]
            matrix.append([v[0] for v in vals])
            matrix.append([v[1] for v in vals])

        assert len(matrix) <= 4 * hs.NUM_QUERIES + 4 <= len(free_rows)
        assert _rank(matrix) == len(matrix)
