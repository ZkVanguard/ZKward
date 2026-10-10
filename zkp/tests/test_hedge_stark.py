"""
The hedge policy STARK: does the verifier refuse what it must refuse?

An honest proof verifying says little. These tests are mostly the other
direction: a prover that lies about the witness, a prover that skips its own
checks, a proof that was edited after the fact, a proof that was made for a
different statement. Each must be rejected by the unmodified verifier.

Run:  python -m pytest zkp/tests/test_hedge_stark.py -q
"""
import copy
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from zkp.core import bounds_stark as bs  # noqa: E402
from zkp.core import hedge_stark as hs  # noqa: E402
from zkp.core import stark_core as sc  # noqa: E402

HEDGE = {
    'asset': 'BTC', 'side': 'LONG', 'leverageX': 3, 'notionalValueUsdcCents': 4_100_000,
    'sizeMilli': 500, 'entryPriceCents': 8_200_000, 'portfolioId': 2, 'timestampMs': 1_791_500_000_000,
}
PUBLIC = {'leverage_cap': 4, 'notional_cap_cents': 100_000_000}


@pytest.fixture(scope='module')
def honest():
    proof, opening = hs.prove(HEDGE, PUBLIC)
    return proof, opening


def tampered(proof, edit):
    p = copy.deepcopy(proof)
    edit(p)
    return p


def flip_hex(s: str, at: int = 0) -> str:
    """The same hex string with one nibble changed."""
    return s[:at] + ('0' if s[at] != '0' else '1') + s[at + 1:]


# ── the building blocks ──────────────────────────────────────────────

class TestCore:
    def test_extension_field_is_a_field(self):
        a, b = (123456789, 987654321), (sc.P - 5, 42)
        assert sc.k_mul(a, sc.k_inv(a)) == sc.K_ONE
        assert sc.k_mul(sc.k_mul(a, b), sc.k_inv(b)) == a
        # u^2 = 7
        assert sc.k_mul((0, 1), (0, 1)) == (7, 0)

    def test_ntt_round_trip_and_coset(self):
        coeffs = [(i * 7919 + 13) % sc.P for i in range(64)]
        w = sc.root_of_unity(64)
        assert sc.intt(sc.ntt(coeffs, w), w) == coeffs
        values = sc.coset_evaluate(coeffs, 256, sc.GENERATOR)
        assert sc.coset_interpolate(values, sc.GENERATOR)[:64] == coeffs
        assert not any(sc.coset_interpolate(values, sc.GENERATOR)[64:])

    def test_merkle_opening_is_bound_to_its_position(self):
        leaves = [sc.leaf_hash(i, bytes([i])) for i in range(8)]
        tree = sc.MerkleTree(leaves)
        path = tree.open(5)
        assert sc.merkle_verify(tree.root, 5, leaves[5], path, 3)
        assert not sc.merkle_verify(tree.root, 4, leaves[5], path, 3)      # same leaf, another index
        assert not sc.merkle_verify(tree.root, 5, leaves[5], path[:2], 3)  # a shorter path
        assert not sc.merkle_verify(tree.root, 5, sc.leaf_hash(4, bytes([5])), path, 3)

    def test_fold_matches_the_polynomial_identity(self):
        # f(x) = e(x^2) + x o(x^2)  =>  fold gives e(y) + beta o(y) at y = x^2
        even, odd = [3, 5, 7, 11], [2, 4, 6, 8]
        f = [0] * 8
        f[0::2], f[1::2] = even, odd
        beta = (17, 23)
        x = sc.GENERATOR * sc.root_of_unity(16) % sc.P
        fx = (sum(c * pow(x, i, sc.P) for i, c in enumerate(f)) % sc.P, 0)
        fmx = (sum(c * pow(sc.P - x, i, sc.P) for i, c in enumerate(f)) % sc.P, 0)
        y = x * x % sc.P
        e = sum(c * pow(y, i, sc.P) for i, c in enumerate(even)) % sc.P
        o = sum(c * pow(y, i, sc.P) for i, c in enumerate(odd)) % sc.P
        assert sc.fold_pair(fx, fmx, beta, x) == sc.k_add((e, 0), sc.k_scale(beta, o))

    def test_prover_and_verifier_share_one_constraint_definition(self):
        # The quotients over Fp at a point of L equal the K formulas at the same point.
        public = bs.normalize_public(hs.to_public(PUBLIC))
        cols = bs.build_trace(hs.to_witness(HEDGE), public)
        coeffs = [sc.intt(c, bs.OMEGA_N) for c in cols]
        x = bs.SHIFT * pow(bs.OMEGA_M, 37, sc.P) % sc.P
        xn = x * bs.OMEGA_A % sc.P
        at = lambda poly, pt: sum(c * pow(pt, i, sc.P) for i, c in enumerate(poly)) % sc.P  # noqa: E731
        cur = [at(c, x) for c in coeffs]
        nxt = [at(c, xn) for c in coeffs]
        fp = bs._quotients(
            bs._FpOps, public, cur, nxt, at(bs.WEIGHT_POLY, x), at(bs.WEIGHT_POLY, xn), (x - bs.LAST) % sc.P,
            sc.inv(pow(x, bs.ACTIVE, sc.P) - 1), sc.inv(x - 1), sc.inv(x - bs.LAST),
        )
        k = bs._constraints_at_k(public, (x, 0), [(v, 0) for v in cur], [(v, 0) for v in nxt])
        assert [(v, 0) for v in fp] == k


