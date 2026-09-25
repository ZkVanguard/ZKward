# ZK Roadmap — path to a completely-real, end-to-end verifiable ZK-STARK

Snapshot 2026-07-28. Companion to `docs/ZK_WHITEPAPER_ALIGNMENT.md` (which
tracks the whitepaper-vs-code gap). This doc is forward-looking: what has
to ship for the ZK stack to be "completely real" — depositor-trustless,
chain-verified, quantum-secure — with honest scoping so future sessions
can pick a phase and finish it without rediscovering the map.

## What's actually done (as of `af23679e`, `c56ff363`, `c40737ce`)

- ✅ Goldilocks field (was NIST P-521; P-521 gives zero PQ benefit, breaks FFT).
- ✅ Real FRI on a multiplicative coset. Per-layer folding-consistency
  `f_L+1(x²) = (v+s)/2 + α·(v−s)/(2x)` checked at verify. Fiat-Shamir
  rebinding on FRI challenges from `sha256(root_L)`.
- ✅ Grinding PoW bound to the full trace + FRI commitment transcript.
  20 bits for legacy proofs (0.7s per proof), 24 bits for hedge proofs
  (~11s per proof).
- ✅ **Hedge invariants inside the STARK** (not just server-side gate):
  composition polynomial `H(x) = Σ α_j · Q_j(x)` where each Q_j =
  P_j(T(x)) / (x − g^j). Verifier re-evaluates P_j locally on Merkle-
  authenticated T(x_q) and asserts H(x_q) equality. Alphas rebound
  to `sha256(trace_merkle_root ‖ "alpha:{j}")` so attacker can't cook
  weights.
- ✅ **10 actual FRI folds for hedge proofs** (matches whitepaper §7).
  Emitted as `proof.actual_fri_layers` for auditor verifiability.
- ✅ Canonical hedge binding — TS + Python byte-identical, golden hash
  pinned in cross-lang tests.
- ✅ Server-side prover-side gate (`assert_hedge_binding`) as defense in
  depth. STARK catches the same violations even if the gate is bypassed.
- ✅ TS metadata guard rebound to Goldilocks + ≥80 queries + ≥20 grinding.

## What's still open (the "completely real" gap)

Three deliverables remain, each is a real project:

1. **On-chain STARK verifier in Move** — chain today only checks
   `ed25519(commitment_hash)`; the STARK itself is verified off-chain by
   `/api/zk/verify`. For trustless on-chain settlement, Move needs to
   run the STARK verifier itself.
2. **Rust prover with real 30-bit+ grinding + faster proof generation.**
   Python prover is fine for correctness but not for prod throughput.
3. **Browser WASM prover for full depositor cryptographic privacy.**
   Today the operator's server sees inputs at `/api/zk/attest`. For
   cryptographic (not just server-attested) privacy, the depositor must
   prove locally.

Below is a phased plan for each.

---

## Phase A — Move on-chain STARK verifier

**Goal:** `contracts/sui/sources/zk_verifier.move` runs the full STARK
verify circuit, replacing today's `ed25519_verify(sig, pubkey, commitment_hash)`
one-liner. Chain observers can independently verify hedge invariants
without trusting the operator's ed25519 key.

**What's already there (do NOT rewrite):**
- `contracts/sui/sources/zk_verifier.move` (484 LOC) — state, admin cap,
  replay-protection via `used_proofs: Table`, `PROVER_PUBKEY_KEY`
  dynamic-field pattern, event emission, existing `verify_proof` entry
  point with an ed25519 path we'll keep as a fast path.
- `contracts/sui/sources/zk_hedge_commitment.move` (502 LOC) — commitment
  storage + nullifier replay-protection. New STARK verifier just needs
  to be CALLED from here; storage layout already exists.
- `sui::hash::sha2_256` (**native SUI opcode**) — no need to implement
  SHA-256 in Move. Same for `sha3_256`, `keccak256`, `blake2b256`.
- `sui::ed25519::ed25519_verify` (native) — fast path kept for
  compatibility during migration.
