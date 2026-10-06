/**
 * Hedge ↔ prediction-signal alignment check.
 *
 * Read-only. Compares each active hedge's side against the per-asset fused
 * prediction signal for THAT asset (not BTC). Inputs:
 *   - Live SUI on-chain hedge positions (pool.hedge_state.active_hedges)
 *   - DB hedge rows (chain='sui', status='active')
 *   - PredictionAggregator.getPerAssetPredictions for each asset with an
 *     active hedge, plus BTC for overall market context
 *
 * Previously this used only the Polymarket 5-min BTC binary and judged
 * every hedge against the BTC signal — which mis-flagged ETH/SUI hedges
 * any time their asset's signal disagreed with BTC. The per-asset signal
 * is the right universe for an ETH SHORT or SUI LONG.
 *
 * Run: bun run scripts/check-hedge-signal-alignment.ts
 */
import 'dotenv/config';
import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'fs';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Pool } from 'pg';

// Manually load .env.local since dotenv/config only loads .env
if (existsSync('.env.local')) loadDotenv({ path: '.env.local', override: true });

const POOL_STATE = (process.env.NEXT_PUBLIC_SUI_MAINNET_USDC_POOL_STATE
  || process.env.NEXT_PUBLIC_SUI_MAINNET_COMMUNITY_POOL_STATE
  || '0xe814e0948e29d9c10b73a0e6fb23c9997ccc373bed223657ab65ff544742fb3a').trim();

type Direction = 'UP' | 'DOWN' | 'NEUTRAL';
type Side = 'LONG' | 'SHORT';

function expectedSide(signal: Direction): Side | null {
  if (signal === 'UP') return 'LONG';        // bullish → long
  if (signal === 'DOWN') return 'SHORT';     // bearish → short hedge
  return null;
}

// On-chain Move struct fields (verified against pool.hedge_state.active_hedges):
//   collateral_usdc (1e6 USDC), is_long (bool), hedge_id (byte vector), leverage, pair_index.
// NB: the field is is_long, NOT is_short — a hedge is SHORT only when is_long === false.
function onChainSide(f: any): Side {
  return f?.is_long === false ? 'SHORT' : 'LONG';
}
function onChainCollatUsd(f: any): number {
  return Number(f?.collateral_usdc || 0) / 1e6;
}
function onChainHedgeId(f: any): string {
  const arr = f?.hedge_id?.fields?.id ?? f?.hedge_id ?? f?.id;
  return Array.isArray(arr)
    ? '0x' + arr.map((n: number) => n.toString(16).padStart(2, '0')).join('')
    : String(arr ?? '');
}

function color(s: string, c: 'g' | 'r' | 'y' | 'b' | 'dim') {
  const codes = { g: 32, r: 31, y: 33, b: 36, dim: 90 } as const;
  return `\x1b[${codes[c]}m${s}\x1b[0m`;
}

