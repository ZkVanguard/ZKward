import { zkApiHeaders } from '@/lib/utils/zk-api-auth';
import { NextRequest, NextResponse } from 'next/server';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { heavyLimiter } from '@/lib/security/rate-limiter';
import { logger } from '@/lib/utils/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// No default host: an unset address must fail closed (.invalid never resolves).
const ZK_API_URL = (process.env.ZK_API_URL || '').trim() || 'http://prover.invalid';

export async function POST(request: NextRequest) {
  const rateLimited = await heavyLimiter.checkDistributed(request);
  if (rateLimited) return rateLimited;

  try {
    const body = await request.json();
    const { proof, statement, claim } = body;

    // The proof is bound to the statement it was generated for, so that
    // statement is what the prover must check it against. The generate route
    // returns it as `statement` (and, as an object, as `claim`). A bare
    // string claim is the older {claim, public_inputs: []} form.
    const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
    const fullStatement = isObject(statement) ? statement : isObject(claim) ? claim : null;
    if (!fullStatement && typeof claim !== 'string') {
      return NextResponse.json({ success: false, error: 'A statement or a claim is required' }, { status: 400 });
    }

    // Call the real FastAPI ZK server
    const response = await fetch(`${ZK_API_URL}/api/zk/verify`, {
      method: 'POST',
      headers: zkApiHeaders(),
      body: JSON.stringify(
        fullStatement
          ? { proof, statement: fullStatement, public_inputs: [] }
          : { proof, claim, public_inputs: [] },
      ),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ZK API error: ${response.statusText} - ${errorText}`);
    }

    const result = await response.json();

    // Defense in depth: even if the Python core-crypto verifier accepts,
    // check descriptive metadata against expected values. See
    // zk/verifier/proof-metadata-guard.ts + fa728adc for the finding
    // that Python doesn't bind security_level / field_prime / blowup to
    // the proof — an attacker could downgrade the claim without invalidating
    // the crypto.
    let verified: boolean = result.valid === true;
    let metadataViolations: string[] | undefined;
    if (verified) {
      const { checkProofMetadata } = await import('@/zk/verifier/proof-metadata-guard');
      const inner = (proof?.proof as Record<string, unknown>) || proof;
      const guard = checkProofMetadata(inner);
      if (!guard.ok) {
        logger.warn('[zk] Metadata guard rejected — refusing to trust', {
          violations: guard.violations,
        });
        verified = false;
        metadataViolations = guard.violations;
      }
    }

    return NextResponse.json({
      success: true,
      verified,
      duration_ms: result.duration_ms,
      ...(metadataViolations ? { metadata_violations: metadataViolations } : {}),
    });
  } catch (error: unknown) {
    logger.error('Error verifying proof:', error);
    return safeErrorResponse(error, 'ZK proof verification');
  }
}
