/**
 * Production health endpoint for the SUI community pool.
 *
 * Returns a single JSON object summarising every component that must be
 * healthy for the pool to safely make profit. Each component returns a
 * status + age, and the overall status is the worst of the components:
 *   - HEALTHY: every check passed
 *   - DEGRADED: at least one warning-grade component (cron stale, etc)
 *   - DOWN: at least one critical component unavailable (DB, RPC, BlueFin)
 *
 * Components:
 *   1. DB: ping Aiven, check latest cron_state + nav_history ages
 *   2. Polymarket 5-min signal: cached signal age (must be < 5min)
 *   3. SUI mainnet RPC: read pool object
 *   4. BlueFin venue: getHealth() + canTrade
 *   5. Cron freshness: last-tick age for each capital-moving cron
 *   6. NAV vs floors: is the pool above the auto-hedge floor?
 *
 * Public + rate-limited. No auth required (think of it like /api/health).
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';
import { query } from '@/lib/db/postgres';
import { envFlag, envFlagOnByDefault } from '@/lib/utils/env-flag';
import { notifyDiscord } from '@/lib/utils/discord-notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Was 20s; 8 sequential DB checks each with 20s query_timeout + 7s pool-
// exhaustion retry backoff can single-handedly eat the entire budget on
// a degraded DB → FUNCTION_INVOCATION_TIMEOUT. 30s + per-check race
// timeout (see withCheckTimeout) leaves comfortable headroom.
export const maxDuration = 30;

// Per-check race timeout. When Aiven is congested a single query can
// hang for its 20s query_timeout + 7s retry backoff. Wrap each health
// check so one slow component can't starve the rest and cascade the
// whole endpoint into a timeout.
const CHECK_TIMEOUT_MS = 3000;
async function withCheckTimeout<T extends Component>(check: Promise<T>, name: string): Promise<T> {
  const timeoutFallback: Component = {
    status: 'warn',
    detail: `${name}: check exceeded ${CHECK_TIMEOUT_MS}ms budget`,
  };
  return Promise.race([
    check,
    new Promise<T>((resolve) => setTimeout(() => resolve(timeoutFallback as T), CHECK_TIMEOUT_MS)),
  ]);
}

type CompStatus = 'ok' | 'warn' | 'down';
interface Component {
  status: CompStatus;
  latencyMs?: number;
  ageSeconds?: number;
  detail?: string;
  error?: string;
}

const HEDGE_MIN_NAV_USD = Number(process.env.HEDGE_MIN_NAV_USD || 20);

// Loud-alert dedupe. Process-scoped: cold starts re-fire, which is the
// point — a persistent outage should page every ~hour, not every ~minute.
const STALE_NAV_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const STALE_NAV_AGE_THRESHOLD_S = 30 * 60;
const RPC_DOWN_ALERT_INTERVAL_MS = 30 * 60 * 1000;
let lastStaleNavAlertAt = 0;
let lastRpcDownAlertAt = 0;

async function maybeAlertStaleNav(
  navFreshness: { status: 'ok' | 'warn' | 'down'; ageSeconds?: number; navUsd?: number },
): Promise<void> {
  const age = navFreshness.ageSeconds ?? 0;
  if (age < STALE_NAV_AGE_THRESHOLD_S) return;
  const now = Date.now();
  if (now - lastStaleNavAlertAt < STALE_NAV_ALERT_INTERVAL_MS) return;
  lastStaleNavAlertAt = now;
  const mins = Math.floor(age / 60);
  try {
    await notifyDiscord(
      `NAV snapshot stale for **${mins} min** (NAV $${(navFreshness.navUsd ?? 0).toFixed(2)}). SUI cron may be failing — check /api/health/production.`,
      'ERROR',
      { ageSeconds: age, navUsd: navFreshness.navUsd },
    );
  } catch { /* notifyDiscord no-ops without webhook */ }
}

async function maybeAlertRpcDown(
  suiRpc: { status: 'ok' | 'warn' | 'down'; error?: string; activeProvider?: string; rotationCount?: number },
): Promise<void> {
  if (suiRpc.status !== 'down') return;
  const now = Date.now();
  if (now - lastRpcDownAlertAt < RPC_DOWN_ALERT_INTERVAL_MS) return;
  lastRpcDownAlertAt = now;
  try {
    await notifyDiscord(
      `SUI RPC is **DOWN across all failover providers**. Last error: ${suiRpc.error ?? 'unknown'}. Rotations attempted: ${suiRpc.rotationCount ?? 0}.`,
      'ERROR',
      { activeProvider: suiRpc.activeProvider, rotationCount: suiRpc.rotationCount },
    );
  } catch { /* notifyDiscord no-ops without webhook */ }
}

