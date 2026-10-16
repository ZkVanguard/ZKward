/**
 * Attest a projected-hedge basket to Hedera Consensus Service.
 *
 * The dashboard's "Projected pool hedges" panel calls this once per
 * mount (or per NAV change) to anchor the entry prices + intended
 * sides in an immutable HCS message. Judges + users can then
 * verify on HashScan that the panel's "entry price" wasn't cherry-picked
 * post-hoc — it's the price at the consensus timestamp.
 *
 * Response includes the consensus timestamp, HashScan URL, and
 * observed finality (submit → consensus). This is the "Hedera stands
 * apart" story: 3-second finality, immutable audit, sub-cent cost.
 *
 * POST body:
 *   {
 *     poolNavUsd: number,
 *     positions: Array<{
 *       symbol: 'BTC' | 'ETH' | 'SUI',
 *       side: 'LONG' | 'SHORT',
 *       entryPrice: number,
 *       notionalUsd: number,
 *       marginUsd: number,
 *       leverage: number,
 *       signalConfidence?: number,
 *     }>
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { envFlag } from '@/lib/utils/env-flag';
import { createRateLimiter } from '@/lib/security/rate-limiter';

// 5/min/IP — this writes to HCS and consumes real HBAR from the operator wallet.
// Even a modest abuse loop would drain the operator balance in minutes.
const attestLimiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000, prefix: 'rl:attest-hedges' });

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

interface PositionInput {
  symbol: 'BTC' | 'ETH' | 'SUI';
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  signalConfidence?: number;
}

interface Body {
  poolNavUsd?: number;
  positions?: PositionInput[];
}

interface AttestResponse {
  attested: boolean;
  reason?: string;
  txId?: string;
  topicId?: string;
  consensusTimestamp?: string;
  finalityMs?: number;
  explorerUrl?: string;
  messagePreview?: string;
}

function badRequest(reason: string): NextResponse<AttestResponse> {
  return NextResponse.json({ attested: false, reason }, { status: 400 });
}

export async function POST(request: NextRequest): Promise<NextResponse<AttestResponse | { error: string; retryAfter?: number }>> {
  const limited = attestLimiter.check(request);
  if (limited) return limited as NextResponse<{ error: string; retryAfter?: number }>;

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return badRequest('invalid json body');
  }

  const positions = body.positions;
  if (!Array.isArray(positions) || positions.length === 0) {
    return badRequest('positions[] required');
  }
  const nav = Number(body.poolNavUsd ?? 0);
  if (!(nav > 0)) {
    return badRequest('poolNavUsd must be > 0');
  }

  if (!envFlag('HCS_AUDIT_ENABLED')) {
    return NextResponse.json({
      attested: false,
      reason: 'HCS_AUDIT_ENABLED=0 — attestation disabled in this environment',
    });
  }

  const topicId = (process.env.HCS_AUDIT_TOPIC_ID || '').trim();
  const operatorId = (process.env.HEDERA_OPERATOR_ID || '').trim();
  const operatorKey = (process.env.HEDERA_OPERATOR_KEY || '').trim();
  const network = ((process.env.HEDERA_NETWORK || 'testnet').trim()) as 'mainnet' | 'testnet';

  if (!topicId || !operatorId || !operatorKey) {
    return NextResponse.json({
      attested: false,
      reason: 'HCS operator env missing',
      topicId: topicId || undefined,
    });
  }

  // The browser builds the basket: hold it to the server's own prices, then
  // take the one slot per interval that every caller shares.
  const { basketProblem, ATTEST_MIN_INTERVAL_MS } = await import('@/lib/services/hedera/attest-basket');
  const livePrice: Record<string, number> = {};
  try {
    const { getLivePrice } = await import('@/lib/services/market-data/unified-price-provider');
    for (const sym of new Set(positions.map((p) => String(p.symbol)))) {
      if (sym === 'BTC' || sym === 'ETH' || sym === 'SUI') livePrice[sym] = await getLivePrice(sym);
    }
  } catch (e) {
    logger.warn('[attest-hedges] price check unavailable', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ attested: false, reason: 'price check unavailable; try again shortly' }, { status: 503 });
  }
  const problem = basketProblem(positions, nav, livePrice);
  if (problem) return badRequest(problem);
  const { tryClaimCronRun } = await import('@/lib/db/cron-state');
  const slot = await tryClaimCronRun('hedera-attest-hedges', ATTEST_MIN_INTERVAL_MS);
  if (!slot.claimed) {
    return NextResponse.json(
      { attested: false, reason: slot.reason === 'rate-limit' ? 'one attestation per 5 minutes; try again later' : 'could not reserve an attestation slot' },
      { status: 429 },
    );
  }

  const message = JSON.stringify({
    v: 1,
    kind: 'hedge-projection',
    poolNavUsd: Number(nav.toFixed(6)),
    positions: positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      entryPrice: Number(p.entryPrice.toFixed(6)),
      notionalUsd: Number(p.notionalUsd.toFixed(6)),
      marginUsd: Number(p.marginUsd.toFixed(6)),
      leverage: p.leverage,
      signalConfidence: p.signalConfidence,
    })),
    submittedAt: new Date().toISOString(),
  });

  // Truncate: HCS message max 1024 bytes with signatures. Our payload is
  // ~600 bytes for 3 assets — fine, but guard anyway.
  if (message.length > 900) {
    return NextResponse.json({
      attested: false,
      reason: `message too large (${message.length} bytes, max 900)`,
    });
  }

  try {
    const submittedAt = Date.now();
    const { Client, PrivateKey, TopicMessageSubmitTransaction, AccountId, TopicId } =
      await import('@hashgraph/sdk');

    const client = network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
    client.setOperator(
      AccountId.fromString(operatorId),
      operatorKey.startsWith('0x')
        ? PrivateKey.fromStringECDSA(operatorKey)
        : PrivateKey.fromString(operatorKey),
    );

    const submit = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(topicId))
      .setMessage(message)
      .execute(client);
    const receipt = await submit.getReceipt(client);
    const finalityMs = Date.now() - submittedAt;

    // Best-effort close — client holds gRPC channels.
    try { client.close(); } catch { /* ignore */ }

    const txId = submit.transactionId?.toString();
    const consensusTs = receipt.topicSequenceNumber?.toString();

    return NextResponse.json({
      attested: true,
      txId,
      topicId,
      consensusTimestamp: consensusTs,
      finalityMs,
      explorerUrl: `https://hashscan.io/${network}/topic/${topicId}`,
      messagePreview: `hedge-projection: ${positions.length} legs, NAV $${nav.toFixed(2)}`,
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logger.warn('[attest-hedges] hcs submit failed', { error: detail });
    return NextResponse.json({
      attested: false,
      reason: `hcs submit failed: ${detail}`,
      topicId,
    });
  }
}