- `sui::table::Table`, `sui::dynamic_field`, `sui::clock::Clock` — all
  already imported in zk_verifier.
- `contracts/sui/tests/` — Move test framework already set up.

**Revised scale:** ~500-750 NEW Move LOC total (was over-estimated at
800-1200), 2-3 weeks (was 3-6). No native crypto to hand-implement.

### Phase A.1 — Goldilocks field arithmetic (~80-100 LOC)

- New file: `contracts/sui/sources/zkv_field.move`.
- Public functions: `add`, `sub`, `mul`, `inv`, `pow` — all mod
  `p = 2^64 − 2^32 + 1 = 18446744069414584321`.
- Use `u128` for intermediates, reduce back to `u64` (since p < 2^64).
- Mostly a mechanical port of the Python `CUDAFiniteField` primitives.
- Unit tests: field axioms + round-trip vectors against the Python impl.

### Phase A.2 — Merkle-proof verify helper (~30-50 LOC)

- Small addition to `zk_verifier.move` (no separate file needed).
- `verify_merkle(leaf: vector<u8>, index: u64, proof: vector<vector<u8>>, root: vector<u8>): bool`
- Just walks siblings, calling `sui::hash::sha2_256(left || right)` at
  each level (SHA-256 is native — this is a ~15-line loop).
- Matches Python `MerkleTree.verify` byte layout (already documented).

### Phase A.3 — FRI folding-consistency check (~150-200 LOC)

- New file: `contracts/sui/sources/zkv_fri.move`.
- Uses `zkv_field` primitives from A.1 and the Merkle helper from A.2.
- Per-query, per-layer: reconstruct `(h_L, ω_L, N_L)`, Merkle-verify
  value + sibling at positions `(q, q + N/2 mod N)`, compute
  `(v+s)/2 + α·(v−s)/(2x)`, compare to Merkle-authenticated next-layer
  value or the final polynomial evaluation.
- Fiat-Shamir binding: recompute α_L via `sha2_256(root_L)`.
- Grinding PoW re-check: `sha2_256(transcript ‖ nonce)` has ≥N leading zeros.

### Phase A.4 — Hedge composition check (~80-100 LOC)

- New file: `contracts/sui/sources/zkv_hedge_air.move`.
- Reconstruct hedge AIR row constraints (asset ∈ {1,2,3}, side ∈ {0,1},
  leverage ∈ {1..cap}) from `statement.public_inputs[3]` (leverage_cap).
- Per query: Merkle-verify trace opening at position q against
  `trace_merkle_root`, evaluate P_j(T(x_q)) locally, compare to FRI-
  layer-0 authenticated H(x_q).
- Rebind α_j from `sha2_256(trace_merkle_root ‖ "alpha:{j}")`.

### Phase A.5 — Wire the STARK path into existing `zk_verifier.move` (~100-150 LOC)

- MODIFY existing `verify_proof` — don't replace. Ed25519 stays as a
  fast path with a `state.strict_mode` toggle (per file's existing
  audit pattern from 2026-06-04). Full STARK path adds a new
  `verify_proof_stark` entry that calls the A.2→A.3→A.4 chain.
- Proof-bytes parser: reuses `vector<u8>` slicing already in use for
  the ed25519 sig extraction (~line 244 of zk_verifier.move).
- Migration: no new package deploy needed if the new entry function
  is added — old hedges keep using ed25519, new hedges call the new
  entry function. `admin_set_prover_pubkey` still governs ed25519 path.

### Phase A.6 — Tests (~150-200 Move LOC)

- New file: `contracts/sui/tests/zkv_stark_tests.move`.
- Test vectors generated by the Python prover (fixed statement + fixed
  witness → known-good proof) pinned as constants; assertions match
  what the harness already checks.
- Follow the pattern in `contracts/sui/tests/community_pool_tests.move`.

**Revised cost:** ~500-750 NEW Move LOC, 2-3 weeks of focused work +
external audit (audit cost separate).