async function checkDb(): Promise<Component> {
  const start = Date.now();
  try {
    const r = await query<{ ok: number }>('SELECT 1::int as ok');
    if (r[0]?.ok !== 1) return { status: 'down', error: 'unexpected query result' };
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (e: any) {
    return { status: 'down', error: e?.message?.slice(0, 200) || 'unknown' };
  }
}

async function checkCronAge(key: string, warnAfterMin: number, downAfterMin: number): Promise<Component> {
  try {
    const r = await query<{ age_s: number }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - updated_at))::int as age_s
       FROM cron_state WHERE key = $1 LIMIT 1`,
      [key],
    );
    if (r.length === 0) return { status: 'warn', detail: 'no entry yet' };
    const ageSeconds = Number(r[0].age_s);
    if (ageSeconds > downAfterMin * 60) return { status: 'down', ageSeconds, detail: `> ${downAfterMin}min stale` };
    if (ageSeconds > warnAfterMin * 60) return { status: 'warn', ageSeconds, detail: `> ${warnAfterMin}min stale` };
    return { status: 'ok', ageSeconds };
  } catch (e: any) {
    return { status: 'warn', error: e?.message?.slice(0, 100) };
  }
}

async function checkPhantomRate(): Promise<Component & { ratePct?: number; total?: number; phantoms?: number; openPhantoms?: number }> {
  try {
    // Two blind spots for the same underlying failure (open call returns
    // orderHash, engine silently drops the order — see f54d5b46):
    //
    //   1. CLOSED-hedge phantom — bluefin-db-reconcile eventually marks
    //      active rows with no BlueFin match as closed w/ realized_pnl=0.
    //      Rate = phantoms / total_closed last hour.
    //
    //   2. OPEN-hedge phantom (in-flight) — before the 15-min reconciler
    //      catches an orphan, the row sits status='active' with an
    //      untouched updated_at. In that window the closed-rate above
    //      stays 0% even if the trader fires 3+ ghost opens back-to-back.
    //      Heuristic: active + notional >= $1 + older than 20min (1 recon
    //      tick + slop) + updated_at within 30s of created_at means no
    //      subsequent job touched the row. Absolute count, not a rate —
    //      ANY in-flight phantom should trip the trader halt.
    const [closedRow, openRow] = await Promise.all([
      query<{ total: string; phantoms: string }>(
        // ponytail: exclude reconstructed_* orders. bluefin-db-reconcile writes
        // these when it adopts real BlueFin trades the trader/pool cron didn't
        // register — realized_pnl is legitimately 0 because reconciler lacks
        // fill data at close time. NOT phantom fills. 2026-07-31 incident:
        // 1 real SOL trade tripped 100% phantom rate + status=down.
        `SELECT COUNT(*)::text as total,
                SUM(CASE WHEN COALESCE(realized_pnl, 0) = 0 THEN 1 ELSE 0 END)::text as phantoms
         FROM hedges
         WHERE chain='sui' AND status='closed' AND notional_value >= 1
           AND created_at > NOW() - INTERVAL '1 hour'
           AND (order_id IS NULL OR order_id NOT LIKE 'reconstructed_%')`,
      ),
      query<{ open_phantoms: string }>(
        `SELECT COUNT(*)::text as open_phantoms
         FROM hedges
         WHERE chain='sui' AND status='active' AND notional_value >= 1
           AND created_at < NOW() - INTERVAL '20 minutes'
           AND EXTRACT(EPOCH FROM (updated_at - created_at)) < 30`,
      ),
    ]);
    const total = Number(closedRow[0]?.total ?? 0);
    const phantoms = Number(closedRow[0]?.phantoms ?? 0);
    const openPhantoms = Number(openRow[0]?.open_phantoms ?? 0);
    const ratePct = total === 0 ? 0 : (phantoms / total) * 100;

    // Escalate to worst-of. Open-phantom absolute count trips independently
    // so alert-response can HALT_TRADER before the reconciler window closes.
    // Sample gate on rate-based checks: matches PHANTOM_RATE_MIN_SAMPLE in
    // alert-response-loop. Below 5 closes/hour a single legitimate zero-move
    // fill reads as 100% phantom and false-tripped 'down' status.
    const RATE_SAMPLE_MIN = 5;
    if (openPhantoms >= 3) return { status: 'down', ratePct, total, phantoms, openPhantoms, detail: `${openPhantoms} in-flight phantom opens — trader firing ghost orders` };
    if (ratePct > 5 && total >= RATE_SAMPLE_MIN) return { status: 'down', ratePct, total, phantoms, openPhantoms, detail: `${ratePct.toFixed(1)}% of last-hour closes have $0 realized (${total} closes) — exchange fills unreliable` };
    if (openPhantoms >= 1) return { status: 'warn', ratePct, total, phantoms, openPhantoms, detail: `${openPhantoms} in-flight phantom open(s) — active hedge(s) never touched by reconciler` };
    if (ratePct > 1 && total >= RATE_SAMPLE_MIN) return { status: 'warn', ratePct, total, phantoms, openPhantoms, detail: `${ratePct.toFixed(1)}% phantom rate (${total} closes, > 1% threshold)` };
    if (total === 0) return { status: 'ok', ratePct: 0, total: 0, phantoms: 0, openPhantoms, detail: 'no hedges closed in last hour' };
    return { status: 'ok', ratePct, total, phantoms, openPhantoms };
  } catch (e: any) {
    return { status: 'warn', error: e?.message?.slice(0, 100) || 'unknown' };
  }
}

/**
 * Reconstructed-orphan rate — catches silent createHedge failures.
 *
 * bluefin-db-reconcile writes `order_id = reconstructed_*` rows when it
 * finds a live BlueFin position with no matching DB row. Post-2026-08-10
 * fix, the trader writes its DB row on open, so orphan adoption should
 * be rare (only when trader-side createHedge genuinely fails after
 * openHedge succeeds). A spike means the trader-side DB write is broken
 * again — same class of silent failure that hid the $0-PnL bug for a
 * month. checkPhantomRate excludes reconstructed rows by design (they
 * legitimately lack fill data), so without this check the regression
 * is invisible.
 */
async function checkOrphanAdoptionRate(): Promise<Component & { orphansLastHour?: number }> {
  try {
    const r = await query<{ n: string }>(
      `SELECT COUNT(*)::text as n
       FROM hedges
       WHERE chain = 'sui'
         AND order_id LIKE 'reconstructed_%'
         AND created_at > NOW() - INTERVAL '1 hour'`,
    );
    const n = Number(r[0]?.n ?? 0);
    if (n >= 10) return { status: 'down', orphansLastHour: n, detail: `${n} orphan adoptions in 1h — trader createHedge broken; every trade losing entry_price + PnL fidelity` };
    if (n >= 3) return { status: 'warn', orphansLastHour: n, detail: `${n} orphan adoptions in 1h — trader-side createHedge may be failing` };
    return { status: 'ok', orphansLastHour: n };
  } catch (e: any) {
    return { status: 'warn', error: e?.message?.slice(0, 100) };
  }
}

/**
 * Trader long-idle check — catches "trader silently broken" regressions.
 *
 * The trader cron heartbeats every 5 min (traderCron check catches "not
 * running"), but doesn't catch "running but never opening". If the
 * signal + collateral + edge gates block every tick indefinitely, that
 * COULD be correct behavior (no edge to trade) OR a silent regression
 * (broken signal, wrong env, etc). This check surfaces prolonged idle:
 *
 *   WARN  ≥ 48 h since last real trade AND noedge-streak > 500
 *   DOWN  ≥ 168 h (1 week) since last real trade AND streak > 1500
 *
 * Combines two independent signals so noise doesn't trip it — the streak
 * counter alone can climb during genuine market quiet; the DB row alone
 * could be stale for other reasons.
 */
async function checkTraderActivity(): Promise<Component & { hoursSinceLastTrade?: number; noedgeStreak?: number }> {
  try {
    const [rowRes, streakRes] = await Promise.all([
      query<{ age_hours: number | null }>(
        `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at)))::float / 3600 as age_hours
         FROM hedges
         WHERE chain = 'sui' AND notional_value >= 5
           AND (order_id IS NULL OR order_id NOT LIKE 'reconstructed_%')`,
      ),
      query<{ value: string | null }>(
        `SELECT value::text FROM cron_state WHERE key = 'polymarket-edge:noedge-streak' LIMIT 1`,
      ),
    ]);
    const hoursSinceLastTrade = Number(rowRes[0]?.age_hours ?? 0);
    let noedgeStreak = 0;
    if (streakRes[0]?.value) {
      try {
        noedgeStreak = Number(JSON.parse(streakRes[0].value));
      } catch {
        noedgeStreak = Number(streakRes[0].value ?? 0);
      }
    }

    if (!Number.isFinite(hoursSinceLastTrade) || hoursSinceLastTrade <= 0) {
      // No qualifying trades ever — pool is bootstrapping, don't alarm.
      return { status: 'ok', hoursSinceLastTrade: 0, noedgeStreak };
    }

    if (hoursSinceLastTrade >= 168 && noedgeStreak > 1500) {
      return {
        status: 'down',
        hoursSinceLastTrade: Number(hoursSinceLastTrade.toFixed(1)),
        noedgeStreak,
        detail: `trader idle ${hoursSinceLastTrade.toFixed(0)}h with ${noedgeStreak} no-edge skips — likely silent regression (signal path / env / collat gate)`,
      };
    }
    if (hoursSinceLastTrade >= 48 && noedgeStreak > 500) {
      return {
        status: 'warn',
        hoursSinceLastTrade: Number(hoursSinceLastTrade.toFixed(1)),
        noedgeStreak,
        detail: `trader idle ${hoursSinceLastTrade.toFixed(0)}h with ${noedgeStreak} no-edge skips — verify signal + collat gate`,
      };
    }
    return { status: 'ok', hoursSinceLastTrade: Number(hoursSinceLastTrade.toFixed(1)), noedgeStreak };
  } catch (e: any) {
    return { status: 'warn', error: e?.message?.slice(0, 100) };
  }
}

/**
 * TVL headroom — surfaces how close the pool is to its on-chain TVL cap so
 * operators can lift it BEFORE deposits start reverting with
 * E_MAX_DEPOSIT_EXCEEDED. Cap is settable via `/api/admin/sui-set-tvl-cap`.
 *
 *   ok    — pool TVL well under conservative-floor
 *   warn  — TVL crossed 80% of deployed cap ($8k of $10k) — plan raise
 *   down  — TVL ≥ 110% of deployed cap — deposits likely already reverting
 *
 * ponytail: reads on-chain `total_deposited`, doesn't fetch the DF-stored
 * cap (would cost a second RPC round-trip per health check). Uses the
 * known-deployed value ($10k) as the reference. Update the constant
 * below whenever you raise the cap via the admin endpoint.
 */
async function checkTvlHeadroom(): Promise<Component & { totalDepositedUsdc?: number; capUsdc?: number; utilizationPct?: number }> {
  const DEPLOYED_TVL_CAP_USDC = 10_000; // update when /api/admin/sui-set-tvl-cap is invoked with a new value
  try {
    const network = (process.env.SUI_NETWORK || 'mainnet').trim() as 'mainnet' | 'testnet';
    const { SUI_USDC_POOL_CONFIG } = await import('@/lib/types/sui-pool-types');
    const poolConfig = SUI_USDC_POOL_CONFIG[network];
    if (!poolConfig.poolStateId) return { status: 'ok', detail: 'no pool configured' };

    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
    const client = createFailoverSuiClient(network);
    const obj = await client.getObject({ id: poolConfig.poolStateId, options: { showContent: true } });
    const content = obj?.data?.content as { fields?: Record<string, unknown> } | undefined;
    const fields = content?.fields;
    if (!fields) return { status: 'warn', detail: 'pool object unreadable' };

    const totalDepositedRaw = Number(fields.total_deposited ?? 0);
    const totalDepositedUsdc = totalDepositedRaw / 1_000_000;
    const utilizationPct = Number(((totalDepositedUsdc / DEPLOYED_TVL_CAP_USDC) * 100).toFixed(1));

    if (utilizationPct >= 110) {
      return {
        status: 'down',
        totalDepositedUsdc: Number(totalDepositedUsdc.toFixed(2)),
        capUsdc: DEPLOYED_TVL_CAP_USDC,
        utilizationPct,
        detail: `pool TVL $${totalDepositedUsdc.toFixed(2)} likely past deployed cap $${DEPLOYED_TVL_CAP_USDC.toLocaleString()} — deposits may already be reverting. Raise cap via POST /api/admin/sui-set-tvl-cap`,
      };
    }
    if (utilizationPct >= 80) {
      return {
        status: 'warn',
        totalDepositedUsdc: Number(totalDepositedUsdc.toFixed(2)),
        capUsdc: DEPLOYED_TVL_CAP_USDC,
        utilizationPct,
        detail: `pool TVL $${totalDepositedUsdc.toFixed(2)} at ${utilizationPct}% of cap $${DEPLOYED_TVL_CAP_USDC.toLocaleString()} — plan raise via /api/admin/sui-set-tvl-cap`,
      };
    }
    return {
      status: 'ok',
      totalDepositedUsdc: Number(totalDepositedUsdc.toFixed(2)),
      capUsdc: DEPLOYED_TVL_CAP_USDC,
      utilizationPct,
    };
  } catch (e: any) {
    return { status: 'warn', error: e?.message?.slice(0, 100) };
  }
}

/**
 * Autohedge halt duration — catches the peak-NAV deadlock class of bug.
 *
 * The 2026-07-30 → 2026-08-11 incident stayed hidden for ~12 days because
 * no monitor tracked how LONG a cron had been in halted state. Individual
 * daily halt-KILL alerts fired, but the fact that they were consecutive
 * (halt re-set at every midnight against a stale peak) wasn't surfaced.
 * This check makes prolonged halts visible.
 *
 *   WARN  ≥ 24 h continuously halted
 *   DOWN  ≥ 72 h continuously halted
 *
 * Detection is based on `cron:haltUntil:sui-community-pool:autohedge`
 * being repeatedly extended. We can't see "extension history" directly,
 * but a haltUntil that's > 24h from the current writer's created_at means
 * either a fresh very-long halt (rare, defense-in-depth) or repeated
 * daily extensions (the deadlock pattern). Both warrant a page.
 */
async function checkAutohedgeHaltDuration(): Promise<Component & { halted?: boolean; haltHours?: number }> {
  try {
    const r = await query<{ value: string | null; updated_at: string }>(
      `SELECT value::text, updated_at::text
       FROM cron_state
       WHERE key = 'cron:haltUntil:sui-community-pool:autohedge'
       LIMIT 1`,
    );
    if (r.length === 0 || !r[0].value || r[0].value === 'null') {
      return { status: 'ok', halted: false };
    }
    // Value shape can be either a raw number (legacy) or { untilMs, reason }
    let untilMs: number | null = null;
    try {
      const parsed = JSON.parse(r[0].value);
      if (typeof parsed === 'number') untilMs = parsed;
      else if (parsed && typeof parsed.untilMs === 'number') untilMs = parsed.untilMs;
    } catch { /* not JSON — try raw parse */ }
    if (untilMs === null) untilMs = Number(r[0].value);
    if (!Number.isFinite(untilMs) || untilMs <= 0) {
      return { status: 'ok', halted: false };
    }
    const now = Date.now();
    if (untilMs <= now) {
      return { status: 'ok', halted: false };
    }
    // Halt is active. How long has it been rolling? Use writer age as
    // proxy — a fresh single-day halt is < 24h old writer; deadlock
    // pattern writes new haltUntil every midnight so writer is < 24h
    // old too. Combine both signals: writer age + untilMs distance.
    const writerAgeHours = (now - new Date(r[0].updated_at).getTime()) / 3_600_000;
    const remainingHours = (untilMs - now) / 3_600_000;
    const totalHaltHours = writerAgeHours + remainingHours;
    if (totalHaltHours >= 72) {
      return { status: 'down', halted: true, haltHours: Number(totalHaltHours.toFixed(1)),
        detail: `autohedge halted ${totalHaltHours.toFixed(1)}h continuously — peak-NAV deadlock class of bug likely; check drawdown gate + poolNav:peak freshness` };
    }
    if (totalHaltHours >= 24) {
      return { status: 'warn', halted: true, haltHours: Number(totalHaltHours.toFixed(1)),
        detail: `autohedge halted ${totalHaltHours.toFixed(1)}h continuously — investigate if extending past 48h` };
    }
    return { status: 'ok', halted: true, haltHours: Number(totalHaltHours.toFixed(1)) };
  } catch (e: any) {
    return { status: 'warn', error: e?.message?.slice(0, 100) };
  }
}

async function checkNavFreshness(): Promise<Component & { navUsd?: number }> {
  try {
    // Filter to chain='sui' — pool-nav-monitor also writes Cronos $0 snapshots
    // every 15min, which would otherwise drag the freshness check to a stale,
    // empty pool that's not the flagship SUI mainnet product.
    const r = await query<{ age_s: number; total_nav: string | number }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - timestamp))::int as age_s, total_nav
       FROM community_pool_nav_history
       WHERE chain = 'sui'
       ORDER BY timestamp DESC LIMIT 1`,
    );
    if (r.length === 0) return { status: 'warn', detail: 'no NAV snapshot yet' };
    const ageSeconds = Number(r[0].age_s);
    const navUsd = Number(r[0].total_nav);
    const out: Component & { navUsd?: number } = { status: 'ok', ageSeconds, navUsd };
    if (ageSeconds > 90 * 60) out.status = 'down';
    else if (ageSeconds > 45 * 60) out.status = 'warn';
    if (Number.isFinite(navUsd) && navUsd < HEDGE_MIN_NAV_USD) {
      out.detail = `NAV $${navUsd.toFixed(2)} < HEDGE_MIN_NAV_USD $${HEDGE_MIN_NAV_USD} — auto-hedge gate closed`;
      if (out.status === 'ok') out.status = 'warn';
    }
    return out;
  } catch (e: any) {
    return { status: 'warn', error: e?.message?.slice(0, 100) };
  }
}

