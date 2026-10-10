"""
Canonical serialization + hashing of private-hedge inputs — Python side.

MUST produce byte-identical output to `lib/hedge-canonical.ts` so the TS
prover client and Python STARK prover agree on the commitment hash the
depositor's key signs and the on-chain Move verifier consumes.

Purpose: a depositor can commit to a hedge (asset, side, size, leverage,
entry price, salt) with a single 32-byte hash on-chain, and prove
off-chain that the hidden inputs satisfy vault invariants (leverage
capped, notional capped, asset in allow-list, side well-formed). The
`public_inputs` pin the CAPS the proof was made against, so any observer
can see the safety envelope even without seeing the trade.

Precision conventions (must match TS):
  - USDC-denominated values → integer cents ($1 = 100). Big enough for
    trillion-dollar notional at u128, so u128-BE on the wire.
  - Leverage                → integer x (1..leverageCap). u32.
  - Prices                  → integer USDC cents. u64.
  - Sizes                   → integer per-asset step units (e.g. SUI:1,
    ETH: 0.01 → 10000 micro-units, BTC: 0.001 → 1000 milli-units). u64.
  - Asset symbols           → uppercase ASCII, enum-coded on the wire.
  - Side                    → "LONG" | "SHORT", enum-coded on the wire.
  - Salt                    → 32 raw bytes (64 hex chars, no 0x prefix).
  - Timestamps              → ms epoch, floored to nearest 1000 ms.
"""

import hashlib
import json
import struct
from typing import Any, Dict


HEDGE_CANONICAL_VERSION = 1

# Enum codes go into the fixed-layout commitment_hash preimage. Never
# renumber — existing on-chain commitments would drift.
ASSET_CODE = {
    "BTC": 1,
    "ETH": 2,
    "SUI": 3,
}

SIDE_CODE = {
    "LONG": 0,
    "SHORT": 1,
}

ALLOWED_ASSETS = frozenset(ASSET_CODE.keys())
ALLOWED_SIDES = frozenset(SIDE_CODE.keys())


class HedgeBindingError(ValueError):
    """
    Raised when a hedge proof request fails a binding check — canonical
    hash mismatch, cap violation, malformed side/asset, salt-length wrong,
    or claimed commitment_hash doesn't match the recomputation. Honest
    prover must not proceed past these checks.
    """


def _normalize(inputs: Dict[str, Any]) -> Dict[str, Any]:
    """Uppercase asset/side, floor timestamp to seconds, coerce numerics."""
    asset = str(inputs["asset"]).upper()
    side = str(inputs["side"]).upper()
    return {
        "version": HEDGE_CANONICAL_VERSION,
        "chain": str(inputs["chain"]).lower(),
        "portfolioId": int(inputs["portfolioId"]),
        "timestampMs": int(inputs["timestampMs"]) // 1000 * 1000,
        "asset": asset,
        "side": side,
        "sizeUnits": int(inputs["sizeUnits"]),
        "leverageX": int(inputs["leverageX"]),
        "entryPriceUsdcCents": int(inputs["entryPriceUsdcCents"]),
        "notionalValueUsdcCents": int(inputs["notionalValueUsdcCents"]),
        "leverageCap": int(inputs["leverageCap"]),
        "notionalCapUsdcCents": int(inputs["notionalCapUsdcCents"]),
        "salt": str(inputs["salt"]).lower(),
    }


def serialize_canonical(inputs: Dict[str, Any]) -> str:
    """
    JSON encode with sorted keys and compact separators — byte-identical
    to the TS `serializeCanonical`. This is the string SHA256 hashes for
    `inputs_hash`.
    """
    normalized = _normalize(inputs)
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"))


def compute_inputs_hash(inputs: Dict[str, Any]) -> str:
    """SHA256 hex of the canonical JSON serialization."""
    return hashlib.sha256(serialize_canonical(inputs).encode("utf-8")).hexdigest()


def _u128_be(x: int) -> bytes:
    """Big-endian unsigned 128-bit encoding — no struct format supports u128 natively."""
    if x < 0 or x >= (1 << 128):
        raise HedgeBindingError(f"u128 out of range: {x}")
    return x.to_bytes(16, byteorder="big", signed=False)


