/**
 * Counterfactual backtest for the paper trader stop-loss / take-profit fix.
 *
 * The historical hedges table only has entry_price + final current_pnl +
 * close_reason — no intra-trade tick series, so we can't replay path
 * exactly. What we CAN do is bound the outcome:
 *
 *   • If the FINAL loss exceeded the price-anchored stop threshold, the
 *     stop would have fired at exactly the threshold (upper bound on
 *     salvage: real intra-trade dip may have been worse than the final
 *     print, so this OVERSTATES how much we'd have saved).
 *   • If the FINAL win exceeded the take-profit threshold, we would
 *     have capped the winner at the threshold (LOWER bound on new PnL —
 *     we assume the position never touched TP earlier and then reversed).
 *   • If the trade stayed within [stop, tp], the new rule wouldn't have
 *     fired and PnL is unchanged.
 *
 * Compares three scenarios against the actual 164 closed paper trades:
 *
 *   A) baseline (what actually happened)
 *   B) + price-anchored stop @ 0.5% of entry (LONG floor / SHORT ceiling)
 *   C) B + take-profit @ 1.0% of entry (2× the stop = 1.5R target)
 *   D) C + skip 60-64% confidence bucket (worst-performing per prior audit)
 *
 * Also breaks down by asset × side, confidence band, and closure reason.
 *
 * Run: bun run scripts/_backtest-paper-stops.ts
 * Prereqs: PROD_DATABASE_URL or DATABASE_URL pointing at Bakchodi.
 */

import { Client } from 'pg';

const STOP_FRAC = Number(process.env.BACKTEST_STOP_FRAC || 0.005);
const TP_FRAC = Number(process.env.BACKTEST_TP_FRAC || 0.010);
const LEVERAGE = 3; // matches PAPER_LEVERAGE default
const FEE_BPS_PER_SIDE = 6.5;
const SKIP_CONF_LOW = Number(process.env.BACKTEST_SKIP_CONF_LOW || 60);
const SKIP_CONF_HIGH = Number(process.env.BACKTEST_SKIP_CONF_HIGH || 65);

interface Row {
  id: number;
  asset: string;
  side: 'LONG' | 'SHORT';
  entry_price: number;
  notional_value: number;
  current_pnl: number;
  reason: string | null;
  created_at: string;
  closed_at: string | null;
}

function feeUsd(notional: number): number {
  return notional * (FEE_BPS_PER_SIDE / 10_000);
}

function extractConfidence(reason: string | null): number | null {
  if (!reason) return null;
  const m = /conf=(\d+)/.exec(reason);
  return m ? Number(m[1]) : null;
}

/**
 * Signed fraction of notional gained (or lost), from the position's
 * perspective. Positive = win, negative = loss. Direction-agnostic.
 * Approximates by ignoring funding + close-fee variance (funding is
 * <$5 over 20-45 min at these sizes; close fee ~= open fee).
 */
function grossFrac(row: Row): number {
  const gross = row.current_pnl + feeUsd(row.notional_value) * 2;
  return gross / row.notional_value;
}

/** Net pnl if the position closed at the given signed move fraction. */
function pnlAtMoveFrac(row: Row, moveFrac: number): number {
  return row.notional_value * moveFrac - feeUsd(row.notional_value) * 2;
}

interface Summary {
  trades: number;
  pnl: number;
  wins: number;
  losses: number;
}

function summarize(rows: Array<{ scenario_pnl: number }>): Summary {
  const trades = rows.length;
  let pnl = 0, wins = 0, losses = 0;
  for (const r of rows) {
    pnl += r.scenario_pnl;
    if (r.scenario_pnl > 0) wins++;
    else if (r.scenario_pnl < 0) losses++;
  }
  return { trades, pnl, wins, losses };
}

function printSummary(name: string, s: Summary) {
  const winPct = s.trades ? (100 * s.wins / s.trades).toFixed(1) : '0.0';
  console.log(
    `  ${name.padEnd(48)}  trades=${String(s.trades).padStart(3)}  pnl=$${s.pnl.toFixed(2).padStart(10)}  wins=${s.wins}  losses=${s.losses}  win%=${winPct}`,
  );
}

