import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { cryptocomExchangeService } from '@/lib/services/CryptocomExchangeService';
import { getMarketDataService } from '@/lib/services/market-data/RealMarketDataService';
import { getCachedPrice, upsertPrices } from '@/lib/db/prices';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { validatePrice, seedPrice } from '@/lib/security/price-circuit-breaker';
import { batchPriceCoalescer, priceCoalescer } from '@/lib/utils/request-deduplication';
import { readLimiter } from '@/lib/security/rate-limiter';
export const runtime = 'nodejs';

export const maxDuration = 15;
// Force dynamic rendering - this route uses request.url
export const dynamic = 'force-dynamic';

/**
 * Enhanced Market Data API using Crypto.com Exchange API
 * Supports both single and batch price queries
 */
export async function GET(request: NextRequest) {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
    const symbols = searchParams
      .get('symbols')
      ?.split(',')
      .map((s) => s.trim());
    const source = searchParams.get('source') || 'auto'; // 'auto', 'exchange', 'fallback'

    // Batch request
    if (symbols && symbols.length > 0) {
      logger.info(`[Market Data API] Fetching batch prices for: ${symbols.join(', ')}`);

      if (source === 'exchange') {
        // Direct from Exchange API — coalesced to deduplicate concurrent requests
        const cacheKey = `exchange:${symbols.sort().join(',')}`;
        const prices = await batchPriceCoalescer.get(cacheKey, () =>
          cryptocomExchangeService.getBatchPrices(symbols)
        );

        // ═══ CIRCUIT BREAKER: Validate prices before use ═══
        const validatedPrices: Record<string, number> = {};
        Object.entries(prices).forEach(([sym, price]) => {
          const result = validatePrice(sym, price);
          if (result.accepted) {
            validatedPrices[sym] = price;
          }
        });

        const priceMap = Object.fromEntries(
          Object.entries(validatedPrices).map(([sym, price]) => [sym, price])
        );

        return NextResponse.json(
          {
            success: true,
            data: Object.entries(priceMap).map(([sym, price]) => ({
              symbol: sym,
              price,
              source: 'cryptocom-exchange',
            })),
            prices: priceMap,
            source: 'cryptocom-exchange',
            timestamp: new Date().toISOString(),
          },
          {
            headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
          }
        );
      } else {
        // Use fallback system (auto). Use allSettled so one unresolvable symbol
        // does not poison the whole batch — a common failure mode when the
        // frontend requests a mix of real tickers (BTC/ETH/USDC) and derived
        // symbols like SUIPOOL that may be temporarily unavailable.
        const marketData = getMarketDataService();
        const settled = await Promise.allSettled(
          symbols.map((sym) => marketData.getTokenPrice(sym))
        );
        const prices = settled.map((r, i) =>
          r.status === 'fulfilled'
            ? r.value
            : { rejected: true, symbol: symbols[i], reason: r.reason }
        ) as Array<
          | import('@/lib/services/market-data/RealMarketDataService').MarketPrice
          | { rejected: true; symbol: string; reason: unknown }
        >;
        for (const p of prices) {
          if ('rejected' in p) {
            logger.warn(`[Market Data API] batch: skipping ${p.symbol}`, {
              error: p.reason instanceof Error ? p.reason.message : String(p.reason),
            });
          }
        }
        // Circuit breaker + webhook trigger, keeping only accepted prices
        const validatedPrices = prices.filter(
          (p): p is import('@/lib/services/market-data/RealMarketDataService').MarketPrice => {
            if ('rejected' in p) return false;
            const result = validatePrice(p.symbol, p.price);
            if (result.accepted) return true;
            return false;
          }
        );

        const priceMap = Object.fromEntries(validatedPrices.map((p) => [p.symbol, p.price]));

        return NextResponse.json(
          {
            success: true,
            data: validatedPrices.map((p) => ({
              symbol: p.symbol,
              price: p.price,
              change24h: p.change24h,
              volume24h: p.volume24h,
              source: p.source,
            })),
            prices: priceMap,
            source: 'multi-source-fallback',
            timestamp: new Date().toISOString(),
          },
          {
            headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
          }
        );
      }
    }

    // Single symbol request
    if (!symbol) {
      return NextResponse.json(
        { error: 'Either symbol or symbols parameter is required' },
        { status: 400 }
      );
    }

    // ═══ DB-FIRST: Check cache before hitting Crypto.com ═══
    // Use fast timeout to prevent serverless cold start issues
    if (source === 'auto') {
      try {
        const cached = await Promise.race([
          getCachedPrice(symbol, 30_000),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)), // 2s timeout
        ]);
        if (cached) {
          // Seed circuit breaker with known-good cached price
          seedPrice(cached.symbol, cached.price);
          logger.info(`[Market Data API] Cache HIT for ${symbol}`);
          return NextResponse.json(
            {
              success: true,
              data: {
                symbol: cached.symbol,
                price: cached.price,
                change24h: cached.change_24h,
                volume24h: cached.volume_24h,
                source: 'db-cache',
              },
              source: 'db-cache',
              timestamp: new Date().toISOString(),
            },
            {
              headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
            }
          );
        }
      } catch (cacheError) {
        logger.warn(`[Market Data API] DB cache timeout/error for ${symbol}, proceeding to fetch`);
      }
      logger.info(`[Market Data API] Cache MISS for ${symbol} — fetching from Crypto.com`);
    }

    logger.info(`[Market Data API] Fetching price for ${symbol} (source: ${source})`);

    if (source === 'exchange') {
      // Direct from Exchange API with full market data — coalesced
      const marketData = await priceCoalescer.get(`exchange:${symbol}`, async () => {
        const md = await cryptocomExchangeService.getMarketData(symbol);
        return {
          symbol: md.symbol,
          price: md.price,
          change24h: md.change24h,
          volume24h: md.volume24h,
          source: md.source,
        };
      });

      // ═══ CIRCUIT BREAKER: Validate before accepting ═══
      const cbResult = validatePrice(marketData.symbol, marketData.price);
      if (!cbResult.accepted) {
        logger.warn(`[Market Data API] Circuit breaker rejected ${symbol}: ${cbResult.reason}`);
        return NextResponse.json(
          { success: false, error: `Price rejected: ${cbResult.reason}` },
          { status: 422 }
        );
      }

      // Cache in DB for other routes
      upsertPrices([
        {
          symbol: marketData.symbol,
          price: marketData.price,
          change24h: marketData.change24h,
          volume24h: marketData.volume24h,
          source: marketData.source,
        },
      ]).catch((err) => logger.warn('Price cache write failed', { error: String(err) }));

      return NextResponse.json({
        success: true,
        data: {
          symbol: marketData.symbol,
          price: marketData.price,
          change24h: marketData.change24h,
          volume24h: marketData.volume24h,
          source: marketData.source,
        },
        source: 'cryptocom-exchange',
        timestamp: new Date().toISOString(),
      }, {
        headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
      });
    } else {
      // Use fallback system (auto) with timeout
      const marketData = getMarketDataService();

      // Race with 8s timeout to prevent Vercel function timeout
      const price = await Promise.race([
        marketData.getTokenPrice(symbol),
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('Price fetch timeout')), 8000)
        ),
      ]);

      if (!price) {
        throw new Error('Price fetch returned null');
      }

      // ═══ CIRCUIT BREAKER: Validate before accepting ═══
      const cbResult = validatePrice(price.symbol, price.price);
      if (!cbResult.accepted) {
        logger.warn(`[Market Data API] Circuit breaker rejected ${symbol}: ${cbResult.reason}`);
        return NextResponse.json(
          { success: false, error: `Price rejected: ${cbResult.reason}` },
          { status: 422 }
        );
      }

      // Cache in DB (fire and forget)
      upsertPrices([
        {
          symbol: price.symbol,
          price: price.price,
          change24h: price.change24h,
          volume24h: price.volume24h,
          source: price.source,
        },
      ]).catch((err) => logger.warn('Price cache write failed', { error: String(err) }));

      return NextResponse.json(
        {
          success: true,
          data: {
            symbol: price.symbol,
            price: price.price,
            change24h: price.change24h,
            volume24h: price.volume24h,
            source: price.source,
          },
          source: 'multi-source-fallback',
          timestamp: new Date().toISOString(),
        },
        {
          headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
        }
      );
    }
  } catch (error: unknown) {
    logger.error('[Market Data API] Error', error);

    // Return error — do NOT return stale hardcoded prices as if they are valid
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');

    logger.error(`[Market Data API] All price sources failed for ${symbol || 'unknown'}`, {
      error,
    });

    return NextResponse.json(
      {
        success: false,
        error: 'All price sources unavailable',
        symbol: symbol?.toUpperCase(),
        timestamp: new Date().toISOString(),
      },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { symbols, action = 'prices' } = body;

    if (!symbols || !Array.isArray(symbols)) {
      return NextResponse.json({ error: 'Symbols array is required' }, { status: 400 });
    }

    logger.info(`[Market Data API] POST request for ${symbols.length} symbols, action: ${action}`);

    switch (action) {
      case 'prices': {
        // Batch price fetch using Exchange API
        const prices = await cryptocomExchangeService.getBatchPrices(symbols);
        return NextResponse.json({
          success: true,
          action: 'prices',
          data: prices,
          source: 'cryptocom-exchange',
          timestamp: new Date().toISOString(),
        });
      }

      case 'market-data': {
        // Full market data for each symbol
        const dataPromises = symbols.map((sym) =>
          cryptocomExchangeService.getMarketData(sym).catch((_err: unknown) => ({
            symbol: sym,
            error: 'Failed to fetch market data',
          }))
        );
        const marketData = await Promise.all(dataPromises);

        return NextResponse.json({
          success: true,
          action: 'market-data',
          data: marketData,
          source: 'cryptocom-exchange',
          timestamp: new Date().toISOString(),
        });
      }

      case 'tickers': {
        // Get all available tickers
        const tickers = await cryptocomExchangeService.getAllTickers();
        return NextResponse.json({
          success: true,
          action: 'tickers',
          data: {
            count: tickers.length,
            tickers: tickers.slice(0, 100), // Limit to first 100 for response size
          },
          source: 'cryptocom-exchange',
          timestamp: new Date().toISOString(),
        });
      }

      default: {
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
      }
    }
  } catch (error: unknown) {
    logger.error('[Market Data API] POST error', error);
    return safeErrorResponse(error, 'Price data operation');
  }
}