# ── an honest proof ──────────────────────────────────────────────────

class TestHonest:
    def test_verifies(self, honest):
        proof, _ = honest
        assert hs.verify(proof, PUBLIC)
        assert hs.verify(proof, PUBLIC, commitment=proof['commitment'])

    def test_every_allowed_extreme_proves(self):
        for w in (
            {**HEDGE, 'leverageX': 1}, {**HEDGE, 'leverageX': 4},
            {**HEDGE, 'notionalValueUsdcCents': 100_000_000}, {**HEDGE, 'sizeMilli': 0, 'notionalValueUsdcCents': 0},
            {**HEDGE, 'asset': 'SUI', 'side': 'SHORT'},
        ):
            proof, _ = hs.prove(w, PUBLIC)
            assert hs.verify(proof, PUBLIC)

    def test_the_commitment_opens_to_the_hedge(self, honest):
        proof, opening = honest
        got = hs.audit_opening(opening, proof['commitment'], PUBLIC)
        assert got == {
            'leverage': 3, 'notional': 4_100_000, 'asset': 1, 'side': 0,
            'sizeMilli': 500, 'entryPriceCents': 8_200_000, 'slack': 0, 'portfolioId': 2, 'timestampMs': 1_791_500_000_000,
        }
        # The caps are part of what the opening is read against.
        assert hs.audit_opening(opening, proof['commitment'], {**PUBLIC, 'leverage_cap': 'x'}) is None

    def test_an_opening_does_not_open_another_commitment(self, honest):
        proof, opening = honest
        other, _ = hs.prove({**HEDGE, 'leverageX': 2}, PUBLIC)
        assert hs.audit_opening(opening, other['commitment'], PUBLIC) is None
        broken = copy.deepcopy(opening)
        broken['columns'][bs.col(0, bs.AU)] = flip_hex(broken['columns'][bs.col(0, bs.AU)], 3)
        assert hs.audit_opening(broken, proof['commitment'], PUBLIC) is None

    def test_two_proofs_of_one_hedge_share_nothing(self, honest):
        proof, _ = honest
        again, _ = hs.prove(HEDGE, PUBLIC)
        assert again['commitment'] != proof['commitment']
        assert again['ood'] != proof['ood']

    def test_the_proof_carries_no_witness_field(self, honest):
        proof, _ = honest
        assert set(proof) == {'protocol', 'public', 'commitment', 'quotient_root', 'ood', 'fri_roots', 'final', 'nonce', 'queries'}
        assert set(proof['public']) == {'kind', 'bounds', 'product'}


# ── a prover that follows the protocol refuses a false statement ─────

class TestHonestProverRefuses:
    @pytest.mark.parametrize('witness', [
        {**HEDGE, 'leverageX': 5},
        {**HEDGE, 'leverageX': 1000},
        {**HEDGE, 'leverageX': 0},
        {**HEDGE, 'notionalValueUsdcCents': 100_000_001},
        {**HEDGE, 'asset': 4},
        {**HEDGE, 'asset': 0},
        {**HEDGE, 'side': 2},
        {**HEDGE, 'asset': 'DOGE'},
    ])
    def test_refused(self, witness):
        with pytest.raises(hs.HedgeProofError):
            hs.prove(witness, PUBLIC)


# ── a prover that does NOT follow the protocol is caught by the verifier ──

