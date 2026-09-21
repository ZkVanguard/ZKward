/**
 * Ping every cron route directly with CRON_SECRET auth. Bypasses the
 * jobs.zkward.com dispatcher entirely — useful when the dispatcher
 * itself is down (all 11 crons stopped at the same instant, 2026-09-19
 * 20:11 UTC-4) or when you need a manual heartbeat kick.
 *
 * Reports HTTP status + latency + any error body per route. Also
 * writes a fresh `cron:lastRun:<name>` to Bakchodi implicitly (via the
 * route's own heartbeat call), so the heartbeat-monitor sees the
 * ping as a legitimate run.
 *
 * Usage:
 *   BASE_URL=https://www.zkward.com CRON_SECRET=xxx bun run scripts/ping-crons.ts
 *   BASE_URL=http://localhost:3000  CRON_SECRET=xxx bun run scripts/ping-crons.ts
 *   ONLY=sui-community-pool,paper-trader bun run scripts/ping-crons.ts
 *
 * Env:
 *   BASE_URL      — required, no trailing slash
 *   CRON_SECRET   — required, matches server-side .env
 *   ONLY          — optional, comma-separated cron names to test only
 *   TIMEOUT_MS    — per-request timeout (default 60000)
 *   METHOD        — GET (default) or POST. Some routes require POST.
 */

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || '';
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60_000);
const METHOD = (process.env.METHOD || 'GET').toUpperCase();

if (!BASE_URL || !CRON_SECRET) {
  console.error('BASE_URL and CRON_SECRET are required');
  process.exit(1);
}

// Every route under app/api/cron/ that has a route.ts and is worth
// pinging live. Kept in source (not derived from FS) so a stray dev
// route doesn't accidentally get poked in prod.
const CRONS = [
  'agent-signal-tick',
  'alert-response-loop',
  'bluefin-db-reconcile',
  'bluefin-health',
  'liquidation-guard',
  'poly-discover',
  'polymarket-edge-trader',
  'pool-nav-monitor',
  'resolve-outcomes',
  'sui-collect-fees',
  'sui-community-pool',
  'sui-hedge-reconcile',
  // Known-dormant, included so this script surfaces both categories:
  'hedge-monitor',
  'health-monitor',
];

interface Result {
  cron: string;
  status: number | 'error';
  ms: number;
  bodyPreview: string;
}

async function pingOne(cron: string): Promise<Result> {
  const url = `${BASE_URL}/api/cron/${cron}`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: METHOD,
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      cron,
      status: res.status,
      ms: Date.now() - start,
      bodyPreview: text.slice(0, 160).replace(/\s+/g, ' '),
    };
  } catch (e) {
    return {
      cron,
      status: 'error',
      ms: Date.now() - start,
      bodyPreview: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const list = ONLY.length ? CRONS.filter((c) => ONLY.includes(c)) : CRONS;
  console.log(`Pinging ${list.length} cron route(s) at ${BASE_URL} — method=${METHOD}\n`);
  const results: Result[] = [];
  // Sequential — parallel bursts can trigger the 20-conn Bakchodi pool
  // limit for routes that all hit the same shared query pool at once.
  for (const cron of list) {
    const r = await pingOne(cron);
    results.push(r);
    const badge = r.status === 200 ? '✅' : r.status === 401 ? '🔒' : r.status === 'error' ? '❌' : '⚠️ ';
    console.log(
      `${badge} ${cron.padEnd(28)} status=${String(r.status).padStart(5)}  ${String(r.ms).padStart(6)}ms  ${r.bodyPreview}`,
    );
  }

  console.log('');
  const ok = results.filter((r) => r.status === 200).length;
  const bad = results.length - ok;
  console.log(`Summary: ${ok} healthy, ${bad} unhealthy`);
  if (bad > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
