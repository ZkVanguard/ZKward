/**
 * BlueFin account and market reads.
 *
 * GET /api/agents/hedging/bluefin
 * - Current positions, balance and market data.
 *
 * This route only reads. Orders are placed by the authenticated cron routes,
 * and an operator opens or closes by hand through the admin routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { bluefinService, BLUEFIN_PAIRS } from '@/lib/services/sui/BluefinService';
import { logger } from '@/lib/utils/logger';
import { safeErrorResponse } from '@/lib/security/safe-error';

export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

const BLUEFIN_PRIVATE_KEY = process.env.BLUEFIN_PRIVATE_KEY?.trim() || null;
// Network from env - defaults to mainnet (trade.bluefin.io)
const BLUEFIN_NETWORK = (process.env.BLUEFIN_NETWORK || 'mainnet') as 'mainnet' | 'testnet';

/**
 * GET - Get BlueFin account info and positions
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const action = searchParams.get('action') || 'status';

    if (!BLUEFIN_PRIVATE_KEY) {
      return NextResponse.json({
        success: false,
        error: 'BLUEFIN_PRIVATE_KEY not configured — BlueFin service unavailable',
      }, { status: 503 });
    }

    // Initialize real client
    await bluefinService.initialize(BLUEFIN_PRIVATE_KEY, BLUEFIN_NETWORK);

    if (action === 'status') {
      const balance = await bluefinService.getBalance();
      const positions = await bluefinService.getPositions();

      return NextResponse.json({
        success: true,
        mode: 'live',
        network: `sui-${BLUEFIN_NETWORK}`,
        address: bluefinService.getAddress(),
        balance,
        positions,
        supportedPairs: Object.keys(BLUEFIN_PAIRS),
      });
    }

    if (action === 'market') {
      const symbol = searchParams.get('symbol') || 'SUI-PERP';
      const marketData = await bluefinService.getMarketData(symbol);
      const orderbook = await bluefinService.getOrderBook(symbol);

      return NextResponse.json({
        success: true,
        symbol,
        ...marketData,
        orderbook,
      });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  } catch (error) {
    logger.error('BlueFin GET failed', error instanceof Error ? error : undefined);
    return safeErrorResponse(error, 'BlueFin market data');
  }
}
