/**
 * Bulletproof end-to-end test: pool money -> swap -> BlueFin margin -> hedges,
 * with AI-driven daily-cap reset.
 *
 *   npx tsx --env-file=.env.production --env-file=.env.local test-bulletproof-e2e.ts
 *
 * READ-ONLY: this script does NOT submit any transactions. It validates every
 * link in the live chain so we know an unsupervised cron tick will succeed.
 */
import 'dotenv/config';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { BluefinService } from './lib/services/sui/BluefinService';
import {
  SUI_USDC_POOL_CONFIG,
  SUI_USDC_COIN_TYPE,
} from './lib/services/sui/SuiCommunityPoolService';
import { getSuiPoolAgent } from './agents/specialized/SuiPoolAgent';
import { getCronStateOr } from './lib/db/cron-state';
type Result = { name: string; ok: boolean; detail?: string };
const results: Result[] = [];
const ok = (name: string, detail?: string) => {
  results.push({ name, ok: true, detail });
  console.log(`  PASS  ${name}${detail ? ' -- ' + detail : ''}`);
};
const fail = (name: string, detail: string) => {
  results.push({ name, ok: false, detail });
  console.log(`  FAIL  ${name} -- ${detail}`);
};
const sect = (n: string) => console.log(`\n${'='.repeat(72)}\n${n}\n${'='.repeat(72)}`);

const NETWORK = 'mainnet' as const;
const ADMIN_ADDR = '0x99a3a0fd45bb6b467547430b8efab77eb64218ab098428297a7a3be77329ac93';

