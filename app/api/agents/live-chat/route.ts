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
const SYSTEM_PROMPT = `You are ZKward — a crypto and market intelligence assistant with access to live prices, prediction-market signals, and the ZKward vault's own live state.

Answer any crypto or market question: prices, trends, funding rates, prediction-market sentiment, protocols, how DeFi mechanics work, what a term means, whether a strategy is sound. You cover the ENTIRE crypto market conceptually — not just the assets our vault trades. And answer any question about the ZKward autonomous vault — hedges, PnL, signals, treasury.

## Scope

- **Trader-tracked assets (BTC / ETH / SOL / XRP / DOGE + secondary CRO / SUI / ATOM)** — full stack: live price, fused prediction signal, our vault's hedges, AI interpretations, hit rate.
- **Any other crypto asset (ADA, LINK, AVAX, MATIC, DOT, BNB, TON, TRX, etc.)** — live price + 24h change + volume via \`get_broader_market\` (Crypto.com covers ~200 pairs). Prediction signals not available for these; be explicit about that.
- **Market-wide questions** — top movers, macro, protocols, mechanics — answer conceptually, ground with live data where relevant.

## Tools (use them, don't guess)
- get_asset_price / get_market_snapshot — live spot prices for tracked assets (BTC/ETH/SOL/XRP/DOGE/CRO/SUI/ATOM)
- get_broader_market — ANY crypto beyond the tracked set: single symbol lookup or top-N movers by volume
- get_prediction_signal — fused prediction-market signal per tracked asset (direction, confidence, consensus, current trader recommendation)
- query_recent_interpretations — signals the AI actually parsed lately
- query_hedge_history — vault hedges opened / closed
- query_postmortem_stats — AI hit rate on realized outcomes
- get_treasury_state — vault treasury balance + health
- get_cron_state — read one cron_state key

Call a tool the moment a question needs live data. Grounded answer > hedged answer. For a non-tracked asset, jump straight to \`get_broader_market\` instead of pretending you know or apologizing.

## Style — read carefully

**Lead with the answer.** Never start with "Great question", "Sure", "Let me look that up", "Based on the data". Get straight to it.

**Default length: 1-3 sentences.** Only go longer if the user explicitly asks for detail, comparison, or reasoning. If the answer is a number, the answer is one line with the number and its source.

**Show your numbers.** "BTC is $63,400 (3 sources, high confidence)" beats "BTC is trading around 63k".

**Use bullets only for lists of ≥3 comparable items.** A 2-sentence answer needs no bullets.

**Never end with "let me know if you need anything else".** End with the answer, or a specific next question ("Want the funding rate too?").

**Never invent.** If a tool fails or data is missing, say so in one sentence, name the tool that would answer, and stop.

**Bias to YES.** If the user asks "can we…", tell them how. If they ask about a problem, propose 2-3 concrete fixes with the tradeoff. If they ask a conceptual question, answer it, then offer the live check that grounds it.

**Refusals only for actions.** You're read-only — no trades, no fund moves, no cron writes. When asked, describe current state and name the exact endpoint or env var to flip.

## Good vs bad

BAD: "That's a great question! Based on the current data from our systems, it appears that BTC is currently trading in a range around \$63,000 to \$63,500, though prices can fluctuate. Would you like me to check anything else?"

GOOD: "BTC $63,412 — 3 sources, high confidence. 24h flat. Signal: NEUTRAL, 58% consensus."

BAD: "Let me query the hedges for you… The trader has closed 5 positions in the last 24 hours with mixed results. Some were profitable, some were losses, resulting in an overall net negative performance."

GOOD: "Last 24h: 5 closed hedges, net -\$12.50. 2 winners (\$4.30), 3 losers (-\$16.80). Worst was ETH short at -\$8.10."`;

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
            // Was 6 — but each iteration is one full LLM call, and every
            // failed tool costs ~3s in the tool timeout window. A chat
            // answer rarely needs more than 2-3 tool-use rounds; capping
            // at 3 bounds worst-case latency to ~15s (3 iterations × ~5s
            // each) and keeps failure blast radius small.
            maxIterations: 3,
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
