/**
 * Signal-interpreter auto-labeler.
 *
 * Reads `data/signal-interpreter/raw.jsonl`, prompts the local LLM (Ollama-
 * first via getLLM(), same chain the prod trader uses) to extract structured
 * labels per title, and writes two files:
 *
 *   • data/signal-interpreter/labeled.jsonl
 *       every example plus its label; retain the LLM's confidence so we can
 *       filter low-conf rows for human review.
 *   • data/signal-interpreter/review-queue.jsonl
 *       rows the LLM was <0.7 confident on — these need human eyes before
 *       going into the training set. Documented in AI_TRAINING_WORKFLOW.md.
 *
 * The prompt asks for JSON only, and we parse strictly. Non-parseable
 * outputs go to the review queue too. No fine-tuning at this stage —
 * we are BUILDING the training dataset.
 *
 * Run:
 *   bun run scripts/ai-training/label-with-llm.ts \
 *     [--in=data/signal-interpreter/raw.jsonl] \
 *     [--out=data/signal-interpreter/labeled.jsonl] \
 *     [--review-out=data/signal-interpreter/review-queue.jsonl] \
 *     [--limit=2000] [--concurrency=4]
 */
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_IN = 'data/signal-interpreter/raw.jsonl';
const DEFAULT_OUT = 'data/signal-interpreter/labeled.jsonl';
const DEFAULT_REVIEW = 'data/signal-interpreter/review-queue.jsonl';
const CONFIDENCE_THRESHOLD = 0.7;

interface RawExample {
  source: string;
  slug: string;
  title: string;
  question?: string;
  endDate?: string;
  liquidity?: number;
  volume24hr?: number;
  category?: string;
  url?: string;
}

type Direction = 'UP' | 'DOWN' | 'NEUTRAL' | 'BINARY_YES' | 'BINARY_NO';
type Horizon = '5min' | '1h' | 'daily' | 'weekly' | 'monthly' | 'longer' | 'unknown';

interface SelfReflectiveMeta {
  novelty: number;              // 0..1
  improvement_ask: string;
  generalization_note: string;
}

interface Label {
  asset: string | null;
  direction: Direction;
  threshold: number | null;
  horizon: Horizon;
  horizon_end: string | null;
  confidence: number;
  reasoning: string;
  meta: SelfReflectiveMeta;     // model tells us how to make the next iteration smarter
}

interface Labeled extends RawExample {
  label: Label;
  labeled_at: string;
  labeled_by: string;           // model identifier
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
    outPath: (out.out ?? DEFAULT_OUT).trim(),
    reviewOutPath: (out['review-out'] ?? DEFAULT_REVIEW).trim(),
    limit: Number(out.limit ?? 0) || Infinity,
    concurrency: Math.max(1, Math.min(8, Number(out.concurrency ?? 4))),
  };
}

// System prompt imported from lib/services/ai/model-constitution.ts (single
// source of truth). Auto-labeler + runtime service + Modelfile + training
// data all use the SAME prompt so weights encode a consistent purpose.
async function loadSystemPrompt(): Promise<string> {
  const { SIGNAL_INTERPRETER_SYSTEM } = await import('../../lib/services/ai/model-constitution');
  return SIGNAL_INTERPRETER_SYSTEM;
}

function buildUserPrompt(ex: RawExample): string {
  const parts = [`Title: ${ex.title}`];
  if (ex.category && ex.category !== 'unknown') parts.push(`Category: ${ex.category}`);
  if (ex.endDate) parts.push(`Resolves: ${ex.endDate}`);
  return parts.join('\n');
}

interface LLMResult {
  ok: boolean;
  label?: Label;
  raw?: string;
  error?: string;
  provider?: string;
}

// Direct Ollama call. Bypasses the app's llm-provider (which injects a
// trading-assistant system prompt + fetches portfolio context — both
// unwanted here). Uses OpenAI-compatible endpoint for portability; the
// same code works against any OpenAI-compatible server just by changing
// OLLAMA_BASE_URL / OLLAMA_MODEL.
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
const LLM_TIMEOUT_MS = 30_000;