def compute_commitment_hash(inputs: Dict[str, Any], inputs_hash_hex: str) -> str:
    """
    32-byte SHA256 the depositor's key signs and Move verifies on-chain.
    Fixed binary layout — NEVER change without a version bump (would
    break every existing commitment).

      SHA256(
        version_u32BE                  (4)
        portfolioId_u32BE              (4)
        timestampMs_u64BE              (8)
        asset_code_u8                  (1)   # from ASSET_CODE
        side_code_u8                   (1)   # from SIDE_CODE
        leverageX_u32BE                (4)
        leverageCap_u32BE              (4)
        entryPriceUsdcCents_u64BE      (8)
        sizeUnits_u64BE                (8)
        notionalValueUsdcCents_u128BE  (16)
        notionalCapUsdcCents_u128BE    (16)
        salt_32B                       (32)
        inputsHash_32B                 (32)
      )
      = 146 bytes total.
    """
    n = _normalize(inputs)

    asset_code = ASSET_CODE.get(n["asset"])
    if asset_code is None:
        raise HedgeBindingError(f"unsupported asset: {n['asset']!r}")
    side_code = SIDE_CODE.get(n["side"])
    if side_code is None:
        raise HedgeBindingError(f"unsupported side: {n['side']!r}")

    salt_bytes = bytes.fromhex(n["salt"])
    if len(salt_bytes) != 32:
        raise HedgeBindingError(
            f"salt must be 32 bytes (64 hex chars), got {len(salt_bytes)} bytes"
        )
    inputs_hash_bytes = bytes.fromhex(inputs_hash_hex)
    if len(inputs_hash_bytes) != 32:
        raise HedgeBindingError(
            f"inputs_hash must be 32 bytes (64 hex chars), got {len(inputs_hash_bytes)} bytes"
        )

    parts = b"".join(
        [
            struct.pack(">I", HEDGE_CANONICAL_VERSION),
            struct.pack(">I", n["portfolioId"] & 0xFFFFFFFF),
            struct.pack(">Q", n["timestampMs"] & 0xFFFFFFFFFFFFFFFF),
            struct.pack(">B", asset_code),
            struct.pack(">B", side_code),
            struct.pack(">I", n["leverageX"] & 0xFFFFFFFF),
            struct.pack(">I", n["leverageCap"] & 0xFFFFFFFF),
            struct.pack(">Q", n["entryPriceUsdcCents"] & 0xFFFFFFFFFFFFFFFF),
            struct.pack(">Q", n["sizeUnits"] & 0xFFFFFFFFFFFFFFFF),
            _u128_be(n["notionalValueUsdcCents"]),
            _u128_be(n["notionalCapUsdcCents"]),
            salt_bytes,
            inputs_hash_bytes,
        ]
    )
    return hashlib.sha256(parts).hexdigest()


