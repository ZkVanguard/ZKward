"""
Python-side golden tests for `zkp.core.risk_canonical`. The most
critical ones are cross-language: the same golden hex hash must appear
in the TS test file (`test/unit/risk-zk-binding.test.ts`) and here — a
drift means the STARK binding is broken.
"""

import json
import struct
import hashlib
import pytest

from zkp.core.risk_canonical import (
    RISK_CANONICAL_VERSION,
    SENTIMENT_CODE,
    serialize_canonical,
    compute_inputs_hash,
    compute_output_hash,
    compute_commitment_hash,
    compute_base_risk_score,
    fuse_risk_scores,
    assert_risk_binding,
    RiskBindingError,
)


def base_inputs(**overrides):
    d = {
        "version": RISK_CANONICAL_VERSION,
        "portfolioId": -2,
        "chain": "sui",
        "timestampMs": 1783017000000,
        "portfolioValueUsdc": 5408,
        "volatilityBps": 2500,
        "exposures": [
            {"asset": "BTC", "exposureBps": 3000, "contributionBps": 1500},
            {"asset": "ETH", "exposureBps": 3000, "contributionBps": 1500},
            {"asset": "SUI", "exposureBps": 2000, "contributionBps": 1000},
            {"asset": "CRO", "exposureBps": 2000, "contributionBps": 1000},
        ],
        "sentimentCode": SENTIMENT_CODE["neutral"],
        "baseRiskScore": 63,
        "aiRiskScore": None,
        "totalRisk": 63,
        "threshold": 100,
    }
    d.update(overrides)
    return d


class TestBaseRiskFormula:
    def test_known_inputs(self):
        exposures = [
            {"contributionBps": 1500},
            {"contributionBps": 1500},
            {"contributionBps": 1000},
            {"contributionBps": 1000},
        ]
        # 2500/100*50 + (15+15+10+10) = 12.5+50 = 62.5 → round 63
        assert compute_base_risk_score(2500, exposures) == 63

    def test_clamps_to_range(self):
        assert compute_base_risk_score(0, []) == 0
        assert compute_base_risk_score(20000, [{"contributionBps": 100_000_000}]) == 100


class TestFuseRiskScores:
    def test_returns_base_when_ai_none(self):
        assert fuse_risk_scores(50, None) == 50

    def test_averages_when_ai_present(self):
        assert fuse_risk_scores(50, 70) == 60

    def test_clamps_result(self):
        assert fuse_risk_scores(100, 100) == 100
        assert fuse_risk_scores(-10, -20) == 0


class TestSerializeCanonical:
    def test_no_whitespace_sorted_keys(self):
        s = serialize_canonical(base_inputs())
        assert " " not in s
        assert "\n" not in s
        # Confirm top-level keys are sorted
        obj = json.loads(s)
        assert list(obj.keys()) == sorted(obj.keys())

    def test_chain_lowercased_assets_uppercased(self):
        s = serialize_canonical(
            base_inputs(
                chain="SUI",
                exposures=[{"asset": "btc", "exposureBps": 100, "contributionBps": 50}],
                baseRiskScore=1,
                totalRisk=1,
            )
        )
        assert '"chain":"sui"' in s
        assert '"asset":"BTC"' in s

    def test_exposures_sorted_regardless_of_order(self):
        a = serialize_canonical(
            base_inputs(
                exposures=[
                    {"asset": "SUI", "exposureBps": 1, "contributionBps": 1},
                    {"asset": "BTC", "exposureBps": 1, "contributionBps": 1},
                ],
                baseRiskScore=1,
                totalRisk=1,
            )
        )
        b = serialize_canonical(
            base_inputs(
                exposures=[
                    {"asset": "BTC", "exposureBps": 1, "contributionBps": 1},
                    {"asset": "SUI", "exposureBps": 1, "contributionBps": 1},
                ],
                baseRiskScore=1,
                totalRisk=1,
            )
        )
        assert a == b

    def test_timestamp_floored_to_second(self):
        a = serialize_canonical(base_inputs(timestampMs=1000, baseRiskScore=1, totalRisk=1))
        b = serialize_canonical(base_inputs(timestampMs=1999, baseRiskScore=1, totalRisk=1))
        assert a == b