async function checkPolymarket(): Promise<Component> {
  const start = Date.now();
  try {
    const { Polymarket5MinService } = await import('@/lib/services/market-data/Polymarket5MinService');
    const sig = await Polymarket5MinService.getLatest5MinSignal();
    if (!sig) return { status: 'warn', detail: 'no signal' };
    return { status: 'ok', latencyMs: Date.now() - start, detail: `${(sig as any).direction} conf=${(sig as any).confidence}` };
  } catch (e: any) {
    return { status: 'down', error: e?.message?.slice(0, 100) };
  }
}

async function checkSuiRpc(): Promise<Component & { activeProvider?: string; rotationCount?: number }> {
  const start = Date.now();
  try {
    const poolStateId = (process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE
      || process.env.NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE
      || '').trim();
    if (!poolStateId) return { status: 'warn', detail: 'pool state id not configured' };
    const { createFailoverSuiClient, getFailoverStats } = await import('@/lib/services/sui/sui-failover-transport');
    const client = createFailoverSuiClient('mainnet');
    const obj = await client.getObject({ id: poolStateId, options: { showType: true } });
    if (!obj.data) return { status: 'down', detail: 'pool object not found' };
    const stats = getFailoverStats();
    // Any rotation in this Lambda's lifetime means the primary provider
    // failed at least once — flag it as warn so the overall health status
    // degrades and monitoring notices. Cold-start resets; a persistent
    // primary outage keeps the warn sticky across successive invocations.
    const status = stats.rotationCount > 0 ? 'warn' : 'ok';
    const detail = stats.rotationCount > 0
      ? `failover active — primary ${new URL(stats.lastRotationFromUrl ?? '').host} down, now on ${new URL(stats.activeUrl).host}`
      : undefined;
    return {
      status,
      latencyMs: Date.now() - start,
      activeProvider: stats.activeUrl ? new URL(stats.activeUrl).host : undefined,
      rotationCount: stats.rotationCount,
      ...(detail ? { detail } : {}),
    };
  } catch (e: any) {
    return { status: 'down', error: e?.message?.slice(0, 100) };
  }
}

