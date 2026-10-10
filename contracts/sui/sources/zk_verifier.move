/// ZK Verifier Module for SUI
/// Handles zero-knowledge proof verification on SUI blockchain
#[allow(unused_const, unused_field)]
module zkvanguard::zk_verifier {
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::{Self, Clock};
    use sui::hash;
    use sui::ed25519;
    use sui::dynamic_field as df;
    use std::string::String;

    // ============ Audit 2026-06-04 — ed25519-based prover attestation ============
    //
    // The verify_proof / execute_commitment paths historically only checked
    // proof byte length. To upgrade from theatre to real verification without
    // breaking existing test deployments, an opt-in attestation model is added:
    //
    //   1. Admin calls admin_set_prover_pubkey(pubkey) with the 32-byte
    //      ed25519 public key of the off-chain STARK prover.
    //   2. From that point on, every verify call requires the proof bytes
    //      to start with a 64-byte ed25519 signature over the expected
    //      context (commitment_hash or commitment_hash || extra context).
    //   3. Until a pubkey is set, the legacy length check is preserved so
    //      existing flows keep working during migration — but operators
    //      should treat unset-pubkey state as INSECURE and set the key
    //      before relying on the ZK gate.
    //
    // Dynamic-field storage is used so the field can be added to already-
    // deployed package state objects without a struct migration.
    const PROVER_PUBKEY_KEY: vector<u8> = b"zkv_prover_pubkey_v1";

    // ============ Error Codes ============
    const E_NOT_AUTHORIZED: u64 = 0;
    const E_INVALID_PROOF: u64 = 1;
    const E_PROOF_ALREADY_USED: u64 = 2;
    const E_PROOF_EXPIRED: u64 = 3;
    const E_PAUSED: u64 = 4;

    // ============ Constants ============
    const PROOF_EXPIRY_MS: u64 = 86400000; // 24 hours in milliseconds

    // ============ Structs ============

    /// Admin capability
    public struct AdminCap has key, store {
        id: UID,
    }

    /// Verifier capability for external verifiers
    public struct VerifierCap has key, store {
        id: UID,
        verifier_address: address,
    }

    /// ZK Verifier state
    public struct ZKVerifierState has key {
        id: UID,
        /// Total proofs verified
        total_proofs_verified: u64,
        /// Used proof hashes (to prevent replay)
        used_proofs: Table<vector<u8>, bool>,
        /// Paused status
        paused: bool,
        /// Proof expiry time in ms
        proof_expiry_ms: u64,
    }

    /// Proof record
    public struct ProofRecord has key, store {
        id: UID,
        /// Proof hash
        proof_hash: vector<u8>,
        /// Commitment hash (for hedge commitments)
        commitment_hash: vector<u8>,
        /// Verifier address
        verifier: address,
        /// Timestamp of verification
        verified_at: u64,
        /// Portfolio ID associated with proof
        portfolio_id: Option<ID>,
        /// Proof type (e.g., "hedge", "rebalance", "allocation")
        proof_type: String,
        /// Additional metadata
        metadata: String,
    }

    /// ZK Commitment for hedge strategies
    public struct ZKCommitment has key, store {
        id: UID,
        /// Commitment owner
        owner: address,
        /// Commitment hash
        commitment_hash: vector<u8>,
        /// Strategy type
        strategy_type: String,
        /// Risk level (0-100)
        risk_level: u64,
        /// Created timestamp
        created_at: u64,
        /// Executed status
        executed: bool,
        /// Execution timestamp
        executed_at: Option<u64>,
    }

    // ============ Events ============

    public struct ProofVerified has copy, drop {
        proof_hash: vector<u8>,
        commitment_hash: vector<u8>,
        verifier: address,
        proof_type: String,
        timestamp: u64,
    }

    public struct CommitmentCreated has copy, drop {
        commitment_id: ID,
        owner: address,
        commitment_hash: vector<u8>,
        strategy_type: String,
        risk_level: u64,
    }

    public struct CommitmentExecuted has copy, drop {
        commitment_id: ID,
        owner: address,
        executor: address,
        timestamp: u64,
    }

    public struct ProofRejected has copy, drop {
        proof_hash: vector<u8>,
        reason: String,
        timestamp: u64,
    }

    // ============ Init ============

    fun init(ctx: &mut TxContext) {
        let sender = tx_context::sender(ctx);

        // Create admin capability
        let admin_cap = AdminCap {
            id: object::new(ctx),
        };
        transfer::transfer(admin_cap, sender);

        // Create verifier state
        let state = ZKVerifierState {
            id: object::new(ctx),
            total_proofs_verified: 0,
            used_proofs: table::new(ctx),
            paused: false,
            proof_expiry_ms: PROOF_EXPIRY_MS,
        };
        transfer::share_object(state);
    }

    // ============ Admin Functions ============

