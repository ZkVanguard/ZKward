/**
 * Cron Job: SUI Pool Fee Collection (heartbeat)
 *
 * Calls `community_pool_usdc::collect_fees` with the FeeManagerCap so the
 * on-chain `last_fee_collection` timestamp is rolled forward and accumulated
 * fees are swept to the treasury wallet.
 *
 * Why this cron exists (defense-in-depth for $1B+ scale):
 *   The on-chain fee math is `fee = nav * fee_bps * seconds_elapsed / DENOM`.
 *   At Move u64 limits, this multiplication can wrap if (nav * bps * seconds)
 *   exceeds 2^64 (1.84e19). With fee_bps=50 and a daily cadence, the safe
 *   ceiling is ~$42T. Without this cron, the safe ceiling collapses to ~$370M
 *   if no deposit/withdraw activity rolls the timestamp for a full year.
 *
 *   Calling this once a day keeps the system mathematically bulletproof to
 *   tens of trillions of NAV with zero contract changes.
 *
 * Schedule: Once per day via QStash (overlaps with master cron are harmless).
 * Security: QStash signature or CRON_SECRET.
 *
 * Safe failure modes (all non-fatal, will retry next day):
 *   - FeeManagerCap held by a multisig (cron signer is not owner) → no-op
 *   - accumulated_fees == 0 (e.g., immediately after another collection)
 *     → the on-chain `assert!(total_fees > 0, E_ZERO_AMOUNT)` will revert,
 *     but no state damage; next call advances the timestamp once fees accrue.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { errMsg } from '@/lib/utils/error-handler';
import { SUI_USDC_POOL_CONFIG, SUI_USDC_COIN_TYPE } from '@/lib/types/sui-pool-types';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { setCronState } from '@/lib/db/cron-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface CollectFeesResult {
  success: boolean;
  ranAt: string;
  network: 'mainnet' | 'testnet';
  attempted: boolean;
  collected?: boolean;
  txDigest?: string;
  reason?: string;
  error?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse<CollectFeesResult>> {
  const ranAt = new Date().toISOString();
  const network: 'mainnet' | 'testnet' =
    (process.env.SUI_NETWORK as 'mainnet' | 'testnet') === 'testnet' ? 'testnet' : 'mainnet';

  const auth = await verifyCronRequest(request, 'SuiCollectFees');
  if (auth !== true) {
    return NextResponse.json(
      { success: false, ranAt, network, attempted: false, reason: 'Unauthorized' },
      { status: 401 },
    );
  }
  // After auth: an unauthenticated hit must not make the job look alive.
  void setCronState('cron:lastRun:sui-collect-fees', Date.now()).catch(() => {});

  const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  const feeManagerCapId = (process.env.SUI_FEE_MANAGER_CAP_ID || '').trim();
  const poolConfig = SUI_USDC_POOL_CONFIG[network];

  if (!adminKey) {
    return NextResponse.json({
      success: true,
      ranAt,
      network,
      attempted: false,
      reason: 'SUI_POOL_ADMIN_KEY not configured — skipping',
    });
  }
  if (!feeManagerCapId) {
    return NextResponse.json({
      success: true,
      ranAt,
      network,
      attempted: false,
      reason: 'SUI_FEE_MANAGER_CAP_ID not configured — skipping',
    });
  }
  if (!poolConfig.packageId || !poolConfig.poolStateId) {
    return NextResponse.json({
      success: true,
      ranAt,
      network,
      attempted: false,
      reason: 'pool not configured for this network',
    });
  }

  try {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { Transaction } = await import('@mysten/sui/transactions');
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

    let keypair: InstanceType<typeof Ed25519Keypair>;
    try {
      keypair = adminKey.startsWith('suiprivkey')
        ? Ed25519Keypair.fromSecretKey(adminKey)
        : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
    } catch {
      return NextResponse.json({
        success: false,
        ranAt,
        network,
        attempted: false,
        error: 'invalid admin key format',
      });
    }

    const suiClient = createFailoverSuiClient(network);

    // Pre-flight: confirm cron's hot key still owns the FeeManagerCap.
    // Once the cap is transferred to the MSafe multisig, the cron MUST stop
    // attempting auto-collection (each tx would fail noisily and burn gas).
    // We treat "not owned" as a clean no-op.
    const capObj = await suiClient.getObject({ id: feeManagerCapId, options: { showOwner: true } });
    const capOwner = capObj.data?.owner;
    const cronSigner = keypair.toSuiAddress();
    if (!capOwner || typeof capOwner !== 'object' || !('AddressOwner' in capOwner)) {
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: false,
        reason: 'FeeManagerCap owner unreadable — skipping',
      });
    }
    const ownerAddr = (capOwner as { AddressOwner: string }).AddressOwner;
    if (ownerAddr.toLowerCase() !== cronSigner.toLowerCase()) {
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: false,
        reason: `FeeManagerCap owned by ${ownerAddr} (multisig-gated) — skipping cron path`,
      });
    }

    const usdcType = SUI_USDC_COIN_TYPE[network];
    const tx = new Transaction();
    tx.moveCall({
      target: `${poolConfig.packageId}::${poolConfig.moduleName}::collect_fees`,
      typeArguments: [usdcType],
      arguments: [
        tx.object(feeManagerCapId),         // FeeManagerCap
        tx.object(poolConfig.poolStateId!), // UsdcPoolState
        tx.object('0x6'),                   // Clock
      ],
    });
    tx.setGasBudget(20_000_000);

    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    });
    const ok = result.effects?.status?.status === 'success';

    if (ok) {
      logger.info('[SuiCollectFees] ✅ collect_fees succeeded', {
        txDigest: result.digest,
        network,
      });
      await notifyDiscord(
        `Fees swept to treasury. tx: ${result.digest}`,
        'INFO',
        { network, txDigest: result.digest },
      );
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: true,
        collected: true,
        txDigest: result.digest,
      });
    }

    const errStr = result.effects?.status?.error || 'unknown failure';
    // E_ZERO_AMOUNT abort is expected when no fees accrued since last call.
    // It's NOT a real error — the cron should keep running daily.
    const isZeroAmount = /E_ZERO_AMOUNT|abort.*1\b/i.test(errStr) || errStr.includes(', 1)');
    logger.info('[SuiCollectFees] collect_fees skipped (nothing to collect or expected revert)', {
      error: errStr, network, txDigest: result.digest,
    });
    return NextResponse.json({
      success: true, // not a real failure — cron is heartbeat-style
      ranAt,
      network,
      attempted: true,
      collected: false,
      txDigest: result.digest,
      reason: isZeroAmount ? 'no fees accrued since last collection' : `revert: ${errStr}`,
    });
  } catch (e) {
    logger.error('[SuiCollectFees] exception', { error: errMsg(e) });
    return safeErrorResponse(e, 'sui-collect-fees') as NextResponse<CollectFeesResult>;
  }
}

export const POST = GET;
