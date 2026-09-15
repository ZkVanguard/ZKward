/**
 * Convert labeled JSONL → Soup chat-template training format.
 *
 * Soup ingests JSONL where each line is a full multi-turn chat example.
 * We produce a stable schema:
 *
 *   {
 *     messages: [
 *       { role: "system", content: <SYSTEM_PROMPT> },
 *       { role: "user",   content: <title, optional metadata> },
 *       { role: "assistant", content: <JSON label> }
 *     ]
 *   }
 *
 * Splits into 80/10/10 train/val/test, deterministic by slug hash so
 * re-running produces the same split.
 *
 * Excludes rows still in the review queue (label.confidence < 0.7)
 * unless --include-review is passed — during initial iteration this keeps
 * the training set clean.
 *
 * Run:
 *   bun run scripts/ai-training/to-soup-format.ts \
 *     [--in=data/signal-interpreter/labeled.jsonl] \
 *     [--out-dir=training/signal-interpreter] \
 *     [--include-review]
 */
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const DEFAULT_IN = 'data/signal-interpreter/labeled.jsonl';
const DEFAULT_OUT_DIR = 'training/signal-interpreter';
const REVIEW_CONFIDENCE_MIN = 0.7;

// Imported at runtime to keep the single source of truth in
// lib/services/ai/model-constitution.ts. Every training example the
// model sees uses this exact string — same string the runtime service
// and the auto-labeler use.
import { SIGNAL_INTERPRETER_SYSTEM } from '../../lib/services/ai/model-constitution';
const SYSTEM_PROMPT = SIGNAL_INTERPRETER_SYSTEM;

interface Labeled {
  source: string;
  slug: string;
  title: string;
  category?: string;
  endDate?: string;
  label: {
    asset: string | null;
    direction: string;
    threshold: number | null;
    horizon: string;
    horizon_end: string | null;
    confidence: number;
    reasoning: string;
    meta?: {
      novelty?: number;
      improvement_ask?: string;
      generalization_note?: string;
    };
  };
}

interface SoupExample {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([a-z\-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? 'true';
  }
  return {
    inPath: (out.in ?? DEFAULT_IN).trim(),
    outDir: (out['out-dir'] ?? DEFAULT_OUT_DIR).trim(),
    includeReview: out['include-review'] === 'true',
  };
}

/** Deterministic hash-based split: 80 train / 10 val / 10 test.
 *  Same slug always lands in same split — safe across re-runs. */
function splitBucket(slug: string): 'train' | 'val' | 'test' {
  const h = createHash('sha256').update(slug).digest();
  const n = h[0]; // 0..255
  if (n < 25) return 'val'; // ~10%
  if (n < 50) return 'test'; // ~10%
  return 'train'; // ~80%
}

function toSoupExample(row: Labeled): SoupExample {
  const userLines = [`Title: ${row.title}`];
  if (row.category && row.category !== 'unknown') userLines.push(`Category: ${row.category}`);
  if (row.endDate) userLines.push(`Resolves: ${row.endDate}`);

  // The assistant turn IS the training target. Every field the model
  // should learn to produce must be here — including the self-reflective
  // meta object. If we drop `meta` here, the fine-tuned model will not
  // learn to emit it, and the compounding-capability loop breaks at
  // Phase 1. Do not omit.
  const assistantJson = {
    asset: row.label.asset,
    direction: row.label.direction,
    threshold: row.label.threshold,
    horizon: row.label.horizon,
    horizon_end: row.label.horizon_end,
    confidence: row.label.confidence,
    reasoning: row.label.reasoning,
    meta: {
      novelty: row.label.meta?.novelty ?? 0,
      improvement_ask: row.label.meta?.improvement_ask ?? '',
      generalization_note: row.label.meta?.generalization_note ?? '',
    },
  };

  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userLines.join('\n') },
      { role: 'assistant', content: JSON.stringify(assistantJson) },
    ],
  };
}

function main() {
  const args = parseArgs();
  console.log(`Input:  ${args.inPath}`);
  console.log(`Output: ${args.outDir}/{train,val,test}.jsonl`);
  console.log(`Include review-queue rows: ${args.includeReview}`);

  if (!fs.existsSync(args.inPath)) {
    console.error(`Missing input: ${args.inPath}`);
    console.error('Run scripts/ai-training/label-with-llm.ts first.');
    process.exit(1);
  }

  const rows: Labeled[] = fs
    .readFileSync(args.inPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Labeled;
      } catch {
        return null;
      }
    })
    .filter((r): r is Labeled => !!r && !!r.slug && !!r.label);

  const eligible = args.includeReview
    ? rows
    : rows.filter((r) => r.label.confidence >= REVIEW_CONFIDENCE_MIN);
  console.log(`\nLoaded ${rows.length} rows, ${eligible.length} eligible for training`);

  const buckets: Record<'train' | 'val' | 'test', SoupExample[]> = { train: [], val: [], test: [] };
  for (const r of eligible) buckets[splitBucket(r.slug)].push(toSoupExample(r));

  fs.mkdirSync(args.outDir, { recursive: true });
  for (const split of ['train', 'val', 'test'] as const) {
    const outPath = path.join(args.outDir, `${split}.jsonl`);
    fs.writeFileSync(
      outPath,
      buckets[split].map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf8',
    );
    console.log(`  ${split.padEnd(6)} ${String(buckets[split].length).padStart(6)}  →  ${outPath}`);
  }
}

main();
