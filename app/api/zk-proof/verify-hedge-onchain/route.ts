/**
 * POST /api/zk-proof/verify-hedge-onchain
 *
 * Turns a Python hedge STARK proof into a Sui PTB that calls
 * `zk_verifier::verify_hedge_stark_proof_entry`, which delegates through
 * `zkv_stark::verify_hedge_stark_proof` (grinding + FRI + composition)
 * to the on-chain verifier. The chain independently confirms the hedge
 * invariants — no trust in the operator's ed25519 key required.
 *
 * The server only builds the transaction. It returns serialized bytes so the
 * caller's wallet signs and pays gas; the server never signs here, because an
 * open route that spends the operator's gas can be drained by anyone.
 *
 * Request body:
 *   {
 *     proof: <Python prover JSON>,             // required
 *     commitmentHashHex: string,               // required (64 hex, no 0x)
 *     maxFinalDegree?: number,                 // default: 80
 *   }
 *
 * Response:
 *   { mode: 'buildOnly', txBytesBase64: string, target: string, config: {...} }
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { heavyLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { createFailoverSuiClient } from '@/lib/services/sui/sui-failover-transport';
import {
  buildHedgeStarkVerifyTx,
  type HedgeStarkOnChainConfig,
} from '@/zk/verifier/hedgeStarkTx';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Every env read gets .trim() per repo convention — Vercel values carry
// trailing \r\n.
function envTrim(name: string): string {
  return (process.env[name] ?? '').trim();
}

interface RequestBody {
  proof: unknown;
  commitmentHashHex: string;
  maxFinalDegree?: number;
}

export async function POST(request: NextRequest) {
  const limited = await heavyLimiter.checkDistributed(request);
  if (limited) return limited;

  try {
    const body = (await request.json()) as RequestBody;
    const { proof, commitmentHashHex } = body;

    if (!proof || typeof proof !== 'object') {
      return NextResponse.json(
        { success: false, error: 'proof is required (Python prover JSON)' },
        { status: 400 },
      );
    }
    if (
      !commitmentHashHex ||
      typeof commitmentHashHex !== 'string' ||
      commitmentHashHex.replace(/^0x/, '').length !== 64
    ) {
      return NextResponse.json(
        { success: false, error: 'commitmentHashHex must be a 64-char hex string' },
        { status: 400 },
      );
    }

    // Address book — same env vars the existing SUI stack reads.
    const network = envTrim('SUI_NETWORK') || envTrim('NEXT_PUBLIC_SUI_NETWORK') || 'mainnet';
    const packageId =
      envTrim('NEXT_PUBLIC_SUI_MAINNET_ZK_STARK_PKG') ||
      envTrim('NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID');
    const zkVerifierStateId = envTrim('NEXT_PUBLIC_SUI_ZK_VERIFIER_STATE');

    if (!packageId || !zkVerifierStateId) {
      return NextResponse.json(
        {
          success: false,
          error:
            'STARK verifier not deployed on this network yet. Expected env vars: ' +
            'NEXT_PUBLIC_SUI_MAINNET_ZK_STARK_PKG (or NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID) ' +
            'and NEXT_PUBLIC_SUI_ZK_VERIFIER_STATE.',
          network,
        },
        { status: 503 },
      );
    }

    const config: HedgeStarkOnChainConfig = {
      packageId,
      zkVerifierStateId,
    };
    const target = `${packageId}::zk_verifier::verify_hedge_stark_proof_entry`;

    // Build the transaction. Throws on malformed proof; surfaced as 400.
    let tx;
    try {
      tx = buildHedgeStarkVerifyTx(
        proof as Parameters<typeof buildHedgeStarkVerifyTx>[0],
        commitmentHashHex,
        config,
        { maxFinalDegree: body.maxFinalDegree ? BigInt(body.maxFinalDegree) : 80n },
      );
    } catch (err) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Failed to build hedge STARK verify tx: ' +
            (err instanceof Error ? err.message : String(err)),
        },
        { status: 400 },
      );
    }

    // The client wallet supplies the sender and signs.
    const suiClient = createFailoverSuiClient(network === 'testnet' ? 'testnet' : 'mainnet');
    const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });
    return NextResponse.json({
      success: true,
      mode: 'buildOnly',
      txBytesBase64: Buffer.from(txBytes).toString('base64'),
      target,
      config: { network, packageId, zkVerifierStateId },
    });
  } catch (error: unknown) {
    logger.error('[verify-hedge-onchain] Error:', error);
    return safeErrorResponse(error, 'ZK on-chain hedge verify');
  }
}
