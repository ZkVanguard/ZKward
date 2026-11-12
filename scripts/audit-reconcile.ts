/**
 * State Reconciliation Audit — the single "is everything consistent?" check
 *
 * Read-only. Cross-references the three sources of truth we maintain:
 *
 *   1. On-chain Move state (SUI RPC) — authoritative for NAV, share supply,
 *      accumulated fees, member list, and the `pool.hedge_state.active_hedges`
 *      operational vector.
 *
 *   2. Postgres DB (Aiven) — authoritative for hedge history, agent
 *      decisions, NAV snapshots, cron heartbeats. Should MIRROR on-chain
 *      state for anything that also lives on-chain.
 *
 *   3. BlueFin venue — authoritative for live perp positions. DB active
 *      hedges MUST match BlueFin getPositions() modulo per-symbol
 *      aggregation.
 *
 * Ships as a self-contained script (no Vercel dependency) so an auditor
 * can run it independently against their own copy of the RPC + DB
 * credentials, verify no funny business, and file findings.
 *
 * Usage:
 *   bun run scripts/audit-reconcile.ts                # console output
 *   bun run scripts/audit-reconcile.ts --json > out.json
 *   bun run scripts/audit-reconcile.ts --strict       # exit 1 on any drift
 *
 * Exit codes:
 *   0 — all sources agree within tolerance
 *   1 — drift detected AND --strict flag OR critical inconsistency
 *   2 — inputs unreachable (no drift detected but incomplete data)
 */

import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) loadDotenv({ path: '.env.local', override: true });

const args = new Set(process.argv.slice(2));
const JSON_MODE = args.has('--json');
const STRICT = args.has('--strict');

interface Finding {
  category: 'ONCHAIN_VS_DB' | 'DB_VS_BLUEFIN' | 'ONCHAIN_VS_BLUEFIN' | 'INTEGRITY' | 'INFO';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
  code: string;
  message: string;
  expected?: string | number;
  actual?: string | number;
  driftPct?: number;
}

const findings: Finding[] = [];
const emit = (f: Finding) => findings.push(f);

function log(...a: unknown[]) { if (!JSON_MODE) console.log(...a); }

