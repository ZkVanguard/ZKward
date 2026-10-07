/**
 * SUI On-Chain Hedge Service
 * 
 * TypeScript service layer wrapping deployed SUI Move contracts:
 * - hedge_executor.move: On-chain hedge execution with collateral
 * - zk_proxy_vault.move: ZK-protected escrow with time-locked withdrawals
 * - zk_verifier.move: ZK proof verification
 * 
 * On-chain hedge service for SUI.
 * 
 * Flow:
 * 1. User creates hedge via frontend
 * 2. Service creates on-chain proxy via ZK Proxy Vault on SUI
 * 3. Collateral is deposited to hedge executor
 * 4. Hedge executes on BlueFin with position tracking
 * 5. On close, ZK proof required to withdraw funds
 * 
 * @see contracts/sui/sources/hedge_executor.move
 * @see contracts/sui/sources/zk_proxy_vault.move
 */

import { logger } from '@/lib/utils/logger';
import * as crypto from 'crypto';

// ============================================
// DEPLOYED CONTRACT ADDRESSES (SUI Testnet)
// ============================================

const SUI_DEPLOYMENTS = {
  testnet: {
    packageId: '0xb1442796d8593b552c7c27a072043639e3e6615a79ba11b87666d31b42fa283a',
    hedgeExecutorState: '0xb6432f1ecc1f55a1f3f3c8c09d110c4bda9ed6536bd9ea4c9cb5e739c41cb41e',
    zkProxyVaultState: '0x5a0c81e3c95abe2b802e65d69439923ba786cdb87c528737e1680a0c791378a4',
    zkVerifierState: '0x6c75de60a47a9704625ecfb29c7bb05b49df215729133349345d0a15bec84be8',
    zkHedgeCommitmentState: '0x9c33f0df3d6a2e9a0f137581912aefb6aafcf0423d933fea298d44e222787b02',
    rpcUrl: 'https://fullnode.testnet.sui.io:443',
    explorerUrl: 'https://suiscan.xyz/testnet',
  },
  mainnet: {
    packageId: '', // TBD after mainnet deployment
    hedgeExecutorState: '',
    zkProxyVaultState: '',
    zkVerifierState: '',
    zkHedgeCommitmentState: '',
    rpcUrl: 'https://fullnode.mainnet.sui.io:443',
    explorerUrl: 'https://suiscan.xyz/mainnet',
  },
} as const;

// ============================================
// TYPES
// ============================================

export interface SuiHedgeRequest {
  ownerAddress: string;       // SUI wallet address
  ownerSecret: string;        // Secret for ZK proof generation
  notionalValue: number;      // USD value of hedge
  collateralAmount: bigint;   // Collateral in MIST (1 SUI = 10^9 MIST)
  asset: string;              // Asset symbol (BTC, ETH, SUI)
  side: 'LONG' | 'SHORT';
  leverage: number;
}

export interface SuiHedgeResult {
  success: boolean;
  hedgeId?: string;           // On-chain hedge position ID
  proxyId?: string;           // ZK proxy vault proxy ID
  commitmentHash?: string;    // Hash of owner+secret
  txDigest?: string;          // SUI transaction digest
  error?: string;
}

export interface SuiWithdrawResult {
  success: boolean;
  txDigest?: string;
  amountWithdrawn?: bigint;
  error?: string;
  requiresTimelock?: boolean;
  timelockEndsAt?: number;
}

export interface SuiHedgePosition {
  hedgeId: string;
  owner: string;
  asset: string;
  side: 'LONG' | 'SHORT';
  size: number;
  leverage: number;
  entryPrice: number;
  collateral: bigint;
  commitmentHash: string;
  status: 'ACTIVE' | 'CLOSED' | 'LIQUIDATED';
  createdAt: number;
}

export interface SuiProxyInfo {
  proxyId: string;
  owner: string;
  balance: bigint;
  isActive: boolean;
  commitmentHash: string;
  timelockEndTime: number;
}

// ============================================
// SUI ON-CHAIN HEDGE SERVICE
// ============================================

export class SuiOnChainHedgeService {
  private network: keyof typeof SUI_DEPLOYMENTS;
  private config: (typeof SUI_DEPLOYMENTS)[keyof typeof SUI_DEPLOYMENTS];

  constructor(network: keyof typeof SUI_DEPLOYMENTS = 'mainnet') {
    this.network = network;
    this.config = SUI_DEPLOYMENTS[network];

    if (!this.config.packageId) {
      if (network === 'mainnet') {
        logger.error('[SuiHedge] MAINNET deployment not configured — hedge operations will fail', { network });
      } else {
        logger.warn('[SuiHedge] No deployment found for network', { network });
      }
    }

    logger.info('[SuiHedge] Initialized', {
      network,
      packageId: this.config.packageId.slice(0, 20) + '...',
    });
  }

  // ============================================
  // ZK COMMITMENT GENERATION
  // ============================================

