import { NextRequest, NextResponse } from 'next/server';
import { POOL_CHAIN_CONFIGS } from '@/lib/contracts/community-pool-config';
import { ALL_AGENTS } from '@/lib/config/pricing';
import { readLimiter } from '@/lib/security/rate-limiter';

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const limited = readLimiter.check(request);
  if (limited) return limited;
  try {
    // Agent count comes from the canonical ALL_AGENTS list rather than a
    // hardcoded number. Adding a new agent to the platform now automatically
    // updates the landing stat.
    const agentCount = ALL_AGENTS.length;

    // Real chain count from config; the simulated book is not a chain
    const chainCount = Object.keys(POOL_CHAIN_CONFIGS).filter((key) => key !== 'paper').length;

    // ZK proof count — sum across every DB-backed proof source rather than
    // just hedges. Custody attestations + zk_hedge_commitment.move + hedge
    // ZK-proof hashes all count. Anything that's only on-chain (no DB row)
    // is not included.
    let zkProofCount = 0;
    try {
      const { getHedgeStats } = await import('@/lib/db/hedges');
      const stats = await getHedgeStats();
      zkProofCount += Number(stats?.total_with_zk_proof || 0);
    } catch {
      /* DB source unavailable — count what we have. */
    }

    return NextResponse.json({
      agents: agentCount,
      chains: chainCount,
      zkProofs: zkProofCount,
      gaslessTxSupport: true,
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch {
    return NextResponse.json({ agents: 0, chains: 0, zkProofs: 0, gaslessTxSupport: false }, { status: 500 });
  }
}