class TestDishonestProver:
    @pytest.mark.parametrize('witness', [
        {**HEDGE, 'leverageX': 1000},                      # the case the old verifier accepted
        {**HEDGE, 'leverageX': 5},
        {**HEDGE, 'leverageX': 0},
        {**HEDGE, 'notionalValueUsdcCents': 100_000_001},
        {**HEDGE, 'asset': 9},
        {**HEDGE, 'side': 2},
    ])
    def test_a_trace_that_breaks_a_rule_is_rejected(self, witness):
        proof, _ = hs.prove(witness, PUBLIC, skip_checks_for_tests=True)
        assert not hs.verify(proof, PUBLIC)

    def test_a_non_boolean_bit_that_still_sums_correctly_is_rejected(self, monkeypatch):
        # Put a whole value in one "bit": every running sum and the final sum
        # are right, only the bit constraint is broken.
        def cheat(value):
            bits = [value] + [0] * (bs.ACTIVE - 1)
            return bits, [value % sc.P] * bs.ACTIVE
        monkeypatch.setattr(bs, '_bits_column', cheat)
        proof, _ = hs.prove({**HEDGE, 'leverageX': 3}, PUBLIC, skip_checks_for_tests=True)
        assert not hs.verify(proof, PUBLIC)

    def test_a_range_that_wraps_around_the_field_is_rejected(self, monkeypatch):
        # leverage 1000 with cap 4: (v - lo) + (hi - v) = hi - lo holds modulo p
        # if the second term is allowed to be p - 996. The 62-bit range forbids it.
        real = bs._bits_column

        def cheat(value):
            bits, acc = real(value)
            return bits, acc
        monkeypatch.setattr(bs, '_bits_column', cheat)
        cols = bs.build_trace(hs.to_witness({**HEDGE, 'leverageX': 1000}), bs.normalize_public(hs.to_public(PUBLIC)), check=False)
        last = (bs.ACTIVE - 1) * bs.STEP
        k = hs.FIELDS.index('leverage')
        # Force the final running sum of (hi - v) to the wrapped value, breaking only the transition into it.
        cols[bs.col(k, bs.AG)][last] = (4 - 1000) % sc.P
        monkeypatch.setattr(bs, 'build_trace', lambda *a, **kw: cols)
        proof, _ = hs.prove({**HEDGE, 'leverageX': 1000}, PUBLIC, skip_checks_for_tests=True)
        assert not hs.verify(proof, PUBLIC)


# ── a valid proof is valid for its own statement only ────────────────

class TestStatementBinding:
    def test_lower_caps_and_other_parameters(self, honest):
        proof, _ = honest
        assert not hs.verify(proof, {'leverage_cap': 2, 'notional_cap_cents': 100_000_000})
        assert not hs.verify(proof, {'leverage_cap': 4, 'notional_cap_cents': 1})
        assert not hs.verify(proof, {'leverage_cap': 5, 'notional_cap_cents': 100_000_000})
        assert not hs.verify(proof, {**PUBLIC, 'asset_count': 2})

    def test_the_caps_come_from_the_caller_not_the_proof(self, honest):
        proof, _ = honest
        lying = tampered(proof, lambda p: p['public']['bounds'].__setitem__(0, [1, 2]))
        assert hs.verify(lying, PUBLIC)            # the field in the proof is not what is checked
        assert not hs.verify(lying, lying['public'])

    def test_another_commitment(self, honest):
        proof, _ = honest
        other, _ = hs.prove({**HEDGE, 'leverageX': 2}, PUBLIC)
        assert not hs.verify(proof, PUBLIC, commitment=other['commitment'])
        assert not hs.verify(tampered(proof, lambda p: p.update(commitment=other['commitment'])), PUBLIC)


# ── a proof edited after the fact ────────────────────────────────────

