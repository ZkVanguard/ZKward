/**
 * Hedera pool → BluFin hedge execution bridge.
 *
 * Wires the Hedera community pool's AI signals to BluFin (SUI perps),
 * closing the "projection vs execution" gap the projected-hedges panel
 * has been openly acknowledging. Story for the demo:
 *
 *   Hedera pool NAV + AI signals   →   this endpoint decides
 *   ↓
 *   BluFin (SUI perps) executes   ←   already-live cron wiring
 *   ↓
 *   HCS receipt anchors the trade   ←   proves the round-trip on-chain
 *
 * Modes:
 *   - Default (dry-run): computes the intent, anchors it on HCS with
 *     source: 'hedera-pool-hedge-intent', returns the intent payload.
 *     No BluFin call.
 *   - HEDERA_HEDGE_EXECUTE=1: also fires bluefinService.openHedge with
 *     the computed intent. Real position on SUI perps. Only flip when
 *     the operator wallet has funded margin.
 *
 * Endpoint: POST /api/hedera/execute-hedge
 * Auth: CRON_SECRET (Bearer). Not public — this can move money when
 * HEDERA_HEDGE_EXECUTE=1.
 *
 * Env
 *   CRON_SECRET              auth
 *   HEDERA_HEDGE_EXECUTE     '1' to actually call BluFin (default: 0)
 *   HEDERA_HEDGE_MAX_PCT     max % of Hedera pool NAV per hedge (default: 30)
 *   HEDERA_HEDGE_LEVERAGE    leverage (default: 2)
 *   HCS_AUDIT_TOPIC_ID       topic to anchor receipts (default: existing)
 *   HEDERA_OPERATOR_ID/KEY   HCS submit auth
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { envFlag } from '@/lib/utils/env-flag';
import { cronSecretMatches } from '@/lib/security/cron-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface HederaAI {
  success?: boolean;
  recommendation?: {
    allocations: Record<string, number>;
    confidence: number;
    reasoning: string;
    indicators: Array<{ asset: string; trend: string; price: number }>;
  };
}

interface HederaPool {
  success?: boolean;
  pool?: { totalValueUSD?: number };
}

interface HedgeIntent {
  source: 'hedera-pool';
  asset: 'BTC' | 'ETH' | 'SUI';
  side: 'LONG' | 'SHORT';
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  confidence: number;
  reasoning: string;
  poolNavUsd: number;
}

const HEDERA_HEDGE_MAX_PCT = 30;
const HEDERA_HEDGE_LEVERAGE = 2;
const MIN_NAV_TO_HEDGE_USD = 10;

/**
 * Pick the strongest signal from the AI recommendation and translate it
 * into a BluFin-ready intent. Uses the FIRST asset whose trend is
 * bullish or bearish; skips neutral. Notional = min(pool NAV × max%,
 * BluFin minimum for the asset).
 */
function buildIntent(pool: HederaPool, ai: HederaAI): HedgeIntent | null {
  const navUsd = Number(pool?.pool?.totalValueUSD) || 0;
  if (navUsd < MIN_NAV_TO_HEDGE_USD) return null;
  const rec = ai?.recommendation;
  if (!rec) return null;
  const indicators = rec.indicators ?? [];
  // Pick the strongest non-neutral signal, prioritising higher confidence
  // and non-USDC assets.
  const candidate = indicators
    .filter((i) => (i.asset === 'BTC' || i.asset === 'ETH' || i.asset === 'SUI') && i.trend !== 'neutral')
    .sort((a, b) => (rec.allocations[b.asset] ?? 0) - (rec.allocations[a.asset] ?? 0))[0];
  if (!candidate) return null;
  const notionalUsd = Math.max(1, (navUsd * HEDERA_HEDGE_MAX_PCT) / 100);
  const marginUsd = notionalUsd / HEDERA_HEDGE_LEVERAGE;
  return {
    source: 'hedera-pool',
    asset: candidate.asset as 'BTC' | 'ETH' | 'SUI',
    side: candidate.trend === 'bullish' ? 'LONG' : 'SHORT',
    notionalUsd: Number(notionalUsd.toFixed(4)),
    marginUsd: Number(marginUsd.toFixed(4)),
    leverage: HEDERA_HEDGE_LEVERAGE,
    confidence: rec.confidence,
    reasoning: rec.reasoning?.slice(0, 240) ?? 'no reasoning',
    poolNavUsd: navUsd,
  };
}

/**
 * Anchor the intent (or executed trade) on HCS so the round-trip is
 * verifiable on-chain independent of our API.
 */
