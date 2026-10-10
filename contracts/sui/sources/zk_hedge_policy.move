/// Hedge policy proofs, verified by the chain's own Groth16 verifier.
///
/// A proof says: "the hedge committed as `commitment` has an allowed asset
/// and side, leverage between 1 and `leverage_cap`, and notional at or under
/// `notional_cap_cents`". The hedge itself stays private. The circuit is
/// `zk/circuits/hedge_policy.circom`; this module holds no cryptography of
/// its own: `sui::groth16` does the verification.
///
/// Trust anchor. A `PolicyVerifier` is created from a verifying key and can
/// never change it. Anyone may create one, so an object is only worth what
/// its key is worth: an application names the verifier object it trusts, and
/// that object's key is the one produced by the circuit's setup.
///
/// What a verified proof does not say: that the order sent to a venue is the
/// committed hedge. The commitment is recorded here; opening it to an
/// auditor is what links the two.
module zkvanguard::zk_hedge_policy {
    use std::hash;
    use sui::bcs;
    use sui::event;
    use sui::groth16;
    use sui::table::{Self, Table};

    /// The commitment is not 32 bytes.
    const EBadCommitment: u64 = 1;
    /// The proof does not verify for this commitment and these caps.
    const EProofRejected: u64 = 2;
    /// This commitment was already attested on this verifier.
    const EAlreadyAttested: u64 = 3;

    /// A verifying key, fixed at creation, and the commitments attested under it.
    public struct PolicyVerifier has key {
        id: UID,
        pvk: groth16::PreparedVerifyingKey,
        /// SHA-256 of the verifying key bytes this verifier was created from.
        vk_hash: vector<u8>,
        attested: Table<vector<u8>, Attestation>,
        total_attested: u64,
    }

    /// The caps a commitment was proven against.
    public struct Attestation has copy, drop, store {
        leverage_cap: u64,
        notional_cap_cents: u64,
        epoch: u64,
    }

    public struct VerifierCreated has copy, drop {
        verifier: ID,
        vk_hash: vector<u8>,
        creator: address,
    }

    public struct HedgePolicyAttested has copy, drop {
        verifier: ID,
        commitment: vector<u8>,
        leverage_cap: u64,
        notional_cap_cents: u64,
        submitter: address,
    }

    /// Share a verifier for `vk_bytes` (the circuit's verifying key in the
    /// compressed encoding `sui::groth16` reads). Aborts on a malformed key.
    public fun create_verifier(vk_bytes: vector<u8>, ctx: &mut TxContext) {
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &vk_bytes);
        let verifier = PolicyVerifier {
            id: object::new(ctx),
            pvk,
            vk_hash: hash::sha2_256(vk_bytes),
            attested: table::new(ctx),
            total_attested: 0,
        };
        event::emit(VerifierCreated {
            verifier: object::id(&verifier),
            vk_hash: verifier.vk_hash,
            creator: ctx.sender(),
        });
        transfer::share_object(verifier);
    }

    /// True when `proof_points` proves the policy for `commitment` under
    /// these caps. Reads only; records nothing.
    public fun check(
        verifier: &PolicyVerifier,
        proof_points: vector<u8>,
        commitment: vector<u8>,
        leverage_cap: u64,
        notional_cap_cents: u64,
    ): bool {
        assert!(commitment.length() == 32, EBadCommitment);
        // Public inputs in the circuit's order: commitment, leverage cap,
        // notional cap. Each is one field element, 32 bytes little-endian.
        let mut inputs = commitment;
        inputs.append(field_element(leverage_cap));
        inputs.append(field_element(notional_cap_cents));
        groth16::verify_groth16_proof(
            &groth16::bn254(),
            &verifier.pvk,
            &groth16::public_proof_inputs_from_bytes(inputs),
            &groth16::proof_points_from_bytes(proof_points),
        )
    }

    /// Verify and record. Aborts unless the proof verifies; a commitment is
    /// attested once.
    public fun attest(
        verifier: &mut PolicyVerifier,
        proof_points: vector<u8>,
        commitment: vector<u8>,
        leverage_cap: u64,
        notional_cap_cents: u64,
        ctx: &TxContext,
    ) {
        assert!(!verifier.attested.contains(commitment), EAlreadyAttested);
        assert!(check(verifier, proof_points, commitment, leverage_cap, notional_cap_cents), EProofRejected);
        verifier.attested.add(commitment, Attestation { leverage_cap, notional_cap_cents, epoch: ctx.epoch() });
        verifier.total_attested = verifier.total_attested + 1;
        event::emit(HedgePolicyAttested {
            verifier: object::id(verifier),
            commitment,
            leverage_cap,
            notional_cap_cents,
            submitter: ctx.sender(),
        });
    }

    /// A u64 as a 32-byte little-endian field element.
    fun field_element(value: u64): vector<u8> {
        let mut bytes = bcs::to_bytes(&value);
        while (bytes.length() < 32) bytes.push_back(0);
        bytes
    }

    // ── Reads ──

    public fun is_attested(verifier: &PolicyVerifier, commitment: vector<u8>): bool {
        verifier.attested.contains(commitment)
    }

    /// The caps a commitment was proven against: (leverage cap, notional cap in cents).
    public fun attested_caps(verifier: &PolicyVerifier, commitment: vector<u8>): (u64, u64) {
        let a = verifier.attested.borrow(commitment);
        (a.leverage_cap, a.notional_cap_cents)
    }

    public fun total_attested(verifier: &PolicyVerifier): u64 { verifier.total_attested }

    public fun vk_hash(verifier: &PolicyVerifier): vector<u8> { verifier.vk_hash }
}