async function main() {
  const lines: string[] = [];
  const log = (s = '') => { console.log(s); lines.push(s); };

  log('\n╔════════════════════════════════════════════════════════════════╗');
  log('║  HEDGE ↔ PREDICTION-SIGNAL ALIGNMENT (read-only)               ║');
  log('╚════════════════════════════════════════════════════════════════╝\n');

  // ── 1. On-chain pool state ────────────────────────────────────
  log('── 1. ON-CHAIN POOL STATE ──');
  const sui = new SuiClient({ url: process.env.SUI_MAINNET_RPC?.trim() || getFullnodeUrl('mainnet') });
  const obj = await sui.getObject({ id: POOL_STATE, options: { showContent: true } });
  if (!obj.data) { log(color('  ✗ pool not found', 'r')); process.exit(2); }
  const fields = (obj.data?.content as any)?.fields;
  const balanceUsd = Number(fields?.balance || 0) / 1e6;
  const totalHedgedUsd = Number(fields?.hedge_state?.fields?.total_hedged_value || 0) / 1e6;
  const dailyTotalUsd = Number(fields?.hedge_state?.fields?.daily_hedge_total || 0) / 1e6;
  const activeHedgesOnChain: any[] = fields?.hedge_state?.fields?.active_hedges || [];
  log(`  On-chain only: $${(balanceUsd + totalHedgedUsd).toFixed(2)}  | balance=$${balanceUsd.toFixed(2)}  hedged=$${totalHedgedUsd.toFixed(2)}  dailyTotal=$${dailyTotalUsd.toFixed(2)}`);
  log(color(`  (excludes off-chain BlueFin collateral + admin assets — full NAV read from DB below)`, 'dim'));
  log(`  Active on-chain hedges: ${color(String(activeHedgesOnChain.length), activeHedgesOnChain.length ? 'g' : 'dim')}`);
  for (const h of activeHedgesOnChain) {
    const f = h?.fields || {};
    const asset = ['BTC','ETH','SUI','CRO'][Number(f.pair_index)] ?? '?';
    const side = onChainSide(f);
    const collat = onChainCollatUsd(f);
    const lev = Number(f.leverage || 1);
    const notional = collat * lev;
    log(`    • ${asset.padEnd(3)} ${side.padEnd(5)}  collat=$${collat.toFixed(4)}  lev=${lev}x  notional=$${notional.toFixed(2)}  id=${onChainHedgeId(f).slice(0, 18)}…`);
  }

  // ── 2. DB hedges (Postgres) ──────────────────────────────────
  log('\n── 2. DB HEDGES (chain=sui, status=active) ──');
  const cs = (process.env.PROD_DATABASE_URL || process.env.DATABASE_URL || '').trim();
  let dbHedges: any[] = [];
  // Canonical full NAV (idle pool USDC + off-chain BlueFin collateral + admin assets) is
  // snapshotted by the cron into community_pool_nav_history — same figure the auto-hedge
  // gate uses. On-chain balance alone undercounts it badly, so read the snapshot for the floor verdict.
  let trueNavUsd: number | null = null;
  let dbDown = false;
  if (!cs) {
    log(color('  ⚠ no DB connection string — skipping', 'y'));
  } else {
    const pg = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
    try {
      const r = await pg.query(
        `SELECT id, asset, side, size, notional_value, leverage, status, prediction_market,
                hedge_id_onchain, created_at, current_pnl
         FROM hedges WHERE chain='sui' AND status='active'
         ORDER BY created_at DESC`
      );
      dbHedges = r.rows;
      const nav = await pg.query(
        `SELECT total_nav FROM community_pool_nav_history WHERE chain='sui' ORDER BY timestamp DESC LIMIT 1`
      );
      if (nav.rows[0]) trueNavUsd = Number(nav.rows[0].total_nav);
      log(`  Active DB rows: ${color(String(dbHedges.length), dbHedges.length ? 'g' : 'dim')}`);
      for (const h of dbHedges) {
        const ageMin = (Date.now() - new Date(h.created_at).getTime()) / 60000;
        log(`    • #${h.id} ${h.asset.padEnd(4)} ${h.side.padEnd(5)}  size=${h.size}  notional=$${Number(h.notional_value).toFixed(2)}  lev=${h.leverage}x  PnL=$${Number(h.current_pnl).toFixed(2)}  age=${ageMin.toFixed(0)}m  pred=${h.prediction_market || '(none)'}`);
      }
    } catch (e) {
      dbDown = true;
      log(color('  ⚠ DB unavailable — skipping DB hedges + full-NAV floor check (on-chain + signal still shown).', 'y'));
      log(color(`    Reason: ${e instanceof Error ? e.message : String(e)}`, 'dim'));
    } finally { await pg.end().catch(() => {}); }
  }

  // ── 3. Per-asset prediction signals (fused) ──────────────────
  // Previously this read only the Polymarket 5-min BTC binary and judged
  // every hedge (ETH SHORT, SUI LONG, etc.) against the BTC signal — which
  // produced false misalignment reports the moment an ETH hedge disagreed
  // with the BTC signal. Now we ask PredictionAggregator for the per-asset
  // fused signal (Polymarket 5-min + Delphi + Crypto.com 24h + funding +
  // Manifold) for each active hedge's asset, plus BTC as overall context.
  log('\n── 3. PER-ASSET PREDICTION SIGNALS ──');
  const hedgeAssets = new Set<string>();
  for (const h of activeHedgesOnChain) {
    if (onChainCollatUsd(h.fields) < 1) continue;
    const a = ['BTC','ETH','SUI','CRO'][Number(h.fields?.pair_index)];
    if (a) hedgeAssets.add(a.toUpperCase());
  }
  for (const h of dbHedges) {
    if (Number(h.notional_value) < 1) continue;
    if (h.asset) hedgeAssets.add(String(h.asset).toUpperCase());
  }
  // Always include BTC as overall-market context, even when no BTC hedges.
  hedgeAssets.add('BTC');

  const perAsset: Record<string, { direction: Direction; confidence: number; consensus: number; recommendation: string } | null> = {};
  try {
    const { PredictionAggregatorService } = await import('@/lib/services/market-data/PredictionAggregatorService');
    const preds = await (PredictionAggregatorService as any).getPerAssetPredictions(Array.from(hedgeAssets));
    for (const a of hedgeAssets) {
      const p = preds[a];
      perAsset[a] = p
        ? { direction: p.direction as Direction, confidence: p.confidence, consensus: p.consensus, recommendation: p.recommendation }
        : null;
      const d = perAsset[a];
      if (d) {
        log(`  ${a.padEnd(4)} ${color(d.direction, d.direction === 'UP' ? 'g' : d.direction === 'DOWN' ? 'r' : 'dim')}  conf=${d.confidence.toFixed(0)}%  consensus=${d.consensus.toFixed(0)}%  rec=${d.recommendation}`);
      } else {
        log(color(`  ${a.padEnd(4)} ⚠ no signal available`, 'y'));
      }
    }
  } catch (e) {
    log(color(`  ✗ Prediction fetch failed: ${e instanceof Error ? e.message : String(e)}`, 'r'));
  }

  // ── 4. ALIGNMENT VERDICT ────────────────────────────────────
  log('\n── 4. ALIGNMENT VERDICT (per-asset) ──');
  {
    // Operational transport hedges (pool→admin USDC moves for spot swaps)
    // are always 1x leverage — real directional hedges are ≥3x. The old
    // <$1 filter missed transports like the 2026-07-28 BTC LONG at $6.07
    // collat 1x that flagged as "misaligned" every tick despite being a
    // capability-transport entry, not a bet.
    const OPERATIONAL_COLLAT_THRESHOLD_USD = 1;
    const isOperational = (f: any) =>
      onChainCollatUsd(f) < OPERATIONAL_COLLAT_THRESHOLD_USD || Number(f?.leverage || 1) <= 1;
    const realOnChain = activeHedgesOnChain.filter(h => !isOperational(h.fields));
    const skippedOps = activeHedgesOnChain.length - realOnChain.length;
    if (skippedOps > 0) log(`  ${color(`(skipping ${skippedOps} on-chain operational entries — 1x leverage or <$1 collat, not directional)`, 'dim')}`);
    const allActive = [
      ...realOnChain.map(h => ({
        src: 'on-chain', asset: ['BTC','ETH','SUI','CRO'][Number(h.fields?.pair_index)] ?? '?',
        side: onChainSide(h.fields),
      })),
      ...dbHedges
        .filter(h => Number(h.notional_value) >= OPERATIONAL_COLLAT_THRESHOLD_USD)
        .map(h => ({ src: 'db', asset: String(h.asset).toUpperCase(), side: h.side as Side })),
    ];

    if (allActive.length === 0) {
      log(`  ${color('No active hedges.', 'dim')} Nothing to validate.`);
      const floor = Number(process.env.HEDGE_MIN_NAV_USD) || 20;
      if (trueNavUsd !== null) {
        log(`  Full NAV (DB snapshot, incl. BlueFin + admin) $${trueNavUsd.toFixed(2)} is ${trueNavUsd < floor ? color('below', 'y') : color('above', 'g')} the $${floor} auto-hedge floor (HEDGE_MIN_NAV_USD).`);
      } else if (dbDown) {
        log(color(`  ⚠ DB unavailable — cannot evaluate the $${floor} auto-hedge floor (full NAV lives in the DB snapshot; on-chain balance alone undercounts it).`, 'y'));
      } else {
        log(color(`  ⚠ No NAV snapshot in DB — cannot evaluate the $${floor} auto-hedge floor (on-chain balance alone undercounts NAV).`, 'y'));
      }
    } else {
      let aligned = 0, misaligned = 0, neutral = 0, missing = 0;
      for (const h of allActive) {
        const sig = perAsset[h.asset];
        if (!sig) {
          missing++;
          log(`    ${color('? unknown', 'y')}    ${h.src.padEnd(8)} ${h.asset.padEnd(4)} ${h.side}  (no signal for ${h.asset})`);
          continue;
        }
        const expSide = expectedSide(sig.direction);
        if (!expSide) {
          neutral++;
          log(`    ${color('~ neutral', 'dim')}   ${h.src.padEnd(8)} ${h.asset.padEnd(4)} ${h.side}  (${h.asset} signal NEUTRAL — neither confirmed nor contradicted)`);
          continue;
        }
        const ok = h.side === expSide;
        if (ok) aligned++; else misaligned++;
        log(`    ${ok ? color('✓ aligned', 'g') : color('✗ MISALIGNED', 'r')}  ${h.src.padEnd(8)} ${h.asset.padEnd(4)} is ${h.side} (${h.asset} signal wants ${expSide} — ${sig.direction} conf=${sig.confidence.toFixed(0)}%)`);
      }
      log('');
      log(`  Total: ${color(String(aligned), 'g')} aligned, ${color(String(misaligned), misaligned ? 'r' : 'dim')} misaligned, ${neutral} neutral, ${missing} no-signal, ${allActive.length} active.`);
      if (misaligned === 0) log(color('  ✓ No hedge contradicts its asset-specific prediction signal.', 'g'));
      else log(color('  ✗ At least one hedge contradicts its asset-specific signal — manual review recommended.', 'r'));
    }
  }

  log('');
}

main().catch(e => { console.error(e); process.exit(1); });
