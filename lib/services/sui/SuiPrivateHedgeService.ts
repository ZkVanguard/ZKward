/**
 * SUI Private Hedge Service
 *
 * Hash commitments for hedges on SUI, and the transaction builders for the
 * published commitment contracts:
 *   - zk_hedge_commitment.move  (commitment storage + nullifier replay-protection)
 *   - zk_verifier.move          (records a commitment signed by the configured key)
 *   - zk_proxy_vault.move       (proxy vault: deposit / time-locked withdraw)
 *
 *   1. COMMITMENT   SHA-256 over the hedge; stored as 32 bytes on chain
 *   2. NULLIFIER    SHA-256(commitment || secret); prevents double-settle
 *   3. ENCRYPTION   local AES-256-GCM of the hedge details for the operator's
 *                   own records; never sent on-chain.
 *
 * These contracts check a signature, not a proof. The hedge policy proof is a
 * separate thing: `proveHedgePolicy` in `zk/prover/ProofGenerator.ts`, whose
 * commitment is the proof's own and is checked by `zk/verifier/boundsStark.ts`.
 *
 * @see contracts/sui/sources/zk_hedge_commitment.move
 * @see contracts/sui/sources/zk_verifier.move
 * @see contracts/sui/sources/zk_proxy_vault.move
 */

import { logger } from '@/lib/utils/logger';
import crypto from 'crypto';
import {
  ASSET_CODE,
  CanonicalHedgeInputs,
  HEDGE_CANONICAL_VERSION,
  HedgeAsset,
  HedgeSide,
  prepareHedgeBinding,
} from '@/zk/prover/hedgeCanonical';

// ============================================
// DEPLOYMENT CONFIG (env-driven)
// ============================================

interface ZkDeployment {
  packageId: string;
  zkHedgeCommitmentState: string;
  zkVerifierState: string;
  zkProxyVaultState: string;
  rpcUrl: string;
  explorerUrl: string;
}

const TESTNET_PRIVACY: ZkDeployment = {
  packageId: '0xb1442796d8593b552c7c27a072043639e3e6615a79ba11b87666d31b42fa283a',
  zkHedgeCommitmentState: '0x9c33f0df3d6a2e9a0f137581912aefb6aafcf0423d933fea298d44e222787b02',
  zkVerifierState: '0x6c75de60a47a9704625ecfb29c7bb05b49df215729133349345d0a15bec84be8',
  zkProxyVaultState: '0x5a0c81e3c95abe2b802e65d69439923ba786cdb87c528737e1680a0c791378a4',
  rpcUrl: 'https://fullnode.testnet.sui.io:443',
  explorerUrl: 'https://suiscan.xyz/testnet',
};

/** Read a SUI mainnet privacy-contract address from env, with optional fallback. */
function readEnv(name: string, fallback = ''): string {
  return ((typeof process !== 'undefined' ? process.env?.[name] : undefined) ?? fallback).trim();
}

function loadMainnetPrivacy(): ZkDeployment {
  return {
    packageId: readEnv('NEXT_PUBLIC_SUI_MAINNET_ZK_PRIVACY_PACKAGE_ID'),
    zkHedgeCommitmentState: readEnv('NEXT_PUBLIC_SUI_MAINNET_ZK_HEDGE_COMMITMENT_STATE'),
    zkVerifierState: readEnv('NEXT_PUBLIC_SUI_MAINNET_ZK_VERIFIER_STATE'),
    zkProxyVaultState: readEnv('NEXT_PUBLIC_SUI_MAINNET_ZK_PROXY_VAULT_STATE'),
    rpcUrl: readEnv('SUI_MAINNET_RPC', 'https://fullnode.mainnet.sui.io:443'),
    explorerUrl: 'https://suiscan.xyz/mainnet',
  };
}

// ============================================
// TYPES
// ============================================

export interface SuiHedgeCommitment {
  asset: string;
  side: 'LONG' | 'SHORT';
  size: number;
  notionalValue: number;
  leverage: number;
  entryPrice: number;
  salt: string;
}

export interface SuiPrivateHedge {
  commitmentHash: string;       // 32 bytes hex (on-chain)
  nullifier: string;            // 32 bytes hex (on-chain)
  timestamp: number;
  encryptedData: string;        // local-only — AES-256-GCM ciphertext + tag
  iv: string;                   // 12 bytes hex
}

// ============================================
// SUI PRIVATE HEDGE SERVICE
// ============================================

type Network = 'mainnet' | 'testnet';

