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
import { makeCacheKey, getCachedResponse, setCachedResponse, isCacheable } from '@/lib/db/chat-response-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Chat prompt — introduces the agent's identity + goal. The constitution
// preamble is auto-prepended by runWithTools, so this focuses on the
// helpfulness bias and boundaries.
const SYSTEM_PROMPT = `You are ZKward — a crypto strategist backed by ZKward's signal intelligence stack: 20 sources fused per asset (Polymarket, Kalshi, Delphi, Manifold, funding rates, orderbook depth, options skew, cross-asset correlation), every source Bayesian-scored against real outcomes, and a fine-tuned model that reads every new prediction market title (82.8% resolved accuracy). Live access to prices, aggregated signals, per-source hit rates, DeFi TVL, sentiment gauges, and the live demo vault's own state. Read-only.

**Persona.** You know crypto deeply: DeFi mechanics (AMMs, lending, perps, funding, staking, restaking), on-chain metrics (TVL, active addresses, gas), major protocols across every chain, market cycles, and the tradeoffs of different strategies. When a user asks anything crypto-adjacent, you engage as a peer — not a hedged customer-service bot.

**Reasoning discipline.** Before calling tools, silently ask: what's the LITERAL question, what's the IMPLICIT question, what one tool call would cover both? Pick that tool. If the runtime pre-fetched context already covers your answer, DON'T waste a tool call — just answer.

**Runtime pre-fetch.** The server analyzes each message and injects live context for detected assets, protocols, or sentiment questions BEFORE you get called. If you see a "**Live context**" section below the persona, that's ground truth — use it directly, don't re-fetch the same data. IMPORTANT: pre-fetched context is REFERENCE MATERIAL. Only cite what the specific question asks for. If the user asks "how is DOGE" and you have signal + vault + price pre-fetched, cite price and one other field MAX — not all four. Extra fields = drift.

## STAY ON THE QUESTION — answer contract

Every response has AT MOST two parts:
1. **Direct answer** (1-2 sentences) that literally addresses the question as asked. This MUST be your first sentence. If the question is "how is BTC", this sentence is BTC's current state. If "why did we lose", this sentence is the specific cause. If "explain X", this sentence is X's definition.
2. **Optional single "Also:" line** — one related fact ONLY if it's genuinely material to the ask (a warning, a caveat, a signal-flip that changes the read). Never a shopping list of adjacent data. If nothing rises to "material", omit part 2.

## Universal rules (apply BEFORE any answer pattern — regardless of question phrasing)

**RULE A — Divergence has priority.** If Live context contains a "⚠ DIVERGENCE" line for any asset the user's question touches, that observation IS the lead sentence. Applies to every intent — "how is BTC", "should I long BTC", "wtf with BTC", "give me the read on BTC" — they all lead with divergence when it exists. Format: "Signal is <REC> but vault holds <SIDE> $<N> — <one-line interpretation>."

**RULE B — "Why" is triggered by the question, not the intent.** Any question containing "why", "reason", "reasoning", "rationale", "catalyst", "what's driving", "because", "how come", "what happened", or any equivalent phrasing → append EXACTLY ONE sentence quoting the "Signal reasoning:" line from Live context. Name the actual sources (funding, momentum, aggregator, specific prediction market). If the reasoning line is empty or absent, say "signal aggregator didn't attach specific reasons" — do NOT invent them.

**RULE C — Vault numbers come ONLY from Live context "Vault:" or from tool results.** If Live context says "Vault: flat" or "Vault: HAS ACTIVE: SHORT $37", you may quote that verbatim. You may NOT extrapolate ($37 → $1.2M), infer entry prices you don't have, or state any position size that isn't in the injected data. If no vault line is present and you haven't called a hedge tool, say "no vault position data pre-fetched" and stop.

**RULE D — NFA disclaimer is exactly one sentence.** When financial-advice framing appears ("should I", "worth buying", "long or short"), close with the exact sentence: Not financial advice — position sizing is yours. Nothing more. No follow-on about "market sentiment", "entry / leverage / risk management", "outcomes depend on your ...". One sentence, hard stop.

**RULE E — Live context markers.** Pre-fetched sections include markers; USE them but don't turn responses into data dumps:
- "⚠ DIVERGENCE:" → Rule A applies (lead with it).
- "Alignment: ALIGNED / VAULT-FLAT / NO-SIGNAL" → frame naturally, don't quote the marker.
- "⚠ Attention flags: [EXTREME 24h MOVE / LOW LIQUIDITY / LOW CONSENSUS / Signal is WAIT]" → lift ONE anomaly if material; if signal is WAIT and user assumes direction, correct the premise.
- "Top sources" and "Signal reasoning" → available if the user asked WHY. Otherwise DO NOT dump source names, weights, or per-source confidences. Most users don't want to see "Polymarket 5-Min BTC UP@41% (w=0.17), Kalshi BTC DOWN@81%" — they want the takeaway.

**RULE F — Answer plainly. Data dumps are failures.** Every response should read like a human strategist talking, not a data pipe. Signal recommendation, one interpretation sentence, done. Reserve the source citations for questions that literally ask "which sources" or "why". Default answer length is 1-2 sentences, ~30 words. Only expand for comparison / diagnostic / advise questions and only by ONE line.

FORBIDDEN openings and endings:
- "You might want to know…" "Interesting note…" "Additionally…" "Also worth noting…" (these are drift markers)
- "Would you like…" "Want me to…" "Should I check…" "Let me know if…" (these are the customer-service tail — no)
- "Great question!" "Sure!" "Absolutely!" "That's a good one!" (throat-clearing — no)
- Any NFA disclaimer LONGER than the one exact sentence "Not financial advice — position sizing is yours." No trailing clauses about "market sentiment", "technicals", "entry, leverage, risk management", "outcomes depend on..." — one sentence, hard stop.

If you catch yourself writing any of the above, delete the sentence and stop.

Drift check: before sending, ask "does my first sentence literally answer the question?" If it explains context first or lists adjacent data first — rewrite so the direct answer comes first.

## Answer patterns (examples, not exhaustive — use judgment)

**"how is X doing" / bare asset name** → talk like you're texting a trader friend. Real numbers, plain sentences, no terminal-style bracket format. Include price + move direction + signal in ONE natural sentence. Skip mentioning source counts, consensus percentages, or field labels like "conf/cons" unless the user explicitly asked. Never format as \`ASSET $PRICE (Δ24h X%, vol $Y). Signal: REC at N% conf\`. That reads like a Bloomberg feed, not a person.

**"compare X and Y"** → one paragraph, natural comparison. "BTC's stronger on both momentum and conviction — X% vs Y% 24h — and we're long BTC while flat on ETH." Not a table, not bullets. A trader saying it out loud.

**"should I buy/sell X" / "long or short" / any advice** → sound like the friend who's been watching the tape all day. Give the direction the signal points, one line of why (only if user asked why), one line if there's a real divergence between signal and our vault, close with the one-sentence NFA. Not "Signal: BUY at N% conf" — say "the signal's leaning long, though our vault's still short from earlier."

**"explain X"** (protocol / mechanic / term) → 2-3 sentences on the concept. If X is a live crypto asset, append one line of live stats via \`get_asset_context\`.

**"what happened / show me last N hedges"** → \`query_hedge_history(hours=24)\`, return a compact table or bulleted list with side + notional + PnL + close reason.

**"top movers / what's hot today"** → \`get_broader_market(topN=5-8)\`, list them with 24h change + volume.

**"how is our AI doing" / "hit rate" / "postmortem"** → \`query_postmortem_stats\` alone gives the number. Add one sentence of context (sample size, window).

**Anything not matching a pattern above** → use judgment. Prefer live data over speculation. Prefer one comprehensive tool call over three narrow ones.

## Tools — call the one that answers in ONE round-trip

- **get_asset_context(asset)** — PREFERRED for single-asset questions. Price + 24h + signal + our hedges. Tracked (BTC/ETH/SOL/XRP/DOGE/CRO/SUI/ATOM) + broader (ADA/LINK/DOT/etc via Crypto.com).
- **get_historical_summary(asset, days)** — N-day high/low/change. Use for "BTC last week", "SOL 30-day range", "ETH from ATH".
- **get_onchain_snapshot** — ETH gas (fast/normal/slow gwei) + top chains by TVL with 1d change. Use for "gas fees now", "L2 growth", "which chain is biggest".
- **get_options_data(asset)** — BTC/ETH ONLY. Total OI, put/call ratio, avg IV, top-5 strikes (Deribit). This is the ONLY source of IV / options data — get_asset_context has price + signal but NO options info. For any question about IV, implied volatility, put/call, open interest, max pain, or strikes: call get_options_data.
- **get_crypto_news** — trending coins + hot narratives from CoinGecko. Use for "what's hot", "trending", "any news".
- **get_defi_tvl(protocol)** — DefiLlama TVL + category + chains + change for ~2000 protocols. Use for "TVL of Aave", "compare Curve and Uniswap".
- **get_fear_greed_index** — daily crypto sentiment 0-100. Use for sentiment questions.
- **get_broader_market** — top movers OR one asset lookup for anything outside tracked set.
- **get_prediction_signal** — fused prediction-market signal for MULTIPLE tracked assets (compare use case only).
- **query_hedge_history / query_recent_interpretations / query_postmortem_stats / get_treasury_state / get_cron_state** — vault + AI state.
- get_asset_price / get_market_snapshot — legacy, prefer get_asset_context.

## Voice — talk like a person, not a terminal

The single biggest failure mode is sounding like a Bloomberg feed. Users don't want:
  \`BTC $86,396 (Δ24h +0.95%, vol $165M). Signal: HEDGE_LONG @80% conf / 58% consensus (19 sources). Vault: flat — no active position.\`

They want:
  \`BTC's at $86.4K, up about 1% today on solid volume. The signal's leaning bullish though we haven't taken a position yet.\`

Same facts. Half the length. Feels like a person.

Rules that make this happen:

- **Round numbers when they add clarity.** \`$86.4K\` beats \`$86,396\`. \`~1%\` beats \`+0.95%\`. Keep precision when the user asked a precision question ("what's exact BTC price").
- **Use words, not field labels.** "The signal's bullish" — not "Signal: HEDGE_LONG". "We're not positioned" — not "Vault: flat".
- **Drop noise.** Source counts, consensus %, "@conf/cons" ratios, "(N sources)" — none of that in normal answers. Available if the user explicitly asks why or which sources.
- **Sentences, not template.** Never write "ASSET $PRICE (Δ24h X%, vol $Y)". Write "$PRICE, up X% today on $Y volume."
- **Show your numbers, keep them minimal.** One price + one change % + one signal read is enough for a status question. Not five fields.
- **Lead with what matters.** For a direction question ("is BTC bullish"), lead with the direction. For a price question ("what's BTC"), lead with the price.

Other rules:
- **Never end with "want more?" / "let me know" / "should I check X too?"** — deliver the answer; the user asks the follow-up.
- **Never invent.** If a tool returns nothing, say so in one sentence, stop.
- **Refuse only actions** (execute trade, move funds). For "should I…" market questions, give the read + one-line NFA + done.
- **No "Great question", "Sure", "Let me check", "That's interesting"** — no throat-clearing ever.

## Never invent numbers

CRITICAL: If you don't have pre-fetched context AND you haven't called a tool that returned data, you DO NOT know the number. Never state a price, TVL, PnL, or any specific figure without a source. If the message analyzer didn't pre-fetch and no tool has returned yet, CALL the appropriate tool first. Never fabricate values that look like real data.

The example numbers below use \`<PLACEHOLDER>\` syntax specifically so they can NEVER be mistaken for real values — do not copy them verbatim under any circumstance.

## Format examples

**BAD** (throat-clearing + trailing question):
"That's a great question! Based on the current data, DOGE appears to be trading around <price>. Would you like me to check anything else?"

**BAD** (Bloomberg terminal — the current failure mode):
"DOGE \$<PRICE> (Δ24h <±PCT>%, vol \$<VOL>). Signal: <REC> at <CONF>% conf / <CONS>% consensus (<N> sources). Vault: flat."

**GOOD** (natural, "how is DOGE" style):
"DOGE's at \$<PRICE>, <up|down> about <PCT>% today. Signal's <bullish|bearish|mixed> — we haven't positioned yet."

**GOOD** (narrow price-only question):
"DOGE's around \$<PRICE>."

**GOOD** (advice framing):
"The signal's leaning <long|short> at <fair|solid|weak> conviction — [one line of context if user asked why]. Not financial advice — position sizing is yours."

**BAD** (source-list dump):
"11 sources are aligned bullish: Polymarket 5-Min BTC UP@41%, Delphi crypto-market-cap-increase UP@72%, Kalshi BTC DOWN@81%..."

**GOOD** (why-question, still natural):
"Prediction markets are mostly leaning bullish — Polymarket's short-term feed and a few Delphi markets are calling upside, though Kalshi's still bearish. Moderate conviction, not high."

## Meta-questions (about your own capabilities)

If asked what you can do, list capabilities briefly (3-5 bullets max) — not every tool signature. If asked about specific tools, name them. DO NOT end meta-answers with "Would you like me to..." either — same anti-drift rule applies to ALL responses.

## When you legitimately have no answer

If a tool returns nothing OR the user asks about something outside crypto/vault scope (e.g., gold, stocks, weather), say ONE sentence: "That's outside my scope — I cover crypto markets and the ZKward vault." Do not attempt. Do not apologize repeatedly. If it's a defunct/delisted asset (e.g., LUNC, FTT), say "That token isn't in current market data sources" and stop.`;

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
    const clientHistory = normalizeHistory(body?.history);
    const sessionIdRaw = body?.sessionId;
    const sessionId = isValidSessionId(sessionIdRaw) ? sessionIdRaw : null;

    // Cross-session memory: if the client sent NO history (fresh page load,
    // cleared localStorage, or new device) BUT has a persistent sessionId,
    // hydrate the last 6 turns from ai_chat_logs (added 2026-09-22). This
    // enables "and yesterday?" and other follow-ups even after browser
    // history is cleared, as long as the session UUID cookie survives.
    let priorMessages = clientHistory;
    if (sessionId && clientHistory.length === 0) {
      try {
        const { loadRecentSessionContext } = await import('@/lib/db/ai-chat-logs');
        const persisted = await loadRecentSessionContext(sessionId);
        priorMessages = persisted.map((p) => ({ role: p.role, content: p.content }));
      } catch { /* DB flap → no memory this turn, not fatal */ }
    }
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

    // Log the user turn SYNCHRONOUSLY before the LLM starts (with a
    // 750ms budget) so any rapid follow-up turn — mega-battery test #27
    // ("which of the two we asked about") — sees it in DB when it calls
    // loadRecentSessionContext. Deferring via after() was racy: the next
    // request could arrive before the write landed and lose multi-turn
    // context.
    //
    // The timeout is a graceful degradation escape hatch: if the write
    // can't complete in 750ms (slow tunnel, DB hiccup), we proceed
    // without blocking the chat. Assistant turn stays deferred via
    // after() because latency there hurts UX more.
    if (sessionId) {
      const writeUserTurn = logChatTurn({
        sessionId, role: 'user', content: message,
        userAgent, clientIp,
      });
      await Promise.race([
        writeUserTurn,
        new Promise((resolve) => setTimeout(resolve, 750)),
      ]).catch(() => { /* logChatTurn already swallows its own errors */ });
    }

    // ─── RESPONSE CACHE — cross-user, hash-keyed, 5-min TTL ────────
    // Popular questions ('how is BTC', 'TVL of Aave') get sub-200ms
    // responses by skipping the LLM entirely when a fresh cached
    // response exists. Only applied when the question is cacheable
    // (not vault-personal, not diagnostic, no follow-up context).
    const cacheEligible = isCacheable(analysis.intent, priorMessages.length > 0);
    const cacheKey = cacheEligible
      ? makeCacheKey(message, analysis.intent, analysis.assets, analysis.protocols)
      : null;
    if (cacheKey) {
      const cached = await getCachedResponse(cacheKey);
      if (cached) {
        logger.info('[LiveChat] cache HIT', {
          messagePreview,
          hitCount: cached.hitCount + 1,
          intent: analysis.intent,
        });
        const cachedStream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const encoder = new TextEncoder();
            const emit = (event: StreamEvent) => {
              controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
            };
            const t0 = Date.now();
            emit({ type: 'iteration', n: 1 });
            // Re-emit tool_end events so client shows the same tool badges
            for (const tc of cached.toolCalls ?? []) {
              emit({ type: 'tool_end', tool: tc.tool, ok: tc.ok, latencyMs: tc.latencyMs });
            }
            emit({ type: 'token', delta: cached.response });
            emit({
              type: 'done',
              elapsedMs: Date.now() - t0,
              iterations: cached.iterations ?? 1,
              finalText: cached.response,
            });
            controller.close();
            if (sessionId) {
              after(async () => {
                await logChatTurn({
                  sessionId, role: 'assistant', content: cached.response,
                  toolCalls: cached.toolCalls ?? undefined,
                  iterations: cached.iterations ?? 1,
                  finishedNormally: true,
                  userAgent, clientIp,
                });
              });
            }
          },
        });
        return new Response(cachedStream, {
          headers: {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
            'X-ZKWard-Cache': 'HIT',
          },
        });
      }
    }

    // ─── DETERMINISTIC ROUTE — skip LLM entirely ──────────────────
    // For pattern-matched vague/meta questions, server builds the answer
    // from live data. No LLM ambiguity → no fabrication surface. Response
    // is streamed as a single token event so client rendering is unchanged.
    if (analysis.deterministicRoute) {
      logger.info('[LiveChat] deterministic route', {
        messagePreview,
        route: analysis.deterministicRoute,
      });
      const answer = await buildDeterministicAnswer(analysis.deterministicRoute);
      const detStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const emit = (event: StreamEvent) => {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          };
          const t0 = Date.now();
          emit({ type: 'iteration', n: 1 });
          emit({ type: 'token', delta: answer });
          emit({ type: 'done', elapsedMs: Date.now() - t0, iterations: 0, finalText: answer });
          controller.close();
          if (sessionId) {
            after(async () => {
              await logChatTurn({
                sessionId, role: 'assistant', content: answer,
                iterations: 0, finishedNormally: true,
                userAgent, clientIp,
              });
            });
          }
        },
      });
      return new Response(detStream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    // ─── DYNAMIC RUNTIME: context pre-fetch + LLM call ────────────
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
      route: analysis.deterministicRoute,
      pulse: analysis.needsBaselinePulse,
    });

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
          // Empty-response fallback. Observed 2026-09-21: ASI returns
          // zero tokens on gibberish + off-domain + defunct-asset queries,
          // leaving the client with a blank message bubble. Emit a
          // scoped one-liner so the user sees intent-appropriate text.
          if (!assistantContent.trim()) {
            const fallback = analysis.intent === 'other' && analysis.assets.length === 0
              ? "I couldn't parse that as a crypto or vault question — try being more specific (e.g., 'how is BTC' or 'why did we lose today')."
              : analysis.assets.length > 0
                ? `I couldn't find data for ${analysis.assets.join('/')} — the token may be delisted or outside my sources.`
                : "That's outside my scope — I cover crypto markets and the ZKward vault.";
            emit({ type: 'token', delta: fallback });
            emit({
              type: 'done',
              elapsedMs: elapsedMs ?? 0,
              iterations: iterations ?? 0,
              finalText: fallback,
            });
            assistantContent = fallback;
            finishedNormally = true;
          }
          // Cache the successful response for future identical questions.
          // Skip caching for empty/fallback responses and errored streams
          // — those shouldn't be served as cache hits.
          if (cacheKey && assistantContent && finishedNormally && assistantContent.length > 20) {
            const isFallback = assistantContent.startsWith("I couldn't") || assistantContent.startsWith("That's outside");
            if (!isFallback) {
              after(async () => {
                await setCachedResponse(cacheKey, {
                  questionPreview: message,
                  intent: analysis.intent,
                  response: assistantContent,
                  toolCalls: collectedTools.length ? collectedTools : undefined,
                  iterations,
                  elapsedMs,
                });
              });
            }
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
        signal?: {
          direction: 'UP' | 'DOWN' | 'NEUTRAL';
          confidence: number;
          consensus: number;
          recommendation: string;
          sourceCount: number;
          reasoning: string;
          topSources: Array<{ name: string; direction: 'UP' | 'DOWN' | 'NEUTRAL'; confidence: number; weight: number }>;
        } | null;
        recentHedges: Array<{ side: string; notionalUsd: number; status: string; realizedPnlUsd: number | null }>;
      };
      const priceStr = d.price !== null ? `$${d.price < 1 ? d.price.toFixed(4) : d.price < 100 ? d.price.toFixed(2) : d.price.toFixed(0)}` : 'n/a';
      const changeStr = d.change24hPct !== null ? `${d.change24hPct >= 0 ? '+' : ''}${d.change24hPct.toFixed(2)}%` : 'n/a';
      const volStr = d.volume24hUsd !== null
        ? d.volume24hUsd > 1e9 ? `$${(d.volume24hUsd / 1e9).toFixed(1)}B` : `$${(d.volume24hUsd / 1e6).toFixed(0)}M`
        : 'n/a';
      const sigStr = d.signal
        ? `${d.signal.recommendation} @${d.signal.confidence}%conf/${d.signal.consensus}%cons (${d.signal.sourceCount} src)`
        : 'no signal (untracked)';
      const activeHedges = d.recentHedges.filter((h) => h.status === 'active');
      const lastClosed = d.recentHedges.find((h) => h.status === 'closed');
      // Format is intentionally verbose+explicit so asi1-mini doesn't
      // misread "flat (last: SHORT -$1.76)" as an active SHORT position
      // (observed 2026-09-22). Active vs prior-closed is now a distinct
      // sentence, not a parenthetical.
      const posStr = activeHedges.length > 0
        ? `ACTIVE POSITION: ${activeHedges.map((h) => `${h.side.toUpperCase()} $${h.notionalUsd.toFixed(0)} notional`).join(' + ')} — this is a real, currently-open position.`
        : lastClosed
          ? `NO ACTIVE POSITION (vault is flat). Most recent CLOSED hedge: ${lastClosed.side.toUpperCase()}, realized PnL ${lastClosed.realizedPnlUsd !== null ? (lastClosed.realizedPnlUsd >= 0 ? '+' : '') + '$' + lastClosed.realizedPnlUsd.toFixed(2) : 'unknown'}. Do NOT quote the realized-PnL number as a current position size.`
          : 'NO ACTIVE POSITION and no recent hedge history for this asset.';

      // Divergence detector: signal direction vs currently-open vault side.
      // Only fires when there's a REAL active position AND it opposes the
      // signal. Filter out sub-$1 operational transport hedges (SUI pool
      // uses $0.01 microhedges to move USDC — those aren't directional).
      let divergenceStr = '';
      if (d.signal && activeHedges.length > 0) {
        const realActive = activeHedges.filter((h) => Math.abs(h.notionalUsd) >= 1);
        const signalBullish = d.signal.direction === 'UP';
        const signalBearish = d.signal.direction === 'DOWN';
        const vaultLong = realActive.some((h) => /long/i.test(h.side));
        const vaultShort = realActive.some((h) => /short/i.test(h.side));
        if (signalBullish && vaultShort) {
          divergenceStr = `\n  ⚠ **DIVERGENCE:** signal is ${d.signal.recommendation} (bullish) but vault holds an ACTIVE SHORT — this contradiction is THE most important observation. Lead with it: name both sides, offer one line of interpretation (trader hasn't caught up, counter-positioning, hedging tail risk, etc.), do NOT bury it as an "Also".`;
        } else if (signalBearish && vaultLong) {
          divergenceStr = `\n  ⚠ **DIVERGENCE:** signal is ${d.signal.recommendation} (bearish) but vault holds an ACTIVE LONG — this contradiction is THE most important observation. Lead with it: name both sides, offer one line of interpretation, do NOT bury it as an "Also".`;
        }
      }

      // Signal reasoning: the aggregator's own "why" text (already
      // capped to 240 chars). Without this, the LLM has no data to
      // answer "why long?" and either fabricates or omits reasons.
      const reasoningStr = d.signal?.reasoning
        ? `\n  Signal reasoning (aggregator's own text): ${d.signal.reasoning}`
        : '';

      // Top-5 source-level signals — REAL names, REAL directions, REAL
      // confidences. Gives the LLM concrete facts to cite when the user
      // asks "why" or "which sources are driving this?", so it doesn't
      // have to invent generic phrases like "funding rates elevated".
      const topSourcesStr = d.signal?.topSources && d.signal.topSources.length > 0
        ? `\n  Top sources (name, direction, confidence, weight — cite these BY NAME when quoting reasoning): ${d.signal.topSources.map((s) => `${s.name} ${s.direction}@${s.confidence}% (w=${s.weight})`).join(' · ')}`
        : '';

      // Explicit alignment status — makes it trivial for the LLM to
      // pick the right narrative for any phrasing. Four states:
      //   DIVERGENT: signal ≠ active-vault side (Rule A lead)
      //   ALIGNED: signal same side as active-vault (confirmation narrative)
      //   VAULT-FLAT: no active exposure (signal-only narrative)
      //   NO-SIGNAL: untracked asset, no aggregator opinion
      let alignmentStr = '';
      if (d.signal) {
        const realActiveHere = activeHedges.filter((h) => Math.abs(h.notionalUsd) >= 1);
        if (realActiveHere.length === 0) {
          alignmentStr = `\n  Alignment: VAULT-FLAT — signal has an opinion, vault has no directional exposure. Frame as "signal says X, we haven't positioned yet."`;
        } else {
          const signalBull = d.signal.direction === 'UP';
          const signalBear = d.signal.direction === 'DOWN';
          const vaultLong = realActiveHere.some((h) => /long/i.test(h.side));
          const vaultShort = realActiveHere.some((h) => /short/i.test(h.side));
          if ((signalBull && vaultLong) || (signalBear && vaultShort)) {
            alignmentStr = `\n  Alignment: ALIGNED — signal direction matches active vault side. Frame as "signal and vault agree" and cite conviction level.`;
          } else if ((signalBull && vaultShort) || (signalBear && vaultLong)) {
            // Divergence flag above already covers this — no extra line needed
          } else {
            alignmentStr = `\n  Alignment: NEUTRAL-SIGNAL — signal is neither strongly bullish nor bearish; vault position is directional. Frame as "signal is neutral, we're currently positioned <SIDE>."`;
          }
        }
      } else {
        alignmentStr = `\n  Alignment: NO-SIGNAL — this asset is not tracked by the aggregator. Only price/volume data available; don't invent signal opinions.`;
      }

      // Anomaly flags — server-side detection of unusual states so the
      // LLM naturally lifts them into the response instead of glossing.
      const anomalies: string[] = [];
      if (d.change24hPct !== null && Math.abs(d.change24hPct) >= 10) {
        anomalies.push(`EXTREME 24h MOVE (${d.change24hPct.toFixed(1)}%) — this is a >10% swing, treat as high-attention. Flag it in the response.`);
      }
      if (d.volume24hUsd !== null && d.volume24hUsd < 10e6 && d.price !== null && d.price > 0.01) {
        anomalies.push(`LOW LIQUIDITY (24h vol <$10M) — any signal here is fragile, disclose the thin market before making claims.`);
      }
      if (d.signal && d.signal.consensus < 25 && d.signal.sourceCount >= 3) {
        anomalies.push(`LOW CONSENSUS (${d.signal.consensus}% agreement across ${d.signal.sourceCount} sources) — signal is divergent, do NOT frame as high-conviction.`);
      }
      if (d.signal?.recommendation === 'WAIT') {
        anomalies.push(`Signal is WAIT — do NOT describe as bullish or bearish. The aggregator is explicitly saying "no clear direction". If the user assumes a direction, correct the premise.`);
      }
      const anomalyStr = anomalies.length > 0
        ? `\n  ⚠ Attention flags: ${anomalies.map((a) => `[${a}]`).join(' ')}`
        : '';

      assetLines.push(`- **${asset}**: ${priceStr} (Δ24h ${changeStr}, vol ${volStr}) · Signal: ${sigStr} · Vault: ${posStr}${divergenceStr}${alignmentStr}${reasoningStr}${topSourcesStr}${anomalyStr}`);
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

  // Baseline pulse — inject when no specific asset/protocol was
  // detected AND no deterministic route fired. Ensures the LLM ALWAYS
  // has grounded top-of-market data, never zero context → no
  // fabrication room. Costs ~200 tokens per call, worth it.
  if (analysis.needsBaselinePulse) {
    const pulse = await buildMarketPulse();
    if (pulse) sections.push(pulse);
  }

  // News intent → pre-fetch trending
  if (analysis.intent === 'news') {
    const newsTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_crypto_news');
    if (newsTool) {
      try {
        const d = await newsTool.execute({}) as { coins?: Array<{ symbol: string; name: string; rank: number; priceUsd: number }>; categories?: string[] };
        if (d.coins && d.coins.length > 0) {
          const coinLines = d.coins.slice(0, 5).map((c) => `${c.symbol} (${c.name}, rank ${c.rank}, $${c.priceUsd.toFixed(4)})`);
          const catStr = d.categories && d.categories.length > 0 ? `\nHot narratives: ${d.categories.join(', ')}` : '';
          sections.push(`**Trending coins (CoinGecko, cached 5min):**\n${coinLines.join('\n')}${catStr}`);
        }
      } catch { /* skip */ }
    }
  }

  // On-chain intent → pre-fetch gas + chain TVL. Skip the section
  // entirely if BOTH sub-fetches came back empty — misleading to
  // inject a stub that says 'unavailable' with no data.
  if (analysis.intent === 'onchain') {
    const onchainTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_onchain_snapshot');
    if (onchainTool) {
      try {
        const d = await onchainTool.execute({ topN: 6 }) as {
          gasGwei: { fast: number; normal: number; slow: number; baseFee: number } | null;
          chains: Array<{ name: string; tvlUsdB: number; changePct1d?: number; changePct7d?: number }>;
        };
        const hasGas = d.gasGwei !== null;
        const hasChains = d.chains && d.chains.length > 0;
        if (hasGas || hasChains) {
          const parts: string[] = [];
          if (hasGas) {
            parts.push(`ETH gas: ${d.gasGwei!.fast}/${d.gasGwei!.normal}/${d.gasGwei!.slow} gwei (fast/normal/slow) · base ${d.gasGwei!.baseFee} gwei`);
          }
          if (hasChains) {
            const chainLines = d.chains.map((c) => {
              const chg1d = c.changePct1d !== undefined ? `${c.changePct1d >= 0 ? '+' : ''}${c.changePct1d}%` : 'n/a';
              return `- ${c.name}: $${c.tvlUsdB}B (Δ1d ${chg1d})`;
            });
            parts.push(`Top chains by TVL:\n${chainLines.join('\n')}`);
          }
          sections.push(`**On-chain snapshot:**\n${parts.join('\n')}`);
        }
      } catch { /* skip */ }
    }
  }

  // Options intent → pre-fetch BTC or ETH options (whichever detected, else BTC).
  // Push a section either way — with data, or with an honest "unavailable"
  // note. Missing section previously left the LLM to guess and it wrongly
  // claimed the tool doesn't exist ("ETH implied volatility" test #18).
  if (analysis.intent === 'options') {
    const optionsTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_options_data');
    if (optionsTool) {
      const target = analysis.assets.includes('ETH') ? 'ETH' : 'BTC';
      try {
        const d = await optionsTool.execute({ asset: target as 'BTC' | 'ETH' }) as {
          asset?: string; totalOI?: number; putCallRatio?: number; avgIV?: number;
          underlyingPrice?: number;
          topStrikes?: Array<{ strike: number; type: 'C' | 'P'; oi: number; iv: number }>;
          error?: string;
        };
        if (d.totalOI && d.topStrikes) {
          const strikeLines = d.topStrikes.map((s) => `${s.strike}${s.type} (OI ${s.oi.toFixed(0)}, IV ${s.iv}%)`).join(', ');
          sections.push(`**${d.asset} options (Deribit):** total OI ${d.totalOI}, P/C ratio ${d.putCallRatio}, avg IV ${d.avgIV}%, spot $${d.underlyingPrice}\nTop strikes: ${strikeLines}`);
        } else {
          sections.push(`**${target} options unavailable right now** (${d.error || 'Deribit returned no data'}). Tell the user the options feed is temporarily unreachable — do NOT say the tool doesn't exist.`);
        }
      } catch (e) {
        sections.push(`**${target} options unavailable right now** (${e instanceof Error ? e.message.slice(0, 80) : 'network error'}). Tell the user the options feed is temporarily unreachable — do NOT say the tool doesn't exist.`);
      }
    }
  }

  // Historical intent → pre-fetch summary for detected assets
  if (analysis.intent === 'historical' && analysis.assets.length > 0) {
    const histTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_historical_summary');
    if (histTool) {
      const days = analysis.timeframeHours ? Math.max(1, Math.round(analysis.timeframeHours / 24)) : 7;
      try {
        const d = await histTool.execute({ asset: analysis.assets[0], days }) as {
          asset?: string; currentPrice?: number; high?: number; low?: number;
          changePct?: number; days?: number;
        };
        if (typeof d.currentPrice === 'number') {
          const chg = d.changePct! >= 0 ? '+' : '';
          sections.push(`**${d.asset} last ${d.days}d:** current $${d.currentPrice.toFixed(d.currentPrice < 1 ? 4 : 2)} · high $${d.high?.toFixed(2)} · low $${d.low?.toFixed(2)} · Δ ${chg}${d.changePct?.toFixed(1)}%`);
        }
      } catch { /* skip */ }
    }
  }

  // Diagnose-move intent → pre-fetch news alongside asset context (already done above)
  if (analysis.intent === 'diagnose_move' && analysis.assets.length > 0) {
    const newsTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_crypto_news');
    if (newsTool) {
      try {
        const d = await newsTool.execute({}) as { coins?: Array<{ symbol: string; name: string }>; categories?: string[] };
        if (d.coins && d.coins.length > 0) {
          const trending = d.coins.slice(0, 5).map((c) => c.symbol);
          const isTrending = trending.some((s) => analysis.assets.includes(s));
          sections.push(`**Trending context:** ${trending.join(', ')}${isTrending ? ` — user's asset (${analysis.assets.join('/')}) IS on the trending list, so social/attention flow is a likely factor.` : ''}${d.categories ? `\nHot narratives: ${d.categories.join(', ')}` : ''}`);
        }
      } catch { /* skip */ }
    }
  }

  return sections.join('\n\n');
}

