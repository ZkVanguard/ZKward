"""
Transcript-binding regression tests (STARK-2.1, 2026-09-28).

Two adversarial-prover forgeries were demonstrated against STARK-2.0:

  1. STATEMENT REBINDING — statement_hash was a field the verifier
     compared but never part of the Fiat-Shamir transcript, so an honest
     proof for statement A verified for any statement B after editing
     that one field ("I owe you $1" -> "I owe you $1,000,000").

  2. QUERY-INDEX FREEDOM — the prover derived query positions via
     Fiat-Shamir but the verifier accepted whatever indices the proof
     carried. A proof with all queries replaced by copies of query[0]
     verified, voiding the rho^num_queries FRI soundness claim.

STARK-2.1 binds sha256(statement) into the grinding transcript and makes
the verifier re-derive and enforce every query index. These tests pin
both properties; if either check is ever removed, the corresponding
forgery reappears and this file fails.
"""

import copy
import hashlib
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest

from core.cuda_true_stark import CUDATrueSTARK

STMT_A = {"claim": "I owe you $1", "public_inputs": [1]}
STMT_B = {"claim": "I owe you $1,000,000", "public_inputs": [1000000]}


@pytest.fixture(scope="module")
def zk():
    return CUDATrueSTARK()


@pytest.fixture(scope="module")
def proof_a(zk):
    return zk.generate_proof(STMT_A, {"secret_value": 5})


def _inner(proof):
    return proof.get("proof", proof)


def test_honest_proof_verifies(zk, proof_a):
    assert zk.verify_proof(proof_a, STMT_A) is True
    assert _inner(proof_a).get("version") == "STARK-2.1"


def test_statement_rebinding_rejected(zk, proof_a):
    """Editing statement_hash to point at a different statement must fail:
    the statement digest is part of the grinding transcript now."""
    forged = copy.deepcopy(proof_a)
    tgt = _inner(forged)
    s = json.dumps(STMT_B, sort_keys=True)
    new_hash = str(int(hashlib.sha256(s.encode()).hexdigest(), 16) % zk.prime)
    tgt["statement_hash"] = new_hash
    forged["statement_hash"] = new_hash
    if "statement" in tgt:
        tgt["statement"] = STMT_B
    assert zk.verify_proof(forged, STMT_B) is False


def test_duplicated_query_rejected(zk, proof_a):
    """All-queries-are-query[0] must fail: the verifier re-derives the
    Fiat-Shamir index sequence and enforces it position by position."""
    dup = copy.deepcopy(proof_a)
    d = _inner(dup)
    d["query_responses"] = [
        copy.deepcopy(d["query_responses"][0]) for _ in range(len(d["query_responses"]))
    ]
    assert zk.verify_proof(dup, STMT_A) is False


def test_reordered_queries_rejected(zk, proof_a):
    """Even a permutation of the HONEST queries must fail — order is part
    of the Fiat-Shamir derivation."""
    perm = copy.deepcopy(proof_a)
    p = _inner(perm)
    p["query_responses"] = list(reversed(p["query_responses"]))
    assert zk.verify_proof(perm, STMT_A) is False


def test_truncated_queries_rejected(zk, proof_a):
    """Half the queries used to pass the old `>= num_queries // 2` bar —
    the count must now be exact."""
    cut = copy.deepcopy(proof_a)
    c = _inner(cut)
    c["query_responses"] = c["query_responses"][: len(c["query_responses"]) // 2]
    assert zk.verify_proof(cut, STMT_A) is False