export class SuiPrivateHedgeService {
  private network: Network;
  private config: ZkDeployment;
  private encryptionKeyHex: string;

  constructor(network: Network = 'mainnet') {
    this.network = network;
    this.config = network === 'mainnet' ? loadMainnetPrivacy() : TESTNET_PRIVACY;

    // Mainnet readiness is per-installation. Operator sets the four
    // NEXT_PUBLIC_SUI_MAINNET_ZK_* env vars after deploying the privacy
    // package; tx builders short-circuit cleanly until then.
    if (network === 'mainnet' && !this.config.packageId) {
      logger.warn('[SuiZKHedge] Mainnet privacy contracts not configured — set NEXT_PUBLIC_SUI_MAINNET_ZK_PRIVACY_PACKAGE_ID + state IDs');
    }

    // AES key derivation: dev fallback is fine for local; production must set
    // HEDGE_ENCRYPTION_SEED to a 64-hex-char value so locally stored hedge
    // details aren't trivially decryptable.
    this.encryptionKeyHex = readEnv(
      'HEDGE_ENCRYPTION_SEED',
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    );

    logger.info('[SuiZKHedge] Initialized', { network });
  }

  isMainnetReady(): boolean {
    return Boolean(
      this.config.packageId &&
      this.config.zkHedgeCommitmentState &&
      this.config.zkVerifierState &&
      this.config.zkProxyVaultState,
    );
  }

  // ============================================
  // COMMITMENT + NULLIFIER
  // ============================================

  generateCommitment(hedge: SuiHedgeCommitment): { commitmentHash: string; salt: string } {
    const salt = hedge.salt || this.randomHex(32);
    // Canonical encoding: sort keys so commitment is stable across producers.
    const data = JSON.stringify({
      asset: hedge.asset,
      entryPrice: hedge.entryPrice,
      leverage: hedge.leverage,
      notionalValue: hedge.notionalValue,
      salt,
      side: hedge.side,
      size: hedge.size,
    });
    const commitmentHash = this.sha256(data);
    logger.info('[SuiZKHedge] Commitment generated', { hash: commitmentHash.slice(0, 16) + '...' });
    return { commitmentHash, salt };
  }

  generateNullifier(commitmentHash: string, secret: string): string {
    return this.sha256(commitmentHash + secret);
  }

  // ============================================
  // TRANSACTION BUILDERS — call REAL Move entry points
  // ============================================

  buildStoreCommitmentTransaction(commitmentHash: string, nullifier: string): {
    target: string;
    arguments: unknown[];
  } {
    this.requireMainnetConfigured();
    return {
      target: `${this.config.packageId}::zk_hedge_commitment::store_commitment`,
      arguments: [
        this.config.zkHedgeCommitmentState,
        this.hexToBytes(commitmentHash),
        this.hexToBytes(nullifier),
        '0x6', // Clock
      ],
    };
  }

  /**
   * Build the call that records a signed commitment on chain. The contract
   * checks that the first 64 bytes of `proofDataHex` are an ed25519
   * signature over the commitment by the key the admin configured; it does
   * not verify a proof.
   */
  buildVerifyProofTransaction(
    proofDataHex: string,
    commitmentHash: string,
    proofType: string,
    metadata: string = '',
  ): { target: string; arguments: unknown[] } {
    this.requireMainnetConfigured();
    return {
      target: `${this.config.packageId}::zk_verifier::verify_proof`,
      arguments: [
        this.config.zkVerifierState,
        this.hexToBytes(proofDataHex),
        this.hexToBytes(commitmentHash),
        proofType,
        metadata,
        '0x6', // Clock
      ],
    };
  }

  /**
   * Deposit into a proxy vault (no stealth — uses the live Move entry point).
   * Caller must own `proxyId` (proxy created via `zk_proxy_vault::create_proxy`).
   */
  buildProxyDepositTransaction(proxyId: string): {
    target: string;
    arguments: unknown[];
    coinAmountRequired: true;
  } {
    this.requireMainnetConfigured();
    return {
      target: `${this.config.packageId}::zk_proxy_vault::deposit`,
      arguments: [
        this.config.zkProxyVaultState,
        proxyId,
        // Caller PTB splits the Coin<SUI> and passes it as the 3rd arg.
        // Marked here so transaction builders know to inject the coin.
      ],
      coinAmountRequired: true,
    };
  }