    /// Grant verifier capability
    public entry fun grant_verifier_role(
        _admin: &AdminCap,
        verifier_address: address,
        ctx: &mut TxContext,
    ) {
        let verifier_cap = VerifierCap {
            id: object::new(ctx),
            verifier_address,
        };
        transfer::transfer(verifier_cap, verifier_address);
    }

    /// Set paused status
    public entry fun set_paused(
        _admin: &AdminCap,
        state: &mut ZKVerifierState,
        paused: bool,
    ) {
        state.paused = paused;
    }

    /// Update proof expiry time
    public entry fun set_proof_expiry(
        _admin: &AdminCap,
        state: &mut ZKVerifierState,
        expiry_ms: u64,
    ) {
        state.proof_expiry_ms = expiry_ms;
    }

    /// Configure the off-chain prover's ed25519 public key.
    ///
    /// Must be exactly 32 bytes. Once set, all verify_proof /
    /// verify_proof_for_portfolio / execute_commitment calls require a
    /// real signature in the first 64 bytes of the proof data over the
    /// commitment_hash (for verify_proof) or hash(proof_data) (for
    /// execute_commitment). Pass an empty vector to clear (back to
    /// insecure length-check mode — operator emergency only).
    public entry fun admin_set_prover_pubkey(
        _admin: &AdminCap,
        state: &mut ZKVerifierState,
        pubkey: vector<u8>,
    ) {
        let len = vector::length(&pubkey);
        assert!(len == 32 || len == 0, E_INVALID_PROOF);
        if (df::exists_(&state.id, PROVER_PUBKEY_KEY)) {
            let _: vector<u8> = df::remove(&mut state.id, PROVER_PUBKEY_KEY);
        };
        if (len == 32) {
            df::add(&mut state.id, PROVER_PUBKEY_KEY, pubkey);
        };
    }

    /// Returns true if a prover pubkey is currently configured. Used by
    /// off-chain ops to detect insecure mode.
    public fun has_prover_pubkey(state: &ZKVerifierState): bool {
        df::exists_(&state.id, PROVER_PUBKEY_KEY)
    }

    /// Extract the first 64 bytes of a proof as the ed25519 signature.
    /// Returns empty if proof is shorter than 64 bytes.
    fun extract_signature(proof: &vector<u8>): vector<u8> {
        let mut sig = vector::empty<u8>();
        if (vector::length(proof) < 64) { return sig };
        let mut i: u64 = 0;
        while (i < 64) {
            vector::push_back(&mut sig, *vector::borrow(proof, i));
            i = i + 1;
        };
        sig
    }

    /// Verify proof against the configured prover. If no pubkey is set,
    /// falls back to the legacy "proof must be non-empty" check.
    fun verify_with_prover(state: &ZKVerifierState, proof: &vector<u8>, msg: &vector<u8>): bool {
        if (!df::exists_(&state.id, PROVER_PUBKEY_KEY)) {
            // INSECURE MODE — legacy length check. Operator should set
            // a prover pubkey before relying on the ZK gate.
            return vector::length(proof) > 0
        };
        if (vector::length(proof) < 64) { return false };
        let pubkey: &vector<u8> = df::borrow(&state.id, PROVER_PUBKEY_KEY);
        let sig = extract_signature(proof);
        ed25519::ed25519_verify(&sig, pubkey, msg)
    }

    // ============ Verification Functions ============

    /// Verify a ZK proof
    public entry fun verify_proof(
        state: &mut ZKVerifierState,
        proof_data: vector<u8>,
        commitment_hash: vector<u8>,
        proof_type: String,
        metadata: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!state.paused, E_PAUSED);

        let verifier = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Real verification (or fallback if no pubkey set). Message =
        // commitment_hash so the prover commits to the specific
        // commitment being verified.
        assert!(verify_with_prover(state, &proof_data, &commitment_hash), E_INVALID_PROOF);

        // AUDIT 2026-06-04 phase 4: dedup by SIGNATURE bytes, not by
        // keccak(proof_data). The signature is over commitment_hash;
        // an attacker who has any valid signature could otherwise
        // append arbitrary bytes to proof_data to mint unlimited
        // distinct keccak hashes while keeping the signature valid —
        // bypassing replay protection. Using the deterministic 64-byte
        // ed25519 signature as the dedup key closes that gap. When in
        // legacy length-check mode (no prover configured) the dedup
        // key is just the full proof_data hash, matching old behavior.
        let dedup_key = if (has_prover_pubkey(state)) {
            extract_signature(&proof_data)
        } else {
            hash::keccak256(&proof_data)
        };

        // Check if proof already used (prevent replay attacks)
        assert!(!table::contains(&state.used_proofs, dedup_key), E_PROOF_ALREADY_USED);

        // Mark proof as used
        table::add(&mut state.used_proofs, dedup_key, true);

        // Increment counter
        state.total_proofs_verified = state.total_proofs_verified + 1;

