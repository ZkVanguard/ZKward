#!/usr/bin/env python3
"""
ZKward proof server.

Serves one proof system: the bounds ZK-STARK in `zkp/core/bounds_stark.py`
("these private numbers are inside these public limits"), and the hedge
policy statement built on it (`zkp/core/hedge_stark.py`).

  POST /api/zk/bounds/prove          statement + witness -> proof, commitment, opening
  POST /api/zk/bounds/verify         proof + statement   -> valid
  POST /api/zk/hedge-policy/prove    hedge + caps        -> proof, commitment, opening
  POST /api/zk/hedge-policy/verify   proof + caps        -> valid
  GET  /health, GET /api/zk/stats

Verification always takes the statement from the caller, never from the
proof. There is no endpoint that signs anything: a proof is checked by
running the verifier, not by trusting this server.

Proving costs a few seconds of CPU and needs no GPU.
"""
import asyncio
import os
import sys
import time
from collections import deque
from pathlib import Path
from typing import Any, Deque, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import uvicorn

project_root = str(Path(__file__).parent.parent.parent)
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from zkp.core import bounds_stark, hedge_stark  # noqa: E402

app = FastAPI(title="ZKward proof server", description="Bounds ZK-STARK proving and verification", version="2.0.0")

# ── Shared-secret auth for the public tunnel ─────────────────────────
# X-Api-Key must match ZK_API_AUTH_HEADER when it is set. Empty = auth
# disabled (local development and tests). /health and / stay open.
_ZK_AUTH_SECRET = (os.environ.get("ZK_API_AUTH_HEADER") or "").strip()


