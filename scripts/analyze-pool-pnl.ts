/**
 * Deep PnL analysis for the SUI community pool.
 *
 * Read-only. Combines:
 *   - On-chain pool state (NAV, total hedged, daily total)
 *   - DB pool snapshots (community_pool_state, _nav_history)
 *   - DB hedges (active + closed, realised + unrealised)
 *   - DB transactions (deposits, withdrawals, fees)
 *   - DB shares (member positions, high-water marks if any)
 *
 * Produces a single verdict: profit or loss, with the breakdown.
 *
 * Run: bun run scripts/analyze-pool-pnl.ts
 */
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) loadDotenv({ path: '.env.local', override: true });
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Pool } from 'pg';

const POOL_STATE_ID = (
  process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE
  || process.env.NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE
  || '0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a'
).trim();

const c = (s: string | number, code: 'g' | 'r' | 'y' | 'b' | 'dim' | 'bold') => {
  const codes = { g: 32, r: 31, y: 33, b: 36, dim: 90, bold: 1 } as const;
  return `\x1b[${codes[code]}m${s}\x1b[0m`;
};
const dollars = (n: number) => (n >= 0 ? '+' : '') + '$' + n.toFixed(2);
const pct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

// Set once if the DB is unreachable (e.g. Neon compute-quota exhaustion). When the
// DB is down the bulk of NAV (off-chain BlueFin snapshot) is invisible, so we show
// on-chain figures only and explicitly DECLINE to render a profit/loss verdict —
// printing on-chain-only NAV minus deposits would falsely look like a huge loss.
let dbDown: string | null = null;
async function safeQuery(pg: Pool, sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
  if (dbDown) return { rows: [] };
  try {
    return await pg.query(sql, params as any[]);
  } catch (e) {
    dbDown = e instanceof Error ? e.message : String(e);
    return { rows: [] };
  }
}