**Gas:** Move-native SHA-256 and ed25519 keep cost manageable. Rough
estimate ~100k-300k SUI gas per verify (~$0.01-0.03 at current gas).
Usable for per-hedge verification, not just periodic audit.

---

## Phase B — Rust prover

**Goal:** replace `zkp/core/cuda_true_stark.py` with a Rust implementation
that runs the same protocol but 100-1000× faster. Enables:
- 30-bit grinding at reasonable proof-gen time (~1s vs Python 12min)
- Sub-second per-hedge proof gen on CPU (vs current ~30s)
- WASM compilation for Phase C

**Scale:** ~2000-3000 Rust LOC, 4-8 weeks.

### Phase B.1 — Rust field + Merkle + FFT (~800 LOC)

- New workspace: `zkp-rust/` with `Cargo.toml`, `zkv-field/`, `zkv-merkle/`.
- Goldilocks arithmetic (single-u64 with 128-bit intermediate).
- Cooley-Tukey FFT + inverse.
- SHA-256 Merkle tree.
- Property tests via `proptest`.

**Status (2026-07-29):**
- ✅ **B.1a** Rust workspace + `zkv-field` (Goldilocks — add, sub, mul, neg,
  pow, inv, div, eq, primitive_root, u64_to_ascii). **25 tests pass**,
  including cross-language golden vectors byte-identical to Python
  `CUDAFiniteField` (`pow(7, 100)` = 2_335_214_203_647_002_900,
  `primitive_root(1024)` = 11_353_340_290_879_379_826).
- ✅ **B.1b** `zkv-merkle` — SHA-256 tree with the exact same layout as
  Python `MerkleTree` and Move `zkv_merkle`. **6 tests pass**, including
  a cross-language golden root (`e3b58dfe27716ef42537b185903ddb93571f28061805339c06ab5d19cc87baa2`)
  and a proof-path vector byte-exact to the Move test's hardcoded
  siblings.
- ⏳ **B.1c** FFT (`zkv-fft` — not started).

### Phase B.2 — Rust FRI (~600 LOC)

- `src/fri.rs`: commit, query, verify. Multiplicative coset, folding
  consistency, Fiat-Shamir binding.
- Grinding: parallelized nonce search via `rayon`.
- Byte-compatible proof format with Python (JSON serialization order fixed).

### Phase B.3 — Rust CUDATrueSTARK + hedge AIR (~600 LOC)

- `src/stark.rs`: full prover including composition polynomial.
- `src/air.rs`: parametric AIR with row constraints.
- `src/hedge_air.rs`: hedge invariant AIR builder.

### Phase B.4 — Rust HTTP server + Python interop (~400 LOC)

- Actix/axum HTTP server exposing `/api/zk/generate`, `/api/zk/verify`,
  `/api/zk/attest`.
- Byte-compatible request/response format so `zkp/api/server.py` clients
  need zero changes.
- Feature flag to route TS callers to Rust prover in prod.

**Cost:** ~2000-3000 Rust LOC + Rust toolchain in CI. Real speedup: 100x
per-proof, unlocks 30-bit grinding and higher trace lengths.

---

## Phase C — Browser WASM prover

**Goal:** depositor proves locally in-browser. Operator never sees the
private hedge inputs. This is what makes it "cryptographic privacy"
instead of "server-attested privacy".

Depends on Phase B (Rust prover).

**Scale:** ~500 Rust + ~500 TS LOC, 2-4 weeks after Phase B.

### Phase C.1 — wasm-pack build of the Rust prover (~200 LOC)

- Add `wasm-bindgen` bindings to `zkp-rust/`.
- Compile to `wasm32-unknown-unknown`.
- Publish as npm package `@zkward/prover-wasm`.

### Phase C.2 — Browser JS integration (~300 TS LOC)