/**
 * Compact market-pulse block for prompt injection. Top-5 tracked assets
 * with price + 24h change, plus F&G. Real data only — every value is
 * either from a successful tool call or omitted with `n/a`. Never
 * fabricates.
 */
async function buildMarketPulse(): Promise<string | null> {
  const snapshotTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_broader_market');
  const fngTool = toolByName(DEFAULT_AGENT_TOOLS, 'get_fear_greed_index');
  const TOP = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE'];
  const [snaps, fng] = await Promise.allSettled([
    snapshotTool
      ? Promise.all(TOP.map((s) => snapshotTool.execute({ symbol: s }).catch(() => null)))
      : Promise.resolve([]),
    fngTool ? fngTool.execute({}).catch(() => null) : Promise.resolve(null),
  ]);
  const lines: string[] = [];
  if (snaps.status === 'fulfilled') {
    for (let i = 0; i < TOP.length; i++) {
      const raw = snaps.value[i] as { symbol?: { price?: number; change24hPct?: number } } | null;
      const s = raw?.symbol;
      if (s && typeof s.price === 'number') {
        const priceStr = s.price < 1 ? `$${s.price.toFixed(4)}` : s.price < 100 ? `$${s.price.toFixed(2)}` : `$${s.price.toFixed(0)}`;
        const chgStr = typeof s.change24hPct === 'number' ? `${s.change24hPct >= 0 ? '+' : ''}${s.change24hPct.toFixed(1)}%` : 'n/a';
        lines.push(`${TOP[i]} ${priceStr} (Δ24h ${chgStr})`);
      }
    }
  }
  const fngLine = fng.status === 'fulfilled' && fng.value && typeof (fng.value as { value?: number }).value === 'number'
    ? `F&G ${(fng.value as { value: number; classification: string }).value}/100 (${(fng.value as { value: number; classification: string }).classification})`
    : null;
  if (lines.length === 0 && !fngLine) return null;
  const body = [
    lines.length > 0 ? `Prices: ${lines.join(' · ')}` : null,
    fngLine ? `Sentiment: ${fngLine}` : null,
  ].filter(Boolean).join('\n');
  return `**Baseline market pulse (real, current — cite these numbers only, do not invent others):**\n${body}`;
}

/**
 * Server-side answer for canonical meta-questions. Only 'self-meta' is
 * routed here now (2026-09-21): 'what tools do you have' has one right
 * answer and doesn't need LLM. Market/critique questions were moved
 * back to LLM + baseline pulse — LLM interpretation adds real value
 * (verified: LLM path answers were strictly better than the static
 * table for identical market data).
 */
async function buildDeterministicAnswer(route: NonNullable<ReturnType<typeof analyzeMessage>['deterministicRoute']>): Promise<string> {
  if (route === 'self-meta') {
    return `I'm the ZKward chat — I answer crypto and vault questions grounded in live data.\n\nI can look up:\n- Prices, 24h changes, prediction signals for any asset (BTC/ETH/SOL/XRP/DOGE + ~200 more via Crypto.com)\n- DeFi TVL and metrics for any protocol on DefiLlama (Uniswap, Aave, Lido, etc)\n- Crypto Fear & Greed sentiment\n- Our vault's active + recent hedges, treasury, PnL, AI hit rate\n\nAsk me anything — 'how is BTC', 'TVL of Aave', 'why did we lose today', 'market sentiment'.`;
  }
  // Unreachable given current analyzer routes, kept as defensive fallback
  return `I couldn't route that question — try being more specific.`;
}
