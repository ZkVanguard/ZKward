/**
 * Receives error reports from visitors' browsers (lib/utils/client-error-reporter.ts)
 * and stores them in `client_errors`. Public by necessity, so it is rate
 * limited, size capped and stores nothing it was not sent.
 */
import { NextRequest, NextResponse } from 'next/server';
import { mutationLimiter } from '@/lib/security/rate-limiter';
import { CLIENT_ERROR_KINDS, recordClientError, type ClientErrorKind } from '@/lib/db/client-errors';
import { logger } from '@/lib/utils/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8_000;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = mutationLimiter.check(request);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: 'too large' }, { status: 413 });
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const kind = body.kind as ClientErrorKind;
  const message = str(body.message);
  if (!CLIENT_ERROR_KINDS.includes(kind) || !message) return NextResponse.json({ error: 'kind and message required' }, { status: 400 });

  try {
    await recordClientError({
      kind,
      message,
      stack: str(body.stack),
      page: str(body.page),
      apiPath: str(body.apiPath),
      apiStatus: typeof body.apiStatus === 'number' ? body.apiStatus : null,
      requestId: str(body.requestId),
      build: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) || null,
      userAgent: request.headers.get('user-agent'),
    });
  } catch (e) {
    logger.warn('[client-errors] store failed', { error: e instanceof Error ? e.message : String(e) });
    return NextResponse.json({ error: 'not stored' }, { status: 503 });
  }
  return new NextResponse(null, { status: 204 });
}