async function anchorOnHcs(payload: unknown, kind: 'intent' | 'executed'): Promise<{ txId?: string; topicId?: string; explorerUrl?: string; error?: string }> {
  if (!envFlag('HCS_AUDIT_ENABLED')) return { error: 'HCS_AUDIT_ENABLED=0' };
  const topicId = (process.env.HCS_AUDIT_TOPIC_ID || '').trim();
  const operatorId = (process.env.HEDERA_OPERATOR_ID || '').trim();
  const operatorKey = (process.env.HEDERA_OPERATOR_KEY || '').trim();
  const network = ((process.env.HEDERA_NETWORK || 'testnet').trim()) as 'mainnet' | 'testnet';
  if (!topicId || !operatorId || !operatorKey) return { error: 'HCS env missing' };
  try {
    const { Client, PrivateKey, TopicMessageSubmitTransaction, AccountId, TopicId } = await import('@hashgraph/sdk');
    const client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
    client.setOperator(
      AccountId.fromString(operatorId),
      operatorKey.startsWith('0x') ? PrivateKey.fromStringECDSA(operatorKey) : PrivateKey.fromString(operatorKey),
    );
    const message = JSON.stringify({ v: 1, kind: `hedera-pool-hedge-${kind}`, ts: new Date().toISOString(), payload });
    const submit = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(message)
      .execute(client);
    await submit.getReceipt(client);
    try { client.close(); } catch { /* ignore */ }
    const txId = submit.transactionId?.toString();
    return {
      topicId,
      txId,
      explorerUrl: `https://hashscan.io/${network}/transaction/${txId}`,
    };
  } catch (e) {
    logger.warn('[hedera-hedge/hcs] submit failed', { error: e instanceof Error ? e.message : String(e) });
    return { error: e instanceof Error ? e.message : 'unknown' };
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!cronSecretMatches(request.headers.get('authorization') || '', process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const origin = new URL(request.url).origin;
  // Read pool state + AI recommendation from the same endpoints the
  // dashboard uses — single source of truth, no drift.
  const [poolRes, aiRes] = await Promise.all([
    fetch(`${origin}/api/community-pool?chain=hedera&network=testnet`, { cache: 'no-store' }),
    fetch(`${origin}/api/community-pool/ai-decision?chain=hedera&network=testnet`, { cache: 'no-store' }),
  ]);
  const pool = (await poolRes.json()) as HederaPool;
  const ai = (await aiRes.json()) as HederaAI;

  const intent = buildIntent(pool, ai);
  if (!intent) {
    const receipt = await anchorOnHcs({ reason: 'no-actionable-signal', navUsd: pool?.pool?.totalValueUSD, confidence: ai?.recommendation?.confidence }, 'intent');
    return NextResponse.json({
      ok: true,
      executed: false,
      reason: 'no actionable signal (weak signals or NAV below floor)',
      poolNavUsd: pool?.pool?.totalValueUSD ?? 0,
      confidence: ai?.recommendation?.confidence ?? null,
      hcs: receipt,
    });
  }

  // Dry-run by default. When HEDERA_HEDGE_EXECUTE=1 flips, we also fire
  // BluefinService.openHedge with these params. The service already lives
  // in the SUI cron path; we just call it directly with the same shape.
  const executeReal = envFlag('HEDERA_HEDGE_EXECUTE');
  let executionResult: { orderId?: string; txHash?: string; error?: string } | null = null;
  if (executeReal) {
    try {
      const { bluefinService } = await import('@/lib/services/sui/BluefinService');
      const res = await bluefinService.openHedge({
        symbol: intent.asset,
        side: intent.side,
        size: intent.notionalUsd,
        leverage: intent.leverage,
        reason: `hedera-pool AI signal (${intent.confidence}% conf): ${intent.side} ${intent.asset} @ 2x`,
        clientOrderId: `hedera_pool_${Date.now()}`,
      });
      executionResult = {
        orderId: res.orderId,
        txHash: res.txDigest,
        error: res.error,
      };
    } catch (e) {
      executionResult = { error: e instanceof Error ? e.message : String(e) };
    }
  }

  const receipt = await anchorOnHcs(
    { intent, execution: executionResult, mode: executeReal ? 'live' : 'dry-run' },
    executeReal ? 'executed' : 'intent',
  );

  return NextResponse.json({
    ok: true,
    executed: executeReal && !executionResult?.error,
    mode: executeReal ? 'live' : 'dry-run',
    intent,
    execution: executionResult,
    hcs: receipt,
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Same handler, GET-friendly for browser inspection during demos.
  return POST(request);
}
