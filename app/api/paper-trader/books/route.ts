/**
 * GET /api/paper-trader/books — every paper book from its rows: running or
 * off, closed trades over 30 days, open positions at their mark, and the
 * assumed interest kept apart. The paper page and the dashboard read it.
 */
import { NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { withOriginCache } from '@/lib/utils/origin-cache';
import { readPaperBooks } from '@/lib/services/paper-trader/books-summary';

const WINDOW_HOURS = 720;

async function handleGet(): Promise<Response> {
  try {
    const books = await readPaperBooks(WINDOW_HOURS);
    const response = NextResponse.json({ success: true, generatedAt: new Date().toISOString(), windowHours: WINDOW_HOURS, books });
    response.headers.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=86400');
    return response;
  } catch (e) {
    // A failed read is an error, never a table of zeros.
    logger.error('[paper-trader/books] failed', { error: errMsg(e) });
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 });
  }
}

export const GET = withOriginCache({ name: 'paper-books', freshSec: 60 }, handleGet);
