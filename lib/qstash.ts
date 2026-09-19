/**
 * Upstash QStash Integration
 * 
 * Replaces Vercel Cron Jobs with QStash for:
 * - Higher frequency scheduling (every 1-5 min vs twice daily)
 * - Free tier: 500 messages/day
 * - Automatic retries with backoff
 * - Request signature verification
 * 
 * Environment Variables Required:
 * - QSTASH_TOKEN: API token for publishing messages/schedules
 * - QSTASH_CURRENT_SIGNING_KEY: Current signing key for verification
 * - QSTASH_NEXT_SIGNING_KEY: Next signing key for key rotation
 * 
 * All variables are available in the Upstash Console → QStash → Signing Keys
 */

import { Receiver } from '@upstash/qstash';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { cronSecretMatches, classifyUnauthedOutcome, jobsSignatureMatches } from '@/lib/security/cron-auth';

const JOBS_REPLAY_WINDOW_SEC = 300;

// Lazy singleton — created on first use
let _receiver: Receiver | null = null;

function getReceiver(): Receiver | null {
  if (_receiver) return _receiver;

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentSigningKey || !nextSigningKey) {
    logger.warn('[QStash] Signing keys not configured — falling back to CRON_SECRET auth');
    return null;
  }

  _receiver = new Receiver({
    currentSigningKey,
    nextSigningKey,
  });

  return _receiver;
}

/**
 * Verify that a request is from QStash OR has a valid CRON_SECRET Bearer token.
 * 
 * Supports both auth methods so that:
 * 1. QStash-triggered requests are verified by signature
 * 2. Internal route-to-route calls (master → sub-crons) still use CRON_SECRET
 * 3. Local development works with just CRON_SECRET
 * 
 * @returns true if authorized, or a NextResponse with 401 if not
 */
export async function verifyCronRequest(
  request: NextRequest,
  routeName: string
): Promise<true | NextResponse> {
  // Method 0: self-hosted jobs.zkward.com HMAC delivery
  const jobsSig = request.headers.get('x-job-signature');
  if (jobsSig) {
    const jobsSecret = process.env.JOBS_SIGNING_SECRET?.trim();
    const rawBody = request.method === 'POST' ? await request.clone().text() : '';
    const ok = jobsSignatureMatches({
      secret: jobsSecret,
      timestampHeader: request.headers.get('x-job-timestamp'),
      jobIdHeader: request.headers.get('x-job-id'),
      signatureHeader: jobsSig,
      rawBody,
      nowMs: Date.now(),
      replayWindowSec: JOBS_REPLAY_WINDOW_SEC,
    });
    if (ok) {
      logger.debug(`[Jobs] ✅ HMAC verified for ${routeName}`, {
        jobId: request.headers.get('x-job-id'),
        attempt: request.headers.get('x-job-attempt'),
      });
      return true;
    }
    logger.warn(`[Jobs] ❌ HMAC verify failed for ${routeName}`, {
      jobId: request.headers.get('x-job-id'),
      hasSecret: !!jobsSecret,
    });
    // Fall through — allow QStash or CRON_SECRET to still authorize
  }

  // Method 1: QStash signature verification
  const signature = request.headers.get('upstash-signature');
  if (signature) {
    const receiver = getReceiver();
    if (receiver) {
      try {
        // QStash sends the body as the signed payload for POST requests
        // For GET requests, the URL is the signed payload
        const body = request.method === 'POST' 
          ? await request.clone().text() 
          : '';
        
        const isValid = await receiver.verify({
          signature,
          body,
          url: request.url,
        });

        if (isValid) {
          logger.debug(`[QStash] ✅ Signature verified for ${routeName}`);
          return true;
        }
      } catch (err: any) {
        logger.warn(`[QStash] Signature verification failed for ${routeName}:`, { 
          error: err?.message || String(err) 
        });
        // Fall through to CRON_SECRET check
      }
    }
  }

  // Method 2: Legacy CRON_SECRET Bearer token (internal calls + dev)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET?.trim();

  if (cronSecretMatches(authHeader, cronSecret)) {
    logger.debug(`[QStash] ✅ CRON_SECRET verified for ${routeName}`);
    return true;
  }

  switch (classifyUnauthedOutcome({
    hasSignature: !!signature || !!jobsSig,
    hasCronSecret: !!cronSecret,
    isDevelopment: process.env.NODE_ENV === 'development',
  })) {
    case 'allow-dev':
      logger.warn(`[QStash] ⚠️ No auth configured — allowing ${routeName} (local dev only)`);
      return true;
    case 'misconfig':
      logger.error(`[QStash] ❌ CRITICAL: No CRON_SECRET or QStash signature — rejecting ${routeName} (NODE_ENV=${process.env.NODE_ENV})`);
      return NextResponse.json(
        { success: false, error: 'Server misconfiguration: auth not configured' },
        { status: 500 }
      );
    default:
      logger.warn(`[QStash] ❌ Unauthorized request to ${routeName}`);
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
  }
}
