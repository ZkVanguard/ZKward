#!/usr/bin/env bun
/**
 * Generic Vercel-cron-route worker. Replaces jobs.zkward.com → Vercel
 * cron invocation with a local process on Bakchodi.
 *
 * ## Usage
 *
 *   bun run scripts/vercel-cron-worker.ts <cron-name>
 *
 * e.g.:
 *   bun run scripts/vercel-cron-worker.ts sui-community-pool
 *   bun run scripts/vercel-cron-worker.ts polymarket-edge-trader
 *
 * Systemd invokes this via zkward-cron@<cron-name>.service (template unit).
 *
 * ## How it works
 *
 * Dynamically imports the route file at
 * `app/api/cron/<cron-name>/route.ts` and invokes its GET handler
 * with a synthetic NextRequest carrying the CRON_SECRET Bearer token.
 * The route's existing distributed lock (`tryClaimCronRun`) still
 * fires, protecting against double-fire from manual invocation on top
 * of the timer.
 *
 * No route refactor required — same code path as the Vercel version.
 *
 * ## Env
 *
 * MINIMUM:
 *   DATABASE_URL              — Bakchodi PG
 *   CRON_SECRET               — passes route's verifyCronRequest
 *
 * PER-CRON (see the route's own docs — copy from Vercel prod env):
 *   sui-community-pool        — SUI_POOL_ADMIN_KEY, SUI_NETWORK,
 *                               NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_*
 *   polymarket-edge-trader    — BLUEFIN_ACCOUNT_KEY, POLYMARKET_*
 *   bluefin-health            — BLUEFIN_ACCOUNT_KEY
 *   sui-hedge-reconcile       — SUI_POOL_ADMIN_KEY, BLUEFIN_*
 *   sui-collect-fees          — SUI_POOL_ADMIN_KEY
 *
 * ## Exit codes
 *
 *   0 = tick completed with 2xx or 429 rate-limit (both healthy)
 *   1 = tick returned 5xx OR threw
 *   2 = env missing OR cron name invalid
 */
import { NextRequest } from 'next/server';

const KNOWN_CRONS = new Set([
  'sui-community-pool',
  'sui-hedge-reconcile',
  'sui-collect-fees',
  'polymarket-edge-trader',
  'agent-signal-tick',
  'alert-response-loop',
  'bluefin-health',
  'bluefin-db-reconcile',
  'pool-nav-monitor',
  'liquidation-guard',
  'poly-discover',
  'paper-fast-tick',
  'resolve-outcomes',
]);

async function main() {
  const cronName = process.argv[2];
  if (!cronName) {
    console.error('[cron-worker] usage: bun run scripts/vercel-cron-worker.ts <cron-name>');
    console.error('[cron-worker] known crons: ' + Array.from(KNOWN_CRONS).sort().join(', '));
    process.exit(2);
  }
  if (!KNOWN_CRONS.has(cronName)) {
    console.error(`[cron-worker] unknown cron '${cronName}' — not in KNOWN_CRONS whitelist`);
    console.error('[cron-worker] to allow: add to KNOWN_CRONS in scripts/vercel-cron-worker.ts');
    process.exit(2);
  }

  if (!process.env.DATABASE_URL && !process.env.PROD_DATABASE_URL) {
    console.error('[cron-worker] DATABASE_URL / PROD_DATABASE_URL not set');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL && process.env.PROD_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.PROD_DATABASE_URL;
  }
  if (!process.env.CRON_SECRET) {
    console.error('[cron-worker] CRON_SECRET not set — route auth will 401');
    process.exit(2);
  }

  const startedAt = Date.now();
  console.log(`[cron-worker] ${cronName} — tick start`, {
    pid: process.pid,
    network: process.env.SUI_NETWORK,
  });

  // Dynamic import — same as Next.js's route loader.
  let GET: (req: NextRequest) => Promise<Response>;
  try {
    const mod = (await import(`@/app/api/cron/${cronName}/route`)) as {
      GET?: (req: NextRequest) => Promise<Response>;
    };
    if (typeof mod.GET !== 'function') {
      throw new Error(`route ${cronName} has no GET export`);
    }
    GET = mod.GET;
  } catch (e) {
    console.error(`[cron-worker] failed to import route '${cronName}':`, e);
    process.exit(1);
  }

  const url = `http://worker.local/api/cron/${cronName}`;
  const mockReq = new NextRequest(url, {
    headers: {
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
      'x-source': 'bakchodi-worker',
      'x-cron-name': cronName,
    },
  });

  let exitCode = 0;
  try {
    const res = await GET(mockReq);
    const status = res.status;
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = '(non-JSON body)';
    }
    console.log(`[cron-worker] ${cronName} — tick complete`, { status, body });
    // 2xx = success, 429 = distributed-lock rate-limit (healthy no-op),
    // 401/403 = auth misconfig (exit 1), 5xx = real error (exit 1).
    if (status >= 500 || status === 401 || status === 403) exitCode = 1;
  } catch (e) {
    console.error(`[cron-worker] ${cronName} — GET threw`, e);
    exitCode = 1;
  }

  const durationMs = Date.now() - startedAt;
  console.log(`[cron-worker] ${cronName} — tick done`, { durationMs, exitCode });

  try {
    const { closePool } = await import('@/lib/db/postgres');
    await closePool();
  } catch { /* pool may not have been opened */ }

  process.exit(exitCode);
}

main().catch((e) => {
  console.error('[cron-worker] fatal', e);
  process.exit(1);
});
