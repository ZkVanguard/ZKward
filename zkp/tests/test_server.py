"""
The proof server: what it serves, what it refuses, and its load limits.

Run:  python -m pytest zkp/tests/test_server.py -q
"""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from zkp.api import server  # noqa: E402

HEDGE = {
    'asset': 'BTC', 'side': 'LONG', 'leverageX': 3, 'notionalValueUsdcCents': 4_100_000,
    'sizeMilli': 500, 'entryPriceCents': 8_200_000, 'portfolioId': 2, 'timestampMs': 1_791_500_000_000,
}
CAPS = {'leverage_cap': 4, 'notional_cap_cents': 100_000_000}
STATEMENT = {'kind': 'risk-score', 'bounds': [[0, 70]]}


@pytest.fixture()
def client():
    server._recent.clear()
    return TestClient(server.app)


@pytest.fixture(scope='module')
def proved():
    server._recent.clear()
    r = TestClient(server.app).post('/api/zk/bounds/prove', json={'statement': STATEMENT, 'witness': {'values': [55]}})
    assert r.status_code == 200
    return r.json()


def test_the_self_test_passes():
    assert server.self_test() > 0


def test_health_names_the_proof_system_and_no_setup(client):
    body = client.get('/health').json()
    assert body['status'] == 'healthy'
    assert body['system_info']['prover'] == 'bounds-stark' and body['system_info']['trusted_setup'] is False


def test_prove_returns_the_proof_its_commitment_and_the_private_opening(proved):
    assert set(proved) == {'proof', 'commitment', 'opening', 'proof_digest', 'duration_ms'}
    assert proved['commitment'] == proved['proof']['commitment'] and len(proved['commitment']) == 64
    assert len(proved['proof_digest']) == 64


def test_verify_takes_the_statement_from_the_caller(client, proved):
    ok = client.post('/api/zk/bounds/verify', json={'proof': proved['proof'], 'statement': STATEMENT, 'commitment': proved['commitment']}).json()
    assert ok['valid'] is True and ok['commitment'] == proved['commitment']
    lower = client.post('/api/zk/bounds/verify', json={'proof': proved['proof'], 'statement': {'kind': 'risk-score', 'bounds': [[0, 50]]}}).json()
    assert lower == {'valid': False, 'commitment': None, 'duration_ms': lower['duration_ms']}
    other = client.post('/api/zk/bounds/verify', json={'proof': proved['proof'], 'statement': STATEMENT, 'commitment': '00' * 32}).json()
    assert other['valid'] is False
    junk = client.post('/api/zk/bounds/verify', json={'proof': {}, 'statement': STATEMENT})
    assert junk.status_code == 200 and junk.json()['valid'] is False


def test_a_value_outside_the_statement_cannot_be_proven(client):
    r = client.post('/api/zk/bounds/prove', json={'statement': STATEMENT, 'witness': {'values': [71]}})
    assert r.status_code == 422 and 'proof' not in r.json()
    r = client.post('/api/zk/bounds/prove', json={'statement': {'kind': 'bad kind', 'bounds': []}, 'witness': {'values': []}})
    assert r.status_code == 422


def test_hedge_policy_endpoints(client):
    p = client.post('/api/zk/hedge-policy/prove', json={'witness': HEDGE, 'public': CAPS})
    assert p.status_code == 200
    proof = p.json()['proof']
    assert client.post('/api/zk/hedge-policy/verify', json={'proof': proof, 'public': CAPS}).json()['valid'] is True
    assert client.post('/api/zk/hedge-policy/verify', json={'proof': proof, 'public': {**CAPS, 'leverage_cap': 2}}).json()['valid'] is False
    # The same proof through the generic endpoint, under the statement the hedge caps stand for.
    from zkp.core import hedge_stark
    assert client.post('/api/zk/bounds/verify', json={'proof': proof, 'statement': hedge_stark.to_public(CAPS)}).json()['valid'] is True
    for bad in ({**HEDGE, 'leverageX': 1000}, {**HEDGE, 'notionalValueUsdcCents': 4_099_999}, {**HEDGE, 'asset': 'DOGE'}):
        assert client.post('/api/zk/hedge-policy/prove', json={'witness': bad, 'public': CAPS}).status_code == 422


def test_there_is_no_signing_endpoint_and_none_of_the_old_ones(client):
    for path in ('/api/zk/attest', '/api/zk/generate', '/api/zk/verify'):
        assert client.post(path, json={}).status_code in (404, 405)
    assert client.get('/api/zk/prover-pubkey').status_code == 404


def test_per_client_proof_limit(client, monkeypatch):
    monkeypatch.setattr(server, 'PROOFS_PER_MINUTE', 2)
    body = {'statement': STATEMENT, 'witness': {'values': [71]}}   # refused quickly, but still counted
    assert [client.post('/api/zk/bounds/prove', json=body).status_code for _ in range(3)] == [422, 422, 429]
    # Another client address has its own allowance.
    assert client.post('/api/zk/bounds/prove', json=body, headers={'cf-connecting-ip': '203.0.113.9'}).status_code == 422


def test_per_client_verify_limit(client, monkeypatch):
    monkeypatch.setattr(server, 'VERIFIES_PER_MINUTE', 1)
    body = {'proof': {}, 'statement': STATEMENT}
    assert [client.post('/api/zk/bounds/verify', json=body).status_code for _ in range(2)] == [200, 429]


def test_oversized_requests_are_refused(client):
    r = client.post('/api/zk/bounds/verify', content=b'{"proof": "' + b'a' * (server.MAX_BODY_BYTES + 10) + b'"}', headers={'content-type': 'application/json'})
    assert r.status_code == 413


def test_the_shared_secret_guards_the_api_but_not_health(client, monkeypatch):
    monkeypatch.setattr(server, '_ZK_AUTH_SECRET', 's3cret')
    assert client.post('/api/zk/bounds/verify', json={'proof': {}, 'statement': STATEMENT}).status_code == 401
    assert client.post('/api/zk/bounds/verify', json={'proof': {}, 'statement': STATEMENT}, headers={'x-api-key': 's3cret'}).status_code == 200
    assert client.get('/health').status_code == 200


def test_stats_count_what_happened(client, proved):
    before = client.get('/api/zk/stats').json()
    client.post('/api/zk/bounds/verify', json={'proof': proved['proof'], 'statement': STATEMENT})
    after = client.get('/api/zk/stats').json()
    assert after['verifications'] == before['verifications'] + 1 and after['verified_true'] == before['verified_true'] + 1