async function main() {
  const conn = process.env.PROD_DATABASE_URL || process.env.DATABASE_URL;
  if (!conn) throw new Error('PROD_DATABASE_URL or DATABASE_URL required');
  const client = new Client({ connectionString: conn });
  await client.connect();

  const { rows } = await client.query<Row>(`
    SELECT id, asset, side, entry_price::float, notional_value::float,
           current_pnl::float, reason, created_at, closed_at
    FROM hedges
    WHERE simulation_mode = true AND status = 'closed'
      AND entry_price > 0 AND notional_value > 0
    ORDER BY closed_at
  `);
  await client.end();

  console.log(`\nBacktesting ${rows.length} closed paper trades\n`);
  console.log(`Config: stopFrac=${(STOP_FRAC*100).toFixed(2)}%  tpFrac=${(TP_FRAC*100).toFixed(2)}%  skipConf=[${SKIP_CONF_LOW},${SKIP_CONF_HIGH}]\n`);

  // Scenario A — baseline (what happened)
  const A = rows.map(r => ({ ...r, scenario_pnl: r.current_pnl }));

  // Scenario B — stop-loss only
  const B = rows.map(r => {
    const move = grossFrac(r); // signed: negative = adverse for the side
    // If the trade ended in adverse territory beyond STOP_FRAC, cap loss at stop.
    if (move < -STOP_FRAC) {
      return { ...r, scenario_pnl: pnlAtMoveFrac(r, -STOP_FRAC) };
    }
    return { ...r, scenario_pnl: r.current_pnl };
  });

  // Scenario C — stop + take-profit
  const C = rows.map(r => {
    const move = grossFrac(r);
    if (move < -STOP_FRAC) {
      return { ...r, scenario_pnl: pnlAtMoveFrac(r, -STOP_FRAC) };
    }
    if (move > TP_FRAC) {
      return { ...r, scenario_pnl: pnlAtMoveFrac(r, TP_FRAC) };
    }
    return { ...r, scenario_pnl: r.current_pnl };
  });

  // Scenario D — C + skip mid-confidence entries
  const D = C.filter(r => {
    const c = extractConfidence(r.reason);
    return c === null || c < SKIP_CONF_LOW || c > SKIP_CONF_HIGH;
  });

  console.log('=== Scenarios (bounded counterfactual) ===');
  printSummary('A: baseline (what happened)', summarize(A));
  printSummary(`B: + stop @ ${(STOP_FRAC*100).toFixed(2)}% of entry`, summarize(B));
  printSummary(`C: B + take-profit @ ${(TP_FRAC*100).toFixed(2)}% of entry`, summarize(C));
  printSummary(`D: C + skip conf ${SKIP_CONF_LOW}-${SKIP_CONF_HIGH}`, summarize(D));

  // Sensitivity: sweep stop fraction
  console.log('\n=== Sensitivity: sweep stop-loss threshold (TP disabled) ===');
  for (const frac of [0.002, 0.003, 0.004, 0.005, 0.007, 0.010, 0.015, 0.020]) {
    const scen = rows.map(r => {
      const move = grossFrac(r);
      if (move < -frac) return { ...r, scenario_pnl: pnlAtMoveFrac(r, -frac) };
      return { ...r, scenario_pnl: r.current_pnl };
    });
    printSummary(`stop @ ${(frac*100).toFixed(2)}%`, summarize(scen));
  }

  // Sensitivity: skip confidence buckets
  console.log('\n=== Sensitivity: what if we skipped each confidence bucket? ===');
  for (const [lo, hi] of [[55,59],[60,64],[65,69],[70,74],[75,100]] as const) {
    const scen = C.filter(r => {
      const c = extractConfidence(r.reason);
      return c === null || c < lo || c > hi;
    });
    printSummary(`C without conf ${lo}-${hi}`, summarize(scen));
  }

  // Sensitivity: skip losing asset×side combos
  console.log('\n=== Sensitivity: skip specific asset×side ===');
  for (const key of ['BTC:LONG','ETH:SHORT','SOL:LONG','BTC:SHORT']) {
    const [a, s] = key.split(':');
    const scen = C.filter(r => !(r.asset === a && r.side === s));
    printSummary(`C without ${key}`, summarize(scen));
  }

  // Sensitivity: only trade the historical winners
  console.log('\n=== Winners bucket: only assets with positive baseline PnL ===');
  const byAsset = new Map<string, number>();
  for (const r of A) byAsset.set(r.asset, (byAsset.get(r.asset) || 0) + r.scenario_pnl);
  const winnersAsset = new Set([...byAsset.entries()].filter(([, v]) => v > 0).map(([k]) => k));
  console.log(`  winners: ${[...winnersAsset].join(', ') || '(none)'}`);
  const scenWinners = C.filter(r => winnersAsset.has(r.asset));
  printSummary(`C on winners only`, summarize(scenWinners));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
