/**
 * POST /api/zk-proof/generate
 *
 * Asks the proof server for a bounds ZK-STARK and returns it with the local
 * verifier's verdict. Two request shapes:
 *   { statement: { kind, bounds, product? }, witness: { values, payload? } }
 *   { hedge: { asset, side, leverageX, ... }, caps: { leverage_cap, notional_cap_cents } }
 *
 * No prover, no proof: when the server is unreachable the answer is 503.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { heavyLimiter } from '@/lib/security/rate-limiter';
import { ProofRefusedError, ProverUnavailableError, proveBounds, proveHedgePolicy } from '@/zk/prover/ProofGenerator';

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
    if (error instanceof ProverUnavailableError) {
      logger.error('[zk-proof/generate] prover unavailable', error);
      return NextResponse.json({ success: false, error: 'The proof server is unavailable', code: 'ZK_SERVICE_UNAVAILABLE' }, { status: 503 });
    }
    // What is left is a number or a statement that could not be read.
    return NextResponse.json({ success: false, error: 'The statement or the witness is malformed' }, { status: 400 });
  }
}