async function main() {
  const sui = new SuiClient({ url: process.env.SUI_MAINNET_RPC?.trim() || getFullnodeUrl('mainnet') });
  // The self-hosted production database. This read the retired hosted one
  // until 2026-10, so its figures were from a database nothing writes to.
  const dbUrl = (process.env.PROD_DATABASE_URL || process.env.DATABASE_URL || '').trim().replace(/([?&])sslmode=[^&]+/g, '$1').replace(/[?&]$/, '');
  if (!dbUrl) throw new Error('PROD_DATABASE_URL (or DATABASE_URL) is not set');
  const pg = new Pool({ connectionString: dbUrl, ssl: /127\.0\.0\.1|localhost/.test(dbUrl) ? false : { rejectUnauthorized: true } });

  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  SUI COMMUNITY POOL — DEEP PnL ANALYSIS                       ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  // Probe the DB once up-front so every section can degrade cleanly.
  await safeQuery(pg, 'SELECT 1');
  if (dbDown) {
    console.log(c('\n  ⚠ Database unavailable — showing ON-CHAIN data only.', 'y'));
    console.log(c(`    Reason: ${dbDown}`, 'dim'));
    console.log(c('    NAV snapshot, hedge PnL, transactions and member figures are skipped,', 'dim'));
    console.log(c('    and no profit/loss verdict is rendered (off-chain BlueFin NAV is invisible without the DB).', 'dim'));
  }

  // ── 1. On-chain pool state ────────────────────────────────────
  console.log('\n── 1. ON-CHAIN POOL STATE ──');
  const obj = await sui.getObject({ id: POOL_STATE_ID, options: { showContent: true } });
  const f = (obj.data?.content as any)?.fields;
  if (!f) { console.log(c('  ✗ pool object unreadable', 'r')); process.exit(2); }

  // USDC convention: 6 decimals for both balance AND total_shares on this pool
  const onChainBalanceUsdc = Number(f.balance || 0) / 1e6;
  const onChainHedgedUsdc = Number(f.hedge_state?.fields?.total_hedged_value || 0) / 1e6;
  // NB: on-chain `balance` is only IDLE pool USDC. The bulk of NAV typically sits
  // off-chain as BlueFin perp collateral — read latest NAV snapshot from DB for the
  // true picture (the cron computes balance + BlueFin + admin + on-chain hedges).
  const totalShares = Number(f.total_shares || 0) / 1e6;
  const totalDepositedUsdc = Number(f.total_deposited || 0) / 1e6;
  const totalWithdrawnUsdc = Number(f.total_withdrawn || 0) / 1e6;
  const athNavPerShare = Number(f.all_time_high_nav_per_share || 0) / 1e6;
  const mgmtFeesAccrued = Number(f.accumulated_management_fees || 0) / 1e6;
  const perfFeesAccrued = Number(f.accumulated_performance_fees || 0) / 1e6;
  const memberCount = Number(f.member_count || 0);

  // Latest NAV snapshot from DB is the truth source for total NAV (incl. BlueFin)
  const latestNav = await safeQuery(pg,
    `SELECT share_price, total_nav, total_shares, timestamp FROM community_pool_nav_history WHERE chain='sui' ORDER BY timestamp DESC LIMIT 1`
  );
  const latestNavRow = latestNav.rows[0];
  const dbTotalNav = latestNavRow ? Number(latestNavRow.total_nav) : null;
  const dbSharePrice = latestNavRow ? Number(latestNavRow.share_price) : null;

  console.log(`  ${c('Total NAV (cron snapshot):', 'bold')} ${dbTotalNav !== null ? c(dollars(dbTotalNav), dbTotalNav > 0 ? 'g' : 'dim') + '  ' + c(`(share price $${dbSharePrice!.toFixed(4)})`, 'b') : c('unavailable (DB down)', 'y')}`);
  console.log(`  On-chain breakdown:`);
  console.log(`    • Idle pool USDC:   $${onChainBalanceUsdc.toFixed(4)}`);
  console.log(`    • On-chain hedged:  $${onChainHedgedUsdc.toFixed(4)}`);
  if (dbTotalNav !== null) {
    const offchain = dbTotalNav - onChainBalanceUsdc - onChainHedgedUsdc;
    console.log(`    • Off-chain (BlueFin + admin):  $${offchain.toFixed(4)}  ← bulk of NAV typically lives here`);
  }
  console.log(`  Total shares:       ${totalShares.toFixed(4)}  | Members: ${memberCount}`);
  console.log(`  ATH share price:    ${c('$' + athNavPerShare.toFixed(6), 'b')}`);
  console.log(`  Lifetime deposits:  ${c('$' + totalDepositedUsdc.toFixed(4), 'g')}`);
  console.log(`  Lifetime withdraws: ${c('$' + totalWithdrawnUsdc.toFixed(4), 'r')}`);
  console.log(`  Accrued mgmt fees:  $${mgmtFeesAccrued.toFixed(4)}`);
  console.log(`  Accrued perf fees:  $${perfFeesAccrued.toFixed(4)}`);

  // Capital-flow PnL. REQUIRES the DB NAV snapshot — the on-chain `balance` is only
  // idle pool USDC and excludes the off-chain BlueFin collateral that holds most of
  // the NAV, so computing (on-chain NAV − net capital) would falsely show a big loss.
  const netCapital = totalDepositedUsdc - totalWithdrawnUsdc;
  const navForPnl = dbTotalNav; // null when DB unavailable — verdict is suppressed below
  const capitalFlowPnl = navForPnl !== null ? navForPnl - netCapital : null;
  console.log(`\n  Net capital in:     $${netCapital.toFixed(4)}  (deposits − withdrawals)`);
  if (capitalFlowPnl !== null) {
    console.log(`  ${c('Capital-flow PnL:', 'bold')}  ${c(dollars(capitalFlowPnl), capitalFlowPnl >= 0 ? 'g' : 'r')}  (NAV − net capital)`);
    if (netCapital > 0) console.log(`  As %:               ${c(pct(capitalFlowPnl / netCapital * 100), capitalFlowPnl >= 0 ? 'g' : 'r')}`);
  } else {
    console.log(`  ${c('Capital-flow PnL:', 'bold')}  ${c('indeterminate — NAV snapshot unavailable (DB down)', 'y')}`);
  }

  // Per-share return is the cleanest investor-facing metric
  if (athNavPerShare > 0 && dbSharePrice !== null) {
    const fromAth = (dbSharePrice / athNavPerShare - 1) * 100;
    console.log(`  ${c('vs ATH share price:', 'bold')}  ${c(pct(fromAth), fromAth >= -0.5 ? 'g' : 'r')}  (currently ${fromAth >= -0.5 ? 'at/near peak' : 'in drawdown'})`);
  }
  if (dbSharePrice !== null) {
    const fromStart = (dbSharePrice / 1.0 - 1) * 100; // pool starts at $1.00/share
    console.log(`  ${c('Share-price total return:', 'bold')} ${c(pct(fromStart), fromStart >= 0 ? 'g' : 'r')}  (from $1.0000 start)`);
  }

  // ── 2. Hedge PnL — realised + unrealised ──────────────────────
  console.log('\n── 2. HEDGE PnL (BlueFin perps, SUI chain) ──');
  // Filter out operational <$1 microhedges (transport-only entries used to move USDC, not directional bets)
  const hedgeAgg = await safeQuery(pg, `
    SELECT
      status,
      COUNT(*) FILTER (WHERE notional_value >= 1)::int       AS n_real,
      COUNT(*) FILTER (WHERE notional_value <  1)::int       AS n_ops,
      COALESCE(SUM(notional_value) FILTER (WHERE notional_value >= 1), 0)::numeric AS total_notional,
      COALESCE(SUM(current_pnl) FILTER (WHERE notional_value >= 1), 0)::numeric    AS sum_current_pnl,
      COALESCE(SUM(realized_pnl) FILTER (WHERE notional_value >= 1), 0)::numeric   AS sum_realized_pnl,
      COUNT(*) FILTER (WHERE realized_pnl IS NOT NULL AND realized_pnl <> 0 AND notional_value >= 1)::int AS n_with_realized
    FROM hedges
    WHERE chain = 'sui'
    GROUP BY status
    ORDER BY status
  `);
  let sumRealizedClosed = 0, sumCurrentClosed = 0, sumCurrentActive = 0;
  for (const row of hedgeAgg.rows) {
    const n = row.n_real, ops = row.n_ops;
    const notional = Number(row.total_notional);
    const cpnl = Number(row.sum_current_pnl);
    const rpnl = Number(row.sum_realized_pnl);
    if (row.status === 'closed' || row.status === 'liquidated') {
      sumRealizedClosed += rpnl;
      sumCurrentClosed += cpnl;
    } else {
      sumCurrentActive += cpnl;
    }
    console.log(`  ${row.status.padEnd(12)} ${String(n).padStart(3)} real (+${ops} ops)  notional $${notional.toFixed(2).padStart(10)}  current_pnl ${c(dollars(cpnl), cpnl >= 0 ? 'g' : 'r')}  realized_pnl ${c(dollars(rpnl), rpnl >= 0 ? 'g' : 'r')}  (${row.n_with_realized}/${n} have settled realized_pnl)`);
  }
  console.log('');
  console.log(`  ${c('Realised PnL (closed, BlueFin-confirmed):', 'bold')}  ${c(dollars(sumRealizedClosed), sumRealizedClosed >= 0 ? 'g' : 'r')}  ← actual settled $ from the perp venue`);
  console.log(`  ${c('Snapshot PnL (current_pnl at close):    ', 'bold')}  ${c(dollars(sumCurrentClosed), sumCurrentClosed >= 0 ? 'g' : 'r')}  ${c('← live-PnL frozen at close (not equal to realised — informational)', 'dim')}`);
  console.log(`  ${c('Unrealised PnL on active hedges:        ', 'bold')}  ${c(dollars(sumCurrentActive), sumCurrentActive >= 0 ? 'g' : 'r')}`);

  // Best / worst hedges using the meaningful column
  const extremes = await safeQuery(pg, `
    SELECT id, asset, side, notional_value, current_pnl, realized_pnl, close_reason,
           EXTRACT(EPOCH FROM (closed_at - created_at))/3600 AS hours_open
    FROM hedges
    WHERE chain='sui' AND status IN ('closed','liquidated') AND notional_value >= 1
    ORDER BY current_pnl DESC NULLS LAST
  `);
  if (extremes.rows.length > 0) {
    const best = extremes.rows[0], worst = extremes.rows[extremes.rows.length - 1];
    console.log(`  Best closed:  #${best.id}  ${best.asset} ${best.side}  notional $${Number(best.notional_value).toFixed(2)}  current=${c(dollars(Number(best.current_pnl||0)), 'g')}  realized=${dollars(Number(best.realized_pnl||0))}  (${Number(best.hours_open || 0).toFixed(1)}h)`);
    if (worst.id !== best.id) {
      console.log(`  Worst closed: #${worst.id} ${worst.asset} ${worst.side}  notional $${Number(worst.notional_value).toFixed(2)}  current=${c(dollars(Number(worst.current_pnl||0)), Number(worst.current_pnl||0) >= 0 ? 'g' : 'r')}  realized=${dollars(Number(worst.realized_pnl||0))}  (${Number(worst.hours_open || 0).toFixed(1)}h)`);
    }
  }

  // ── 3. Share-price evolution (NAV history) ────────────────────
  console.log('\n── 3. SHARE-PRICE EVOLUTION (NAV snapshots) ──');
  const navHist = await safeQuery(pg, `
    (SELECT timestamp, share_price, total_nav, total_shares
       FROM community_pool_nav_history WHERE chain='sui' ORDER BY timestamp ASC LIMIT 1)
    UNION ALL
    (SELECT timestamp, share_price, total_nav, total_shares
       FROM community_pool_nav_history WHERE chain='sui' ORDER BY timestamp DESC LIMIT 1)
  `);
  if (navHist.rows.length >= 2) {
    const [first, last] = navHist.rows;
    const days = (new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()) / 86400000;
    const spChangePct = (Number(last.share_price) - Number(first.share_price)) / Math.max(Number(first.share_price), 1e-9) * 100;
    console.log(`  First snapshot: ${new Date(first.timestamp).toISOString().slice(0,10)}  sharePrice=$${Number(first.share_price).toFixed(6)}  NAV=$${Number(first.total_nav).toFixed(2)}`);
    console.log(`  Latest:         ${new Date(last.timestamp).toISOString().slice(0,10)}  sharePrice=$${Number(last.share_price).toFixed(6)}  NAV=$${Number(last.total_nav).toFixed(2)}`);
    console.log(`  Δ over ${days.toFixed(1)} days: ${c(pct(spChangePct), spChangePct >= 0 ? 'g' : 'r')}  share-price change`);
  } else if (navHist.rows.length === 1) {
    console.log(`  Only 1 snapshot — can't measure change. sharePrice=$${Number(navHist.rows[0].share_price).toFixed(6)}`);
  } else {
    console.log(c(dbDown ? '  (skipped — DB unavailable)' : '  (no NAV history rows for chain=sui)', 'dim'));
  }

  // ── 4. Capital flow from transactions table ───────────────────
  console.log('\n── 4. CAPITAL FLOW (community_pool_transactions, chain=sui) ──');
  const txAgg = await safeQuery(pg, `
    SELECT type, COUNT(*)::int n, COALESCE(SUM(amount_usd), 0)::numeric sum_usd
    FROM community_pool_transactions
    WHERE chain='sui' AND type IN ('DEPOSIT','WITHDRAW','FEE_COLLECTED','REBALANCE','HEDGE_OPEN','HEDGE_CLOSE')
    GROUP BY type ORDER BY type
  `);
  if (dbDown) console.log(c('  (skipped — DB unavailable)', 'dim'));
  for (const row of txAgg.rows) {
    console.log(`  ${row.type.padEnd(15)} ${String(row.n).padStart(4)} tx   $${Number(row.sum_usd).toFixed(2).padStart(12)}`);
  }

  // ── 5. Members + share concentration ─────────────────────────
  console.log('\n── 5. MEMBER POSITIONS ──');
  // community_pool_shares columns: shares, cost_basis_usd (no separate withdrawn col).
  // Don't silently swallow a query error here — a swallowed schema mismatch previously
  // masked all 3 members as "Members: 0", which is exactly the kind of false-zero this
  // diagnostic must never print.
  if (dbDown) {
    console.log(c('  (skipped — DB unavailable)', 'dim'));
  } else {
    const sharesAgg = await pg.query(`
      SELECT
        COUNT(*) ::int                                                   AS n,
        COALESCE(SUM(shares),0)::numeric                                 AS total_shares,
        COALESCE(MAX(shares),0)::numeric                                 AS max_shares,
        COALESCE(SUM(cost_basis_usd),0)::numeric                         AS sum_cost_basis
      FROM community_pool_shares WHERE chain='sui'
    `).catch((e: unknown) => {
      console.log(`  ${c('⚠ member query failed:', 'r')} ${e instanceof Error ? e.message : String(e)}`);
      return { rows: [{ n: '?', total_shares: 0, max_shares: 0, sum_cost_basis: 0 }] };
    });
    const sharesRow = sharesAgg.rows[0];
    console.log(`  Members: ${sharesRow.n}  total_shares=${Number(sharesRow.total_shares || 0).toFixed(4)}  largest=${Number(sharesRow.max_shares || 0).toFixed(4)}`);
    if (Number(sharesRow.sum_cost_basis || 0) > 0) {
      console.log(`  DB-tracked cost basis: $${Number(sharesRow.sum_cost_basis).toFixed(2)}`);
    }
  }

  // ── 6. VERDICT ────────────────────────────────────────────────
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║  VERDICT                                                       ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');

  // A trustworthy verdict needs the DB NAV snapshot. Without it (DB down) we only
  // see idle on-chain USDC, not the off-chain BlueFin NAV — so we report INDETERMINATE
  // rather than a misleading LOSS.
  if (navForPnl === null || dbSharePrice === null) {
    console.log(`\n  ${c('Capital flow (true $ generated):', 'bold')}`);
    console.log(`    ${c('Indeterminate — NAV snapshot unavailable (DB down).', 'y')}`);
    console.log(`    On-chain idle USDC $${onChainBalanceUsdc.toFixed(2)} only; the bulk of NAV is off-chain (BlueFin) and needs the DB snapshot or a live BlueFin read.`);
    console.log(`\n  ${c('VERDICT:', 'bold')} ${c('INDETERMINATE ⚠ (DB unavailable)', 'y')}\n`);
    await pg.end().catch(() => {});
    return;
  }

  const investorReturnPct = (dbSharePrice / 1.0 - 1) * 100;
  const capitalPnl = navForPnl - netCapital;

  console.log(`\n  ${c('Headline (investor-facing):', 'bold')}`);
  console.log(`    Share price: $${dbSharePrice.toFixed(4)} (from $1.0000)  →  ${c(pct(investorReturnPct), investorReturnPct >= 0 ? 'g' : 'r')} return per share`);
  console.log(`    ATH per share: $${athNavPerShare.toFixed(4)} — currently ${Math.abs(dbSharePrice - athNavPerShare) < 0.001 ? c('at peak', 'g') : c('off peak', 'y')}`);
  console.log(`\n  ${c('Capital flow (true $ generated):', 'bold')}`);
  console.log(`    NAV $${navForPnl.toFixed(2)} vs net capital in $${netCapital.toFixed(2)}  →  ${c(dollars(capitalPnl), capitalPnl >= 0 ? 'g' : 'r')}`);
  console.log(`\n  ${c('Hedge engine contribution:', 'bold')}`);
  console.log(`    BlueFin-settled realised: ${c(dollars(sumRealizedClosed), sumRealizedClosed >= 0 ? 'g' : 'r')}`);
  console.log(`    Active unrealised:        ${c(dollars(sumCurrentActive), sumCurrentActive >= 0 ? 'g' : 'r')}`);
  console.log(`    Accrued mgmt fees:        $${mgmtFeesAccrued.toFixed(4)}`);

  const inProfit = investorReturnPct > 0 && capitalPnl > 0;
  const inLoss = investorReturnPct < 0 || capitalPnl < 0;
  const verdict = inProfit ? c('PROFIT ✅', 'g') : inLoss ? c('LOSS ❌', 'r') : c('FLAT', 'dim');
  console.log(`\n  ${c('VERDICT:', 'bold')} ${verdict}\n`);

  await pg.end().catch(() => {});
}

main().catch(e => { console.error(e); process.exit(1); });
