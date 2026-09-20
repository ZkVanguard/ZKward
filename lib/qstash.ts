/**
 * Cron auth for scheduled route deliveries.
 *
 * Legacy filename — the QStash integration was ripped 2026-09-19 after
 * migration to self-hosted jobs.zkward.com. The file is kept in place so
 * the ~40 cron-route imports of `verifyCronRequest` don't have to change
 * in the same commit. A separate rename PR will move this to
 * lib/cron-verify.ts.
 *
 * Auth methods (in priority order):
 *   1. Self-hosted jobs.zkward.com HMAC delivery (x-job-signature header)
 *   2. Legacy CRON_SECRET Bearer (master → sub-cron internal dispatch + dev)
 *
 * Env:
 *   - JOBS_SIGNING_SECRET  — HMAC key for method 1
 *   - CRON_SECRET          — Bearer token for method 2
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { cronSecretMatches, classifyUnauthedOutcome, jobsSignatureMatches } from '@/lib/security/cron-auth';

const JOBS_REPLAY_WINDOW_SEC = 300;

export async function verifyCronRequest(
  request: NextRequest,
  routeName: string
): Promise<true | NextResponse> {
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
      logger.debug(`[Jobs] HMAC verified for ${routeName}`, {
        jobId: request.headers.get('x-job-id'),
        attempt: request.headers.get('x-job-attempt'),
      });
      return true;
    }
    // TEMP diagnostic — will be tightened once secret is confirmed correct.
    const ts = request.headers.get('x-job-timestamp');
    const jid = request.headers.get('x-job-id');
    const expected = jobsSecret
      ? require('crypto').createHmac('sha256', jobsSecret).update(`${ts}.${jid}.${rawBody}`).digest('hex')
      : '(no secret)';
    logger.warn(`[Jobs] HMAC verify failed for ${routeName}`, {
      jobId: jid,
      attempt: request.headers.get('x-job-attempt'),
      hasSecret: !!jobsSecret,
      secretLen: jobsSecret?.length,
      tsHeader: ts,
      receivedSig: jobsSig,
      expectedSig: 'sha256=' + expected,
      bodyLen: rawBody.length,
      bodyStart: rawBody.slice(0, 80),
    });
    // Fall through to CRON_SECRET check.
  }

  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET?.trim();

  if (cronSecretMatches(authHeader, cronSecret)) {
    logger.debug(`[CronAuth] CRON_SECRET verified for ${routeName}`);
    return true;
  }

  switch (classifyUnauthedOutcome({
    hasSignature: !!jobsSig,
    hasCronSecret: !!cronSecret,
    isDevelopment: process.env.NODE_ENV === 'development',
  })) {
    case 'allow-dev':
      logger.warn(`[CronAuth] No auth configured — allowing ${routeName} (local dev only)`);
      return true;
    case 'misconfig':
      logger.error(`[CronAuth] No CRON_SECRET or job signature — rejecting ${routeName} (NODE_ENV=${process.env.NODE_ENV})`);
      return NextResponse.json(
        { success: false, error: 'Server misconfiguration: auth not configured' },
        { status: 500 }
      );
    default:
      logger.warn(`[CronAuth] Unauthorized request to ${routeName}`);
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
  }
}
