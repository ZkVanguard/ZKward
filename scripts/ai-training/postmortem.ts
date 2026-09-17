/**
 * Postmortem — Phase 3 of the self-improvement loop.
 *
 * Reads interpretations that have a linked realized_pnl_usd (via
 * signal_interpretations.retrospective_pnl_usd) and produces new
 * training examples for the next fine-tune round.
 *
 * ## Two kinds of postmortem output
 *
 *   1. WINS (pnl > 0) — reinforce the model's parse. Emitted verbatim
 *      into a "confirmed" bucket so the next training run gets more of
 *      the patterns that worked.
 *
 *   2. LOSSES (pnl < 0) — the postmortem prompt asks the CURRENT model
 *      to identify what feature of the title, if present, would have
 *      flipped the direction call. That feature becomes an
 *      "improvement_ask" string in a synthetic training example the
 *      next round of fine-tuning sees.
 *
 * ## Output shape
 *
 * Appends to `data/signal-interpreter/raw.jsonl` — the same file the
 * dataset builder reads. Next `bun run ai:train:full` picks them up
 * automatically. Deduplicated by slug so we don't re-add a market
 * across postmortem runs.
 *
 * ## Runs standalone
 *
 * Not a cron — one-shot script the operator triggers when there's
 * enough resolved trade volume to be worth retraining. Prints a summary
 * of what would be added and asks for confirmation before writing (use
 * --yes to skip).
 *
 * ## Usage
 *
 *   bun run scripts/ai-training/postmortem.ts [--since-days=30] [--yes] [--dry-run]
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  resolvedInterpretations,
  type InterpretationRow,
} from '@/lib/db/signal-interpretations';

const DEFAULT_RAW_PATH = 'data/signal-interpreter/raw.jsonl';
const DEFAULT_SINCE_DAYS = 30;

interface RawExample {
  source: string;
  slug: string;
  title: string;
  category?: string;
  endDate?: string;
  postmortem?: {
    outcome: 'WIN' | 'LOSS';
    realized_pnl_usd: number;
    original_direction: string;
    original_novelty: number | null;
    improvement_ask_derived?: string;
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([a-z\-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return {
    sinceDays: Number(out['since-days'] ?? DEFAULT_SINCE_DAYS),
    yes: out.yes === 'true',
    dryRun: out['dry-run'] === 'true',
    rawPath: (out.out ?? DEFAULT_RAW_PATH).trim(),
  };
}

function classify(row: InterpretationRow): 'WIN' | 'LOSS' | 'FLAT' {
  const pnl = Number(row.retrospective_pnl_usd ?? 0);
  if (pnl > 0.5) return 'WIN';
  if (pnl < -0.5) return 'LOSS';
  return 'FLAT';
}

/** For losses: derive the "what would have flipped this" ask.
 *  Uses the model's own improvement_ask if it flagged one at parse
 *  time — that's the most useful signal we have. Otherwise fall back
 *  to a generic template that at least surfaces the direction miss. */
function deriveImprovementAsk(row: InterpretationRow): string {
  if (row.improvement_ask && row.improvement_ask.trim()) {
    return `Original ask at parse: "${row.improvement_ask.trim()}". Direction ${row.direction} was wrong.`;
  }
  return `Direction ${row.direction} realized as ${row.direction === 'UP' ? 'DOWN' : 'UP'}. No parse-time ask surfaced.`;
}

async function main() {
  const args = parseArgs();
  const sinceMs = Date.now() - args.sinceDays * 24 * 60 * 60 * 1000;

  console.log(`Postmortem window:  last ${args.sinceDays} days`);
  console.log(`Raw dataset target: ${args.rawPath}`);
  console.log(`Dry run:            ${args.dryRun}`);

  const rows = await resolvedInterpretations(sinceMs, 500);
  console.log(`\nResolved interpretations in window: ${rows.length}`);

  if (rows.length === 0) {
    console.log('Nothing to postmortem yet. Link some outcomes via linkOutcome() first.');
    return;
  }

  const buckets = { WIN: [] as InterpretationRow[], LOSS: [] as InterpretationRow[], FLAT: [] as InterpretationRow[] };
  for (const r of rows) buckets[classify(r)].push(r);

  console.log(`  Wins:   ${buckets.WIN.length}`);
  console.log(`  Losses: ${buckets.LOSS.length}`);
  console.log(`  Flat:   ${buckets.FLAT.length}  (ignored)`);

  const existingSlugs = new Set<string>();
  if (fs.existsSync(args.rawPath)) {
    for (const line of fs.readFileSync(args.rawPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const j = JSON.parse(t) as RawExample;
        if (j.slug) existingSlugs.add(j.slug);
      } catch {
        // skip malformed
      }
    }
  }
  console.log(`\nDataset already contains ${existingSlugs.size} slugs — will skip duplicates.`);

  const newExamples: RawExample[] = [];
  for (const r of [...buckets.WIN, ...buckets.LOSS]) {
    if (existingSlugs.has(r.slug)) continue;
    const outcome = classify(r) as 'WIN' | 'LOSS';
    newExamples.push({
      source: 'postmortem',
      slug: r.slug,
      title: r.title,
      postmortem: {
        outcome,
        realized_pnl_usd: Number(r.retrospective_pnl_usd ?? 0),
        original_direction: r.direction,
        original_novelty: r.novelty === null ? null : Number(r.novelty),
        improvement_ask_derived: outcome === 'LOSS' ? deriveImprovementAsk(r) : undefined,
      },
    });
  }

  console.log(`\nNew examples to append: ${newExamples.length}`);

  if (newExamples.length === 0) {
    console.log('All resolved slugs already in dataset. Nothing to do.');
    return;
  }

  if (args.dryRun) {
    console.log('\n--dry-run: not writing. Sample:');
    for (const ex of newExamples.slice(0, 5)) {
      console.log(`  ${ex.postmortem?.outcome}  ${ex.slug}  ${ex.title.slice(0, 60)}...`);
    }
    return;
  }

  if (!args.yes) {
    console.log('\nAdd --yes to append. (dry summary printed above.)');
    return;
  }

  fs.mkdirSync(path.dirname(args.rawPath), { recursive: true });
  const appendLines = newExamples.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(args.rawPath, appendLines, 'utf8');
  console.log(`\nAppended ${newExamples.length} rows to ${args.rawPath}`);
  console.log('Next: bun run ai:train:full  → picks them up automatically.');
}

main().catch((err) => {
  console.error('[postmortem] fatal', err);
  process.exit(1);
});