class TestHashes:
    def test_inputs_hash_deterministic_hex_shape(self):
        h = compute_inputs_hash(base_inputs())
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)
        assert compute_inputs_hash(base_inputs()) == h

    def test_inputs_hash_changes_on_any_field(self):
        h0 = compute_inputs_hash(base_inputs())
        assert compute_inputs_hash(base_inputs(portfolioId=42)) != h0
        assert compute_inputs_hash(base_inputs(volatilityBps=2501)) != h0
        mutated = base_inputs()
        mutated["exposures"] = [
            {"asset": "BTC", "exposureBps": 3001, "contributionBps": 1500},
            {"asset": "ETH", "exposureBps": 3000, "contributionBps": 1500},
            {"asset": "SUI", "exposureBps": 2000, "contributionBps": 1000},
            {"asset": "CRO", "exposureBps": 2000, "contributionBps": 1000},
        ]
        assert compute_inputs_hash(mutated) != h0
        assert compute_inputs_hash(base_inputs(aiRiskScore=50)) != h0
        assert compute_inputs_hash(base_inputs(totalRisk=64)) != h0

    def test_output_hash_is_sha256_of_u32be(self):
        expected = hashlib.sha256(struct.pack(">I", 63)).hexdigest()
        assert compute_output_hash(63) == expected


class TestAssertRiskBinding:
    def _statement_from(self, inputs):
        ih = compute_inputs_hash(inputs)
        oh = compute_output_hash(inputs["totalRisk"])
        return {
            "claim": f"zkv-risk-v{RISK_CANONICAL_VERSION}",
            "public_inputs": [ih, oh, str(inputs["totalRisk"]), str(inputs["threshold"])],
        }

    def test_accepts_consistent_tuple(self):
        inputs = base_inputs()
        statement = self._statement_from(inputs)
        witness = {"canonical": inputs}
        normalized = assert_risk_binding(statement, witness)
        assert normalized["totalRisk"] == inputs["totalRisk"]

    def test_rejects_bad_input_hash(self):
        inputs = base_inputs()
        statement = self._statement_from(inputs)
        statement["public_inputs"][0] = "0" * 64
        with pytest.raises(RiskBindingError, match="inputs_hash mismatch"):
            assert_risk_binding(statement, {"canonical": inputs})

    def test_rejects_forged_total_risk(self):
        inputs = base_inputs()
        statement = self._statement_from(inputs)
        # Tamper only totalRisk in statement — inputs_hash still matches
        # inputs, but stmt_total_risk != witness total_risk.
        statement["public_inputs"][2] = str(30)
        with pytest.raises(RiskBindingError, match="totalRisk"):
            assert_risk_binding(statement, {"canonical": inputs})

    def test_rejects_wrong_base_score(self):
        inputs = base_inputs(baseRiskScore=10, totalRisk=10)
        statement = self._statement_from(inputs)
        with pytest.raises(RiskBindingError, match="baseRiskScore"):
            assert_risk_binding(statement, {"canonical": inputs})

    def test_rejects_wrong_fusion(self):
        # If AI is present, totalRisk must equal fuse(base, ai). Keep the
        # reported base consistent with the formula (63 for the default
        # exposures — the binding recomputes it and would otherwise reject
        # at baseRiskScore before the fusion check is ever reached) and set
        # an inconsistent totalRisk.
        inputs = base_inputs(baseRiskScore=63, aiRiskScore=60, totalRisk=99)
        statement = self._statement_from(inputs)
        with pytest.raises(RiskBindingError, match="totalRisk mismatch"):
            assert_risk_binding(statement, {"canonical": inputs})

    def test_rejects_threshold_violation(self):
        # base must match the formula (63) so the threshold check is what
        # fires, not the earlier baseRiskScore recompute.
        inputs = base_inputs(baseRiskScore=63, totalRisk=63, threshold=50)
        statement = self._statement_from(inputs)
        with pytest.raises(RiskBindingError, match="exceeds threshold"):
            assert_risk_binding(statement, {"canonical": inputs})


class TestCrossLangGolden:
    """
    Pinned hex the TS side MUST reproduce byte-for-byte. If either
    number changes, the STARK binding is silently broken on-chain until
    re-signed. Same constant lives in
    test/unit/risk-zk-binding.test.ts `GOLDEN_INPUTS_HASH`.
    """

    EXPECTED_HASH = (
        "0619fb3793c77deddf71250e684ad0074c8f9b08ec0fd218e780cc77d7235f2c"
    )

    def test_inputs_hash_golden(self):
        inputs = base_inputs()  # baseRiskScore=63, totalRisk=63
        h = compute_inputs_hash(inputs)
        assert h == self.EXPECTED_HASH, (
            f"cross-lang hash drift — TS + Python no longer produce the same bytes.\n"
            f"  expected: {self.EXPECTED_HASH}\n"
            f"  got:      {h}\n"
            f"canonical: {serialize_canonical(inputs)}"
        )
