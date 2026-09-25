# Deploy `rwa_custody_attestor` to Sui Mainnet — Runbook

> Module is built + tested (`sui move test rwa_custody` → 11/11 PASS).
> This runbook is for the deployment operator to execute when ready.

## Pre-deployment checklist

- [ ] Operator wallet has ≥ 0.5 SUI for gas (`sui client gas`)
- [ ] You're on the right network: `sui client active-env` → `mainnet`
- [ ] `Move.toml` `published-at` is correct (auto-managed; do **not** hand-edit before deploy)
- [ ] Tests pass locally: `cd contracts/sui && sui move test rwa_custody`
- [ ] Backup the current `Move.toml` — `sui move build` rewrites the `[env]` block

## Decision: package upgrade vs. new package

The `rwa_custody_attestor` module is a NEW capability that doesn't touch any
existing module. Two options:

| Option | Pros | Cons |
|---|---|---|
| **Package upgrade** (add module to existing v0.2.0 package) | Shared deployment, same `UpgradeCap`, one mainnet object to reference everywhere | Forces re-publish of all 10 existing modules; bigger gas cost; small risk of upgrade-compatibility issue on any existing module |
| **New standalone package** | Isolated blast radius, can iterate independently, cleaner audit scope | New package ID to track in env vars; need separate `UpgradeCap`; no implicit dependency on `zk_verifier`'s AdminCap |

**Recommendation: package upgrade.** Adding a single module to an existing
package is the standard Sui pattern. Upgrade compatibility for unchanged
modules is automatic. Bigger gas cost is ~0.05 SUI — negligible.

## Deployment commands (upgrade path)

```powershell
# From repo root
cd contracts/sui

# Verify build + tests
sui move build
sui move test rwa_custody    # expect 11/11 PASS

# Identify the UpgradeCap object on operator wallet
sui client objects --json `
  | jq '.[] | select(.data.type | test("UpgradeCap"))'
# Expected: the existing v0.2.0 UpgradeCap (per DEPLOY_2026-06-12_v0.2.0.md)

# Upgrade
sui client upgrade `
  --upgrade-capability <upgrade_cap_object_id> `
  --gas-budget 700000000

# After upgrade, the new package ID will be printed. Save it.
```

## Post-deployment

1. **Capture the new package ID + objects** from the upgrade transaction effects:
   - `NEXT_PUBLIC_SUI_MAINNET_CUSTODY_ATTESTOR_PACKAGE` = new package ID
   - `NEXT_PUBLIC_SUI_MAINNET_CUSTODY_ATTESTOR_REGISTRY` = shared AttestorRegistry object ID
   - `NEXT_PUBLIC_SUI_MAINNET_CUSTODY_ATTESTOR_ADMIN_CAP` = AdminCap (sent to operator wallet)
2. **Add to Vercel env**: paste the 3 vars into Vercel project settings,
   redeploy production
3. **Smoke test**:
   ```bash
   # Should now return deployed=true with empty attestations[]
   curl "https://www.zkward.com/api/custody?action=list-attestations&wallet=0x<your_wallet>"
   ```
4. **Enroll the first custodian** (test ed25519 key for now):
   ```typescript
   import { RwaCustodyAttestService } from '@/lib/services/sui/RwaCustodyAttestService';
   import { ed25519 } from '@noble/curves/ed25519';

   const privKey = ed25519.utils.randomPrivateKey();
   const pubKey = ed25519.getPublicKey(privKey);

   const svc = new RwaCustodyAttestService(client, PACKAGE, REGISTRY);
   const tx = svc.buildEnrollCustodianTx(
     ADMIN_CAP_ID,
     pubKey,
     'ZKward Internal Test Custodian',
     'US',
   );
   // sign + execute with operator wallet
   ```
5. **Transfer AdminCap to MSafe** per `ADMINCAP_MIGRATION_RUNBOOK.md`
6. **Update `docs/VISION.md`** — move Phase 5 to "✅ SHIPPED"

## Estimated deployment cost

- Gas: 0.05-0.15 SUI (~$0.10-$0.30 at current SUI prices)
- Time: 30 min for the deploy + smoke test
- Audit delta: ~$1.5K (250 LOC added to external audit scope)

## Files involved

- `contracts/sui/sources/rwa_custody_attestor.move` (~340 LOC)
- `contracts/sui/tests/rwa_custody_attestor_tests.move`
- `lib/services/sui/RwaCustodyAttestService.ts`
- `app/api/custody/route.ts` (single action-dispatched route — list-attestations · build-message · hash-assets · verify)
- `app/[locale]/dashboard/custody-proofs/page.tsx`

## Rollback

If a critical bug is found post-deployment:

1. **Don't try to "downgrade" — Sui upgrades are forward-only.**
2. Operator calls `revoke_custodian` for every enrolled custodian (kills attestation issuance).
3. Hotfix the module → publish a new upgrade → consumers point to new package.
4. Existing CustodyAttestation objects in user wallets remain valid as
   read-only view; the registry-side gate prevents new abuse.

## Out of scope for this deployment

- KYC/jurisdiction enforcement at submission time (handled by custodian-side governance)
- Asset price oracle integration (this primitive proves backing, not value)
- Custodian-facing UI (custodians sign off-platform; we provide the message-build endpoint)

Last updated: 2026-06-29