- New file: `lib/browser/wasmProver.ts`.
- `generateHedgeProofInBrowser(inputs) → { proof, commitment, statement }`.
- Uses Web Workers for the ~5-30s proof-gen (doesn't block UI).
- Includes canonical binding (already exists in TS: `zk/prover/hedgeCanonical.ts`).

### Phase C.3 — Depositor flow rewrite (~200 TS LOC)

- Update `SuiPrivateHedgeService.getAttestedHedgeCommitmentProof()` to
  call the browser prover instead of POSTing to `/api/zk/attest`.
- Attestation signing MOVES to depositor's own key (or a threshold sig
  scheme) — no more operator ed25519 key seeing everything.
- `/api/zk/attest` becomes obsolete for hedges; kept for internal /
  risk-attestation flows.

**Result:** operator sees only `(commitment_hash, proof)`. Trade details
never leave the depositor's browser.

**Cost:** ~1000 LOC total, ~4 weeks.

---

## Phase D — Optional formal verification (Coq / Lean)

**Not on any planned timeline.** Real machine-checked STARK soundness
proofs are a year+ of specialist work. Documented in the whitepaper §7
footnote as a "necessary-but-not-sufficient" caveat: "empirical checks
pass, formal proofs would require Coq/Lean encoding."

Reference implementations that could be adapted:
- `ethSTARK` (StarkWare) has partial formal analysis.
- `Plonky2` (Polygon Zero) has proptest coverage but not full Coq.

Deferred indefinitely. Not blocking any product milestone.

---

## Milestone table

| Phase | New LOC (existing infra credited) | Status | Blocks |
|-------|-----------------------------------|--------|--------|
| A.1 Goldilocks field (`zkv_field.move`) | 148 Move (est. 80-100) | ✅ **1aed48ab / 32844020** | ✅ unblocked |
| A.2 Merkle verify (`zkv_merkle.move`) | 55 Move (est. 30-50; `sha2_256` native) | ✅ **1aed48ab** | ✅ unblocked |
| A.3 FRI folding (`zkv_fri.move`) | 251 Move (est. 150-200) | ✅ **32844020** | ✅ unblocked |
| A.4 Hedge composition (`zkv_hedge_air.move`) | 172 Move (est. 80-100) | ✅ **this commit** | ✅ unblocked |
| A.5 End-to-end composer (`zkv_stark.move`) | 178 Move (est. 100-150) | ✅ **this commit** | ✅ done |
| A.6 Move tests + golden vectors | 553 Move (98 tests, all pass) | ✅ | ships alongside |
| **A total** | **~1357 Move LOC** (500-750 est.; over because 553 is tests + more thorough coverage than estimated) | ✅ **ALL SHIPPED** | |

**Phase A landed 2026-07-28.** Chain-side hedge-STARK verification is now
possible in Move. What ships:
- `zkv_stark::verify_hedge_stark_proof(...)` — public function taking
  fully-structured Move types. Returns `true` iff grinding PoW passes,
  FRI verify passes for every query, composition identity holds at
  every (opening, query) pair, and query/opening indices match.
- `zkv_stark::verify_grinding(...)` — public grinding-only check.
- Composition round-trip against real Python-generated hedge proof
  passes byte-for-byte (`composition_round_trip_accepts_honest_hedge_proof`).
- 5 tamper vectors reject (wrong `H`, downgraded leverage_cap, tampered
  trace value, wrong `trace_merkle_root`, insufficient grinding).

**Wired into `zk_verifier.move` as of 2026-07-28.** Added
`verify_hedge_stark_proof_pub` that:
- Delegates to `zkv_stark::verify_hedge_stark_proof` for the full check
- Enforces replay protection via the existing `used_proofs: Table`
  (BY COMMITMENT hash — a depositor commits once; any subsequent proof
  over the same commitment aborts with `E_PROOF_ALREADY_USED`)
- Emits `ProofVerified` event and mints a `ProofRecord` transferred to
  the sender
- Bumps `state.total_proofs_verified` counter for observability
- Kept as a `public fun` (not `entry`) because Move entry functions
  can't take custom struct arguments — see follow-up below

