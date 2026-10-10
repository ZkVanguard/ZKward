/**
 * POST /api/zk-proof/verify
 *
 * Checks a bounds ZK-STARK with the verifier in this process; the proof
 * server is not asked. The statement comes from the caller, never from the
 * proof:
 *   { proof, statement: { kind, bounds, product? }, commitment? }
 *   { proof, caps: { leverage_cap, notional_cap_cents }, commitment? }
 */
import { NextRequest, NextResponse } from 'next/server';
import { heavyLimiter } from '@/lib/security/rate-limiter';
import { verifyBoundsProof, verifyHedgePolicyProof } from '@/zk/verifier/boundsStark';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
  if (!isObject(body) || !isObject(body.proof)) {
    return NextResponse.json({ success: false, error: 'A proof is required' }, { status: 400 });
  }
  const commitment = typeof body.commitment === 'string' ? body.commitment : undefined;
  const started = Date.now();

  let verified: boolean;
  if (isObject(body.caps)) verified = verifyHedgePolicyProof(body.proof, body.caps as never, commitment);
  else if (isObject(body.statement)) verified = verifyBoundsProof(body.proof, body.statement as never, commitment);
  else return NextResponse.json({ success: false, error: 'A statement or caps are required' }, { status: 400 });

  return NextResponse.json({ success: true, verified, duration_ms: Date.now() - started });
}
