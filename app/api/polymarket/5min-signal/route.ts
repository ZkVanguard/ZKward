import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';
import { Polymarket5MinService } from '@/lib/services/market-data/Polymarket5MinService';

/**
 * Polymarket 5-min BTC signal endpoint.
 *
 * Returns the latest crowd-sourced 5-minute BTC direction signal
 * (UP/DOWN with probability + confidence) used by the trading agents.
 *
 * Polymarket's 5-min BTC binary markets are reported to resolve with
 * very high accuracy (>90%) — they pull from Chainlink BTC/USD on resolve.
 * Agents use these as a high-conviction directional signal.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const limited = readLimiter.check(req);
  if (limited) return limited;

  try {
    const [signal, history] = await Promise.all([
      Polymarket5MinService.getLatest5MinSignal(),
      Promise.resolve(Polymarket5MinService.getSignalHistory()),
    ]);

    if (!signal) {
      return NextResponse.json(
        {
          success: false,
          detail: null,
          historyDetail: history,
          direction: null,
          message: 'No active 5-min market window found',
          history: {
            count: history.signals.length,
            accuracy: history.accuracy,
            avgConfidence: history.avgConfidence,
          },
        },
        { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20' } },
      );
    }

    return NextResponse.json(
      {
        success: true,
        detail: signal,
        historyDetail: history,
        direction: signal.direction,
        signal: signal.direction,
        probability: signal.probability,
        upProbability: signal.upProbability,
        downProbability: signal.downProbability,
        confidence: signal.confidence,
        signalStrength: signal.signalStrength,
        recommendation: signal.recommendation,
        windowLabel: signal.windowLabel,
        timeRemainingSeconds: signal.timeRemainingSeconds,
        currentPrice: signal.currentPrice,
        priceToBeat: signal.priceToBeat,
        volume: signal.volume,
        liquidity: signal.liquidity,
        question: signal.question,
        sourceUrl: signal.sourceUrl,
        fetchedAt: signal.fetchedAt,
        history: {
          count: history.signals.length,
          accuracy: history.accuracy,
          streak: history.streak,
          avgConfidence: history.avgConfidence,
        },
      },
      { headers: { 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20' } },
    );
  } catch (error) {
    logger.error('5min-signal endpoint error', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch 5-min signal' },
      { status: 500 },
    );
  }
}