  /**
   * Withdraw from a proxy vault. The contract rejects any payload whose
   * first 64 bytes are not a valid ed25519 signature over the proxy's
   * zk_binding_hash by the configured key.
   *
   * NOTE: For amounts ≥ time_lock_threshold the Move contract returns a
   * `PendingWithdrawal` object; the caller must wait the time-lock then
   * invoke `zk_proxy_vault::execute_withdrawal` separately.
   */
  buildProxyWithdrawTransaction(
    proxyId: string,
    amount: bigint,
    proofDataHex: string,
    publicInputsHex: string[],
  ): { target: string; arguments: unknown[] } {
    this.requireMainnetConfigured();
    if (!proofDataHex || this.hexToBytes(proofDataHex).length < 64) {
      throw new Error('proofDataHex must include a 64-byte ed25519 signature prefix');
    }
    return {
      target: `${this.config.packageId}::zk_proxy_vault::withdraw`,
      arguments: [
        this.config.zkProxyVaultState,
        proxyId,
        amount.toString(),
        this.hexToBytes(proofDataHex),
        publicInputsHex.map((h) => this.hexToBytes(h)),
        '0x6', // Clock
      ],
    };
  }

  // ============================================
  // PRIVATE HEDGE LIFECYCLE
  // ============================================

  async createPrivateHedge(
    asset: string,
    side: 'LONG' | 'SHORT',
    size: number,
    notionalValue: number,
    leverage: number,
    entryPrice: number,
  ): Promise<{
    privateHedge: SuiPrivateHedge;
    storeCommitmentTx: { target: string; arguments: unknown[] } | null;
  }> {
    const hedgeData: SuiHedgeCommitment = {
      asset, side, size, notionalValue, leverage, entryPrice,
      salt: this.randomHex(32),
    };
    const { commitmentHash } = this.generateCommitment(hedgeData);
    const nullifier = this.generateNullifier(commitmentHash, this.encryptionKeyHex);
    const { encrypted, iv } = this.encrypt(JSON.stringify(hedgeData));

    const privateHedge: SuiPrivateHedge = {
      commitmentHash, nullifier, timestamp: Date.now(),
      encryptedData: encrypted, iv,
    };
    const storeCommitmentTx = this.isMainnetReady() || this.network === 'testnet'
      ? this.buildStoreCommitmentTransaction(commitmentHash, nullifier)
      : null;

    logger.info('[SuiZKHedge] Private hedge created', {
      hash: commitmentHash.slice(0, 16) + '...',
      readyForOnChain: storeCommitmentTx !== null,
    });
    return { privateHedge, storeCommitmentTx };
  }

  // ============================================
  // CANONICAL HEDGE BINDING  (zkv-hedge-v1)
  // ============================================

  /**
   * Per-asset step multipliers — snapping factor from the whole-asset
   * quantity the caller thinks in (SUI: 1, ETH: 0.01, BTC: 0.001) to the
   * integer step units the canonical binding hashes over. Must match
   * BLUEFIN_PAIRS in `lib/services/sui/bluefin/BluefinService.ts`.
   */
  private static readonly ASSET_STEP_UNITS: Record<HedgeAsset, number> = {
    BTC: 1000,   // 0.001 BTC → 1 unit
    ETH: 100,    // 0.01 ETH  → 1 unit
    SUI: 1,      // 1 SUI     → 1 unit
  };

  /**
   * Build a `CanonicalHedgeInputs` from the user-facing hedge shape +
   * per-portfolio caps. Callers who want the byte-exact binding should
   * use this instead of assembling the fields by hand.
   */
  buildCanonicalHedgeInputs(
    hedge: SuiHedgeCommitment,
    opts: {
      portfolioId: number;
      chain: string;
      leverageCap: number;
      notionalCapUsdcCents: bigint | number;
      timestampMs?: number;
      salt?: string;
    },
  ): CanonicalHedgeInputs {
    const asset = hedge.asset.toUpperCase() as HedgeAsset;
    if (!(asset in ASSET_CODE)) {
      throw new Error(`[SuiZKHedge] unsupported asset for canonical binding: ${hedge.asset}`);
    }
    const step = SuiPrivateHedgeService.ASSET_STEP_UNITS[asset];
    return {
      version: HEDGE_CANONICAL_VERSION,
      chain: opts.chain.toLowerCase(),
      portfolioId: Math.trunc(opts.portfolioId),
      timestampMs: opts.timestampMs ?? Date.now(),
      asset,
      side: hedge.side as HedgeSide,
      sizeUnits: BigInt(Math.round(hedge.size * step)),
      leverageX: Math.round(hedge.leverage),
      entryPriceUsdcCents: BigInt(Math.round(hedge.entryPrice * 100)),
      notionalValueUsdcCents: BigInt(Math.round(hedge.notionalValue * 100)),
      leverageCap: Math.round(opts.leverageCap),
      notionalCapUsdcCents: BigInt(opts.notionalCapUsdcCents),
      salt: (hedge.salt || opts.salt || this.randomHex(32)).toLowerCase(),
    };
  }

