/**
 * Golden tests for the cron-auth decision boundary (lib/security/cron-auth.ts).
 * This guards money-moving cron routes; a regression here once left the
 * auto-hedge POST unauthenticated (6700b492). Both predicates must fail closed.
 */
import { describe, it, expect } from '@jest/globals';
import { createHmac } from 'crypto';
import { cronSecretMatches, classifyUnauthedOutcome, jobsSignatureMatches } from '@/lib/security/cron-auth';

describe('cronSecretMatches', () => {
  const SECRET = 's3cr3t-cron-value';

  it('accepts the exact Bearer <secret> header', () => {
    expect(cronSecretMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it('rejects a wrong secret of the same length', () => {
    const wrong = 'X'.repeat(SECRET.length);
    expect(cronSecretMatches(`Bearer ${wrong}`, SECRET)).toBe(false);
  });

  it('rejects a header missing the Bearer prefix', () => {
    expect(cronSecretMatches(SECRET, SECRET)).toBe(false);
  });

  it('rejects different-length headers without throwing', () => {
    expect(cronSecretMatches(`Bearer ${SECRET}extra`, SECRET)).toBe(false);
    expect(cronSecretMatches('Bearer short', SECRET)).toBe(false);
  });

  it('returns false for any missing input (never throws)', () => {
    expect(cronSecretMatches(null, SECRET)).toBe(false);
    expect(cronSecretMatches(undefined, SECRET)).toBe(false);
    expect(cronSecretMatches(`Bearer ${SECRET}`, undefined)).toBe(false);
    expect(cronSecretMatches(`Bearer ${SECRET}`, null)).toBe(false);
    expect(cronSecretMatches('', '')).toBe(false);
  });
});

describe('classifyUnauthedOutcome', () => {
  it('allows only when no auth is configured AND in development', () => {
    expect(classifyUnauthedOutcome({ hasSignature: false, hasCronSecret: false, isDevelopment: true }))
      .toBe('allow-dev');
  });

  it('fails closed (misconfig) when no auth is configured in production', () => {
    expect(classifyUnauthedOutcome({ hasSignature: false, hasCronSecret: false, isDevelopment: false }))
      .toBe('misconfig');
  });

  it('returns unauthorized when an auth method was present but did not validate', () => {
    // a secret is configured but the Bearer check already failed upstream
    expect(classifyUnauthedOutcome({ hasSignature: false, hasCronSecret: true, isDevelopment: false }))
      .toBe('unauthorized');
    expect(classifyUnauthedOutcome({ hasSignature: false, hasCronSecret: true, isDevelopment: true }))
      .toBe('unauthorized');
    // a signature was present but invalid → never falls through to dev-allow
    expect(classifyUnauthedOutcome({ hasSignature: true, hasCronSecret: false, isDevelopment: true }))
      .toBe('unauthorized');
    expect(classifyUnauthedOutcome({ hasSignature: true, hasCronSecret: true, isDevelopment: false }))
      .toBe('unauthorized');
  });

  it('never allows in production no matter the inputs', () => {
    const prod = (hasSignature: boolean, hasCronSecret: boolean) =>
      classifyUnauthedOutcome({ hasSignature, hasCronSecret, isDevelopment: false });
    expect([prod(false, false), prod(true, false), prod(false, true), prod(true, true)])
      .not.toContain('allow-dev');
  });
});

describe('jobsSignatureMatches', () => {
  const SECRET = 'test-jobs-signing-secret-32bytes-min';
  const JOB_ID = 'a1b2c3d4-1234-4567-89ab-cdef01234567';
  const NOW_MS = 1789852800_000;
  const TS_SEC = String(Math.floor(NOW_MS / 1000));

  const sign = (ts: string, jobId: string, body: string) =>
    'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${jobId}.${body}`).digest('hex');

  const valid = {
    secret: SECRET,
    timestampHeader: TS_SEC,
    jobIdHeader: JOB_ID,
    rawBody: '{"kind":"test"}',
    nowMs: NOW_MS,
    replayWindowSec: 300,
  };

  it('accepts a well-formed signature within the replay window', () => {
    expect(jobsSignatureMatches({ ...valid, signatureHeader: sign(TS_SEC, JOB_ID, valid.rawBody) })).toBe(true);
  });

  it('accepts a signature without the sha256= prefix', () => {
    const sig = sign(TS_SEC, JOB_ID, valid.rawBody).replace(/^sha256=/, '');
    expect(jobsSignatureMatches({ ...valid, signatureHeader: sig })).toBe(true);
  });

  it('rejects when the body was tampered with', () => {
    expect(jobsSignatureMatches({
      ...valid,
      signatureHeader: sign(TS_SEC, JOB_ID, valid.rawBody),
      rawBody: '{"kind":"tampered"}',
    })).toBe(false);
  });

  it('rejects when the timestamp is outside the replay window', () => {
    const staleTs = String(Math.floor(NOW_MS / 1000) - 3600);
    expect(jobsSignatureMatches({
      ...valid,
      timestampHeader: staleTs,
      signatureHeader: sign(staleTs, JOB_ID, valid.rawBody),
    })).toBe(false);
  });

  it('rejects a signature signed under a different secret', () => {
    const otherSig = 'sha256=' + createHmac('sha256', 'attacker-secret')
      .update(`${TS_SEC}.${JOB_ID}.${valid.rawBody}`)
      .digest('hex');
    expect(jobsSignatureMatches({ ...valid, signatureHeader: otherSig })).toBe(false);
  });

  it('returns false for any missing input (never throws)', () => {
    const s = sign(TS_SEC, JOB_ID, valid.rawBody);
    expect(jobsSignatureMatches({ ...valid, signatureHeader: s, secret: '' })).toBe(false);
    expect(jobsSignatureMatches({ ...valid, signatureHeader: s, secret: undefined })).toBe(false);
    expect(jobsSignatureMatches({ ...valid, signatureHeader: null })).toBe(false);
    expect(jobsSignatureMatches({ ...valid, signatureHeader: s, jobIdHeader: null })).toBe(false);
    expect(jobsSignatureMatches({ ...valid, signatureHeader: s, timestampHeader: 'not-a-number' })).toBe(false);
  });
});
