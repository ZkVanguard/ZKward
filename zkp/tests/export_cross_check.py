"""
Write a corpus of hedge policy proofs with the Python verifier's verdict on
each, for a second verifier to be checked against.

    python -m zkp.tests.export_cross_check <out.json>

The corpus is deliberately mostly proofs that must be REJECTED: honest
proofs under the wrong caps, edited proofs, and proofs from a prover that
cheats at each step of the protocol. Two verifiers that agree on all of
them agree on the transcript, the encodings, the arithmetic and the checks.
"""
import copy
import json
import random
import sys

from zkp.core import hedge_stark as hs
from zkp.core import stark_core as sc
from zkp.tests.test_hedge_stark_soundness import solve_first_chunk

HEDGE = {
    'asset': 'BTC', 'side': 'LONG', 'leverageX': 3, 'notionalValueUsdcCents': 4_100_000,
    'sizeUnits': 500, 'entryPriceUsdcCents': 8_200_000, 'portfolioId': 2, 'timestampMs': 1_791_500_000_000,
}
PUBLIC = {'leverage_cap': 4, 'notional_cap_cents': 100_000_000}


def flip(s: str, at: int) -> str:
    return s[:at] + ('0' if s[at] != '0' else '1') + s[at + 1:]


def main(out_path: str) -> None:
    rng = random.Random(11)
    cases = []

    def add(name, proof, public, commitment=None):
        cases.append({
            'name': name, 'proof': proof, 'public': public, 'commitment': commitment,
            'expected': hs.verify(proof, public, commitment),
        })

    honest, _ = hs.prove(HEDGE, PUBLIC)
    add('honest', honest, PUBLIC)
    add('honest, with its commitment named', honest, PUBLIC, honest['commitment'])
    add('honest, another commitment named', honest, PUBLIC, '00' * 32)
    add('honest, lower leverage cap', honest, {**PUBLIC, 'leverage_cap': 2})
    add('honest, higher leverage cap', honest, {**PUBLIC, 'leverage_cap': 5})
    add('honest, lower notional cap', honest, {**PUBLIC, 'notional_cap_cents': 1})
    add('honest, other asset count', honest, {**PUBLIC, 'asset_count': 2})

    big_public = {'leverage_cap': 50, 'notional_cap_cents': (1 << 61) + 12345, 'asset_count': 3}
    big, _ = hs.prove({**HEDGE, 'asset': 'SUI', 'side': 'SHORT', 'leverageX': 50, 'notionalValueUsdcCents': 1 << 61}, big_public)
    add('honest, caps beyond 2^53', big, big_public)

    edits = {
        'edited: commitment': lambda p: p.update(commitment=flip(p['commitment'], 0)),
        'edited: quotient root': lambda p: p.update(quotient_root=flip(p['quotient_root'], 1)),
        'edited: trace value at z': lambda p: p['ood'].update(trace_z=flip(p['ood']['trace_z'], 5)),
        'edited: trace value at the shifted point': lambda p: p['ood'].update(trace_zn=flip(p['ood']['trace_zn'], 40)),
        'edited: chunk value at z': lambda p: p['ood'].update(chunks_z=flip(p['ood']['chunks_z'], 9)),
        'edited: a FRI root': lambda p: p['fri_roots'].__setitem__(3, flip(p['fri_roots'][3], 2)),
        'edited: final polynomial': lambda p: p.update(final=flip(p['final'], 3)),
        'edited: nonce': lambda p: p.update(nonce=p['nonce'] + 1),
        'edited: an opened trace row': lambda p: p['queries'][7]['trace'][1].update(row=flip(p['queries'][7]['trace'][1]['row'], 30)),
        'edited: a leaf salt': lambda p: p['queries'][0]['quotient'][0].update(salt=flip(p['queries'][0]['quotient'][0]['salt'], 0)),
        'edited: a trace path': lambda p: p['queries'][2]['trace'][0]['path'].__setitem__(5, flip(p['queries'][2]['trace'][0]['path'][5], 0)),
        'edited: the masking value': lambda p: p['queries'][1]['quotient'][1].update(values=flip(p['queries'][1]['quotient'][1]['values'], 100)),
        'edited: a FRI layer value': lambda p: p['queries'][9]['fri'][2][1].update(value=flip(p['queries'][9]['fri'][2][1]['value'], 4)),
        'edited: a FRI path': lambda p: p['queries'][9]['fri'][4][0]['path'].__setitem__(0, flip(p['queries'][9]['fri'][4][0]['path'][0], 0)),
        'reshaped: one query fewer': lambda p: p['queries'].pop(),
        'reshaped: one query repeated': lambda p: p.update(queries=[p['queries'][0]] * len(p['queries'])),
        'reshaped: a longer final polynomial': lambda p: p.update(final=p['final'] + '00' * 16),
        'reshaped: openings at swapped positions': lambda p: p['queries'][0]['trace'].reverse(),
        'reshaped: a non-canonical field element': lambda p: p['ood'].update(trace_z='ff' * (16 * hs.WIDTH)),
        'reshaped: another protocol version': lambda p: p.update(protocol='zkward-hedge-policy-v2'),
    }
    for name, edit in edits.items():
        p = copy.deepcopy(honest)
        edit(p)
        add(name, p, PUBLIC)

    illegal = {**HEDGE, 'leverageX': 1000}
    cheat, _ = hs.prove(illegal, PUBLIC, skip_checks_for_tests=True)
    add('dishonest prover: leverage 1000 against cap 4', cheat, PUBLIC)
    cheat, _ = hs.prove({**HEDGE, 'notionalValueUsdcCents': 100_000_001}, PUBLIC, skip_checks_for_tests=True)
    add('dishonest prover: notional over the cap', cheat, PUBLIC)
    cheat, _ = hs.prove(illegal, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={'ood': solve_first_chunk})
    add('dishonest prover: out-of-domain values forged so the identity holds', cheat, PUBLIC)
    cheat, _ = hs.prove(HEDGE, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={
        'fri_layer': lambda k, layer: [(rng.randrange(sc.P), rng.randrange(sc.P)) for _ in layer] if k == 2 else layer,
    })
    add('dishonest prover: a FRI layer that is not a fold', cheat, PUBLIC)
    cheat, _ = hs.prove(HEDGE, PUBLIC, skip_checks_for_tests=True, attack_hooks_for_tests={
        'final': lambda layer, shift: [(rng.randrange(sc.P), rng.randrange(sc.P)) for _ in range(hs.FINAL_DEGREE)],
    })
    add('dishonest prover: a final polynomial of its own choosing', cheat, PUBLIC)

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(cases, f)
    accepted = sum(1 for c in cases if c['expected'])
    print(f'{len(cases)} cases: {accepted} accepted, {len(cases) - accepted} rejected')


if __name__ == '__main__':
    main(sys.argv[1])
