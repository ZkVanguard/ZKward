/**
 * `reason()` — the ONE way Layer 3 callers get an LLM answer in this stack.
 *
 * Wraps runWithTools() for the "no tools, just reason" case: pass a
 * system prompt and user prompt, get text back. Uses ASI:One (via the
 * OpenAI-compat client) as its provider.
 *
 * ## Why not llmProvider.generateDirectResponse
 *
 * The legacy chain (Crypto.com/Ollama/ASI/OpenAI/Claude) has been failing
 * in prod with "No AI provider available" — the fallback tail is
 * unreliable at Vercel runtime. This helper routes through the same
 * verified path as runWithTools (ASI:One via api.asi1.ai/v1), so
 * every Layer 3 reasoning call in the stack has ONE provider chain.
 *
 * ## When to use which
 *
 *   - Task is prediction-market title extraction → interpretSignal()
 *   - Task needs live state (hedges, prices, treasury) → runWithTools()
 *   - Task is pure LLM reasoning (write a report, analyze a description,
 *     summarize) → reason() [this module]
 *   - Task is deterministic (regex, threshold check) → no LLM
 *
 * ## Silent fallback
 *
 * If ASI is unreachable, returns the empty string with `ok: false`.
 * Callers must handle this (typically a rule-based fallback path,
 * NEVER a hallucinated answer).
 */
import { runWithTools } from './tool-runner';
import { logger } from '@/lib/utils/logger';

export interface ReasonInput {
  systemPrompt: string;
  userPrompt: string;
  /** Cap generation length. Default 800 tokens (matches most agent
   *  tasks — recommendations, summaries, analyses). */
  maxIterations?: number;
}

export interface ReasonOutput {
  ok: boolean;
  text: string;
  elapsedMs: number;
  /** Present when ok=false. */
  error?: string;
}

/** Route a reasoning task through the same Layer 3 provider as runWithTools.
 *  No tools exposed — plain text-in/text-out. */
export async function reason(opts: ReasonInput): Promise<ReasonOutput> {
  const t0 = Date.now();
  try {
    const r = await runWithTools({
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      tools: [],
      maxIterations: opts.maxIterations ?? 2,
    });
    const elapsed = Date.now() - t0;
    if (!r.finishedNormally && !r.finalText) {
      return { ok: false, text: '', elapsedMs: elapsed, error: 'no-provider' };
    }
    return { ok: true, text: r.finalText, elapsedMs: elapsed };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[reason] failed', { error: msg });
    return { ok: false, text: '', elapsedMs: Date.now() - t0, error: msg };
  }
}