  /**
   * Generate cryptographic commitment for hedge
   */
  generateCommitment(ownerAddress: string, secret: string): {
    commitmentHash: string;
    nullifier: string;
    salt: string;
  } {
    const salt = crypto.randomBytes(32).toString('hex');

    // commitmentHash = SHA256(ownerAddress || secret || salt)
    const commitmentData = `${ownerAddress}:${secret}:${salt}`;
    const commitmentHash = crypto
      .createHash('sha256')
      .update(commitmentData)
      .digest('hex');

    // nullifier = SHA256(secret || salt) — prevents double claims
    const nullifier = crypto
      .createHash('sha256')
      .update(`${secret}:${salt}`)
      .digest('hex');

    return { commitmentHash, nullifier, salt };
  }

  // ============================================
  // HEDGE OPERATIONS (Transaction Builders)
  // ============================================

  /**
   * Build transaction to create a new on-chain hedge position
   * Returns Move call parameters for execution via SUI dApp kit
   */
  buildCreateHedgeTransaction(request: SuiHedgeRequest): {
    target: string;
    arguments: unknown[];
    coinAmount: bigint;
  } {
    const { commitmentHash } = this.generateCommitment(
      request.ownerAddress,
      request.ownerSecret
    );

    const assetBytes = new TextEncoder().encode(request.asset);
    const sideValue = request.side === 'LONG' ? 0 : 1;

    return {
      target: `${this.config.packageId}::hedge_executor::create_hedge`,
      arguments: [
        this.config.hedgeExecutorState,
        Array.from(assetBytes),                              // asset name as bytes
        sideValue,                                            // 0=LONG, 1=SHORT
        Math.floor(request.notionalValue * 1e6),             // notional in 6 decimals
        request.leverage,                                     // leverage multiplier
        Array.from(Buffer.from(commitmentHash, 'hex')),      // commitment hash
        '0x6',                                                // Clock object
      ],
      coinAmount: request.collateralAmount,
    };
  }

  /**
   * Build transaction to close a hedge position
   */
  buildCloseHedgeTransaction(hedgeId: string, proof: Uint8Array): {
    target: string;
    arguments: unknown[];
  } {
    return {
      target: `${this.config.packageId}::hedge_executor::close_hedge`,
      arguments: [
        this.config.hedgeExecutorState,
        hedgeId,
        Array.from(proof),
        '0x6', // Clock object
      ],
    };
  }

  // ============================================
  // ZK PROXY VAULT OPERATIONS
  // ============================================

  /**
   * Build transaction to create a ZK proxy in the vault
   */
  buildCreateProxyTransaction(
    ownerAddress: string,
    secret: string,
    depositAmount: bigint,
  ): {
    target: string;
    arguments: unknown[];
    coinAmount: bigint;
  } {
    const { commitmentHash } = this.generateCommitment(ownerAddress, secret);

    return {
      target: `${this.config.packageId}::zk_proxy_vault::create_proxy`,
      arguments: [
        this.config.zkProxyVaultState,
        Array.from(Buffer.from(commitmentHash, 'hex')),
        '0x6', // Clock
      ],
      coinAmount: depositAmount,
    };
  }

  /**
   * Build transaction to deposit to an existing proxy
   */
  buildDepositToProxyTransaction(
    proxyId: string,
    amount: bigint,
  ): {
    target: string;
    arguments: unknown[];
    coinAmount: bigint;
  } {
    return {
      target: `${this.config.packageId}::zk_proxy_vault::deposit`,
      arguments: [
        this.config.zkProxyVaultState,
        proxyId,
        '0x6',
      ],
      coinAmount: amount,
    };
  }

  /**
   * Build transaction to withdraw from proxy with ZK proof
   */
  buildWithdrawFromProxyTransaction(
    proxyId: string,
    amount: bigint,
    proof: Uint8Array,
    recipient: string,
  ): {
    target: string;
    arguments: unknown[];
  } {
    return {
      target: `${this.config.packageId}::zk_proxy_vault::withdraw`,
      arguments: [
        this.config.zkProxyVaultState,
        proxyId,
        amount.toString(),
        Array.from(proof),
        recipient,
        '0x6',
      ],
    };
  }

  // ============================================
  // ZK PROOF VERIFICATION
  // ============================================

  /**
   * Build transaction to verify a ZK proof on-chain
   */
  buildVerifyProofTransaction(
    proofData: Uint8Array,
    commitmentHash: string,
    proofType: string,
  ): {
    target: string;
    arguments: unknown[];
  } {
    return {
      target: `${this.config.packageId}::zk_verifier::verify_proof`,
      arguments: [
        this.config.zkVerifierState,
        Array.from(proofData),
        Array.from(Buffer.from(commitmentHash, 'hex')),
        new TextEncoder().encode(proofType),
        '0x6',
      ],
    };
  }

  // ============================================
  // READ OPERATIONS (via SUI RPC)
  // ============================================