const COLLATERAL_FLOOR_USD = Number(process.env.BLUEFIN_COLLATERAL_FLOOR_USD || 5);

async function checkBluefin(): Promise<Component & {
  freeCollateral?: number;
  positionsCount?: number;
  totalMarginUsd?: number;
  positionsSummary?: string;
  source?: 'live' | 'cache' | 'unknown';
  cacheAgeMs?: number;
}> {
  const start = Date.now();
  try {
    const network: 'mainnet' | 'testnet' =
      (process.env.SUI_NETWORK as 'mainnet' | 'testnet') === 'testnet' ? 'testnet' : 'mainnet';
    // Read the canonical on-chain hedge state so the safe-snapshot helper can
    // distinguish "venue truly empty" from "venue read suspicious." Best-effort;
    // health endpoint shouldn't fail just because RPC is slow.
    let onChainHasExposure = false;
    try {
      const poolStateId = (process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE
        || process.env.NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE
        || '').trim();
      if (poolStateId) {
        const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
        const client = createFailoverSuiClient('mainnet');
        const obj = await client.getObject({ id: poolStateId, options: { showContent: true } });
        type SuiContentFields = { hedge_state?: { fields?: { total_hedged_value?: string; active_hedges?: unknown[] } } };
        const fields = (obj.data?.content as { fields?: SuiContentFields } | null)?.fields;
        const hedgedRaw = Number(fields?.hedge_state?.fields?.total_hedged_value || 0);
        const activeCount = fields?.hedge_state?.fields?.active_hedges?.length ?? 0;
        onChainHasExposure = hedgedRaw > 0 || activeCount > 0;
      }
    } catch { /* best-effort */ }

    const { safeBluefinSnapshot } = await import('@/lib/services/sui/bluefin-read-safe');
    const snap = await safeBluefinSnapshot({ network, onChainHasExposure });

    if (snap.source === 'unknown') {
      return {
        status: 'down',
        latencyMs: Date.now() - start,
        detail: snap.warning || 'BlueFin snapshot unavailable',
        freeCollateral: 0,
        positionsCount: 0,
        totalMarginUsd: 0,
        positionsSummary: 'unavailable',
        source: snap.source,
      };
    }

    const balance = snap.free;
    const positionsCount = snap.positionsCount;
    const totalMargin = snap.lockedMargin;
    const summary = snap.positions
      .map(p => {
        const pp = p as unknown as Record<string, unknown>;
        return `${pp.symbol || '?'} ${pp.side || '?'} ${Number(pp.size ?? 0).toFixed(4)}`;
      })
      .join(', ') || (snap.source === 'cache' ? `${positionsCount} cached` : 'none');

    const tooLow = balance < COLLATERAL_FLOOR_USD && positionsCount > 0;
    const cacheWarn = snap.source === 'cache';
    const status: CompStatus = tooLow || cacheWarn ? 'warn' : 'ok';
    const detail =
      `freeCollateral=$${balance.toFixed(2)}, positions=${positionsCount}, margin=$${totalMargin.toFixed(2)}` +
      (tooLow ? ` (BELOW FLOOR $${COLLATERAL_FLOOR_USD} with positions open)` : '') +
      (cacheWarn ? ` (source=cache, age=${Math.round((snap.ageMs ?? 0) / 1000)}s)` : '');

    return {
      status,
      latencyMs: Date.now() - start,
      detail,
      freeCollateral: balance,
      positionsCount,
      totalMarginUsd: Number(totalMargin.toFixed(4)),
      positionsSummary: summary,
      source: snap.source,
      ...(snap.ageMs !== undefined ? { cacheAgeMs: snap.ageMs } : {}),
    };
  } catch (e: any) {
    return { status: 'down', error: e?.message?.slice(0, 100) };
  }
}

