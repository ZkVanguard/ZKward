/**
 * What the proof system is. The prover and the verifier run in this process,
 * so this answers whenever the application does.
 */
import { NextResponse } from 'next/server';
import { proofSystemInfo } from '@/zk/prover/ProofGenerator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(
    { status: 'healthy', system_info: proofSystemInfo(), timestamp: Date.now() },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=86400' } },
  );
}
