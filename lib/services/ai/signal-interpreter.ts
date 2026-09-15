/**
 * Signal Interpreter — structured extraction from prediction-market titles.
 *
 * Uses a Soup-fine-tuned Qwen 2.5 model served via Ollama (or any
 * OpenAI-compatible endpoint) to parse titles into `{ asset, direction,
 * threshold, horizon }`. Falls back to a regex-based extractor on
 * network / parse failure, so this is safe to enable in production —
 * a model outage never breaks signal ingestion.
 *
 * Env knobs:
 *   SIGNAL_INTERPRETER_ENABLED    — "1" to use the model. Default OFF.
 *   SIGNAL_INTERPRETER_MODEL_URL  — base URL of the OpenAI-compatible
 *                                   endpoint (default: http://localhost:11434 = Ollama).
 *   SIGNAL_INTERPRETER_MODEL_NAME — model name (default: zkward-signal-interp:qwen2.5-7b)
 *   SIGNAL_INTERPRETER_TIMEOUT_MS — hard cap per request (default: 5000)
 *
 * Training pipeline: see docs/AI_TRAINING_WORKFLOW.md.
 */
import { logger } from '@/lib/utils/logger';
import { envFlag } from '@/lib/utils/env-flag';
import { SIGNAL_INTERPRETER_SYSTEM } from './model-constitution';

export type SignalDirection =
  | 'UP'
  | 'DOWN'
  | 'NEUTRAL'
  | 'BINARY_YES'
  | 'BINARY_NO';

export type SignalHorizon =
  | '5min'
  | '1h'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'longer'
  | 'unknown';

/** Self-reflective meta the model produces alongside its answer.
 *  Fed back into the training pipeline to teach future iterations of
 *  itself what to expect and where to focus. This is not aesthetic —
 *  it is how the model "knows" it's supposed to compound. */
export interface SignalMeta {
  novelty: number;              // 0..1 — how unusual this title looks
  improvement_ask: string;      // what extra context would have helped
  generalization_note: string;  // a pattern worth adding more of
}

export interface InterpretedSignal {
  asset: string | null;
  direction: SignalDirection;
  threshold: number | null;
  horizon: SignalHorizon;
  horizon_end: string | null;
  confidence: number;
  reasoning?: string;
  meta?: SignalMeta;
  source: 'model' | 'regex-fallback';
}

const DIRECTIONS: readonly SignalDirection[] = [
  'UP',
  'DOWN',
  'NEUTRAL',
  'BINARY_YES',
  'BINARY_NO',
];
const HORIZONS: readonly SignalHorizon[] = [
  '5min',
  '1h',
  'daily',
  'weekly',
  'monthly',
  'longer',
  'unknown',
];

const SYSTEM_PROMPT = SIGNAL_INTERPRETER_SYSTEM;

interface InterpretOptions {
  category?: string;
  endDate?: string;
}

/** Public entry point. Non-throwing — always returns a signal. */
export async function interpretSignal(
  title: string,
  opts: InterpretOptions = {},
): Promise<InterpretedSignal> {
  if (!title || typeof title !== 'string') return regexFallback('', opts);

  if (!envFlag('SIGNAL_INTERPRETER_ENABLED')) {
    return regexFallback(title, opts);
  }
  try {
    const model = await callModel(title, opts);
    if (model) return { ...model, source: 'model' };
  } catch (e) {
    logger.warn('[SignalInterpreter] model call failed, using regex fallback', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  return regexFallback(title, opts);
}

async function callModel(title: string, opts: InterpretOptions): Promise<InterpretedSignal | null> {
  const base = (process.env.SIGNAL_INTERPRETER_MODEL_URL || 'http://localhost:11434').replace(
    /\/$/,
    '',
  );
  const model = process.env.SIGNAL_INTERPRETER_MODEL_NAME || 'zkward-signal-interp:qwen2.5-7b';
  const timeoutMs = Number(process.env.SIGNAL_INTERPRETER_TIMEOUT_MS) || 5000;

  const userLines = [`Title: ${title}`];
  if (opts.category && opts.category !== 'unknown') userLines.push(`Category: ${opts.category}`);
  if (opts.endDate) userLines.push(`Resolves: ${opts.endDate}`);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userLines.join('\n') },
        ],
        temperature: 0,
        max_tokens: 400,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as any;
    const text = String(body?.choices?.[0]?.message?.content ?? '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
    return coerceLabel(parsed);
  } finally {
    clearTimeout(t);
  }
}

