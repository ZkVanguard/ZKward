import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';

// Force dynamic rendering (uses request.url)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * Proxy endpoint for Polymarket API to avoid CORS issues.
 * Forwards all query parameters (slug, limit, closed, tag, etc.)
 * to gamma-api.polymarket.com/markets.
 */
export async function GET(req: NextRequest) {
  const limited = readLimiter.check(req);
  if (limited) return limited;

  try {
    const { searchParams } = new URL(req.url);

    // Special action: 5min-signal — return crowd-sourced BTC direction signal
    // used by agents (>90% historical resolution accuracy via Chainlink).
    const action = searchParams.get('action');
    if (action === '5min-signal') {
      const { Polymarket5MinService } = await import('@/lib/services/market-data/Polymarket5MinService');
      const signal = await Polymarket5MinService.getLatest5MinSignal();
      const history = Polymarket5MinService.getSignalHistory();
      if (!signal) {
        return NextResponse.json(
          {
            success: false,
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
    }

    // Build upstream URL — forward every query parameter the caller sent
    const upstream = new URL('https://gamma-api.polymarket.com/markets');
    searchParams.forEach((value, key) => {
      // Validate slug format to prevent injection
      if (key === 'slug' && !/^[a-zA-Z0-9_-]+$/.test(value)) {
        return; // Skip malformed slugs
      }
      upstream.searchParams.set(key, value);
    });

    // Default closed=false so we only get active markets unless caller overrides
    if (!upstream.searchParams.has('closed')) {
      upstream.searchParams.set('closed', 'false');
    }
    // Default limit when no slug-based lookup (slug returns 1 market anyway)
    if (!upstream.searchParams.has('limit') && !upstream.searchParams.has('slug')) {
      upstream.searchParams.set('limit', '100');
    }

    const url = upstream.toString();
    logger.info(`[Polymarket Proxy] Fetching: ${url}`);

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      logger.warn(`[Polymarket Proxy] Upstream error: ${response.status} ${response.statusText}`, { url });
      throw new Error(`Polymarket API returned ${response.status}`);
    }

    const data = await response.json();
    const count = Array.isArray(data) ? data.length : 1;
    logger.info(`[Polymarket Proxy] Returned ${count} market(s)`);

    // 5-minute markets move every few seconds: 15 s + stale-while-revalidate
    // showed odds up to 45 s old (0.37 here vs 0.51 at the venue). Other slug
    // lookups keep 15 s, generic lists 5 min.
    const slugParam = upstream.searchParams.get('slug') ?? '';
    const maxAge = /-5m-\d+$/.test(slugParam) ? 5 : slugParam ? 15 : 300;

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': `public, s-maxage=${maxAge}, stale-while-revalidate=${maxAge * 2}`,
      },
    });
  } catch (error) {
    logger.error('Polymarket proxy error', error);
    return NextResponse.json(
      { error: 'Failed to fetch Polymarket data' },
      { status: 500 }
    );
  }
}
