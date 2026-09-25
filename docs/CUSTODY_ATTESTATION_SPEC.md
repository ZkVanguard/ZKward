# Custody Attestation Primitive — Design Spec

> **Status:** Specification only. Implementation deferred to Tranche 2/3 of the
> SUI Foundation grant (~50 hours dev + ~$1.5K audit scope delta).
>
> **Purpose:** First on-chain primitive on Sui that lets an institutional
> custodian sign an attestation binding `(portfolio_id, asset_list, nonce)` to
> a wallet, proving off-chain real-world backing without revealing what's held.
> This is the bridge from "crypto vault" to "BlackRock-for-Web3" — the
> primitive that any RWA-adjacent integration needs.

## Why this matters

ZKward does not hold real-world assets today. But the codebase already has
the trust scaffolding to support them:

- 7-agent autonomous orchestrator (asset-agnostic)
- ZK-STARK attestation system (any commitment can be proven)
- Multi-chain Move deployments
- Role-based capability access (`AdminCap`, `FeeManagerCap`, `AgentCap`,
  `RebalancerCap`)
- Treasury + timelock + MSafe governance

What's missing is the **bridge from "this wallet holds X" to "Bank Y attests
this wallet's portfolio is backed by Z off-chain"**. Custody attestation is
that bridge.

After shipping this primitive:

- Institutional users can prove to counterparties that their ZKward
  portfolio is backed by off-chain T-bills, real estate, gold, etc., **without
  revealing the asset list publicly**
- ZKward becomes credible to RWA tokenizers (Ondo, Maple, Securitize
  analogs) as the autonomous risk + attestation layer for their assets
- The "BlackRock for Web3" framing earns concrete code instead of being
  aspirational

## Contract design

### `contracts/sui/sources/rwa_custody_attestor.move`

~250 LOC, single new module. Doesn't touch existing contracts.

```move
module zkward::rwa_custody_attestor {
    use sui::object::{Self, UID};
    use sui::tx_context::{Self, TxContext};
    use sui::event;
    use std::string::String;
    use std::vector;

    // === Errors ===
    const E_CUSTODIAN_NOT_ENROLLED: u64 = 1;
    const E_INVALID_SIGNATURE: u64 = 2;
    const E_NONCE_REPLAY: u64 = 3;
    const E_NOT_ADMIN: u64 = 4;

    // === State ===

    /// Registry of enrolled custodians, indexed by their ed25519 pubkey.
    /// Admin-controlled via AdminCap (transferred to MSafe per ADMINCAP_MIGRATION_RUNBOOK).
    struct AttestorRegistry has key {
        id: UID,
        // ed25519 pubkey → enrolled custodian metadata
        enrolled: vector<EnrolledCustodian>,
        admin: address,
    }

    struct EnrolledCustodian has store, drop {
        pubkey: vector<u8>,       // 32 bytes ed25519
        label: String,             // "Bank of A — Custody Division"
        jurisdiction: String,      // ISO-3166 country code
        enrolled_at: u64,
        revoked_at: u64,           // 0 = active
    }

    /// One attestation per (custodian, portfolio_id, nonce) triple.
    /// Lives as an owned object on the portfolio holder's wallet.
    struct CustodyAttestation has key, store {
        id: UID,
        portfolio_id: u64,
        custodian_pubkey: vector<u8>,
        // Hash of the off-chain asset list (commitment).
        // Asset list itself stays off-chain — only the holder + custodian
        // know what's actually backing this attestation.
        asset_list_hash: vector<u8>,  // 32 bytes
        nonce: u64,                   // monotonic per (custodian, portfolio) to prevent replay
        attested_at: u64,
        valid_until: u64,             // expires after configured TTL (default 90 days)
        // ed25519 signature over (portfolio_id || asset_list_hash || nonce || valid_until)
        signature: vector<u8>,         // 64 bytes
    }

    // === Events ===
    struct CustodianEnrolled has copy, drop {
        pubkey: vector<u8>,
        label: String,
        jurisdiction: String,
    }
    struct CustodianRevoked has copy, drop {
        pubkey: vector<u8>,
    }
    struct AttestationIssued has copy, drop {
        portfolio_id: u64,
        custodian_pubkey: vector<u8>,
        asset_list_hash: vector<u8>,
        nonce: u64,
        attested_at: u64,
        valid_until: u64,
    }

    // === Admin ===
    public entry fun enroll_custodian(
        _admin_cap: &AdminCap,
        registry: &mut AttestorRegistry,
        pubkey: vector<u8>,
        label: String,
        jurisdiction: String,
        ctx: &mut TxContext,
    ) {
        // assert pubkey.length == 32
        // append to registry.enrolled
        // emit CustodianEnrolled event
    }

    public entry fun revoke_custodian(
        _admin_cap: &AdminCap,
        registry: &mut AttestorRegistry,
        pubkey: vector<u8>,
        ctx: &mut TxContext,
    ) {
        // mark revoked_at = current_timestamp
        // emit CustodianRevoked event
    }

    // === Attestation issuance ===
    /// Anyone can submit; the ed25519 signature gates whether it's accepted.
    public entry fun submit_attestation(
        registry: &AttestorRegistry,
        portfolio_id: u64,
        asset_list_hash: vector<u8>,
        nonce: u64,
        valid_until: u64,
        custodian_pubkey: vector<u8>,
        signature: vector<u8>,
        ctx: &mut TxContext,
    ) {
        // 1. Look up custodian in registry — abort if not enrolled / revoked
        // 2. Reconstruct signed message: portfolio_id || asset_list_hash || nonce || valid_until
        // 3. Verify ed25519 signature over message with custodian_pubkey
        // 4. Check nonce > last_nonce for (custodian, portfolio) — anti-replay
        // 5. Mint CustodyAttestation owned object, transfer to tx_sender
        // 6. Emit AttestationIssued event
    }

    // === View functions ===
    public fun is_valid_attestation(
        attestation: &CustodyAttestation,
        current_time: u64,
    ): bool {
        attestation.valid_until > current_time
    }

    public fun get_attestation_summary(
        attestation: &CustodyAttestation,
    ): (u64, vector<u8>, u64, u64) {
        (attestation.portfolio_id, attestation.asset_list_hash,
         attestation.attested_at, attestation.valid_until)
    }
}
```

