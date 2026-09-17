/**
 * Live agent chat — user asks a question, ASI reasons over live platform
 * state via the 6 read-only tools we ship in DEFAULT_AGENT_TOOLS.
 *
 * The endpoint returns:
 *   - final agent text (what the assistant says)
 *   - the full tool invocation trace (auditability: which live data
 *     the agent actually queried before answering)
 *
 * This is the "chat with your platform" surface: users can ask
 * "how is BTC doing?", "why did we stop trading?", "can we afford
 * another training run?" — and get an answer grounded in real DB
 * state, not a hallucination.
 *
 * Not for actions — tools are read-only. If a user asks the agent to
 * "open a hedge", it can EXPLAIN the current setup but can't execute.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { heavyLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { runWithTools } from '@/lib/services/ai/tool-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Chat prompt — introduces the agent's identity + boundaries. The
// constitution preamble is auto-prepended by runWithTools, so this only
// covers the platform-specific persona + response guidance.
const SYSTEM_PROMPT = `You are the ZkWard status oracle. Users chat with you to understand what the autonomous trading platform is doing RIGHT NOW.

You have tools to query live state — hedges, signal interpretations, cron state, prices, postmortem stats, treasury balance. Always ground your answers in real data. Never fabricate numbers.

Style:
- Concise. Bullet lists when comparing multiple items.
- Cite tool results ("last 24h: 5 closed hedges, net -$12.50").
- If the answer requires data, use the tools. If it's conceptual (e.g. "what is a hedge?"), answer directly.
- If a tool errors, say so honestly — don't guess.
- You cannot open trades or move funds. If asked, explain the current state and let the user decide.`;

export async function POST(request: NextRequest) {
  const limited = heavyLimiter.check(request);
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message) {
      return NextResponse.json({ error: 'message required' }, { status: 400 });
    }
    if (message.length > 2000) {
      return NextResponse.json({ error: 'message too long' }, { status: 413 });
    }

    const started = Date.now();
    const result = await runWithTools({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: message,
      maxIterations: 5,
    });
    const elapsed = Date.now() - started;

    if (!result.finishedNormally && result.invocations.length === 0) {
      // No provider available (env not set) — return a helpful fallback
      return NextResponse.json({
        answer: 'The status oracle is not currently available. Set ASI_API_KEY in production to enable live status queries.',
        toolCalls: [],
        elapsedMs: elapsed,
        healthy: false,
      });
    }

    logger.info('[LiveChat] answered', {
      messagePreview: message.slice(0, 60),
      tools: result.invocations.map(i => `${i.tool}(${i.ok ? 'ok' : 'err'})`),
      iterations: result.iterations,
      elapsedMs: elapsed,
    });

    return NextResponse.json({
      answer: result.finalText || '(no response generated)',
      toolCalls: result.invocations.map(i => ({
        tool: i.tool,
        ok: i.ok,
        latencyMs: i.latencyMs,
        // Redact large results — UI shows they were called, not their contents
        argsPreview: JSON.stringify(i.args).slice(0, 200),
      })),
      iterations: result.iterations,
      elapsedMs: elapsed,
      healthy: true,
    });
  } catch (err) {
    logger.error('[LiveChat] failed', { error: err instanceof Error ? err.message : err });
    return safeErrorResponse(err, 'live-chat failed');
  }
}

// Health check — used by UI to detect whether ASI is configured before
// showing the chat surface. Cheap, no LLM call.
export async function GET() {
  const hasAsi = (process.env.ASI_API_KEY || '').trim().length > 0;
  return NextResponse.json({ ready: hasAsi });
}