function coerceMeta(raw: any): SignalMeta {
  const m = raw?.meta ?? {};
  return {
    novelty: Math.max(0, Math.min(1, Number(m.novelty ?? 0))),
    improvement_ask:
      typeof m.improvement_ask === 'string' ? m.improvement_ask.slice(0, 200) : '',
    generalization_note:
      typeof m.generalization_note === 'string' ? m.generalization_note.slice(0, 200) : '',
  };
}

function coerceLabel(raw: any): InterpretedSignal {
  return {
    asset: typeof raw.asset === 'string' && raw.asset ? raw.asset.toUpperCase() : null,
    direction: DIRECTIONS.includes(raw.direction) ? raw.direction : 'NEUTRAL',
    threshold: typeof raw.threshold === 'number' && Number.isFinite(raw.threshold) ? raw.threshold : null,
    horizon: HORIZONS.includes(raw.horizon) ? raw.horizon : 'unknown',
    horizon_end: typeof raw.horizon_end === 'string' ? raw.horizon_end : null,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0.5))),
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning.slice(0, 200) : undefined,
    meta: coerceMeta(raw),
    source: 'model',
  };
}

// ── Regex fallback ────────────────────────────────────────────────────
// Mirrors the current parsing in MultiAssetSignalService / poly-discover.
// Not intended to be complete — a floor for when the model is unavailable
// or the feature flag is off. The model will replace 95%+ of accuracy.

const ASSET_ALIASES: Array<[RegExp, string]> = [
  [/\b(bitcoin|btc)\b/i, 'BTC'],
  [/\b(ethereum|eth)\b/i, 'ETH'],
  [/\b(solana|sol)\b/i, 'SOL'],
  [/\bxrp\b/i, 'XRP'],
  [/\b(dogecoin|doge)\b/i, 'DOGE'],
  [/\b(sui)\b/i, 'SUI'],
  [/\b(cardano|ada)\b/i, 'ADA'],
];

function extractAsset(title: string): string | null {
  for (const [re, sym] of ASSET_ALIASES) {
    if (re.test(title)) return sym;
  }
  return null;
}

function extractDirection(title: string): SignalDirection {
  const lower = title.toLowerCase();
  const upHints = /\b(above|higher|hit|reach|surpass|exceed|greater|up|>)\b/;
  const downHints = /\b(below|lower|under|drop|fall|down|<)\b/;
  if (upHints.test(lower) && !downHints.test(lower)) return 'UP';
  if (downHints.test(lower) && !upHints.test(lower)) return 'DOWN';
  return 'NEUTRAL';
}

function extractThreshold(title: string): number | null {
  // "above $68,000" / "$100K" / "68000"
  const m = title.match(/\$?\s?([\d,]+(?:\.\d+)?)\s?([kmb])?\b/i);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(base)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  if (unit === 'k') return base * 1_000;
  if (unit === 'm') return base * 1_000_000;
  if (unit === 'b') return base * 1_000_000_000;
  return base;
}

function extractHorizon(title: string): SignalHorizon {
  const lower = title.toLowerCase();
  if (/\b(5\s?min|five\s?minute)/.test(lower)) return '5min';
  if (/\b(hour|1h)\b/.test(lower)) return '1h';
  if (/\b(today|24h|end of the day)/.test(lower)) return 'daily';
  if (/\b(this week|next week|week)/.test(lower)) return 'weekly';
  if (/\b(this month|next month|month)/.test(lower)) return 'monthly';
  if (/\b(202[6-9]|by end of|year)/.test(lower)) return 'longer';
  return 'unknown';
}

function regexFallback(title: string, opts: InterpretOptions): InterpretedSignal {
  return {
    asset: extractAsset(title),
    direction: extractDirection(title),
    threshold: extractThreshold(title),
    horizon: extractHorizon(title),
    horizon_end: opts.endDate ?? null,
    confidence: 0.4, // regex is coarse — signal caller that this is low-conf
    reasoning: 'regex-fallback: no model available',
    // Regex path has no self-reflection to offer; leave meta empty but
    // present so downstream code can rely on the shape.
    meta: { novelty: 0, improvement_ask: '', generalization_note: '' },
    source: 'regex-fallback',
  };
}
