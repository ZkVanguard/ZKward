"""
Hedge policy ZK-STARK: the hedge statement on the bounds engine.

"The hedge committed as `commitment` has
   leverage  in [1, leverage_cap],
   notional  in [0, notional_cap_cents],
   asset     in [1, asset_count]   (the asset codes of hedge_canonical),
   side      in {0, 1},
 and its notional covers its exposure:
   1000 * notional_cents = size_milli * entry_price_cents + slack,  slack >= 0."

Public: the commitment and the caps. Private: the hedge. The proof system,
its parameters and its limits are in `bounds_stark.py`.

Units: size in thousandths of one asset unit, price in USD cents per unit,
notional in USD cents; so size * price is in thousandths of a cent, and
1000 * notional is the same unit. Size and price are each below 2^31, which
keeps their product below 2^62 and the relation exact over the integers.

What the proof does not say: that an order sent to a venue is this hedge.
The commitment is recorded with the hedge; `audit_opening` reads the hedge
back out of it for whoever is given the opening.
"""
from typing import Any, Dict, Optional, Tuple

from zkp.core import bounds_stark
from zkp.core.bounds_stark import ProofError as HedgeProofError  # noqa: F401  (the name callers catch)

KIND = 'hedge-policy'
SIZE_PRICE_LIMIT = (1 << 31) - 1
# The order of the values in the statement. Slots 1, 4, 5 and 6 are the ones
# the engine's product relation reads: 1000 * notional = size * price + slack.
FIELDS = ('leverage', 'notional', 'asset', 'side', 'sizeMilli', 'entryPriceCents', 'slack')
PAYLOAD_FIELDS = ('portfolioId', 'timestampMs')


def to_public(caps: Dict[str, Any]) -> Dict[str, Any]:
    """The statement for these caps: leverage_cap, notional_cap_cents, and asset_count (default 3)."""
    try:
        leverage_cap = int(caps['leverage_cap'])
        notional_cap = int(caps['notional_cap_cents'])
        asset_count = int(caps.get('asset_count', 3))
    except (KeyError, TypeError, ValueError) as e:
        raise HedgeProofError(f'malformed caps: {e}')
    if leverage_cap < 1 or asset_count < 1 or notional_cap < 0:
        raise HedgeProofError('caps out of range')
    return {
        'kind': KIND,
        'bounds': [
            [1, leverage_cap], [0, notional_cap], [1, asset_count], [0, 1],
            [0, SIZE_PRICE_LIMIT], [0, SIZE_PRICE_LIMIT], [0, bounds_stark.LIMIT - 1],
        ],
        'product': True,
    }


def to_witness(hedge: Dict[str, Any]) -> Dict[str, Any]:
    """
    The engine's witness for a hedge. The slack is what the notional exceeds
    the exposure by; a notional that understates the exposure has a negative
    slack, which no proof can carry.
    """
    from zkp.core.hedge_canonical import ASSET_CODE, SIDE_CODE
    asset, side = hedge.get('asset'), hedge.get('side')
    asset_code = asset if isinstance(asset, int) else ASSET_CODE.get(str(asset).upper())
    side_code = side if isinstance(side, int) else SIDE_CODE.get(str(side).upper())
    if asset_code is None or side_code is None:
        raise HedgeProofError(f'unsupported asset or side: {asset!r} {side!r}')
    try:
        leverage = int(hedge['leverageX'])
        notional = int(hedge['notionalValueUsdcCents'])
        size = int(hedge['sizeMilli'])
        price = int(hedge['entryPriceCents'])
        payload = [int(hedge.get(name, 0)) for name in PAYLOAD_FIELDS]
    except (KeyError, TypeError, ValueError) as e:
        raise HedgeProofError(f'malformed hedge: {e}')
    slack = bounds_stark.PROD_SCALE * notional - size * price
    return {'values': [leverage, notional, int(asset_code), int(side_code), size, price, slack], 'payload': payload}


def prove(hedge: Dict[str, Any], caps: Dict[str, Any], **test_options: Any) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Prove the hedge policy. Returns (proof, opening); the proof's `commitment` is the hedge commitment."""
    return bounds_stark.prove(to_witness(hedge), to_public(caps), **test_options)


def verify(proof: Dict[str, Any], caps: Dict[str, Any], commitment: Optional[str] = None) -> bool:
    """True only when `proof` proves the hedge policy under the CALLER's caps."""
    try:
        public = to_public(caps)
    except (HedgeProofError, AttributeError):
        return False
    return bounds_stark.verify(proof, public, commitment)


def audit_opening(opening: Dict[str, Any], commitment: str, caps: Dict[str, Any]) -> Optional[Dict[str, int]]:
    """The hedge a commitment opens to, by field name, or None when the opening is not for it."""
    try:
        opened = bounds_stark.audit_opening(opening, commitment, to_public(caps))
    except HedgeProofError:
        return None
    if opened is None:
        return None
    out = dict(zip(FIELDS, opened['values']))
    out.update(zip(PAYLOAD_FIELDS, opened['payload']))
    return out


proof_digest = bounds_stark.proof_digest
proof_size_bytes = bounds_stark.proof_size_bytes