## TypeScript SDK

`lib/services/rwa/RwaCustodyAttestService.ts` (~150 LOC):

```typescript
export class RwaCustodyAttestService {
  /** Generate signable message for a custodian */
  buildSignableMessage(params: {
    portfolioId: bigint;
    assetListHash: Uint8Array;
    nonce: bigint;
    validUntil: bigint;
  }): Uint8Array { /* concat per Move contract spec */ }

  /** Submit a signed attestation to chain */
  async submitAttestation(params: {
    portfolioId: bigint;
    assetListHash: Uint8Array;
    nonce: bigint;
    validUntil: bigint;
    custodianPubkey: Uint8Array;
    signature: Uint8Array;
  }): Promise<{ txDigest: string; attestationObjectId: string }> { /* ... */ }

  /** Fetch all active attestations for a wallet */
  async getActiveAttestations(wallet: string): Promise<CustodyAttestation[]> { /* ... */ }

  /** Helper: hash an asset list off-chain (custodian-side) */
  hashAssetList(assets: AssetEntry[]): Uint8Array { /* SHA-256 of canonical JSON */ }
}
```

## Frontend integration

New page: `/app/[locale]/dashboard/custody-proofs/page.tsx`

For wallets holding `CustodyAttestation` objects:
- Show list of attestations (custodian label, portfolio ID, asset hash, valid until)
- For each: copy-shareable proof URL that a counterparty can verify via:
  `GET /api/custody/verify?attestation_id=<obj_id>`
- "Request new attestation" CTA — generates an off-chain request bundle
  the user can send to their custodian for signing

## Use cases unlocked

1. **Institutional LP onboarding** — hedge fund proves to a counterparty
   that their ZKward private portfolio is backed by $X of T-bills held
   at Bank Y, without revealing the T-bill ladder

2. **Insurance / reinsurance proofs** — DAO treasury proves its hedge has
   reinsurance backing from a Lloyd's syndicate, attestation visible to
   members but assets not

3. **Regulatory accommodation** — tier-3 jurisdictions require proof of
   collateral; custody attestation lets the user satisfy that without
   compromising portfolio privacy

4. **B2B SDK consumer** — RWA tokenizer like Ondo can integrate ZKward
   as the custody-attestation layer for any USDY-backed product

## Implementation effort

| Phase | Effort | Notes |
|---|---|---|
| Move contract draft + unit tests | 12 hrs | Single module, no cross-contract deps |
| Audit-prep doc + threat model | 4 hrs | Replay attacks, custodian impersonation, jurisdiction enforcement |
| TS SDK + tests | 8 hrs | Reuse existing ed25519 patterns from zk_verifier |
| Frontend page + flow | 6 hrs | Simple list + CTA, no new design system work |
| Mainnet deploy + smoke test | 4 hrs | Includes registering a test custodian |
| Audit cycle delta | ~$1.5K | +250 LOC to audit scope, ~3 day delta |
| **Total** | **~34 hrs eng + audit** | Achievable in Tranche 2 window (week 4-6) |

The earlier "50 hours" estimate accounted for buffer + integration polish.
Strict implementation is closer to 30-40 hours.

## Grant narrative — how this earns "BlackRock for Web3"

Today's pitch: "AI-managed crypto vault on Sui."
With custody attestation: "First Sui platform with institutional-grade custody
proofs, ready for RWA integration. We're the autonomous risk + attestation
infrastructure that any tokenized-real-asset issuer needs."

That framing is defensible because the primitive exists in code, the
mechanism is auditable, and the integration path for partners is documented
in the SDK. It doesn't claim ZKward *is* an RWA platform — it claims
ZKward is the **trust layer that RWA platforms need** on Sui.

## Out of scope (don't promise this in Tranche 3)

- Holding actual real-world assets ourselves (custodian role)
- KYC/AML gating of the attestation layer (that's the custodian's job)
- Specific RWA-token integrations (USDY, USDsui, etc. — those happen post-Tranche)
- Regulated wrapper / fund structure
- Multi-asset class price oracles

Last updated: 2026-06-29