  /**
   * Canonical replacement for `generateCommitment`. Uses the fixed
   * binary layout in `zk/prover/hedgeCanonical` so the commitment is
   * byte-identical across TS and Python. Prefer this over the legacy
   * JSON-based `generateCommitment`.
   */
  generateCanonicalCommitment(
    hedge: SuiHedgeCommitment,
    opts: {
      portfolioId: number;
      chain: string;
      leverageCap: number;
      notionalCapUsdcCents: bigint | number;
      timestampMs?: number;
    },
  ): {
    commitmentHash: string;
    inputsHash: string;
    canonical: CanonicalHedgeInputs;
  } {
    const canonical = this.buildCanonicalHedgeInputs(hedge, opts);
    const binding = prepareHedgeBinding(canonical);
    logger.info('[SuiZKHedge] Canonical commitment generated', {
      commitmentHash: binding.commitmentHash.slice(0, 16) + '...',
      asset: canonical.asset,
      side: canonical.side,
    });
    return {
      commitmentHash: binding.commitmentHash,
      inputsHash: binding.inputsHash,
      canonical: binding.canonical,
    };
  }

  // ============================================
  // READ OPERATIONS
  // ============================================

  async getCommitment(_commitmentHash: string): Promise<{ exists: boolean }> {
    if (!this.isMainnetReady() && this.network === 'mainnet') return { exists: false };
    try {
      // Migrated 2026-07-29 to SuiClient (see commit 61e889cb).
      const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
      const client = createFailoverSuiClient(this.network as 'mainnet' | 'testnet');
      const res = await client.getObject({
        id: this.config.zkHedgeCommitmentState,
        options: { showContent: true },
      });
      const content = res.data?.content as { fields?: Record<string, any> } | null | undefined;
      return { exists: !!content?.fields };
    } catch (e) {
      logger.error('[SuiZKHedge] Failed to fetch commitment', { error: e });
      return { exists: false };
    }
  }

  // ============================================
  // CRYPTO HELPERS
  // ============================================

  private requireMainnetConfigured(): void {
    if (this.network === 'mainnet' && !this.isMainnetReady()) {
      throw new Error(
        'SUI mainnet privacy contracts not configured. Set NEXT_PUBLIC_SUI_MAINNET_ZK_PRIVACY_PACKAGE_ID and the three state IDs after deploying the privacy package (see docs/HEDGE_PRIVACY_MAINNET_DEPLOY.md).',
      );
    }
  }

  private sha256(input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  private randomHex(bytes: number): string {
    return crypto.randomBytes(bytes).toString('hex');
  }

  private hexToBytes(hex: string): number[] {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bytes: number[] = [];
    for (let i = 0; i < clean.length; i += 2) {
      bytes.push(parseInt(clean.slice(i, i + 2), 16));
    }
    return bytes;
  }

  private encrypt(plaintext: string): { encrypted: string; iv: string } {
    const iv = crypto.randomBytes(12);
    const key = Buffer.from(this.encryptionKeyHex.slice(0, 64), 'hex');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encBuf = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encrypted: Buffer.concat([encBuf, tag]).toString('hex'),
      iv: iv.toString('hex'),
    };
  }

  decrypt(encryptedHex: string, ivHex: string): SuiHedgeCommitment {
    const key = Buffer.from(this.encryptionKeyHex.slice(0, 64), 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const raw = Buffer.from(encryptedHex, 'hex');
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(0, raw.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const text = decipher.update(ciphertext) + decipher.final('utf8');
    return JSON.parse(text);
  }

  getDeploymentConfig(): ZkDeployment {
    return { ...this.config };
  }
}

// ============================================
// SINGLETON
// ============================================

let suiZKHedgeInstance: SuiPrivateHedgeService | null = null;
let suiZKHedgeInstanceNetwork: Network | null = null;

export function getSuiPrivateHedgeService(network: Network = 'mainnet'): SuiPrivateHedgeService {
  if (!suiZKHedgeInstance || suiZKHedgeInstanceNetwork !== network) {
    suiZKHedgeInstance = new SuiPrivateHedgeService(network);
    suiZKHedgeInstanceNetwork = network;
  }
  return suiZKHedgeInstance;
}