        // Create proof record (keep keccak hash in the record so off-chain
        // indexers can still verify the proof_data ↔ record link).
        let proof_hash = hash::keccak256(&proof_data);
        let proof_record = ProofRecord {
            id: object::new(ctx),
            proof_hash,
            commitment_hash,
            verifier,
            verified_at: current_time,
            portfolio_id: option::none(),
            proof_type,
            metadata,
        };

        event::emit(ProofVerified {
            proof_hash,
            commitment_hash,
            verifier,
            proof_type: proof_record.proof_type,
            timestamp: current_time,
        });

        // Transfer proof record to verifier
        transfer::transfer(proof_record, verifier);
    }

    /// Create a ZK commitment for hedge strategy
    public entry fun create_commitment(
        state: &ZKVerifierState,
        commitment_data: vector<u8>,
        strategy_type: String,
        risk_level: u64,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!state.paused, E_PAUSED);
        assert!(risk_level <= 100, E_INVALID_PROOF);

        let owner = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);
        
        // Generate commitment hash
        let commitment_hash = hash::keccak256(&commitment_data);

        let commitment = ZKCommitment {
            id: object::new(ctx),
            owner,
            commitment_hash,
            strategy_type,
            risk_level,
            created_at: current_time,
            executed: false,
            executed_at: option::none(),
        };

        let commitment_id = object::id(&commitment);

        event::emit(CommitmentCreated {
            commitment_id,
            owner,
            commitment_hash,
            strategy_type: commitment.strategy_type,
            risk_level,
        });

        transfer::transfer(commitment, owner);
    }

    /// Execute a ZK commitment
    public entry fun execute_commitment(
        _verifier: &VerifierCap,
        state: &ZKVerifierState,
        commitment: &mut ZKCommitment,
        proof_data: vector<u8>,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!state.paused, E_PAUSED);
        assert!(!commitment.executed, E_PROOF_ALREADY_USED);

        let executor = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        // Verify proof matches commitment
        let proof_hash = hash::keccak256(&proof_data);
        // In production, add proper ZK proof verification here
        assert!(vector::length(&proof_hash) > 0, E_INVALID_PROOF);

        // Real verification: prover signs the commitment_hash so
        // execution is gated by a fresh attestation, not just possession
        // of a VerifierCap.
        assert!(verify_with_prover(state, &proof_data, &commitment.commitment_hash), E_INVALID_PROOF);

        commitment.executed = true;
        commitment.executed_at = option::some(current_time);

        event::emit(CommitmentExecuted {
            commitment_id: object::id(commitment),
            owner: commitment.owner,
            executor,
            timestamp: current_time,
        });
    }

    /// Verify proof with portfolio reference
    public entry fun verify_proof_for_portfolio(
        state: &mut ZKVerifierState,
        proof_data: vector<u8>,
        commitment_hash: vector<u8>,
        portfolio_id: ID,
        proof_type: String,
        metadata: String,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        assert!(!state.paused, E_PAUSED);

        let verifier = tx_context::sender(ctx);
        let current_time = clock::timestamp_ms(clock);

        assert!(verify_with_prover(state, &proof_data, &commitment_hash), E_INVALID_PROOF);

        // AUDIT 2026-06-04 phase 4: dedup by signature, not full proof
        // hash — see verify_proof above for the rationale.
        let dedup_key = if (has_prover_pubkey(state)) {
            extract_signature(&proof_data)
        } else {
            hash::keccak256(&proof_data)
        };
        assert!(!table::contains(&state.used_proofs, dedup_key), E_PROOF_ALREADY_USED);
        table::add(&mut state.used_proofs, dedup_key, true);
        state.total_proofs_verified = state.total_proofs_verified + 1;

        let proof_hash = hash::keccak256(&proof_data);
        let proof_record = ProofRecord {
            id: object::new(ctx),
            proof_hash,
            commitment_hash,
            verifier,
            verified_at: current_time,
            portfolio_id: option::some(portfolio_id),
            proof_type,
            metadata,
        };

        event::emit(ProofVerified {
            proof_hash,
            commitment_hash,
            verifier,
            proof_type: proof_record.proof_type,
            timestamp: current_time,
        });

        transfer::transfer(proof_record, verifier);
    }

    // ============ View Functions ============

    /// Get total proofs verified
    public fun get_total_proofs_verified(state: &ZKVerifierState): u64 {
        state.total_proofs_verified
    }

    /// Check if proof has been used
    public fun is_proof_used(state: &ZKVerifierState, proof_hash: vector<u8>): bool {
        table::contains(&state.used_proofs, proof_hash)
    }

    /// Check if verifier is paused
    public fun is_paused(state: &ZKVerifierState): bool {
        state.paused
    }

    /// Get commitment info
    public fun get_commitment_info(commitment: &ZKCommitment): (address, vector<u8>, bool) {
        (commitment.owner, commitment.commitment_hash, commitment.executed)
    }

    /// Get proof record info
    public fun get_proof_info(record: &ProofRecord): (vector<u8>, address, u64) {
        (record.proof_hash, record.verifier, record.verified_at)
    }

    // ============ Test Functions ============

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx)
    }
}