function worstStatus(comps: Component[]): CompStatus {
  if (comps.some(c => c.status === 'down')) return 'down';
  if (comps.some(c => c.status === 'warn')) return 'warn';
  return 'ok';
}

export async function GET(req: NextRequest) {
  const limited = readLimiter.check(req);
  if (limited) return limited;

  const start = Date.now();
  // External HTTP checks fire in parallel — they don't touch the DB pool.
  const [polymarket, suiRpc, bluefin] = await Promise.all([
    withCheckTimeout(checkPolymarket(), 'polymarket'),
    withCheckTimeout(checkSuiRpc(), 'suiRpc'),
    withCheckTimeout(checkBluefin(), 'bluefin'),
  ]);

  // DB-touching checks run sequentially. Aiven's plan-wide connection_limit=20
  // is shared across every Vercel instance, so a single Promise.all of 6 DB
  // queries can saturate the pool and tip the endpoint into the same
  // `remaining connection slots are reserved...` error it's meant to diagnose.
  // Six fast queries serialized cost ~600ms total — acceptable for a health probe.
  // Each is race-wrapped so a stuck query fails fast instead of eating the
  // whole 30s budget.
  //
  // Heartbeat keys written by each cron's tryClaimCronRun or explicit
  // setCronState, NOT the bare route names. The trader writes
  // polymarket-edge:* only on trade state changes; an idle WAIT tick writes
  // nothing, so we fall back to its daily stats key which updates on every
  // realized trade.
  const db = await withCheckTimeout(checkDb(), 'db');
  const navFreshness = await withCheckTimeout(checkNavFreshness(), 'navFreshness');
  const suiPoolCron = await withCheckTimeout(checkCronAge('cron:lastRun:sui-community-pool', 45, 90), 'suiPoolCron');
  // FIX 2026-06-22: was reading 'polymarket-edge:daily' (a stats key only
  // written on actual trade execution), so cron 'no entry yet' even though
  // the trader was firing every 5 min. Use the real heartbeat key the
  // trader route writes at the top of every invocation.
  const traderCron = await withCheckTimeout(checkCronAge('cron:lastRun:polymarket-edge-trader', 15, 30), 'traderCron');
  const hedgeReconcileCron = await withCheckTimeout(checkCronAge('cron:lastRun:sui-hedge-reconcile', 120, 240), 'hedgeReconcileCron');
  const bluefinHealthCron = await withCheckTimeout(checkCronAge('bluefin-health:consecutiveDegraded', 15, 30), 'bluefinHealthCron');
  const bluefinDbReconcileCron = await withCheckTimeout(checkCronAge('cron:lastRun:bluefin-db-reconcile', 30, 60), 'bluefinDbReconcileCron');
  // pool-nav-monitor runs every 15 min and owns the `poolNav:peak` rolling-window
  // computation (PR #55). If this cron stops, peak stops updating → rolling
  // window silently degrades to "stuck at last value" → the peak-NAV deadlock
  // class of bug can re-establish. Detect the cron death, not just the deadlock.
  const poolNavMonitorCron = await withCheckTimeout(checkCronAge('cron:lastRun:pool-nav-monitor', 25, 60), 'poolNavMonitorCron');

  // v0.3.0 defense: phantom hedge rate over last hour. Proxies via closed
  // hedges with $0 realized_pnl and notional ≥ $1 — the same query the
  // bulletproof drawdown test uses as its meta-invariant. > 1% warns;
  // > 5% is down (exchange fills unreliable → auto-halt trader gate).
  const phantomRate = await withCheckTimeout(checkPhantomRate(), 'phantomRate');
  const orphanRate = await withCheckTimeout(checkOrphanAdoptionRate(), 'orphanRate');
  const autohedgeHalt = await withCheckTimeout(checkAutohedgeHaltDuration(), 'autohedgeHalt');
  const traderActivity = await withCheckTimeout(checkTraderActivity(), 'traderActivity');
  const tvlHeadroom = await withCheckTimeout(checkTvlHeadroom(), 'tvlHeadroom');

  const components = { db, polymarket, suiRpc, bluefin, navFreshness, suiPoolCron, traderCron, hedgeReconcileCron, bluefinHealthCron, bluefinDbReconcileCron, poolNavMonitorCron, phantomRate, orphanRate, autohedgeHalt, traderActivity, tvlHeadroom };
  const overall = worstStatus(Object.values(components));

  const body = {
    status: overall === 'ok' ? 'healthy' : overall === 'warn' ? 'degraded' : 'down',
    timestamp: new Date().toISOString(),
    responseTimeMs: Date.now() - start,
    components,
    config: {
      hedgeMinNavUsd: HEDGE_MIN_NAV_USD,
      network: (process.env.SUI_NETWORK || 'mainnet').trim(),
    },
    // Deployed commit — surfaces "wait, prod is on old sha" for silent
    // Vercel deploy failures. Fell into this on 2026-07-20 when the
    // tsconfig types drift bailed two prod deploys unnoticed for 2 days.
    build: {
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) || 'local',
      branch: process.env.VERCEL_GIT_COMMIT_REF || 'unknown',
    },
    // v0.3.0 defense gate footprint — answers "is the safety off or on
    // in prod?" without hitting Vercel env dashboard. INFO/TRADE logs
    // don't ring-buffer, so DB inspection can't tell. This does.
    gates: {
      portfolioDriverExecute: envFlagOnByDefault('PORTFOLIO_DRIVER_EXECUTE'),
      staleHedgeAutoClose: envFlagOnByDefault('STALE_HEDGE_AUTO_CLOSE'),
      alertResponseExecute: envFlagOnByDefault('ALERT_RESPONSE_EXECUTE'),
      alertResponseExecuteHalt: envFlag('ALERT_RESPONSE_EXECUTE_HALT'),
      regretTrackerDisable: envFlag('REGRET_TRACKER_DISABLE'),
      suiAutoHedgeDisable: envFlag('SUI_AUTO_HEDGE_DISABLE'),
      profitLockDisable: envFlag('PROFIT_LOCK_DISABLE'),
    },
    // Rate-limiter backend — 'upstash' means globally consistent across all
    // Vercel instances; 'none' means in-memory only (per-instance, misses
    // cross-lambda abuse). Under demo/judging load with many warm lambdas,
    // 'none' can leak ~N× the intended limit. If this reads 'none' in prod,
    // set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
    security: {
      rateLimiterBackend: readLimiter.stats().distributed.backend,
    },
  };

  if (overall !== 'ok') {
    logger.warn('[health/production] degraded', { overall, components });
  }

  // Loud stale-NAV alert. When the NAV snapshot is > 30 min old the pool
  // is flying blind — trader can't gate against real capital, dashboard
  // is misleading, and (before the failover transport shipped) this was
  // the class of silent outage that killed weeks of profit. Fires
  // Discord ERROR once per hour per process; cold starts re-fire.
  await maybeAlertStaleNav(navFreshness);
  // Same treatment for suiRpc — a rotation is already alerted from
  // inside the transport, but if RPC is DOWN entirely (all providers
  // failed) the transport can't fire; catch it here.
  await maybeAlertRpcDown(suiRpc);

  const httpStatus = overall === 'down' ? 503 : 200;
  return NextResponse.json(body, {
    status: httpStatus,
    headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=40' },
  });
}