async function main() {
  console.log('Bulletproof E2E Test  ::  Sui Community Pool Auto-Hedge\n');

  // ── 1. ENV / SECRETS ────────────────────────────────────────────────────
  sect('1. Environment & secrets');
  const required = [
    'BLUEFIN_PRIVATE_KEY',
    'SUI_POOL_ADMIN_KEY',
    'SUI_ADMIN_CAP_ID',
    'SUI_AGENT_CAP_ID',
    'DATABASE_URL',
  ];
  for (const k of required) {
    const v = (process.env[k] || '').trim();
    if (v) ok(`env.${k}`, 'set');
    else fail(`env.${k}`, 'NOT SET');
  }

  // ── 2. POOL ON-CHAIN STATE ───────────────────────────────────────────────
  sect('2. Pool on-chain state (NAV, balance, daily hedge counter)');
  const cfg = SUI_USDC_POOL_CONFIG[NETWORK];
  const sui = new SuiClient({ url: process.env.SUI_MAINNET_RPC || getFullnodeUrl('mainnet') });
  let navUsd = 0,
    contractBalance = 0,
    dailyHedgedToday = 0;
  let poolFields: any = null;
  try {
    const obj = await sui.getObject({ id: cfg.poolStateId!, options: { showContent: true } });
    poolFields = (obj.data?.content as any)?.fields;
    if (!poolFields) throw new Error('no fields');
    contractBalance =
      Number(
        typeof poolFields.balance === 'string'
          ? poolFields.balance
          : poolFields.balance?.fields?.value || '0'
      ) / 1e6;
    const totalHedged = Number(poolFields.hedge_state?.fields?.total_hedged_value || 0) / 1e6;
    navUsd = contractBalance + totalHedged;
    dailyHedgedToday = Number(poolFields.hedge_state?.fields?.daily_hedge_total || 0) / 1e6;
    ok(
      'pool readable',
      `NAV=$${navUsd.toFixed(2)} bal=$${contractBalance.toFixed(2)} dailyHedged=$${dailyHedgedToday.toFixed(2)}`
    );
  } catch (e) {
    fail('pool readable', e instanceof Error ? e.message : String(e));
    return;
  }

  // ── 3. AI / PREDICTION MARKET PIPELINE ──────────────────────────────────
  sect('3. AI + Polymarket signal pipeline');
  const agent = getSuiPoolAgent();
  let aiCtx: any = null;
  try {
    aiCtx = await agent.getEnhancedAllocationContext();
    const sigs = aiCtx?.predictionSignals?.length ?? 0;
    if (sigs >= 1)
      ok(
        'prediction signals',
        `${sigs} markets, sentiment=${aiCtx.marketSentiment}, urgency=${aiCtx.urgency}, conf=${aiCtx.confidence}%`
      );
    else fail('prediction signals', 'no signals');
    const a = aiCtx?.allocations || {};
    const sumPct = ['BTC', 'ETH', 'SUI'].reduce((s, k) => s + Number(a[k] || 0), 0);
    if (sumPct > 0 && sumPct <= 110)
      ok('allocations sum', `BTC=${a.BTC} ETH=${a.ETH} SUI=${a.SUI} (sum ${sumPct})`);
    else fail('allocations sum', `unexpected sum ${sumPct}`);
  } catch (e) {
    fail('AI pipeline', e instanceof Error ? e.message : String(e));
  }

  // ── 4. DAILY-CAP RESET LOGIC ─────────────────────────────────────────────
  sect('4. AI-driven daily-cap reset gate');
  const dailyCap = navUsd * 0.5;
  const exhausted = dailyHedgedToday >= dailyCap * 0.99;
  const minConf = Number(process.env.HEDGE_RESET_MIN_CONFIDENCE || 75);
  const maxResets = Number(process.env.HEDGE_DAILY_MAX_RESETS || 4);
  const urgency = (aiCtx?.urgency || '').toUpperCase();
  const conf = Number(aiCtx?.confidence || 0);
  const strongSignal = urgency === 'HIGH' || urgency === 'CRITICAL' || conf >= minConf;
  const dayKey = `hedgeDailyReset:${Math.floor(Date.now() / 86_400_000)}`;
  const usedToday = await getCronStateOr<number>(dayKey, 0);
  ok(
    'cap status',
    `cap=$${dailyCap.toFixed(2)} used=$${dailyHedgedToday.toFixed(2)} exhausted=${exhausted}`
  );
  ok('reset budget', `${usedToday}/${maxResets} used today`);
  if (exhausted) {
    if (strongSignal && usedToday < maxResets)
      ok('reset would fire', `urgency=${urgency} conf=${conf} -> reset()`);
    else
      ok(
        'reset declined',
        `weak signal or budget exhausted (urgency=${urgency} conf=${conf} used=${usedToday}/${maxResets})`
      );
  } else {
    ok('cap not yet exhausted', 'reset gate not needed this tick');
  }

  // ── 5. ADMIN CAP OWNERSHIP (so reset call would actually succeed) ────────
  sect('5. AdminCap ownership');
  const adminCapId = (process.env.SUI_ADMIN_CAP_ID || '').trim();
  try {
    const c = await sui.getObject({ id: adminCapId, options: { showOwner: true, showType: true } });
    const owner: any = c.data?.owner;
    const ownerAddr = owner?.AddressOwner;
    if (ownerAddr === ADMIN_ADDR)
      ok(
        'AdminCap owned by admin wallet',
        `${adminCapId.slice(0, 12)}... -> ${ownerAddr.slice(0, 12)}...`
      );
    else
      fail(
        'AdminCap owner',
        `expected ${ADMIN_ADDR.slice(0, 12)}, got ${String(ownerAddr).slice(0, 12)}`
      );
    if ((c.data?.type || '').includes('AdminCap')) ok('AdminCap type', c.data!.type!);
    else fail('AdminCap type', c.data?.type || 'unknown');
  } catch (e) {
    fail('AdminCap fetch', e instanceof Error ? e.message : String(e));
  }

  // ── 6. ADMIN WALLET BALANCES ─────────────────────────────────────────────
  sect('6. Admin wallet (treasury between pool and BlueFin)');
  const usdcType = SUI_USDC_COIN_TYPE[NETWORK];
  let adminUsdc = 0,
    adminSui = 0;
  try {
    const u = await sui.getBalance({ owner: ADMIN_ADDR, coinType: usdcType });
    adminUsdc = Number(BigInt(u.totalBalance)) / 1e6;
    const s = await sui.getBalance({ owner: ADMIN_ADDR });
    adminSui = Number(BigInt(s.totalBalance)) / 1e9;
    ok('admin USDC', `$${adminUsdc.toFixed(4)}`);
    ok('admin SUI ', `${adminSui.toFixed(4)} (gas + reverse-swap source)`);
  } catch (e) {
    fail('admin balances', e instanceof Error ? e.message : String(e));
  }

  // ── 7. BLUEFIN MARGIN ACCOUNT ───────────────────────────────────────────
  sect('7. BlueFin margin account');
  const bfKey = (process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  const bf = BluefinService.getInstance();
  if (!bf.isInitialized()) await bf.initialize(bfKey, 'mainnet');
  let positions: any[] = [];
  let freeColl = 0,
    totalColl = 0;
  try {
    const acct: any = await (bf as any).apiRequest(
      'GET',
      `/api/v1/account?accountAddress=${bf.getAddress()}`,
      undefined,
      'exchange'
    );
    freeColl = Number(acct.freeCollateral || 0);
    totalColl = Number(acct.crossAccountValueE9 || 0) / 1e9;
    positions = acct.positions || [];
    ok(
      'BlueFin acct readable',
      `total=$${totalColl.toFixed(2)} free=$${freeColl.toFixed(4)} positions=${positions.length}`
    );
    if (acct.canTrade) ok('canTrade=true');
    else fail('canTrade', 'false');
  } catch (e) {
    fail('BlueFin account', e instanceof Error ? e.message : String(e));
  }

  // ── 8. SIZING SIMULATION (full hedge plan) ───────────────────────────────
  sect('8. Hedge sizing simulation (BTC/ETH/SUI)');
  const PERP = {
    BTC: { minQty: 0.001, step: 0.001 },
    ETH: { minQty: 0.01, step: 0.01 },
    SUI: { minQty: 1, step: 1 },
  } as const;
  const lev = navUsd < 1000 ? 10 : 5;
  const ratio = navUsd < 1000 ? 1.0 : 0.5;
  const prices: Record<string, number> = {};
  try {
    const { getMarketDataService } =
      await import('./lib/services/market-data/RealMarketDataService');
    const md = getMarketDataService();
    for (const a of ['BTC', 'ETH', 'SUI']) {
      const p = await md.getTokenPrice(a);
      prices[a] = p?.price || 0;
    }
    ok(
      'prices',
      `BTC=$${prices.BTC.toFixed(0)} ETH=$${prices.ETH.toFixed(0)} SUI=$${prices.SUI.toFixed(2)}`
    );
  } catch (e) {
    fail('prices', e instanceof Error ? e.message : String(e));
  }
  let totalNotional = 0;
  for (const a of ['BTC', 'ETH', 'SUI'] as const) {
    const alloc = Number(aiCtx?.allocations?.[a] || 0);
    const valUsd = navUsd * (alloc / 100) * ratio;
    const eff = valUsd * lev;
    const raw = eff / (prices[a] || 1);
    const snapped = Math.floor(raw / PERP[a].step) * PERP[a].step;
    totalNotional += valUsd;
    if (snapped >= PERP[a].minQty)
      ok(
        `${a}-PERP sizing`,
        `alloc=${alloc}% size=${snapped} (notional $${valUsd.toFixed(2)} eff $${eff.toFixed(2)})`
      );
    else fail(`${a}-PERP sizing`, `size=${snapped} < minQty=${PERP[a].minQty}`);
  }
  const requiredMargin = totalNotional / lev + 0.5;
  ok('required margin', `$${requiredMargin.toFixed(2)} for full BTC+ETH+SUI plan`);

  // ── 9. MARGIN TOP-UP PLAN (autoTopUp inputs) ─────────────────────────────
  sect('9. Margin top-up planner');
  const targetMargin = Math.max(1.5, requiredMargin);
  const minMargin = targetMargin * 0.9;
  if (freeColl >= minMargin)
    ok('margin sufficient', `$${freeColl.toFixed(2)} >= $${minMargin.toFixed(2)}`);
  else {
    const shortfall = targetMargin - freeColl;
    if (adminUsdc >= shortfall)
      ok('top-up via spot USDC', `need $${shortfall.toFixed(2)} have $${adminUsdc.toFixed(2)}`);
    else {
      const suiPx = prices.SUI || 2;
      const reserve = 0.5;
      const spendableSui = Math.max(0, adminSui - reserve);
      const suiNeeded = (shortfall - adminUsdc) / suiPx;
      if (spendableSui >= suiNeeded) {
        ok(
          'top-up via SUI->USDC',
          `swap ${suiNeeded.toFixed(3)} SUI (have ${spendableSui.toFixed(3)} spendable)`
        );
      } else {
        // Pool->admin transfer (Step 6.5) is the upstream funding source. If it's
        // feasible (now or after AI-driven reset), the next cron tick will fill
        // admin USDC before autoTopUp runs.
        const totalHedgedNow =
          Number(poolFields.hedge_state?.fields?.total_hedged_value || 0) / 1e6;
        const poolMax = Math.min(contractBalance * 0.8, Math.max(0, navUsd * 0.5 - totalHedgedNow));
        const willFundFromPool =
          (exhausted ? strongSignal && usedToday < maxResets : true) && poolMax >= shortfall;
        if (willFundFromPool)
          ok(
            'top-up via pool->admin (next tick)',
            `pool can fund $${poolMax.toFixed(2)} >= $${shortfall.toFixed(2)} need`
          );
        else
          fail(
            'top-up coverage',
            `need $${shortfall.toFixed(2)}, have $${adminUsdc.toFixed(2)} USDC + ${spendableSui.toFixed(3)} SUI ($${(spendableSui * suiPx).toFixed(2)}); pool max $${poolMax.toFixed(2)} (exhausted=${exhausted} strongSignal=${strongSignal})`
          );
      }
    }
  }

  // ── 10. POOL -> ADMIN TRANSFER FEASIBILITY (Step 6.5) ───────────────────
  sect('10. Pool -> admin transfer (Step 6.5) feasibility');
  const _reserveFloor = contractBalance * 0.2;
  const maxByReserve = contractBalance * 0.8;
  const totalHedged = Number(poolFields.hedge_state?.fields?.total_hedged_value || 0) / 1e6;
  const maxByRatio = Math.max(0, navUsd * 0.5 - totalHedged);
  const maxByDaily = Math.max(0, dailyCap - dailyHedgedToday);
  const maxXfer = Math.min(maxByReserve, maxByRatio, maxByDaily);
  ok(
    'transfer caps',
    `reserve=$${maxByReserve.toFixed(2)} ratio=$${maxByRatio.toFixed(2)} daily=$${maxByDaily.toFixed(2)} -> max $${maxXfer.toFixed(2)}`
  );
  if (maxXfer >= 1) ok('transfer feasible NOW');
  else if (exhausted && strongSignal && usedToday < maxResets)
    ok('transfer feasible AFTER reset', `AI signal will trigger reset`);
  else ok('transfer waits for cap reset or signal', `next reset @ midnight UTC or stronger AI`);

  // ── 11. EXISTING POSITIONS / DEDUP ──────────────────────────────────────
  sect('11. Existing positions / dedup');
  for (const p of positions) {
    ok(`live position`, `${p.symbol} ${p.side} qty=${p.quantity} entry=${p.avgEntryPrice}`);
  }
  if (!positions.length) ok('no live positions', 'all 3 hedges available');

  // ── 12. RECONCILER STATE ─────────────────────────────────────────────────
  sect('12. Reconciler state (DB hedges vs live BlueFin positions)');
  try {
    const { query } = await import('./lib/db/postgres');
    const dbRows = await query<{ order_id: string; market: string; side: string }>(
      `SELECT order_id, market, side FROM hedges WHERE chain='sui' AND status='active'`
    );
    const reconciled = dbRows.filter((r) => r.order_id?.startsWith('BF_RECONCILE_'));
    const livePosKeys = new Set(
      positions.map((p: any) => `${p.symbol}|${(p.side || '').toUpperCase()}`)
    );
    // Each BF_RECONCILE_* row should match an actual live position.
    let orphans = 0;
    for (const r of reconciled) {
      const key = `${r.market}|${(r.side || '').toUpperCase()}`;
      if (!livePosKeys.has(key)) orphans++;
    }
    if (orphans === 0)
      ok(
        'reconciler clean',
        `${reconciled.length} adopted row(s) match ${livePosKeys.size} live position(s)`
      );
    else
      fail(
        'orphan reconciler rows',
        `${orphans} BF_RECONCILE_* rows have no matching live position`
      );
  } catch (e) {
    fail('reconciler check', e instanceof Error ? e.message : String(e));
  }

  // ── 13. CRON FRESHNESS ──────────────────────────────────────────────────
  sect('13. Cron heartbeat (community_pool_nav_history)');
  try {
    const { query } = await import('./lib/db/postgres');
    const last = await query<{ timestamp: string; total_nav: number; source: string }>(
      `SELECT timestamp, total_nav, source FROM community_pool_nav_history
       WHERE chain='sui' ORDER BY timestamp DESC LIMIT 1`
    );
    const row = last[0];
    if (row) {
      const minsAgo = (Date.now() - new Date(row.timestamp).getTime()) / 60_000;
      if (minsAgo < 60)
        ok(
          'recent cron run',
          `${minsAgo.toFixed(1)}m ago, NAV=$${Number(row.total_nav).toFixed(2)}, source=${row.source}`
        );
      else fail('cron stale', `${minsAgo.toFixed(0)}m ago`);
    } else fail('cron heartbeat', 'no community_pool_nav_history rows for chain=sui');
  } catch (e) {
    fail('cron heartbeat', e instanceof Error ? e.message : String(e));
  }

  // ── SUMMARY ─────────────────────────────────────────────────────────────
  sect('SUMMARY');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`PASS: ${passed}    FAIL: ${failed}    TOTAL: ${results.length}`);
  if (failed > 0) {
    console.log('\nFailures:');
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}: ${r.detail}`));
    process.exit(1);
  }
  console.log('\nALL GREEN -- pipeline is bulletproof.');
}

main().catch((e) => {
  console.error('TEST CRASHED:', e);
  process.exit(2);
});