Tests added (2 more, 100 total, all pass):
- `stark_verify_pub_rejects_below_minimum_grinding` — insufficient
  grinding_bits aborts with `E_INVALID_PROOF`
- `stark_verify_pub_rejects_replayed_commitment` — pre-seeded
  commitment aborts with `E_PROOF_ALREADY_USED` on second call

**BCS decoders + PTB entry function shipped 2026-07-28** (hybrid approach:
BCS blobs only for the deeply nested pieces, everything else as native
tx-arg types):

- `zkv_stark::decode_fri_queries(blob) → vector<FriQuery>`
- `zkv_stark::decode_trace_openings(blob) → vector<TraceOpening>`
- `zk_verifier::verify_hedge_stark_proof_entry(...)` — PTB-callable
  entry function. Takes `trace_merkle_root`, `fri_roots`, `final_poly_coeffs`,
  and all scalar parameters as native tx-arg types; takes `fri_queries_bcs`
  and `trace_openings_bcs` as BCS-encoded `vector<u8>`. Decodes, calls
  `verify_hedge_stark_proof_pub`, which delegates to `zkv_stark::verify_hedge_stark_proof`
  and mints a `ProofRecord` on success.

TS-side (using `@mysten/bcs`): only needs to BCS-encode the two nested
pieces. Struct layout the encoder must match:
- `FriQuery { index: u64, layers: vector<FriQueryLayer> }`
- `FriQueryLayer { value: u64, sibling_value: u64,
                   merkle_proof: vector<MerkleProofStep>,
                   sibling_proof: vector<MerkleProofStep> }`
- `MerkleProofStep { sibling: vector<u8>, is_left: bool }`
- `TraceOpening { index: u64, value: u64,
                  merkle_proof: vector<MerkleProofStep> }`

Tests added (5 more; 105 total, all pass):
- Empty FRI queries round-trip
- Single FRI query with zero layers round-trip
- FRI query with one layer + two-step Merkle proofs round-trip
  (exercises every nesting level: query → layer → proof → step)
- Trace openings round-trip (2 openings, one with a proof)
- PTB entry rejects below-minimum grinding through the wired path

**TS `@mysten/sui/bcs` serializer shipped 2026-07-29** (`zk/verifier/hedgeStarkBcs.ts`, ~280 LOC):
- `MerkleProofStep`, `FriQueryLayer`, `FriQuery`, `TraceOpening` BCS
  schemas via `@mysten/sui/bcs` — byte-exact to the Move `sui::bcs::to_bytes`
  side.
- `serializeFriQueries(queries)` / `serializeTraceOpenings(openings)` —
  produce the two `Uint8Array` blobs the Move entry function expects.
  Accept either pre-normalized JS shape OR the raw Python prover JSON
  (`query_responses[]` / `trace_openings[]`) via the adapters
  `pythonQueriesToJs` / `pythonTraceOpeningsToJs`.
- `buildHedgeStarkEntryArgs(pythonProof, commitmentHashHex)` — one-shot
  builder returning every arg `verify_hedge_stark_proof_entry` needs,
  ready to drop into a Sui PTB `moveCall`.

**Cross-language byte-exact test shipped in the same pass** — 2 Move
tests decode TS-emitted golden hex, 13 TS Jest tests exercise the
serializer + Python-JSON adapters. Both sides fail loud if either
struct schema drifts.

**Route + tx-builder shipped 2026-07-29:**
- `zk/verifier/hedgeStarkTx.ts` (~85 LOC) — `buildHedgeStarkVerifyTx`
  pure `Transaction` builder that composes the BCS serializer with a
  `moveCall` targeting `zk_verifier::verify_hedge_stark_proof_entry`.
  No execution, no side effects — safe to unit test offline.
