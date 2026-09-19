/**
 * Pure cron-auth decision logic, extracted from lib/qstash.ts so the security
 * boundary can be unit-tested without a live request. verifyCronRequest keeps
 * the I/O (QStash signature verify, NextRequest/NextResponse); these two pure
 * predicates decide the rest. Behavior-identical to the inline code they
 * replaced — locked by test/unit/cron-auth.test.ts.
 *
 * Why this matters: a cron auth regression once left the auto-hedge POST
 * unauthenticated (6700b492). The misconfig branch must reject in production
 * and only ever allow when NO auth is configured AND NODE_ENV=development.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Constant-time check that an Authorization header carries the expected
 * `Bearer <CRON_SECRET>`. Returns false (never throws) for any missing input or
 * length mismatch, so callers can use it as a plain boolean guard. The
 * length-equality pre-check is required because timingSafeEqual throws on
 * unequal-length buffers.
 */
export function cronSecretMatches(
  authHeader: string | null | undefined,
  cronSecret: string | null | undefined,
): boolean {
  if (!cronSecret || !authHeader) return false;
  const expected = Buffer.from(`Bearer ${cronSecret}`, 'utf8');
  const provided = Buffer.from(authHeader, 'utf8');
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * Verify a delivery from the self-hosted jobs.zkward.com service.
 * The service signs `${timestamp}.${jobId}.${rawBody}` with HMAC-SHA256 using
 * JOBS_SIGNING_SECRET and delivers via the x-job-signature header (format
 * `sha256=<hex>`). Callers must pass the RAW request body bytes, not a
 * re-serialized JSON string (canonicalization would produce a different HMAC).
 *
 * Returns false (never throws) for missing/invalid inputs, expired timestamps,
 * or signature mismatch. `nowMs` and `replayWindowSec` are injected for testability.
 */
export function jobsSignatureMatches(args: {
  secret: string | null | undefined;
  timestampHeader: string | null | undefined;
  jobIdHeader: string | null | undefined;
  signatureHeader: string | null | undefined;
  rawBody: string;
  nowMs: number;
  replayWindowSec: number;
}): boolean {
  const { secret, timestampHeader, jobIdHeader, signatureHeader, rawBody, nowMs, replayWindowSec } = args;
  if (!secret || !timestampHeader || !jobIdHeader || !signatureHeader) return false;

  const tsNum = Number(timestampHeader);
  if (!Number.isFinite(tsNum)) return false;
  if (Math.abs(nowMs / 1000 - tsNum) > replayWindowSec) return false;

  const supplied = signatureHeader.replace(/^sha256=/, '');
  const expected = createHmac('sha256', secret)
    .update(`${timestampHeader}.${jobIdHeader}.${rawBody}`)
    .digest('hex');

  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(supplied, 'utf8'), Buffer.from(expected, 'utf8'));
}

export type UnauthedOutcome = 'allow-dev' | 'misconfig' | 'unauthorized';

/**
 * Decide what to do once neither QStash signature nor CRON_SECRET has
 * authorized a request:
 *  - no secret AND no signature configured → 'allow-dev' in development, else
 *    'misconfig' (fail closed with a 500 in prod — auth was never set up)
 *  - otherwise (an auth method was present but didn't validate) → 'unauthorized'
 */
export function classifyUnauthedOutcome(args: {
  hasSignature: boolean;
  hasCronSecret: boolean;
  isDevelopment: boolean;
}): UnauthedOutcome {
  const { hasSignature, hasCronSecret, isDevelopment } = args;
  if (!hasCronSecret && !hasSignature) {
    return isDevelopment ? 'allow-dev' : 'misconfig';
  }
  return 'unauthorized';
}
