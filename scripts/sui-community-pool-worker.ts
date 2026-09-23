#!/usr/bin/env bun
/**
 * Standalone sui-community-pool worker. Replaces the Vercel cron
 * route by invoking its GET handler directly with a synthetic
 * NextRequest.
 *
 * Runs one full cycle:
 *   Step 1: pool stats
 *   Step 2: prices
 *   Step 3: AI allocation
 *   Step 4: NAV defense (mutates aiResult in-place)
 *   Step 5: sync members
 *   Step 6: save pool state
 *   Step 6.5: settle previous hedges
 *   Step 6.6: drift rebalance (pre-Step-7 USDC replenish)
 *   Step 7: rebalance execution
 *   Step 7.9: position-drift auto-close
 *   Step 8: auto-hedge via BlueFin perps
 *   Step 9: log AI decision
 *
 * The distributed lock (tryClaimCronRun) inside the GET handler still
 * fires — protects against manual double-invocation on top of the timer.
 *
 * ## Env requirements
 *
 * MINIMUM:
 *   DATABASE_URL              — Bakchodi PG
 *   CRON_SECRET               — passes verifyCronRequest inside the route
 *   SUI_POOL_ADMIN_KEY        — signs Move txs (suiprivkey... or 64-char hex)
 *   SUI_NETWORK               — 'mainnet' | 'testnet'
 *   NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_PKG
 *   NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE
 *
 * RECOMMENDED (falls back to public APIs otherwise):
 *   Aggregator + signal keys (copy from Vercel prod .env)
 *
 * ## Exit codes
 *
 *   0 = tick completed (may have been rate-limited / no rebalance needed)
 *   1 = tick threw unhandled error
 *   2 = env misconfigured (bail early, no tick)
 */
import { NextRequest } from 'next/server';

async function main() {
  const startedAt = Date.now();

  // Minimum env gate. The route itself validates more (SUI_POOL_ADMIN_KEY
  // format, mainnet config) but we short-circuit on the obvious ones so
  // ops sees a clean error instead of a stack trace.
  if (!process.env.DATABASE_URL && !process.env.PROD_DATABASE_URL) {
    console.error('[sui-worker] DATABASE_URL / PROD_DATABASE_URL not set — bailing');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL && process.env.PROD_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
  }
  if (!process.env.CRON_SECRET) {
    console.error('[sui-worker] CRON_SECRET not set — route auth will fail');
    process.exit(2);
  }

  console.log('[sui-worker] tick start', {
    pid: process.pid,
    network: process.env.SUI_NETWORK || 'testnet',
  });

  // Late-import so env is set before the route module evaluates its
  // constants (POOL_ASSETS, NAV_SAFETY_CEILING_USDC etc read process.env
  // at module scope).
  const { GET } = await import('@/app/api/cron/sui-community-pool/route');

  // Synthetic request. The route's verifyCronRequest checks either a
  // Bearer token matching CRON_SECRET or a valid QStash signature; the
  // Bearer path is what we exercise here.
  const url = 'http://worker.local/api/cron/sui-community-pool';
  const mockReq = new NextRequest(url, {
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
      'x-source': 'bakchodi-worker',
    },
  });

  let ok = true;
  try {
    const res = await GET(mockReq);
    const status = res.status;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = '(non-JSON response body)';
    }
    console.log('[sui-worker] tick complete', { status, body });
    if (status >= 500) ok = false;
  } catch (e) {
    ok = false;
    console.error('[sui-worker] GET threw', e);
  }

  const durationMs = Date.now() - startedAt;
  console.log('[sui-worker] tick done', { durationMs, ok });

  try {
    const { closePool } = await import('@/lib/db/postgres');
    await closePool();
  } catch { /* pool may not have been opened */ }

  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[sui-worker] fatal', e);
  process.exit(1);
});