async function callLLM(system: string, user: string): Promise<LLMResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(`${OLLAMA_BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 400,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}`, provider: OLLAMA_MODEL };
    }
    const body = (await resp.json()) as any;
    const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { ok: false, raw: text, error: 'no JSON found', provider: OLLAMA_MODEL };
    }
    let parsed: any;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return { ok: false, raw: text, error: 'JSON.parse failed', provider: OLLAMA_MODEL };
    }
    const meta: SelfReflectiveMeta = {
      novelty: Math.max(0, Math.min(1, Number(parsed?.meta?.novelty ?? 0))),
      improvement_ask:
        typeof parsed?.meta?.improvement_ask === 'string'
          ? parsed.meta.improvement_ask.slice(0, 200)
          : '',
      generalization_note:
        typeof parsed?.meta?.generalization_note === 'string'
          ? parsed.meta.generalization_note.slice(0, 200)
          : '',
    };
    const label: Label = {
      asset: typeof parsed.asset === 'string' ? parsed.asset.toUpperCase() : null,
      direction: (['UP', 'DOWN', 'NEUTRAL', 'BINARY_YES', 'BINARY_NO'] as const).includes(parsed.direction)
        ? parsed.direction
        : 'NEUTRAL',
      threshold: typeof parsed.threshold === 'number' ? parsed.threshold : null,
      horizon: (['5min', '1h', 'daily', 'weekly', 'monthly', 'longer', 'unknown'] as const).includes(parsed.horizon)
        ? parsed.horizon
        : 'unknown',
      horizon_end: typeof parsed.horizon_end === 'string' ? parsed.horizon_end : null,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.5))),
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 200) : '',
      meta,
    };
    return { ok: true, label, provider: OLLAMA_MODEL };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), provider: OLLAMA_MODEL };
  } finally {
    clearTimeout(t);
  }
}

async function processBatch(examples: RawExample[], concurrency: number, provider: string): Promise<{ labeled: Labeled[]; review: Labeled[] }> {
  const labeled: Labeled[] = [];
  const review: Labeled[] = [];
  let done = 0;
  const total = examples.length;
  const systemPrompt = await loadSystemPrompt();

  const queue = [...examples];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const ex = queue.shift();
      if (!ex) break;
      const result = await callLLM(systemPrompt, buildUserPrompt(ex));
      const label: Label = result.ok && result.label
        ? result.label
        : {
            asset: null,
            direction: 'NEUTRAL',
            threshold: null,
            horizon: 'unknown',
            horizon_end: null,
            confidence: 0,
            reasoning: result.error ? `AUTO-FAIL: ${result.error}` : 'no output',
            meta: { novelty: 0, improvement_ask: '', generalization_note: '' },
          };
      const row: Labeled = {
        ...ex,
        label,
        labeled_at: new Date().toISOString(),
        labeled_by: result.provider ?? provider,
      };
      labeled.push(row);
      if (label.confidence < CONFIDENCE_THRESHOLD) review.push(row);
      done += 1;
      if (done % 25 === 0 || done === total) {
        console.log(`  ${done}/${total} labeled (${review.length} → review queue)`);
      }
    }
  });
  await Promise.all(workers);
  return { labeled, review };
}

async function main() {
  const args = parseArgs();
  console.log(`Input:      ${args.inPath}`);
  console.log(`Output:     ${args.outPath}`);
  console.log(`Review:     ${args.reviewOutPath}`);
  console.log(`Concurrency: ${args.concurrency}`);

  if (!fs.existsSync(args.inPath)) {
    console.error(`Missing input: ${args.inPath}`);
    console.error(`Run scripts/ai-training/build-signal-interpreter-dataset.ts first.`);
    process.exit(1);
  }

  const rawLines = fs.readFileSync(args.inPath, 'utf8').trim().split('\n').filter(Boolean);
  const examples = rawLines
    .map((l) => {
      try {
        return JSON.parse(l) as RawExample;
      } catch {
        return null;
      }
    })
    .filter((x): x is RawExample => !!x && !!x.title)
    .slice(0, args.limit);

  console.log(`\nLabeling ${examples.length} examples...`);
  const { labeled, review } = await processBatch(examples, args.concurrency, 'auto');

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, labeled.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(
    args.reviewOutPath,
    review.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf8',
  );

  console.log(`\nWrote ${labeled.length} to ${args.outPath}`);
  console.log(`Wrote ${review.length} to ${args.reviewOutPath}  (confidence < ${CONFIDENCE_THRESHOLD})`);

  const highConf = labeled.filter((r) => r.label.confidence >= CONFIDENCE_THRESHOLD);
  console.log(`\nHigh-confidence (≥ ${CONFIDENCE_THRESHOLD}): ${highConf.length}`);
  console.log(`Low-confidence  (< ${CONFIDENCE_THRESHOLD}): ${review.length}`);

  const byAsset: Record<string, number> = {};
  for (const r of highConf) {
    const k = r.label.asset ?? '(null)';
    byAsset[k] = (byAsset[k] ?? 0) + 1;
  }
  console.log('\nAsset distribution (high-conf):');
  for (const [a, n] of Object.entries(byAsset).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${a.padEnd(10)} ${n}`);
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
