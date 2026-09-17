/**
 * Post-training evaluation for the Signal Interpreter.
 *
 * Reads training/signal-interpreter/test.jsonl (held-out 10% split), calls
 * the fine-tuned Ollama model on each user turn, compares the output JSON
 * to the labeled ground-truth assistant turn, and reports per-field
 * accuracy.
 *
 * Also runs the SAME test against the BASE (un-fine-tuned) Qwen 2.5 7B
 * so we can quantify the lift from fine-tuning.
 *
 * Output:
 *   data/signal-interpreter/eval-report.json — machine-readable summary
 *   stdout — human-readable comparison table
 */
import * as fs from 'fs';
import * as path from 'path';

const BASE = (process.env.SIGNAL_INTERPRETER_MODEL_URL || 'http://localhost:11434').replace(/\/$/, '');
const FINE_TUNED = process.env.SIGNAL_INTERPRETER_MODEL_NAME || 'zkward-signal-interp:qwen2.5-7b';
const BASELINE = 'qwen2.5:7b';
const TEST_PATH = 'training/signal-interpreter/test.jsonl';
const OUT_PATH = 'data/signal-interpreter/eval-report.json';
const REQ_TIMEOUT_MS = 30_000;
const CONCURRENCY = 2;

interface Turn { role: 'system' | 'user' | 'assistant'; content: string }
interface Example { messages: Turn[] }

interface Label {
  asset: string | null;
  direction: string;
  threshold: number | null;
  horizon: string;
  horizon_end: string | null;
  confidence: number;
}

interface EvalRow {
  system: string;
  user: string;
  truth: Label;
  fineTuned: Label | null;
  baseline: Label | null;
  fineTunedRaw: string;
  baselineRaw: string;
}

function tryParseLabel(raw: string): Label | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const p = JSON.parse(match[0]);
    return {
      asset: typeof p.asset === 'string' && p.asset ? p.asset.toUpperCase() : null,
      direction: typeof p.direction === 'string' ? p.direction : 'NEUTRAL',
      threshold: typeof p.threshold === 'number' ? p.threshold : null,
      horizon: typeof p.horizon === 'string' ? p.horizon : 'unknown',
      horizon_end: typeof p.horizon_end === 'string' ? p.horizon_end : null,
      confidence: Math.max(0, Math.min(1, Number(p.confidence ?? 0.5))),
    };
  } catch {
    return null;
  }
}

async function callModel(model: string, system: string, user: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 400,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return `HTTP_${resp.status}`;
    const body = (await resp.json()) as any;
    return String(body?.choices?.[0]?.message?.content ?? '').trim();
  } catch (e) {
    return `ERR:${e instanceof Error ? e.message : String(e)}`;
  } finally {
    clearTimeout(t);
  }
}

function fieldEq(a: any, b: any, field: string): boolean {
  const av = a?.[field];
  const bv = b?.[field];
  if (av === null && bv === null) return true;
  if (typeof av === 'number' && typeof bv === 'number') {
    return Math.abs(av - bv) < 1e-6;
  }
  return av === bv;
}

async function main() {
  if (!fs.existsSync(TEST_PATH)) {
    console.error(`Missing ${TEST_PATH}. Run to-soup-format.ts first.`);
    process.exit(1);
  }
  const examples: Example[] = fs
    .readFileSync(TEST_PATH, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  console.log(`Loaded ${examples.length} test examples`);
  console.log(`Fine-tuned: ${FINE_TUNED}`);
  console.log(`Baseline:   ${BASELINE}`);
  console.log();

  const rows: EvalRow[] = [];
  const queue = examples.map((ex, i) => ({ ex, i }));
  let done = 0;

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { ex } = item;
      const systemTurn = ex.messages.find((m) => m.role === 'system')?.content ?? '';
      const userTurn = ex.messages.find((m) => m.role === 'user')?.content ?? '';
      const truthTurn = ex.messages.find((m) => m.role === 'assistant')?.content ?? '';
      const truth = tryParseLabel(truthTurn);
      if (!truth) continue;

      // Run in parallel (both models, single query each)
      const [ftRaw, blRaw] = await Promise.all([
        callModel(FINE_TUNED, systemTurn, userTurn),
        callModel(BASELINE, systemTurn, userTurn),
      ]);

      rows.push({
        system: systemTurn.slice(0, 120),
        user: userTurn,
        truth,
        fineTuned: tryParseLabel(ftRaw),
        baseline: tryParseLabel(blRaw),
        fineTunedRaw: ftRaw.slice(0, 500),
        baselineRaw: blRaw.slice(0, 500),
      });

      done += 1;
      if (done % 10 === 0 || done === examples.length) {
        console.log(`  ${done}/${examples.length} evaluated`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // Aggregate per-field accuracy
  const fields = ['asset', 'direction', 'threshold', 'horizon'] as const;
  const stats = {
    fineTuned: Object.fromEntries(fields.map((f) => [f, 0])) as Record<string, number>,
    baseline: Object.fromEntries(fields.map((f) => [f, 0])) as Record<string, number>,
    parseFailFT: 0,
    parseFailBL: 0,
  };
  for (const r of rows) {
    if (!r.fineTuned) stats.parseFailFT += 1;
    if (!r.baseline) stats.parseFailBL += 1;
    for (const f of fields) {
      if (r.fineTuned && fieldEq(r.fineTuned, r.truth, f)) stats.fineTuned[f] += 1;
      if (r.baseline && fieldEq(r.baseline, r.truth, f)) stats.baseline[f] += 1;
    }
  }

  const n = rows.length;
  const pct = (x: number) => ((x / n) * 100).toFixed(1) + '%';

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`EVAL RESULTS — ${n} test examples`);
  console.log('══════════════════════════════════════════════════════════');
  console.log('Field      Fine-tuned    Baseline (base Qwen)    Δ');
  for (const f of fields) {
    const ft = stats.fineTuned[f];
    const bl = stats.baseline[f];
    const delta = ft - bl;
    const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '=';
    console.log(
      `  ${f.padEnd(10)} ${pct(ft).padStart(6)} (${ft})   ${pct(bl).padStart(6)} (${bl})     ${arrow} ${delta >= 0 ? '+' : ''}${delta}`,
    );
  }
  console.log();
  console.log(`Parse failures — Fine-tuned: ${stats.parseFailFT} / ${n},  Baseline: ${stats.parseFailBL} / ${n}`);
  console.log();

  // Write machine-readable report
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        fineTunedModel: FINE_TUNED,
        baselineModel: BASELINE,
        n,
        stats: {
          fineTuned: Object.fromEntries(fields.map((f) => [f, stats.fineTuned[f] / n])),
          baseline: Object.fromEntries(fields.map((f) => [f, stats.baseline[f] / n])),
          parseFailFT: stats.parseFailFT,
          parseFailBL: stats.parseFailBL,
        },
        // Sample of 20 mismatches for eyeballing
        mismatches: rows
          .filter((r) => !fieldEq(r.fineTuned, r.truth, 'asset') || !fieldEq(r.fineTuned, r.truth, 'direction'))
          .slice(0, 20)
          .map((r) => ({
            user: r.user.slice(0, 120),
            truth: r.truth,
            fineTuned: r.fineTuned,
          })),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`Report written to ${OUT_PATH}`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
