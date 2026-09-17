/**
 * Interpretation outcome resolver — Phase 2 of the self-improvement loop.
 *
 * Reads directional interpretations whose horizon has passed and haven't
 * yet been judged. For each one:
 *   1. Fetch current spot price for the asset
 *   2. Compare to entry_price_usd captured at interpretation time
 *   3. Signed delta = (exit - entry) × (direction === 'UP' ? +1 : -1)
 *   4. Persist exit_price_usd, outcome_correct, retrospective_pnl_usd
 *
 * Binary interpretations (BINARY_YES/NO) are NOT resolved here — they
 * need Polymarket's own resolution oracle. Add that as a follow-up.
 *
 * Runs standalone. Not a cron (yet) — operator triggers when there's
 * enough resolved volume to be worth judging.
 *
 * Usage:
 *   bun run scripts/ai-training/resolve-interpretations.ts [--limit=200] [--dry-run]
 */
import {
  unresolvedDirectionalPastHorizon,
  resolveDirectional,
} from '@/lib/db/signal-interpretations';

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([a-z\-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return {
    limit: Number(out.limit ?? 200),
    dryRun: out['dry-run'] === 'true',
  };
}

async function main() {
  const args = parseArgs();
  const rows = await unresolvedDirectionalPastHorizon(args.limit);
  console.log(`Unresolved directional interpretations past horizon: ${rows.length}`);
  if (rows.length === 0) return;

  const { getMultiSourceValidatedPrice } = await import('@/lib/services/market-data/unified-price-provider');

  // Group by asset so we fetch each spot once.
  const byAsset = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.asset) continue;
    const arr = byAsset.get(r.asset) ?? [];
    arr.push(r);
    byAsset.set(r.asset, arr);
  }

  let resolved = 0;
  let correct = 0;
  let priceFailed = 0;

  for (const [asset, group] of byAsset.entries()) {
    let exitPrice: number;
    try {
      const v = await getMultiSourceValidatedPrice(asset);
      if (!Number.isFinite(v.price) || v.price <= 0) throw new Error(`bad price: ${v.price}`);
      exitPrice = v.price;
    } catch (err) {
      console.warn(`[resolve] skipping ${group.length} ${asset} rows — price fetch failed:`, err);
      priceFailed += group.length;
      continue;
    }

    for (const r of group) {
      const entry = Number(r.entry_price_usd ?? 0);
      if (!Number.isFinite(entry) || entry <= 0) {
        console.warn(`[resolve] skipping ${r.slug} — no entry price`);
        continue;
      }
      const direction = r.direction as 'UP' | 'DOWN';
      if (direction !== 'UP' && direction !== 'DOWN') continue;

      if (args.dryRun) {
        const signedDelta = (exitPrice - entry) * (direction === 'UP' ? 1 : -1);
        const wouldCorrect = signedDelta > 0;
        console.log(`  [dry] ${r.slug}  ${asset} ${direction}  entry=${entry} exit=${exitPrice}  → ${wouldCorrect ? 'CORRECT' : 'WRONG'} (Δ=${signedDelta.toFixed(2)})`);
        continue;
      }

      const result = await resolveDirectional(r.slug, direction, entry, exitPrice);
      resolved++;
      if (result.correct) correct++;
      console.log(`  ${r.slug}  ${asset} ${direction}  Δ=${result.signedDelta.toFixed(2)}  ${result.correct ? 'CORRECT' : 'WRONG'}`);
    }
  }

  if (args.dryRun) {
    console.log('\n--dry-run: no writes.');
    return;
  }

  console.log(`\nResolved:  ${resolved}`);
  console.log(`Correct:   ${correct} / ${resolved}  (${resolved > 0 ? ((correct / resolved) * 100).toFixed(1) : '0.0'}%)`);
  console.log(`Price-fail: ${priceFailed}`);
}

main().catch((err) => {
  console.error('[resolve] fatal', err);
  process.exit(1);
});