class TestTampering:
    @pytest.mark.parametrize('name,edit', [
        ('commitment', lambda p: p.update(commitment=flip_hex(p['commitment']))),
        ('quotient root', lambda p: p.update(quotient_root=flip_hex(p['quotient_root']))),
        ('trace value at z', lambda p: p['ood'].update(trace_z=flip_hex(p['ood']['trace_z'], 5))),
        ('trace value at the shifted point', lambda p: p['ood'].update(trace_zn=flip_hex(p['ood']['trace_zn'], 5))),
        ('chunk value at z', lambda p: p['ood'].update(chunks_z=flip_hex(p['ood']['chunks_z'], 5))),
        ('a FRI root', lambda p: p['fri_roots'].__setitem__(2, flip_hex(p['fri_roots'][2]))),
        ('final polynomial', lambda p: p.update(final=flip_hex(p['final'], 3))),
        ('nonce', lambda p: p.update(nonce=p['nonce'] + 1)),
        ('an opened trace row', lambda p: p['queries'][0]['trace'][0].update(row=flip_hex(p['queries'][0]['trace'][0]['row'], 7))),
        ('a leaf salt', lambda p: p['queries'][0]['trace'][1].update(salt=flip_hex(p['queries'][0]['trace'][1]['salt']))),
        ('a trace path', lambda p: p['queries'][3]['trace'][0]['path'].__setitem__(0, flip_hex(p['queries'][3]['trace'][0]['path'][0]))),
        ('an opened chunk value', lambda p: p['queries'][0]['quotient'][0].update(values=flip_hex(p['queries'][0]['quotient'][0]['values'], 9))),
        ('the masking value', lambda p: p['queries'][0]['quotient'][0].update(values=flip_hex(p['queries'][0]['quotient'][0]['values'], 16 * 2 * 3 + 1))),
        ('a FRI layer value', lambda p: p['queries'][5]['fri'][1][0].update(value=flip_hex(p['queries'][5]['fri'][1][0]['value']))),
        ('a FRI path', lambda p: p['queries'][5]['fri'][0][1]['path'].__setitem__(1, flip_hex(p['queries'][5]['fri'][0][1]['path'][1]))),
    ])
    def test_any_single_change_is_rejected(self, honest, name, edit):
        assert not hs.verify(tampered(honest[0], edit), PUBLIC), name

    def test_weaker_or_reshaped_proofs(self, honest):
        proof, _ = honest
        assert not hs.verify(tampered(proof, lambda p: p['queries'].pop()), PUBLIC)                     # fewer queries
        assert not hs.verify(tampered(proof, lambda p: p.update(queries=[])), PUBLIC)                   # no queries at all
        assert not hs.verify(tampered(proof, lambda p: p.update(queries=[p['queries'][0]] * bs.NUM_QUERIES)), PUBLIC)  # one query repeated
        assert not hs.verify(tampered(proof, lambda p: p.update(final=p['final'] + '00' * 16)), PUBLIC)  # a longer final polynomial
        assert not hs.verify(tampered(proof, lambda p: p.update(final=p['final'][:-32])), PUBLIC)
        assert not hs.verify(tampered(proof, lambda p: p['fri_roots'].pop()), PUBLIC)                   # one layer fewer
        assert not hs.verify(tampered(proof, lambda p: p['queries'][0]['trace'].reverse()), PUBLIC)     # openings at swapped positions
        assert not hs.verify(tampered(proof, lambda p: p.update(protocol='zkward-bounds-v3')), PUBLIC)

    def test_malformed_input_is_false_not_an_exception(self, honest):
        proof, _ = honest
        for junk in ({}, {'protocol': proof['protocol']}, None, 'proof', 7,
                     tampered(proof, lambda p: p.update(commitment='zz')),
                     tampered(proof, lambda p: p.update(nonce='1')),
                     tampered(proof, lambda p: p['ood'].update(trace_z='ff' * 16 * bs.WIDTH))):  # a non-canonical field element
            assert hs.verify(junk, PUBLIC) is False
        assert hs.verify(proof, {'leverage_cap': 'x'}) is False


# ── the opened points say nothing about the witness ──────────────────

class TestHiding:
    def test_nothing_is_opened_on_the_trace_domain(self):
        # Every opened position is on the coset L, and L does not meet H.
        h = {pow(bs.OMEGA_N, i, sc.P) for i in range(bs.N)}
        assert all(bs.SHIFT * pow(bs.OMEGA_M, i, sc.P) % sc.P not in h for i in range(0, bs.M, 97))

    def test_the_randomness_budget_covers_what_is_revealed(self):
        # Free random rows per column against the field functionals of a column the view depends on.
        assert bs.N - bs.ACTIVE >= 4 * bs.NUM_QUERIES + 4
        assert bs.MASK >= 2 * bs.NUM_QUERIES + 2

    def test_opened_rows_differ_between_proofs_of_the_same_hedge(self, honest):
        proof, _ = honest
        again, _ = hs.prove(HEDGE, PUBLIC)
        rows = lambda p: {o['row'] for q in p['queries'] for o in q['trace']}  # noqa: E731
        assert not rows(proof) & rows(again)


# ── the notional must cover size times price ─────────────────────────

