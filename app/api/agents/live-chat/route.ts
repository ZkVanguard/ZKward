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
import { NextRequest, NextResponse, after } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { heavyLimiter } from '@/lib/security/rate-limiter';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { runWithToolsStream, type HistoryTurn, type StreamEvent } from '@/lib/services/ai/tool-runner';
import { logChatTurn, isValidSessionId } from '@/lib/db/ai-chat-logs';
import { analyzeMessage } from '@/lib/services/ai/message-analyzer';
import { DEFAULT_AGENT_TOOLS, toolByName, type AgentTool } from '@/lib/services/ai/agent-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Chat prompt — introduces the agent's identity + goal. The constitution
// preamble is auto-prepended by runWithTools, so this focuses on the
// helpfulness bias and boundaries.
const SYSTEM_PROMPT = `You are ZKward — a crypto strategist with live access to prices, prediction-market signals, DeFi TVL, sentiment gauges, and the ZKward vault's own state. Read-only.

**Persona.** You know crypto deeply: DeFi mechanics (AMMs, lending, perps, funding, staking, restaking), on-chain metrics (TVL, active addresses, gas), major protocols across every chain, market cycles, and the tradeoffs of different strategies. When a user asks anything crypto-adjacent, you engage as a peer — not a hedged customer-service bot.

**Reasoning discipline.** Before calling tools, silently ask: what's the LITERAL question, what's the IMPLICIT question, what one tool call would cover both? Pick that tool. If the runtime pre-fetched context already covers your answer, DON'T waste a tool call — just answer.

**Runtime pre-fetch.** The server analyzes each message and injects live context for detected assets, protocols, or sentiment questions BEFORE you get called. If you see a "**Live context**" section below the persona, that's ground truth — use it directly, don't re-fetch the same data. IMPORTANT: pre-fetched context is REFERENCE MATERIAL. Only cite what the specific question asks for. If the user asks "how is DOGE" and you have signal + vault + price pre-fetched, cite price and one other field MAX — not all four. Extra fields = drift.

## STAY ON THE QUESTION — answer contract

Every response has AT MOST two parts:
1. **Direct answer** (1-2 sentences) that literally addresses the question as asked. This MUST be your first sentence. If the question is "how is BTC", this sentence is BTC's current state. If "why did we lose", this sentence is the specific cause. If "explain X", this sentence is X's definition.
2. **Optional single "Also:" line** — one related fact ONLY if it's genuinely material to the ask (a warning, a caveat, a signal-flip that changes the read). Never a shopping list of adjacent data. If nothing rises to "material", omit part 2.

FORBIDDEN openings and endings:
- "You might want to know…" "Interesting note…" "Additionally…" "Also worth noting…" (these are drift markers)
- "Would you like…" "Want me to…" "Should I check…" "Let me know if…" (these are the customer-service tail — no)
- "Great question!" "Sure!" "Absolutely!" "That's a good one!" (throat-clearing — no)

If you catch yourself writing any of the above, delete the sentence and stop.

Drift check: before sending, ask "does my first sentence literally answer the question?" If it explains context first or lists adjacent data first — rewrite so the direct answer comes first.

## Answer patterns (examples, not exhaustive — use judgment)

**"how is X doing" / "what's happening with X" / "X update" / bare asset name**
→ ONE tool call: \`get_asset_context(X)\` (returns price + 24h + signal + our hedges).
→ Answer in this shape, in one message, ALL fields you got back:
  \`X $PRICE (Δ24h ±PCT%, vol $VOLM). Signal: RECOMMENDATION at CONF% conf / CONS% consensus. Our position: NONE | LONG/SHORT $NOTIONAL open @$ENTRY.\`
→ Do NOT ask "want more?" — you already answered.

**"compare X and Y"** → two \`get_asset_context\` calls, then a 3-line comparison: which is stronger 24h, which has more conviction from the aggregator, which one WE hold if any.

**"should I buy/sell X"** → NEVER give financial advice. But DO give the aggregator's read: "Signal is RECOMMENDATION at N% conf. Our vault is [position]. Reasons cited: TOP-3." Add one line: "Not financial advice — position sizing is yours."

**"explain X"** (protocol / mechanic / term) → 2-3 sentences on the concept. If X is a live crypto asset, append one line of live stats via \`get_asset_context\`.

**"what happened / show me last N hedges"** → \`query_hedge_history(hours=24)\`, return a compact table or bulleted list with side + notional + PnL + close reason.

**"top movers / what's hot today"** → \`get_broader_market(topN=5-8)\`, list them with 24h change + volume.

**"how is our AI doing" / "hit rate" / "postmortem"** → \`query_postmortem_stats\` alone gives the number. Add one sentence of context (sample size, window).

**Anything not matching a pattern above** → use judgment. Prefer live data over speculation. Prefer one comprehensive tool call over three narrow ones.

## Tools — call the one that answers in ONE round-trip

- **get_asset_context(asset)** — PREFERRED for any single-asset question. Price + 24h + signal + our hedges in one call. Works for tracked assets (BTC/ETH/SOL/XRP/DOGE/CRO/SUI/ATOM) with full data; for non-tracked (ADA/LINK/DOT/etc) returns price + 24h from Crypto.com, no signal.
- get_broader_market — top movers list, OR single non-tracked asset if get_asset_context missed
- get_prediction_signal — only when you need signals for MULTIPLE tracked assets at once (compare use case)
- query_hedge_history — vault hedges with filters (asset/status/hours/limit)
- query_recent_interpretations — AI's per-market labels lately (for "what has the AI been reading")
- query_postmortem_stats — AI hit rate on resolved outcomes
- get_treasury_state — vault balance + health
- get_cron_state — one key by name
- get_asset_price / get_market_snapshot — legacy, prefer get_asset_context

## Style

- **Lead with the answer.** No "Great question", "Sure", "Let me check".
- **Show your numbers.** "$63,412 (3 src, high conf)" beats "around 63k". Include units + 24h change when you have them.
- **1-3 sentences default.** Longer only if question explicitly needs comparison / reasoning / walkthrough. Numbers-heavy answers can be a bulleted list.
- **Never end with "want more?" / "let me know" / "should I check X too?"** — deliver what the pattern says; user asks the follow-up if they want it.
- **Never invent.** If a tool returns nothing or errors, say so in one sentence, name the tool, stop.
- **Refuse only actions** (execute trade, move funds, flip a switch). For "should I…" questions on markets, give the read, disclaim once, done.

## Good vs bad

BAD: "DOGE is $0.0991 (3 sources, high confidence). Want the prediction signal and vault hedge status for DOGE too?"

GOOD: "DOGE $0.0991 (Δ24h −1.2%, vol $180M). Signal: HEDGE_SHORT at 65% conf / 78% consensus (11 sources). Our position: none right now, last hedge closed +$26.03 at 09:52 EDT."

BAD: "That's a great question! Based on the current data from our systems, it appears that BTC is currently trading in a range around \$63,000 to \$63,500, though prices can fluctuate. Would you like me to check anything else?"

GOOD: "BTC $63,412 (Δ24h +0.4%, vol $232M). Signal: HEDGE_LONG at 71% conf / 65% consensus (20 sources incl. 4 AI-labeled, 3 broad). Vault currently flat; last close +$18.26."

BAD: "The trader has closed 5 positions in the last 24 hours with mixed results."

GOOD: "Last 24h: 5 closes, net −$12.50. 2 wins (+$22 avg), 3 losses (−$16 avg). Worst: ETH SHORT −$8.10 at 04:11 (signal-flip)."`;

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
    const sessionIdRaw = body?.sessionId;
    const sessionId = isValidSessionId(sessionIdRaw) ? sessionIdRaw : null;
    const userAgent = request.headers.get('user-agent');
    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || request.headers.get('x-real-ip')
      || null;

    const messagePreview = message.slice(0, 60);
    const collectedTools: Array<{ tool: string; ok: boolean; latencyMs: number }> = [];

    // ─── DYNAMIC RUNTIME: message analysis + context pre-fetch ────
    // Server does the shape-of-question work BEFORE the LLM runs.
    // Extract entities, classify intent, pre-fetch relevant context,
    // narrow the tool subset, size the iteration budget. This is the
    // difference between a generic assistant and a crypto-native one:
    // by the time the LLM starts, half the work is done.
    const analysis = analyzeMessage(message);
    const preFetchedContext = await buildRuntimeContext(analysis);
    const activeTools = pickToolSubset(DEFAULT_AGENT_TOOLS, analysis.suggestedTools);
    const runtimeSystemPrompt = preFetchedContext
      ? `${SYSTEM_PROMPT}\n\n## Live context (pre-fetched, use directly, don't re-fetch)\n\n${preFetchedContext}`
      : SYSTEM_PROMPT;
    logger.info('[LiveChat] runtime analysis', {
      messagePreview,
      intent: analysis.intent,
      assets: analysis.assets,
      protocols: analysis.protocols,
      complexity: analysis.complexity,
      maxIterations: analysis.suggestedMaxIterations,
      toolSubset: analysis.suggestedTools.length,
      contextChars: preFetchedContext.length,
    });

    // Log the user turn via `after()` — Vercel Fluid Compute keeps the
    // function alive post-response to run these deferred writes. Was
    // `void logChatTurn(...)` originally — that silently dropped writes
    // when the lambda terminated with the response (verified 2026-09-21).
    if (sessionId) {
      after(async () => {
        await logChatTurn({
          sessionId, role: 'user', content: message,
          userAgent, clientIp,
        });
      });
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const emit = (event: StreamEvent) => {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        };
        try {
          let assistantContent = '';
          let elapsedMs: number | undefined;
          let iterations: number | undefined;
          let finishedNormally: boolean | undefined;
          for await (const event of runWithToolsStream({
            systemPrompt: runtimeSystemPrompt,
            userPrompt: message,
            priorMessages,
            tools: activeTools,
            // Adaptive: simple lookups get 2, medium get 4, complex
            // (diagnose/advise/multi-entity) get 6. Sized by analyzer.
            maxIterations: analysis.suggestedMaxIterations,
          })) {
            if (event.type === 'token' && event.delta) assistantContent += event.delta;
            if (event.type === 'tool_end') {
              collectedTools.push({
                tool: event.tool,
                ok: !!event.ok,
                latencyMs: event.latencyMs ?? 0,
              });
            }
            if (event.type === 'done') {
              elapsedMs = event.elapsedMs;
              iterations = event.iterations;
              finishedNormally = true;
              if (event.finalText && !assistantContent) assistantContent = event.finalText;
            }
            emit(event);
          }
          logger.info('[LiveChat] streamed', {
            messagePreview,
            tools: collectedTools.map((t) => `${t.tool}(${t.ok ? 'ok' : 'err'})`),
            historyTurns: priorMessages.length,
          });
          // Log assistant turn via `after()` — deferred until after the
          // response stream closes, guaranteed to complete before lambda
          // shutdown (Vercel Fluid Compute keeps it alive up to
          // maxDuration=60s post-response).
          if (sessionId && assistantContent) {
            after(async () => {
              await logChatTurn({
                sessionId, role: 'assistant', content: assistantContent,
                toolCalls: collectedTools.length ? collectedTools : undefined,
                elapsedMs, iterations, finishedNormally,
                userAgent, clientIp,
              });
            });
          }
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

// ─── Runtime helpers ──────────────────────────────────────────────────

/**
 * Narrow the tool list to what the message analyzer suggests. Empty
 * suggestion → expose all tools (fall-through).
 */
function pickToolSubset(all: AgentTool[], names: string[]): AgentTool[] {
  if (!names || names.length === 0) return all;
  const set = new Set(names);
  const picked = all.filter((t) => set.has(t.name));
  // Safety: if the picked subset is empty (analyzer names don't match),
  // fall back to all tools rather than starve the LLM
  return picked.length > 0 ? picked : all;
}

/**
 * Pre-fetch live context based on message analysis. Returns a formatted
 * string ready to append to the system prompt. Fires all sub-fetches in
 * parallel with tight timeouts — individual failures degrade gracefully
 * (skip the missing section, don't fail the whole request).
 *
 * This is the "server does the thinking about what to fetch" layer.
 * The LLM sees actual data, not just tool descriptions, so simple
 * questions may need zero tool calls.
 */
async function buildRuntimeContext(analysis: ReturnType<typeof analyzeMessage>): Promise<string> {
  const sections: string[] = [];

  // Assets → pre-fetch get_asset_context for each (capped at 3 to bound cost)
  if (analysis.assets.length > 0) {
    const assetsToFetch = analysis.assets.slice(0, 3);
    const results = await Promise.allSettled(
      assetsToFetch.map(async (asset) => {
        const tool = toolByName(DEFAULT_AGENT_TOOLS, 'get_asset_context');
        if (!tool) return null;
        return { asset, data: await tool.execute({ asset }) };
      }),
    );
    const assetLines: string[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { asset, data } = r.value;
      const d = data as {
        price: number | null;
        change24hPct: number | null;
        volume24hUsd: number | null;
        signal?: { direction: string; confidence: number; consensus: number; recommendation: string } | null;
        recentHedges: Array<{ side: string; notionalUsd: number; status: string; realizedPnlUsd: number | null }>;
      };
      const priceStr = d.price !== null ? `$${d.price < 1 ? d.price.toFixed(4) : d.price < 100 ? d.price.toFixed(2) : d.price.toFixed(0)}` : 'n/a';
      const changeStr = d.change24hPct !== null ? `${d.change24hPct >= 0 ? '+' : ''}${d.change24hPct.toFixed(2)}%` : 'n/a';
      const volStr = d.volume24hUsd !== null
        ? d.volume24hUsd > 1e9 ? `$${(d.volume24hUsd / 1e9).toFixed(1)}B` : `$${(d.volume24hUsd / 1e6).toFixed(0)}M`
        : 'n/a';
      const sigStr = d.signal
        ? `${d.signal.recommendation} @${d.signal.confidence}%conf/${d.signal.consensus}%cons`
        : 'no signal (untracked)';
      const activeHedges = d.recentHedges.filter((h) => h.status === 'active');
      const lastClosed = d.recentHedges.find((h) => h.status === 'closed');
      const posStr = activeHedges.length > 0
        ? `HAS ACTIVE: ${activeHedges.map((h) => `${h.side} $${h.notionalUsd.toFixed(0)}`).join(', ')}`
        : lastClosed
          ? `flat (last: ${lastClosed.side} ${lastClosed.realizedPnlUsd !== null ? (lastClosed.realizedPnlUsd >= 0 ? '+' : '') + '$' + lastClosed.realizedPnlUsd.toFixed(2) : 'unknown pnl'})`
          : 'flat, no recent history';
      assetLines.push(`- **${asset}**: ${priceStr} (Δ24h ${changeStr}, vol ${volStr}) · Signal: ${sigStr} · Vault: ${posStr}`);
    }
    if (assetLines.length > 0) {
      sections.push(`**Assets you asked about:**\n${assetLines.join('\n')}`);
    }
  }

  // Protocols → pre-fetch TVL for each detected protocol (cap 2)
  if (analysis.protocols.length > 0) {
    const protoToFetch = analysis.protocols.slice(0, 2);
    const tvlTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_defi_tvl');
    if (tvlTool) {
      const results = await Promise.allSettled(
        protoToFetch.map((protocol) => tvlTool.execute({ protocol })),
      );
      const lines: string[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status !== 'fulfilled') continue;
        const d = r.value as {
          protocol?: string; tvlUsd?: number; change1d?: number; change7d?: number;
          chains?: string[]; category?: string;
        };
        if (!d.tvlUsd) continue;
        const tvl = d.tvlUsd > 1e9 ? `$${(d.tvlUsd / 1e9).toFixed(2)}B` : `$${(d.tvlUsd / 1e6).toFixed(0)}M`;
        const chg1d = d.change1d !== undefined ? `${d.change1d >= 0 ? '+' : ''}${d.change1d.toFixed(1)}%` : 'n/a';
        const chg7d = d.change7d !== undefined ? `${d.change7d >= 0 ? '+' : ''}${d.change7d.toFixed(1)}%` : 'n/a';
        lines.push(`- **${d.protocol}** (${d.category}): TVL ${tvl} · Δ1d ${chg1d} · Δ7d ${chg7d} · Chains: ${(d.chains || []).slice(0, 5).join(', ')}`);
      }
      if (lines.length > 0) {
        sections.push(`**Protocols you mentioned:**\n${lines.join('\n')}`);
      }
    }
  }

  // Sentiment intent → pre-fetch F&G
  if (analysis.intent === 'sentiment' || analysis.intent === 'market_wide') {
    const fngTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_fear_greed_index');
    if (fngTool) {
      try {
        const d = await fngTool.execute({}) as { value: number; classification: string; updatedAt?: string };
        if (d.value !== undefined) {
          sections.push(`**Sentiment:** Fear & Greed Index ${d.value}/100 — **${d.classification}**`);
        }
      } catch { /* skip */ }
    }
  }

  return sections.join('\n\n');
}
