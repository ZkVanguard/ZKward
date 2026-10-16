/**
 * Wallet display-name profiles.
 *
 * GET  /api/profile?addresses=0xa,0xb,...   → { profiles: { 0xa: { displayName }, ... } }
 * POST /api/profile { address, displayName } → { ok: true } | { error }
 *
 * Auth (POST): the wallet signs the request (requireAuth); only the signing
 * wallet's own name can be set. Internal callers may set any.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getWalletProfiles,
  setWalletProfile,
  normalizeAddress,
} from '@/lib/db/wallet-profiles';
import { readLimiter, mutationLimiter } from '@/lib/security/rate-limiter';
import { requireAuth } from '@/lib/security/auth-middleware';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(request);
  if (limited) return limited;
  const url = new URL(request.url);
  const raw = (url.searchParams.get('addresses') || '').trim();
  if (!raw) {
    return NextResponse.json({ profiles: {} }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=3600' },
    });
  }
  const addrs = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
  const profiles = await getWalletProfiles(addrs);
  // CDN caches profile lookups for 30s — leaderboard enrichment on
  // /api/community-pool?action=leaderboard hits this every 60s per
  // client. Cache lets one origin fetch fan out to N viewers.
  return NextResponse.json({ profiles }, {
    headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=3600' },
  });
}

interface Body { address?: string; displayName?: string }

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Writes are DB-bound and can spam-fill wallet_profiles otherwise.
  // Mutation limiter: 20 req/min per IP.
  const limited = mutationLimiter.check(request);
  if (limited) return limited;
  let body: Body = {};
  try { body = (await request.json()) as Body; } catch { /* default */ }
  if (!body.address || !body.displayName) {
    return NextResponse.json({ error: 'address and displayName required' }, { status: 400 });
  }
  const address = normalizeAddress(body.address);
  if (!address) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 });
  }
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  if (auth.method === 'wallet' && auth.identity !== address) {
    return NextResponse.json({ error: 'a wallet can set only its own name' }, { status: 403 });
  }
  const res = await setWalletProfile(address, body.displayName);
  if ('error' in res) {
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
