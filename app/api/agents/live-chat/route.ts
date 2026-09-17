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
import { runWithToolsStream, type HistoryTurn, type StreamEvent } from '@/lib/services/ai/tool-runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Chat prompt — introduces the agent's identity + goal. The constitution
// preamble is auto-prepended by runWithTools, so this focuses on the
// helpfulness bias and boundaries.
const SYSTEM_PROMPT = `You are the ZkWard status oracle. Your goal: be maximally helpful to the user. Your job is to teach them everything they want to know about the autonomous trading platform — what it's doing, why, and how to make it better.

You have tools to query live state — hedges, signal interpretations, cron state, prices, postmortem stats, treasury balance. Use them liberally; a grounded answer beats a hedged one.

Bias toward YES:
- If the user asks a "can we do X?" question, tell them how to do X. If capital is short, propose the smallest path that could get there. Don't just say no.
- If the user asks about a problem, propose 2-3 concrete fixes with tradeoffs, not just describe the problem.
- If the user asks a conceptual question, answer it directly and then offer the live-state check that connects it to their platform.
- If a tool errors, still try to answer with what you know + explain what would let you answer better next time.

Only refuse when:
- The user asks you to move funds / open trades / cancel positions — you're read-only. But even then: explain current state + suggest the exact endpoint or env var they'd flip to do it themselves.

Style:
- Concise but complete. Bullets for comparisons, sentences for reasoning.
- Cite tool results with numbers ("last 24h: 5 closed hedges, net -$12.50").
- Never fabricate — if you don't have data, say what tool would get it.
- Never end with "let me know if you need anything else". End with the next actionable step or question.`;

const MAX_HISTORY_TURNS = 12;

function normalizeHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role === 'user' || role === 'assistant') && typeof content === 'string' && content.trim()) {
      out.push({ role, content: content.slice(0, 8000) });
    }
  }
  return out.slice(-MAX_HISTORY_TURNS);
}

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
    const priorMessages = normalizeHistory(body?.history);

    const messagePreview = message.slice(0, 60);
    const collectedTools: string[] = [];

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const emit = (event: StreamEvent) => {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        };
        try {
          for await (const event of runWithToolsStream({
            systemPrompt: SYSTEM_PROMPT,
            userPrompt: message,
            priorMessages,
            maxIterations: 6,
          })) {
            if (event.type === 'tool_end') {
              collectedTools.push(`${event.tool}(${event.ok ? 'ok' : 'err'})`);
            }
            emit(event);
          }
          logger.info('[LiveChat] streamed', {
            messagePreview,
            tools: collectedTools,
            historyTurns: priorMessages.length,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'stream failed';
          logger.error('[LiveChat] stream error', { error: msg });
          emit({ type: 'error', message: msg });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
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