  /**
   * Fetch hedge position details from SUI
   */
  async getHedgePosition(hedgeId: string): Promise<SuiHedgePosition | null> {
    if (!hedgeId.startsWith('0x')) return null;
    try {
      // Migrated 2026-07-29 from raw `sui_getObject` JSON-RPC to
      // SuiClient — public fullnode deprecated the raw method name.
      const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
      const client = createFailoverSuiClient(this.network as 'mainnet' | 'testnet');
      const res = await client.getObject({
        id: hedgeId,
        options: { showContent: true, showType: true },
      });
      const content = res.data?.content as { fields?: Record<string, any> } | null | undefined;
      const fields = content?.fields;
      if (!fields) return null;
      let asset: string;
      try {
        asset = new TextDecoder().decode(new Uint8Array(fields.asset || []));
      } catch {
        asset = String(fields.asset || 'UNKNOWN');
      }
      return {
        hedgeId,
        owner: fields.owner,
        asset,
        side: fields.side === 0 ? 'LONG' : 'SHORT',
        size: Number(fields.notional_value) / 1e6,
        leverage: Number(fields.leverage),
        entryPrice: Number(fields.entry_price || 0) / 1e6,
        collateral: BigInt(fields.collateral || '0'),
        commitmentHash: Buffer.from(fields.commitment_hash || []).toString('hex'),
        status: fields.is_active ? 'ACTIVE' : 'CLOSED',
        createdAt: Number(fields.created_at || 0),
      };
    } catch (error) {
      logger.error('[SuiHedge] Failed to fetch position', { hedgeId, error });
      return null;
    }
  }

  /**
   * Fetch proxy vault info
   */
  async getProxyInfo(proxyId: string): Promise<SuiProxyInfo | null> {
    if (!proxyId.startsWith('0x')) return null;
    try {
      // Migrated 2026-07-29 to SuiClient (see getHedgePosition above).
      const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
      const client = createFailoverSuiClient(this.network as 'mainnet' | 'testnet');
      const res = await client.getObject({
        id: proxyId,
        options: { showContent: true },
      });
      const content = res.data?.content as { fields?: Record<string, any> } | null | undefined;
      const fields = content?.fields;
      if (!fields) return null;
      return {
        proxyId,
        owner: fields.owner,
        balance: BigInt(fields.balance || '0'),
        isActive: fields.is_active ?? true,
        commitmentHash: Buffer.from(fields.commitment_hash || []).toString('hex'),
        timelockEndTime: Number(fields.timelock_end || 0),
      };
    } catch (error) {
      logger.error('[SuiHedge] Failed to fetch proxy info', { proxyId, error });
      return null;
    }
  }

  /**
   * Get all hedge positions owned by an address
   */
  async getPositionsByOwner(ownerAddress: string): Promise<SuiHedgePosition[]> {
    try {
      const response = await fetch(this.config.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'suix_getOwnedObjects',
          params: [
            ownerAddress,
            {
              filter: {
                StructType: `${this.config.packageId}::hedge_executor::HedgePosition`,
              },
              options: { showContent: true, showType: true },
            },
          ],
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json();
      const objects = data.result?.data || [];

      return objects.map((obj: Record<string, unknown>) => {
        const fields = (obj as { data?: { content?: { fields?: Record<string, unknown> } } }).data?.content?.fields || {};
        let asset: string;
        try {
          asset = new TextDecoder().decode(new Uint8Array((fields.asset as number[]) || []));
        } catch {
          asset = String(fields.asset || 'UNKNOWN');
        }
        return {
          hedgeId: (obj as { data?: { objectId?: string } }).data?.objectId || '',
          owner: ownerAddress,
          asset,
          side: fields.side === 0 ? 'LONG' : 'SHORT',
          size: Number(fields.notional_value || 0) / 1e6,
          leverage: Number(fields.leverage || 1),
          entryPrice: Number(fields.entry_price || 0) / 1e6,
          collateral: BigInt(String(fields.collateral || '0')),
          commitmentHash: Buffer.from((fields.commitment_hash as number[]) || []).toString('hex'),
          status: fields.is_active ? 'ACTIVE' : 'CLOSED',
          createdAt: Number(fields.created_at || 0),
        } as SuiHedgePosition;
      });
    } catch (error) {
      logger.error('[SuiHedge] Failed to fetch positions by owner', { ownerAddress, error });
      return [];
    }
  }

  // ============================================
  // UTILITY METHODS
  // ============================================

  /**
   * Get deployment config
   */
  getDeploymentConfig() {
    return { ...this.config };
  }

  /**
   * Get explorer URL for an object
   */
  getExplorerUrl(objectId: string): string {
    return `${this.config.explorerUrl}/object/${objectId}`;
  }

  /**
   * Get explorer URL for a transaction
   */
  getTxExplorerUrl(digest: string): string {
    return `${this.config.explorerUrl}/tx/${digest}`;
  }
}

// ============================================
// SINGLETON
// ============================================

let suiHedgeServiceInstance: SuiOnChainHedgeService | null = null;

export function getSuiOnChainHedgeService(
  network: keyof typeof SUI_DEPLOYMENTS = 'mainnet'
): SuiOnChainHedgeService {
  if (!suiHedgeServiceInstance || suiHedgeServiceInstance['network'] !== network) {
    suiHedgeServiceInstance = new SuiOnChainHedgeService(network);
  }
  return suiHedgeServiceInstance;
}