class TestExposure:
    def test_a_notional_that_understates_the_exposure_cannot_be_proven(self):
        # 0.5 BTC at $82,000 is $41,000. Declaring $40,999.99 hides exposure from the notional cap.
        with pytest.raises(hs.HedgeProofError):
            hs.prove({**HEDGE, 'notionalValueUsdcCents': 4_099_999}, PUBLIC)

    def test_a_dishonest_prover_understating_the_exposure_is_rejected(self):
        proof, _ = hs.prove({**HEDGE, 'notionalValueUsdcCents': 4_099_999}, PUBLIC, skip_checks_for_tests=True)
        assert not hs.verify(proof, PUBLIC)
        # Hiding a large position behind a tiny declared notional.
        proof, _ = hs.prove({**HEDGE, 'sizeMilli': 2_000_000, 'notionalValueUsdcCents': 1}, PUBLIC, skip_checks_for_tests=True)
        assert not hs.verify(proof, PUBLIC)

    def test_a_notional_above_the_exposure_is_allowed_and_the_slack_is_what_is_left(self):
        proof, opening = hs.prove({**HEDGE, 'notionalValueUsdcCents': 5_000_000}, PUBLIC)
        assert hs.verify(proof, PUBLIC)
        got = hs.audit_opening(opening, proof['commitment'], PUBLIC)
        assert got['slack'] == 1000 * 5_000_000 - 500 * 8_200_000

    def test_size_and_price_are_range_checked(self):
        for w in ({**HEDGE, 'sizeMilli': 1 << 31}, {**HEDGE, 'entryPriceCents': 1 << 31}):
            with pytest.raises(hs.HedgeProofError):
                hs.prove(w, {**PUBLIC, 'notional_cap_cents': 1 << 50})


# ── the engine on a statement that is not a hedge ────────────────────

class TestBoundsEngine:
    RISK = {'kind': 'risk-score', 'bounds': [[0, 70], [0, 1 << 60]]}

    def test_any_bounded_values_with_a_committed_payload(self):
        witness = {'values': [55, (1 << 60) - 7], 'payload': [11, 22, (1 << 62) - 1]}
        proof, opening = bs.prove(witness, self.RISK)
        assert bs.verify(proof, self.RISK)
        opened = bs.audit_opening(opening, proof['commitment'], self.RISK)
        assert opened['values'][:2] == [55, (1 << 60) - 7] and opened['values'][2:] == [0] * 5
        assert opened['payload'][:3] == [11, 22, (1 << 62) - 1] and not any(opened['payload'][3:])

    def test_the_statement_is_the_kind_the_bounds_and_the_relation(self):
        proof, _ = bs.prove({'values': [55, 9]}, self.RISK)
        assert not bs.verify(proof, {**self.RISK, 'kind': 'risk-score-2'})
        assert not bs.verify(proof, {**self.RISK, 'bounds': [[0, 60], [0, 1 << 60]]})
        assert not bs.verify(proof, {**self.RISK, 'bounds': [[0, 70], [0, 1 << 60], [0, 1]]})
        assert not bs.verify(proof, {**self.RISK, 'bounds': [[0, 70], [0, 1 << 40]], 'product': True})

    def test_a_value_outside_its_bounds(self):
        with pytest.raises(bs.ProofError):
            bs.prove({'values': [71, 0]}, self.RISK)
        proof, _ = bs.prove({'values': [71, 0]}, self.RISK, skip_checks_for_tests=True)
        assert not bs.verify(proof, self.RISK)

    @pytest.mark.parametrize('public', [
        {'kind': '', 'bounds': []},
        {'kind': 'has space', 'bounds': []},
        {'kind': 'k', 'bounds': [[5, 4]]},
        {'kind': 'k', 'bounds': [[0, 1 << 62]]},
        {'kind': 'k', 'bounds': [[-1, 4]]},
        {'kind': 'k', 'bounds': [[0, 1]] * 8},
        {'kind': 'k', 'bounds': [[0, True]]},
        {'kind': 'k', 'bounds': [], 'product': 1},
        # The product relation's sides must stay below 2^62.
        {'kind': 'k', 'bounds': [[0, 0], [0, 1 << 55]], 'product': True},
        {'kind': 'k', 'bounds': [[0, 0], [0, 1], [0, 0], [0, 0], [0, 1 << 31], [0, 1 << 31]], 'product': True},
    ])
    def test_malformed_statements_are_refused(self, public):
        with pytest.raises(bs.ProofError):
            bs.normalize_public(public)
        assert bs.verify({}, public) is False