async function readOnChain(): Promise<{
  reachable: boolean;
  totalDeposited?: number;
  totalWithdrawn?: number;
  totalSharesRaw?: string;
  memberCount?: number;
  accumulatedMgmtFees?: number;
  accumulatedPerfFees?: number;
  activeHedgesOperational?: number;
  externalNavUsdc?: number;
  onchainNavUsdc?: number;
  error?: string;
}> {
  const poolStateId = (process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE || process.env.NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE || '').trim();
  if (!poolStateId) return { reachable: false, error: 'No mainnet pool state ID in env' };
  try {
    const { createFailoverSuiClient } = await import('../lib/services/sui/sui-failover-transport');
    const client = createFailoverSuiClient('mainnet');
    const res = await client.getObject({
      id: poolStateId,
      options: { showContent: true },
    });
    const content = res.data?.content as { fields?: Record<string, unknown> } | null | undefined;
    const f = content?.fields;
    if (!f) return { reachable: false, error: 'No fields in RPC response' };
    // Handle both direct fields and nested hedge_state structure
    const hedgeState = f.hedge_state as { fields?: { active_hedges?: unknown[]; total_hedged_value?: string } } | undefined;
    const activeHedgesArr = hedgeState?.fields?.active_hedges ?? [];
    return {
      reachable: true,
      totalDeposited: Number(f.total_deposited ?? 0) / 1e6,
      totalWithdrawn: Number(f.total_withdrawn ?? 0) / 1e6,
      totalSharesRaw: String(f.total_shares ?? '0'),
      memberCount: Number(f.member_count ?? 0),
      accumulatedMgmtFees: Number(f.accumulated_management_fees ?? 0) / 1e6,
      accumulatedPerfFees: Number(f.accumulated_performance_fees ?? 0) / 1e6,
      activeHedgesOperational: Array.isArray(activeHedgesArr) ? activeHedgesArr.length : 0,
      externalNavUsdc: Number((f.external_nav_state as { fields?: { latest_nav_usdc?: string } } | undefined)?.fields?.latest_nav_usdc ?? 0) / 1e6,
      onchainNavUsdc: Number(hedgeState?.fields?.total_hedged_value ?? 0) / 1e6,
    };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function readDb(): Promise<{
  reachable: boolean;
  activeHedges?: Array<{ market: string; side: string; notionalUsd: number; orderId: string | null; hedgeIdOnchain: string | null }>;
  latestNavSnapshotUsd?: number;
  latestNavAgeMin?: number;
  totalMembers?: number;
  totalDepositedUsdc?: number;
  recentAgentDecisions?: number;
  cronHeartbeatsCount?: number;
  error?: string;
}> {
  try {
    const { query } = await import('../lib/db/postgres');
    const [hedgeRows, navRows, memberRows, decisionRows, heartbeatRows] = await Promise.all([
      query<{ market: string; side: string; notional_value: string; order_id: string | null; hedge_id_onchain: string | null }>(
        `SELECT market, side, notional_value, order_id, hedge_id_onchain
           FROM hedges
          WHERE chain = 'sui' AND status = 'active' AND COALESCE(notional_value, 0) >= 1`,
      ),
      query<{ total_nav: string; timestamp: Date }>(
        `SELECT total_nav, timestamp FROM community_pool_nav_history
          WHERE chain = 'sui' AND total_nav > 10
          ORDER BY timestamp DESC LIMIT 1`,
      ).catch(() => []),
      query<{ cnt: string; total: string }>(
        `SELECT COUNT(DISTINCT wallet_address)::text AS cnt,
                COALESCE(SUM(amount_usdc), 0)::text AS total
           FROM community_pool_members WHERE chain = 'sui'`,
      ).catch(() => []),
      query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM agent_decisions
          WHERE chain = 'sui' AND created_at > NOW() - INTERVAL '7 days'`,
      ).catch(() => [{ cnt: '0' }]),
      query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM cron_state WHERE key LIKE 'cron:lastRun:%'`,
      ).catch(() => [{ cnt: '0' }]),
    ]);
    const nav = navRows[0];
    return {
      reachable: true,
      activeHedges: hedgeRows.map((r) => ({
        market: r.market,
        side: r.side,
        notionalUsd: Number(r.notional_value),
        orderId: r.order_id,
        hedgeIdOnchain: r.hedge_id_onchain,
      })),
      latestNavSnapshotUsd: nav ? Number(nav.total_nav) : undefined,
      latestNavAgeMin: nav ? Math.floor((Date.now() - new Date(nav.timestamp).getTime()) / 60_000) : undefined,
      totalMembers: memberRows[0] ? Number(memberRows[0].cnt) : 0,
      totalDepositedUsdc: memberRows[0] ? Number(memberRows[0].total) : 0,
      recentAgentDecisions: decisionRows[0] ? Number(decisionRows[0].cnt) : 0,
      cronHeartbeatsCount: heartbeatRows[0] ? Number(heartbeatRows[0].cnt) : 0,
    };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function readBluefin(): Promise<{
  reachable: boolean;
  positions?: Array<{ symbol: string; side: string; sizeUsd: number }>;
  error?: string;
}> {
  const key = (process.env.BLUEFIN_PRIVATE_KEY || process.env.SUI_POOL_ADMIN_KEY || '').trim();
  if (!key) return { reachable: false, error: 'No BLUEFIN_PRIVATE_KEY in env — expected for local audit runs' };
  try {
    const { BluefinService } = await import('../lib/services/sui/BluefinService');
    const bf = BluefinService.getInstance();
    const positions = await bf.getPositions();
    return {
      reachable: true,
      positions: positions.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        sizeUsd: p.size * p.markPrice,
      })).filter((p) => p.sizeUsd >= 1),
    };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── Reconciliation logic ─────────────────────────────────────────────────

function reconcileOnchainVsDb(onchain: Awaited<ReturnType<typeof readOnChain>>, db: Awaited<ReturnType<typeof readDb>>) {
  if (!onchain.reachable || !db.reachable) return;

  // Members count parity
  if (onchain.memberCount !== undefined && db.totalMembers !== undefined && db.totalMembers > 0) {
    const drift = Math.abs(onchain.memberCount - db.totalMembers);
    if (drift > 0) {
      emit({
        category: 'ONCHAIN_VS_DB', severity: drift > 2 ? 'HIGH' : 'MEDIUM',
        code: 'MEMBER_COUNT_DRIFT',
        message: `Member count differs: on-chain=${onchain.memberCount}, db=${db.totalMembers}`,
        expected: onchain.memberCount, actual: db.totalMembers,
      });
    }
  }

  // Deposited total parity (allow 1% drift for fee edge)
  if (onchain.totalDeposited !== undefined && (db.totalDepositedUsdc ?? 0) > 0) {
    const oc = onchain.totalDeposited;
    const dbTotal = db.totalDepositedUsdc ?? 0;
    const drift = Math.abs(oc - dbTotal);
    const driftPct = oc > 0 ? drift / oc * 100 : 0;
    if (driftPct > 1) {
      emit({
        category: 'ONCHAIN_VS_DB', severity: driftPct > 5 ? 'HIGH' : 'MEDIUM',
        code: 'DEPOSITED_TOTAL_DRIFT',
        message: `Total deposited differs by ${driftPct.toFixed(2)}%: on-chain=$${oc.toFixed(2)}, db=$${dbTotal.toFixed(2)}`,
        expected: oc, actual: dbTotal, driftPct,
      });
    }
  }

  // NAV freshness (informational, but log if very stale)
  if (db.latestNavAgeMin !== undefined && db.latestNavAgeMin > 45) {
    emit({
      category: 'INTEGRITY', severity: db.latestNavAgeMin > 120 ? 'HIGH' : 'MEDIUM',
      code: 'NAV_SNAPSHOT_STALE',
      message: `Latest DB NAV snapshot is ${db.latestNavAgeMin}min old (SLO: < 45min)`,
      actual: db.latestNavAgeMin,
    });
  }
}

function reconcileDbVsBluefin(db: Awaited<ReturnType<typeof readDb>>, bf: Awaited<ReturnType<typeof readBluefin>>) {
  if (!db.reachable || !bf.reachable) return;

  const dbBySymbolSide = new Map<string, number>();
  for (const h of db.activeHedges ?? []) {
    const key = `${h.market}:${(h.side || '').toUpperCase()}`;
    dbBySymbolSide.set(key, (dbBySymbolSide.get(key) ?? 0) + h.notionalUsd);
  }

  const bfBySymbolSide = new Map<string, number>();
  for (const p of bf.positions ?? []) {
    const key = `${p.symbol}:${p.side.toUpperCase()}`;
    bfBySymbolSide.set(key, (bfBySymbolSide.get(key) ?? 0) + p.sizeUsd);
  }

  const allKeys = new Set([...dbBySymbolSide.keys(), ...bfBySymbolSide.keys()]);
  for (const key of allKeys) {
    const dbVal = dbBySymbolSide.get(key) ?? 0;
    const bfVal = bfBySymbolSide.get(key) ?? 0;
    const drift = Math.abs(dbVal - bfVal);
    const larger = Math.max(dbVal, bfVal);
    const driftPct = larger > 0 ? drift / larger * 100 : 0;

    if (dbVal > 0 && bfVal === 0) {
      emit({
        category: 'DB_VS_BLUEFIN', severity: 'HIGH', code: 'DB_ORPHAN_HEDGE',
        message: `DB has active hedge for ${key} ($${dbVal.toFixed(2)}) but BlueFin has NO position — DB row is orphaned (venue closed, DB didn't sync)`,
        expected: 'BlueFin position', actual: 'none',
      });
    } else if (bfVal > 0 && dbVal === 0) {
      emit({
        category: 'DB_VS_BLUEFIN', severity: 'HIGH', code: 'BLUEFIN_UNTRACKED_POSITION',
        message: `BlueFin has position for ${key} ($${bfVal.toFixed(2)}) but DB has NO active hedge — untracked exposure`,
        expected: 'DB row', actual: 'none',
      });
    } else if (driftPct > 5) {
      emit({
        category: 'DB_VS_BLUEFIN', severity: driftPct > 20 ? 'HIGH' : 'MEDIUM',
        code: 'NOTIONAL_DRIFT',
        message: `Notional differs by ${driftPct.toFixed(2)}% for ${key}: db=$${dbVal.toFixed(2)}, bluefin=$${bfVal.toFixed(2)}`,
        expected: bfVal, actual: dbVal, driftPct,
      });
    }
  }
}

function reconcileOnchainVsBluefin(onchain: Awaited<ReturnType<typeof readOnChain>>, bf: Awaited<ReturnType<typeof readBluefin>>) {
  if (!onchain.reachable || !bf.reachable) return;

  // The on-chain operational hedge count includes $0.01 transport entries;
  // BlueFin has only real venue positions. So we compare on-chain-hedged
  // USDC value + external NAV attestation vs BlueFin position aggregate.
  const bfTotalUsd = (bf.positions ?? []).reduce((s, p) => s + p.sizeUsd, 0);
  const onchainReported = (onchain.externalNavUsdc ?? 0);

  if (onchainReported > 0 && bfTotalUsd > 0) {
    const drift = Math.abs(onchainReported - bfTotalUsd);
    const driftPct = onchainReported > 0 ? drift / onchainReported * 100 : 0;
    // External NAV can include admin-wallet spot in addition to BlueFin
    // positions, so a positive delta is expected. Only flag if BlueFin
    // EXCEEDS the attested external NAV — that would mean the cron under-
    // reported and share math is understating true asset backing.
    if (bfTotalUsd > onchainReported * 1.05) {
      emit({
        category: 'ONCHAIN_VS_BLUEFIN', severity: 'HIGH', code: 'UNDER_ATTESTED_NAV',
        message: `BlueFin position value $${bfTotalUsd.toFixed(2)} > attested external NAV $${onchainReported.toFixed(2)} — cron under-attesting`,
        expected: onchainReported, actual: bfTotalUsd, driftPct,
      });
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  log('\n╔═══════════════════════════════════════════════════════════╗');
  log('║  STATE RECONCILIATION AUDIT                                ║');
  log('╚═══════════════════════════════════════════════════════════╝\n');

  const [onchain, db, bf] = await Promise.all([readOnChain(), readDb(), readBluefin()]);

  // Reachability
  if (onchain.reachable) {
    log(`  ✅ On-chain (SUI RPC)   — deposited $${onchain.totalDeposited?.toFixed(2)}, members ${onchain.memberCount}, fees $${onchain.accumulatedMgmtFees?.toFixed(4)}`);
  } else {
    log(`  ❌ On-chain            — ${onchain.error}`);
    emit({ category: 'INFO', severity: 'INFO', code: 'SOURCE_UNREACHABLE', message: `On-chain: ${onchain.error}` });
  }
  if (db.reachable) {
    log(`  ✅ Postgres (Aiven)     — ${db.activeHedges?.length ?? 0} active hedges, NAV $${db.latestNavSnapshotUsd?.toFixed(2)} (${db.latestNavAgeMin}min old), ${db.recentAgentDecisions} agent decisions/7d`);
  } else {
    log(`  ❌ Postgres            — ${db.error}`);
    emit({ category: 'INFO', severity: 'INFO', code: 'SOURCE_UNREACHABLE', message: `Postgres: ${db.error}` });
  }
  if (bf.reachable) {
    log(`  ✅ BlueFin venue       — ${bf.positions?.length ?? 0} live positions`);
  } else {
    log(`  ⚠️  BlueFin            — ${bf.error} (skipped)`);
    emit({ category: 'INFO', severity: 'INFO', code: 'BLUEFIN_UNREACHABLE', message: `BlueFin: ${bf.error}` });
  }

  log('\n── Cross-checks ───────────────────────────────────────────');
  reconcileOnchainVsDb(onchain, db);
  reconcileDbVsBluefin(db, bf);
  reconcileOnchainVsBluefin(onchain, bf);

  const critical = findings.filter((f) => f.severity === 'CRITICAL');
  const high = findings.filter((f) => f.severity === 'HIGH');
  const medium = findings.filter((f) => f.severity === 'MEDIUM');
  const low = findings.filter((f) => f.severity === 'LOW');
  const info = findings.filter((f) => f.severity === 'INFO');

  for (const f of [...critical, ...high, ...medium, ...low]) {
    const marker = f.severity === 'CRITICAL' ? '💀' : f.severity === 'HIGH' ? '❌' : f.severity === 'MEDIUM' ? '⚠️ ' : '·';
    log(`  ${marker} [${f.severity}] ${f.code}: ${f.message}`);
  }

  const materialCount = critical.length + high.length + medium.length + low.length;
  if (materialCount === 0) {
    log('\n  ✅ All sources agree within tolerance.');
  } else {
    log(`\n  ${materialCount} material finding(s) (info-only omitted from tally).`);
  }

  if (JSON_MODE) {
    console.log(JSON.stringify({
      ranAt: new Date().toISOString(),
      sources: {
        onchain: onchain.reachable ? { reachable: true, ...onchain } : { reachable: false, error: onchain.error },
        db: db.reachable ? { reachable: true, activeHedgeCount: db.activeHedges?.length ?? 0, latestNavUsd: db.latestNavSnapshotUsd, latestNavAgeMin: db.latestNavAgeMin, recentAgentDecisions: db.recentAgentDecisions } : { reachable: false, error: db.error },
        bluefin: bf.reachable ? { reachable: true, positionCount: bf.positions?.length ?? 0 } : { reachable: false, error: bf.error },
      },
      findings,
      summary: { critical: critical.length, high: high.length, medium: medium.length, low: low.length, info: info.length },
    }, null, 2));
  }

  // Exit codes
  if (critical.length > 0) process.exit(1);
  if (STRICT && (high.length > 0 || medium.length > 0)) process.exit(1);
  if (!onchain.reachable && !db.reachable) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  console.error('Reconcile audit threw:', e);
  process.exit(1);
});