- `app/api/zk-proof/verify-hedge-onchain/route.ts` (~150 LOC) — the
  API route. Two modes:
    * `mode: 'buildOnly'` (default) — returns serialized tx bytes for
      wallet signing. The depositor pays gas ("self-custodial" path).
    * `mode: 'execute'` — server signs with `SUI_POOL_ADMIN_KEY` and
      executes. Operator pays gas ("sponsored" path). 403 if the admin
      key isn't configured — no silent downgrade.
  Reads deployment address from `NEXT_PUBLIC_SUI_MAINNET_ZK_STARK_PKG`
  (falls back to `NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID`) and
  `NEXT_PUBLIC_SUI_ZK_VERIFIER_STATE`. Returns 503 with a clear message
  if neither is set (redeploy needed).
- Tests: 6 tx-builder unit tests. 677/677 TS total.

**Still open** (deployment-blocked, not code):
- **Testnet gas benchmark** for realistic proof sizes. Rough estimate
  ~100k-300k MIST per verify (dominated by 80 × 10 layer SHA-256
  hashes). Needs measurement on a live SUI deployment.
- **Move package redeploy** to a network. The current mainnet package
  (`0x107292…7b726`, v0.2.0) predates the STARK verifier modules
  (`zkv_field`, `zkv_merkle`, `zkv_fri`, `zkv_hedge_air`, `zkv_stark`)
  and the `verify_hedge_stark_proof_entry` entry function. Redeploy
  gives us fresh IDs to plug into the env vars above.

**Phase A is truly complete end-to-end.** Every piece of code needed to
run "depositor generates hedge proof → chain independently verifies →
ProofRecord minted with replay protection" is in the repo, tested, and
typechecks. The only remaining work is a mainnet deploy of the new Move
modules and setting the env vars.
| B.1 Rust field + Merkle + FFT (or adopt Winterfell) | ~800 Rust LOC (or ~200 glue) | pending | B.2, B.3 |
| B.2 Rust FRI | ~600 Rust LOC (or use existing) | pending | B.3, B.4 |
| B.3 Rust STARK + hedge AIR | ~600 Rust LOC | pending | B.4 |
| B.4 Rust HTTP server (byte-compat with current Python API) | ~400 Rust LOC | pending | 100x speedup done |
| **B total** | **~1000-2400 Rust LOC (2-8w depending on adopt vs build)** | | |
| C.1 wasm-pack build | ~200 LOC, 3d | pending on B | C.2 |
| C.2 Browser JS integration | ~300 TS LOC, 1w | pending on C.1 | C.3 |
| C.3 Depositor flow rewrite | ~200 TS LOC, 1w | pending on C.2 | cryptographic privacy done |
| **C total** | **~700 LOC (2-4w after B)** | | |
| D Formal verification (Coq/Lean) | ~1yr specialist | not planned | — |

**Existing files that Phase A builds on (no rewrite needed):**
- `contracts/sui/sources/zk_verifier.move` (484 LOC) — state, admin cap, replay-protection, ed25519 fast path, event emission
- `contracts/sui/sources/zk_hedge_commitment.move` (502 LOC) — commitment/nullifier storage
- `contracts/sui/sources/zk_proxy_vault.move` (727 LOC) — proxy vault
- `sui::hash::sha2_256` + `sui::ed25519::ed25519_verify` (native Move opcodes, zero LOC)
- `sui::table::Table`, `sui::dynamic_field`, `sui::clock::Clock` (already imported)
- `contracts/sui/tests/` framework already set up (see `community_pool_tests.move` for the pattern)

## Ordering recommendation

**If the constraint is "no operator trust":** ship B then C (Rust prover
→ WASM). Chain still verifies via ed25519 attestation, but the ed25519
KEY belongs to the depositor's browser, not the operator's server. That
closes the "operator sees inputs" gap without needing Move-side STARK.

**If the constraint is "no chain-side trust":** ship A (Move on-chain
STARK verifier). Chain independently verifies the STARK, no ed25519
key at all. Higher gas cost but zero prover trust.

**If both are wanted:** A + B + C. Time budget ~4-6 months.

Neither ordering is required for the current commit chain; both are
tracked as follow-ups. Whatever ships next in this doc should update
the milestone table above and cross-reference in commit messages.