@app.middleware("http")
async def _zk_api_auth(request: Request, call_next):
    if _ZK_AUTH_SECRET and request.url.path.startswith("/api/zk/"):
        if request.headers.get("x-api-key", "") != _ZK_AUTH_SECRET:
            return JSONResponse(status_code=401, content={"detail": "invalid or missing X-Api-Key"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "https://zkward.com", "https://www.zkward.com"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# ── Load limits ──────────────────────────────────────────────────────
# A proof is about three seconds of one CPU core. Without limits one caller
# could hold every core. Two proofs run at a time, a few more may wait, and
# each client address gets a per-minute allowance. Verification is cheap
# (about 20 ms) and is limited per client only.
MAX_CONCURRENT_PROOFS = max(1, int(os.environ.get("ZK_MAX_CONCURRENT_PROOFS", "2")))
MAX_WAITING_PROOFS = max(0, int(os.environ.get("ZK_MAX_WAITING_PROOFS", "6")))
PROOFS_PER_MINUTE = max(1, int(os.environ.get("ZK_PROOFS_PER_MINUTE", "20")))
VERIFIES_PER_MINUTE = max(1, int(os.environ.get("ZK_VERIFIES_PER_MINUTE", "300")))
MAX_BODY_BYTES = 2 * 1024 * 1024

_proof_slots = asyncio.Semaphore(MAX_CONCURRENT_PROOFS)
_waiting = 0
_recent: Dict[str, Deque[float]] = {}
_stats = {"proofs": 0, "proofs_refused": 0, "verifications": 0, "verified_true": 0, "started_at": time.time()}


def _client(request: Request) -> str:
    # Behind the tunnel the peer is the tunnel itself; the visitor is in the forwarding header.
    forwarded = request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def _allow(request: Request, bucket: str, per_minute: int) -> None:
    key = f"{bucket}:{_client(request)}"
    now = time.monotonic()
    window = _recent.setdefault(key, deque())
    while window and now - window[0] > 60:
        window.popleft()
    if len(window) >= per_minute:
        raise HTTPException(status_code=429, detail="too many requests; try again in a minute")
    window.append(now)
    if len(_recent) > 10_000:  # forget idle clients
        for k in [k for k, w in _recent.items() if not w or now - w[-1] > 120]:
            _recent.pop(k, None)


@app.middleware("http")
async def _body_limit(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "request too large"})
    return await call_next(request)


async def _prove(request: Request, fn, *args):
    """Run one proof on a worker thread, within the concurrency and per-client limits."""
    global _waiting
    _allow(request, "prove", PROOFS_PER_MINUTE)
    if _waiting >= MAX_WAITING_PROOFS and _proof_slots.locked():
        _stats["proofs_refused"] += 1
        raise HTTPException(status_code=503, detail="the prover is busy; try again shortly")
    _waiting += 1
    try:
        async with _proof_slots:
            started = time.perf_counter()
            try:
                proof, opening = await asyncio.get_running_loop().run_in_executor(None, fn, *args)
            except (bounds_stark.ProofError, KeyError, TypeError, ValueError) as e:
                # The witness is outside the statement, or the request is malformed: there is nothing to prove.
                raise HTTPException(status_code=422, detail=f"cannot prove: {e}")
            _stats["proofs"] += 1
            return {
                "proof": proof,
                "commitment": proof["commitment"],
                "opening": opening,
                "proof_digest": bounds_stark.proof_digest(proof),
                "duration_ms": int((time.perf_counter() - started) * 1000),
            }
    finally:
        _waiting -= 1


def _verified(valid: bool, proof: Dict[str, Any], started: float) -> Dict[str, Any]:
    _stats["verifications"] += 1
    _stats["verified_true"] += 1 if valid else 0
    return {
        "valid": valid,
        "commitment": proof.get("commitment") if valid and isinstance(proof, dict) else None,
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }


# ── Models ───────────────────────────────────────────────────────────

class BoundsProveRequest(BaseModel):
    statement: Dict[str, Any] = Field(..., description="{kind, bounds: [[lo, hi], ...up to 7], product?}")
    witness: Dict[str, Any] = Field(..., description="{values: [...], payload: [...]}; never leaves this server")


class BoundsVerifyRequest(BaseModel):
    proof: Dict[str, Any]
    statement: Dict[str, Any] = Field(..., description="The statement the CALLER wants checked")
    commitment: Optional[str] = Field(None, description="The commitment the caller expects the proof to be for")


class HedgePolicyProveRequest(BaseModel):
    witness: Dict[str, Any] = Field(..., description="asset, side, leverageX, notionalValueUsdcCents, sizeMilli, entryPriceCents, portfolioId, timestampMs")
    public: Dict[str, Any] = Field(..., description="leverage_cap, notional_cap_cents, optional asset_count")


class HedgePolicyVerifyRequest(BaseModel):
    proof: Dict[str, Any]
    public: Dict[str, Any]
    commitment: Optional[str] = None


# ── Routes ───────────────────────────────────────────────────────────

def _system_info() -> Dict[str, Any]:
    return {
        "prover": "bounds-stark",
        "protocol": f"{bounds_stark.AIR_ID}-v{bounds_stark.AIR_VERSION}",
        "field": "Goldilocks, challenges in its quintic extension",
        "hash": "SHA-384",
        "trace_rows": bounds_stark.N,
        "blowup": bounds_stark.BLOWUP,
        "queries": bounds_stark.NUM_QUERIES,
        "grinding_bits": bounds_stark.GRINDING_BITS,
        "trusted_setup": False,
    }


@app.get("/")
async def root():
    return {"service": "ZKward proof server", "status": "operational", "version": "2.0.0"}


@app.get("/health")
async def health_check():
    return {"status": "healthy", "system_info": _system_info()}


@app.get("/api/zk/stats")
async def stats():
    return {**_stats, "uptime_seconds": int(time.time() - _stats["started_at"]), "waiting": _waiting, "system_info": _system_info()}


@app.post("/api/zk/bounds/prove")
async def bounds_prove(body: BoundsProveRequest, request: Request):
    """
    Prove that the witness values are inside the statement's bounds. Returns
    the public proof, whose `commitment` commits to the values, and the
    opening. The opening is the caller's secret: it is what an auditor needs
    to read the values back out of the commitment.
    """
    return await _prove(request, bounds_stark.prove, body.witness, body.statement)


@app.post("/api/zk/bounds/verify")
async def bounds_verify(body: BoundsVerifyRequest, request: Request):
    """Check a proof against the statement the CALLER supplies."""
    _allow(request, "verify", VERIFIES_PER_MINUTE)
    started = time.perf_counter()
    return _verified(bounds_stark.verify(body.proof, body.statement, body.commitment), body.proof, started)


@app.post("/api/zk/hedge-policy/prove")
async def hedge_policy_prove(body: HedgePolicyProveRequest, request: Request):
    """Prove that a hedge is inside the vault's rules. The proof's `commitment` is the hedge commitment."""
    return await _prove(request, hedge_stark.prove, body.witness, body.public)


@app.post("/api/zk/hedge-policy/verify")
async def hedge_policy_verify(body: HedgePolicyVerifyRequest, request: Request):
    """Check a hedge policy proof against caps the CALLER supplies."""
    _allow(request, "verify", VERIFIES_PER_MINUTE)
    started = time.perf_counter()
    return _verified(hedge_stark.verify(body.proof, body.public, body.commitment), body.proof, started)


def self_test() -> float:
    """One proof made and checked, and one forgery refused. Raises when the prover is unfit to serve."""
    started = time.perf_counter()
    statement = {"kind": "self-test", "bounds": [[0, 10]]}
    proof, opening = bounds_stark.prove({"values": [7]}, statement)
    if not bounds_stark.verify(proof, statement):
        raise RuntimeError("an honest proof did not verify")
    if bounds_stark.verify(proof, {"kind": "self-test", "bounds": [[0, 6]]}):
        raise RuntimeError("a proof verified under bounds it was not made for")
    opened = bounds_stark.audit_opening(opening, proof["commitment"], statement)
    if not opened or opened["values"][0] != 7:
        raise RuntimeError("the commitment did not open to its value")
    return time.perf_counter() - started


if __name__ == "__main__":
    # Prove the prover before serving: exit non-zero so the task wrapper
    # respawns us instead of leaving a warm corpse behind the tunnel.
    try:
        print(f"[self-test] prove, verify, refuse, open: OK ({self_test():.1f}s)")
    except Exception as err:  # noqa: BLE001 — unfit to serve on any failure
        print(f"[self-test] FATAL: {err}")
        sys.exit(1)

    print("ZKward proof server on http://0.0.0.0:8000  (bounds ZK-STARK, CPU only)")
    # access_log off: per-request lines once filled the wrapper's stdout pipe
    # and blocked the event loop mid-request.
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="warning", access_log=False)
