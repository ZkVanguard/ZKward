/**
 * POST /api/zk-proof/generate
 *
 * Makes a bounds ZK-STARK in this process and returns it with the verifier's
 * verdict. Two request shapes:
 *   { statement: { kind, bounds, product? }, witness: { values, payload? } }
 *   { hedge: { asset, side, leverageX, ... }, caps: { leverage_cap, notional_cap_cents } }
 *
 * A witness outside its statement gets 422 and no proof.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { heavyLimiter } from '@/lib/security/rate-limiter';
import { ProofRefusedError, proveBounds, proveHedgePolicy } from '@/zk/prover/ProofGenerator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export async function POST(request: NextRequest) {
  const rateLimited = await heavyLimiter.checkDistributed(request);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'The request body is not JSON' }, { status: 400 });
  }
  if (!isObject(body)) return NextResponse.json({ success: false, error: 'The request body is not an object' }, { status: 400 });

  try {
    let proven;
    if (isObject(body.hedge) && isObject(body.caps)) {
      proven = await proveHedgePolicy(body.hedge as never, body.caps as never);
    } else if (isObject(body.statement) && isObject(body.witness) && Array.isArray(body.statement.bounds) && Array.isArray(body.witness.values)) {
      proven = await proveBounds(body.statement as never, body.witness as never);
    } else {
      return NextResponse.json({ success: false, error: 'Send { statement, witness } or { hedge, caps }' }, { status: 400 });
    }
    return NextResponse.json({
      success: true,
      proof: proven.proof,
      commitment: proven.commitment,
      opening: proven.opening,
      verified: proven.verified,
      protocol: proven.protocol,
      duration_ms: proven.generationTime,
    });
  } catch (error) {
    if (error instanceof ProofRefusedError) {
      return NextResponse.json({ success: false, error: error.message, code: 'OUTSIDE_STATEMENT' }, { status: 422 });
    }
    logger.error('[zk-proof/generate] proving failed', error);
    return NextResponse.json({ success: false, error: 'The proof could not be made', code: 'PROVER_ERROR' }, { status: 500 });
  }
}