def assert_hedge_binding(
    statement: Dict[str, Any], witness: Dict[str, Any]
) -> Dict[str, Any]:
    """
    Full binding check for a hedge proof. Called by whoever receives one
    before invoking the STARK prover.

    Requires:
      statement.claim         == "zkv-hedge-v1"
      statement.public_inputs == [commitment_hash, inputs_hash,
                                  notional_cap_cents, leverage_cap]
      witness.canonical       == CanonicalHedgeInputs dict

    Enforces vault invariants: asset in allow-list, side well-formed,
    leverage in [1, leverageCap], notional ≤ cap, size × entry ≈ notional
    (integer-cent tolerance), salt is 32 bytes.

    Raises HedgeBindingError on any mismatch. Returns the normalized
    canonical dict for downstream logging / attestation.
    """
    claim = str(statement.get("claim") or "")
    expected_claim = f"zkv-hedge-v{HEDGE_CANONICAL_VERSION}"
    if claim != expected_claim:
        raise HedgeBindingError(
            f"hedge-binding: claim mismatch — expected '{expected_claim}', got '{claim}'"
        )

    public_inputs = statement.get("public_inputs") or []
    if not isinstance(public_inputs, list) or len(public_inputs) < 4:
        raise HedgeBindingError(
            "hedge-binding: public_inputs must be "
            "[commitment_hash, inputs_hash, notional_cap_cents, leverage_cap]"
        )

    stmt_commitment_hash = str(public_inputs[0]).lower()
    stmt_inputs_hash = str(public_inputs[1]).lower()
    try:
        stmt_notional_cap = int(public_inputs[2])
        stmt_leverage_cap = int(public_inputs[3])
    except (TypeError, ValueError) as e:
        raise HedgeBindingError(
            f"hedge-binding: notional_cap / leverage_cap must be integer-castable — {e}"
        )

    canonical = witness.get("canonical")
    if not isinstance(canonical, dict):
        raise HedgeBindingError(
            "hedge-binding: witness.canonical is required and must be a dict"
        )

    # 1) Whitelist enforcement (fail fast before any hashing).
    asset = str(canonical.get("asset", "")).upper()
    if asset not in ALLOWED_ASSETS:
        raise HedgeBindingError(
            f"hedge-binding: asset {asset!r} not in allow-list {sorted(ALLOWED_ASSETS)}"
        )
    side = str(canonical.get("side", "")).upper()
    if side not in ALLOWED_SIDES:
        raise HedgeBindingError(
            f"hedge-binding: side {side!r} not in allow-list {sorted(ALLOWED_SIDES)}"
        )

    normalized = _normalize(canonical)

    # 2) Cap pinning: caps advertised in public_inputs must match the
    # caps the witness was normalized against. Otherwise an attacker could
    # ship a witness with leverageCap=4 but public_inputs claiming
    # leverage_cap=2 — the proof would attest to safety it doesn't provide.
    if normalized["leverageCap"] != stmt_leverage_cap:
        raise HedgeBindingError(
            f"hedge-binding: witness.leverageCap ({normalized['leverageCap']}) "
            f"!= statement.leverage_cap ({stmt_leverage_cap})"
        )
    if normalized["notionalCapUsdcCents"] != stmt_notional_cap:
        raise HedgeBindingError(
            f"hedge-binding: witness.notionalCapUsdcCents ({normalized['notionalCapUsdcCents']}) "
            f"!= statement.notional_cap_cents ({stmt_notional_cap})"
        )

    # 3) Vault invariants on the actual hedge values.
    if not (1 <= normalized["leverageX"] <= normalized["leverageCap"]):
        raise HedgeBindingError(
            f"hedge-binding: leverageX ({normalized['leverageX']}) outside [1, "
            f"{normalized['leverageCap']}]"
        )
    if normalized["notionalValueUsdcCents"] <= 0:
        raise HedgeBindingError(
            f"hedge-binding: notionalValueUsdcCents must be positive, got "
            f"{normalized['notionalValueUsdcCents']}"
        )
    if normalized["notionalValueUsdcCents"] > normalized["notionalCapUsdcCents"]:
        raise HedgeBindingError(
            f"hedge-binding: notional ({normalized['notionalValueUsdcCents']}) exceeds cap "
            f"({normalized['notionalCapUsdcCents']})"
        )
    if normalized["sizeUnits"] <= 0:
        raise HedgeBindingError(
            f"hedge-binding: sizeUnits must be positive, got {normalized['sizeUnits']}"
        )
    if normalized["entryPriceUsdcCents"] <= 0:
        raise HedgeBindingError(
            f"hedge-binding: entryPriceUsdcCents must be positive, got "
            f"{normalized['entryPriceUsdcCents']}"
        )

    # 4) Salt shape (32 bytes = 64 hex chars, lowercase).
    salt = normalized["salt"]
    if len(salt) != 64 or any(c not in "0123456789abcdef" for c in salt):
        raise HedgeBindingError(
            f"hedge-binding: salt must be 64 lowercase hex chars, got {salt!r}"
        )

    # 5) Recompute inputs_hash and compare to statement.
    recomputed_inputs_hash = compute_inputs_hash(canonical)
    if recomputed_inputs_hash != stmt_inputs_hash:
        raise HedgeBindingError(
            "hedge-binding: inputs_hash mismatch — the witness does NOT hash to "
            f"the claimed inputsHash. recomputed={recomputed_inputs_hash} "
            f"claimed={stmt_inputs_hash}"
        )

    # 6) Recompute commitment_hash and compare to statement.
    recomputed_commitment = compute_commitment_hash(canonical, recomputed_inputs_hash)
    if recomputed_commitment != stmt_commitment_hash:
        raise HedgeBindingError(
            "hedge-binding: commitment_hash mismatch — recomputed commitment does not "
            f"match statement. recomputed={recomputed_commitment} "
            f"claimed={stmt_commitment_hash}"
        )

    return normalized
