/**
 * Synthetic tool-use training example generator.
 *
 * Produces JSONL examples in Qwen 2.5 chat format teaching the model:
 *   1. Emit <tool_call>{...}</tool_call> when data is needed
 *   2. Consume <tool_response>{...}</tool_response> observations
 *   3. Handle tool errors honestly (no hallucination)
 *   4. Answer directly without a tool call when the prompt is self-sufficient
 *
 * The tool schemas match EXACTLY what lib/services/ai/agent-tools.ts
 * exposes — so a model trained on this data can immediately be routed
 * through tool-runner.ts.
 *
 * Output: data/signal-interpreter/tool-use.jsonl
 *
 * Run:
 *   bun run scripts/ai-training/generate-tool-use-data.ts
 */
import * as fs from 'fs';

const OUT = 'data/signal-interpreter/tool-use.jsonl';

const TOOL_SPECS = [
  {
    name: 'get_asset_price',
    description: 'Fetch validated spot price for an asset across multiple sources.',
    parameters: { type: 'object', properties: { asset: { type: 'string', description: 'Ticker: BTC, ETH, SOL, SUI' } }, required: ['asset'] },
  },
  {
    name: 'query_hedge_history',
    description: 'Fetch recent hedges (open + closed positions on BlueFin).',
    parameters: { type: 'object', properties: { asset: { type: 'string' }, hours: { type: 'number', description: 'Lookback in hours. Default 168.' }, status: { type: 'string', enum: ['active', 'closed'] }, limit: { type: 'number' } } },
  },
  {
    name: 'query_recent_interpretations',
    description: 'Fetch recent Signal Interpreter outputs.',
    parameters: { type: 'object', properties: { asset: { type: 'string' }, hours: { type: 'number' }, limit: { type: 'number' } } },
  },
  {
    name: 'get_cron_state',
    description: 'Read one key from cron_state table.',
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'query_postmortem_stats',
    description: 'Aggregate signal-interpretation outcomes over the last N days.',
    parameters: { type: 'object', properties: { days: { type: 'number' } } },
  },
];

// Compact tool declarations — the model learns the <tool_call>/<tool_response>
// format from example turns, so we don't need paragraphs of instructions.
// Full JSON schemas at inference time via apply_chat_template(tools=[...]).
// Training-time budget: ~150 tokens vs the initial 408 (blew past v1's
// max_length=512 from the system prompt alone → forced max_length=1024 →
// VRAM paging → 90s/step → unusable).
const SYSTEM_PROMPT = `You reason about Zkward's live state. Available tools:
${TOOL_SPECS.map(t => `- ${t.name}: ${t.description}`).join('\n')}

Call a tool with <tool_call>{"name":"...","arguments":{...}}</tool_call>. If a tool errors, be honest — never fabricate results. If the answer is in the prompt, respond directly without a tool call.`;

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

interface Example {
  messages: Message[];
}

const ASSETS = ['BTC', 'ETH', 'SOL', 'SUI', 'DOGE', 'XRP', 'AVAX', 'LINK', 'MATIC', 'ADA'];
const PRICE_RANGES: Record<string, [number, number]> = {
  BTC: [55000, 95000], ETH: [2200, 4800], SOL: [110, 260], SUI: [0.8, 3.4],
  DOGE: [0.06, 0.25], XRP: [0.5, 3.2], AVAX: [18, 55], LINK: [12, 32], MATIC: [0.5, 1.4], ADA: [0.3, 1.2],
};

const rand = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const rint = (lo: number, hi: number) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
const rfloat = (lo: number, hi: number, dp = 2) => Number((Math.random() * (hi - lo) + lo).toFixed(dp));

function pricePayload(asset: string) {
  const [lo, hi] = PRICE_RANGES[asset] ?? [1, 100];
  return { asset, price: rfloat(lo, hi, 2), confidence: rand(['high', 'high', 'medium']), sources: rint(2, 5) };
}

function toolCall(name: string, args: Record<string, unknown>): string {
  // Inline format (no newlines) — matches the pattern the model naturally
  // wants to emit after seeing our system prompt example. v2 first attempt
  // used `<tool_call>\n{...}\n</tool_call>` but the model over-learned the
  // signal-interp `}}<|im_end|>` ending and never emitted the closing
  // </tool_call> tag. Inline gives a shorter learn-this-pattern signal.
  return `<tool_call>{"name":"${name}","arguments":${JSON.stringify(args)}}</tool_call>`;
}

// Qwen's chat template already wraps role:"tool" content with
// <tool_response>...</tool_response>. Content should be raw JSON only.
function toolResponse(result: unknown): string {
  return JSON.stringify(result);
}

function toolError(err: string): string {
  return JSON.stringify({ error: err });
}

const base = (): Message[] => [{ role: 'system', content: SYSTEM_PROMPT }];

// ── Category 1: Single-tool (50 examples) ───────────────────────────────

function makeSingleTool(): Example[] {
  const out: Example[] = [];

  // Simple price queries
  for (const asset of ASSETS) {
    for (let i = 0; i < 3; i++) {
      const q = rand([
        `What is the current ${asset} price?`,
        `Fetch the latest ${asset} spot.`,
        `How much is ${asset} trading at right now?`,
        `Give me ${asset}'s spot price.`,
      ]);
      const payload = pricePayload(asset);
      out.push({
        messages: [
          ...base(),
          { role: 'user', content: q },
          { role: 'assistant', content: toolCall('get_asset_price', { asset }) },
          { role: 'tool', content: toolResponse(payload) },
          {
            role: 'assistant',
            content: `${asset} is trading at $${payload.price.toLocaleString()} (${payload.confidence} confidence, ${payload.sources} sources).`,
          },
        ],
      });
    }
  }

  // Hedge history queries
  for (let i = 0; i < 10; i++) {
    const asset = rand(ASSETS);
    const hours = rand([24, 48, 72, 168]);
    const q = rand([
      `Show me recent ${asset} hedge activity from the last ${hours} hours.`,
      `What ${asset} hedges have we opened in the past ${hours} hours?`,
      `List ${asset} positions from the last ${hours}h.`,
    ]);
    const nHedges = rint(2, 8);
    const rows = Array.from({ length: nHedges }, (_, k) => ({
      order_id: `polyedge_${asset}_${1723600000 + k * 300000}`,
      asset,
      side: rand(['LONG', 'SHORT']),
      notional_value: rfloat(50, 800, 2),
      status: rand(['active', 'closed', 'closed']),
      realized_pnl: rfloat(-25, 30, 2),
      current_pnl: rfloat(-25, 30, 2),
      created_at: new Date(Date.now() - k * 3600 * 1000).toISOString(),
      closed_at: k > 2 ? new Date(Date.now() - (k - 1) * 3600 * 1000).toISOString() : null,
    }));
    const wins = rows.filter(r => r.realized_pnl > 0).length;
    const losses = rows.filter(r => r.realized_pnl < 0).length;
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: q },
        { role: 'assistant', content: toolCall('query_hedge_history', { asset, hours }) },
        { role: 'tool', content: toolResponse(rows) },
        {
          role: 'assistant',
          content: `Last ${hours}h ${asset}: ${nHedges} hedges (${wins} wins, ${losses} losses). Net PnL ${rows.reduce((s, r) => s + r.realized_pnl, 0).toFixed(2)} USD.`,
        },
      ],
    });
  }

  // cron_state reads
  for (let i = 0; i < 5; i++) {
    const key = rand([
      'cron:lastRun:sui-community-pool',
      'cron:lastRun:polymarket-edge-trader',
      'cron:haltUntil:sui-community-pool:autohedge',
      'alert-response:spot-target-risk-cap',
      'profit-lock:zero-since',
    ]);
    const payload = { key, value: { ts: Date.now(), status: rand(['ok', 'ok', 'triggered']) }, exists: true };
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: `Read cron_state key "${key}".` },
        { role: 'assistant', content: toolCall('get_cron_state', { key }) },
        { role: 'tool', content: toolResponse(payload) },
        {
          role: 'assistant',
          content: `\`${key}\`: ${JSON.stringify(payload.value)}`,
        },
      ],
    });
  }

  // Postmortem stats
  for (let i = 0; i < 5; i++) {
    const days = rand([7, 14, 30]);
    const total = rint(20, 200);
    const resolved = Math.floor(total * rfloat(0.4, 0.9, 2));
    const correct = Math.floor(resolved * rfloat(0.5, 0.85, 2));
    const payload = { total, resolved, correct, wrong: resolved - correct, accuracy: correct / resolved };
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: rand([`How well is the AI predicting over the last ${days} days?`, `Give me the postmortem stats for the past ${days}d.`]) },
        { role: 'assistant', content: toolCall('query_postmortem_stats', { days }) },
        { role: 'tool', content: toolResponse(payload) },
        {
          role: 'assistant',
          content: `Last ${days}d: ${correct}/${resolved} correct (${(payload.accuracy * 100).toFixed(1)}%). ${total - resolved} still pending.`,
        },
      ],
    });
  }

  return out;
}

// ── Category 2: Multi-tool (30 examples) ────────────────────────────────

function makeMultiTool(): Example[] {
  const out: Example[] = [];

  // price + hedges for one asset
  for (let i = 0; i < 10; i++) {
    const asset = rand(ASSETS);
    const price = pricePayload(asset);
    const nHedges = rint(1, 4);
    const rows = Array.from({ length: nHedges }, () => ({
      asset,
      side: rand(['LONG', 'SHORT']),
      notional_value: rfloat(50, 500, 2),
      status: 'closed',
      realized_pnl: rfloat(-15, 25, 2),
    }));
    const netPnl = rows.reduce((s, r) => s + r.realized_pnl, 0);
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: `Summarize ${asset}: current price and last 24h hedge performance.` },
        { role: 'assistant', content: toolCall('get_asset_price', { asset }) },
        { role: 'tool', content: toolResponse(price) },
        { role: 'assistant', content: toolCall('query_hedge_history', { asset, hours: 24 }) },
        { role: 'tool', content: toolResponse(rows) },
        {
          role: 'assistant',
          content: `${asset} at $${price.price} (${price.confidence}). Last 24h: ${nHedges} hedges, net ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}.`,
        },
      ],
    });
  }

  // Compare two assets
  for (let i = 0; i < 10; i++) {
    const [a, b] = [rand(ASSETS), rand(ASSETS.filter(x => x !== ASSETS[0]))];
    const pa = pricePayload(a);
    const pb = pricePayload(b);
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: `Compare current ${a} and ${b} spot prices.` },
        { role: 'assistant', content: toolCall('get_asset_price', { asset: a }) },
        { role: 'tool', content: toolResponse(pa) },
        { role: 'assistant', content: toolCall('get_asset_price', { asset: b }) },
        { role: 'tool', content: toolResponse(pb) },
        {
          role: 'assistant',
          content: `${a}: $${pa.price} / ${b}: $${pb.price}. Ratio ${(pa.price / pb.price).toFixed(4)}.`,
        },
      ],
    });
  }

  // Risk assessment: hedges + postmortem
  for (let i = 0; i < 10; i++) {
    const nHedges = rint(3, 12);
    const rows = Array.from({ length: nHedges }, () => ({
      asset: rand(ASSETS),
      side: rand(['LONG', 'SHORT']),
      notional_value: rfloat(50, 500, 2),
      status: 'closed',
      realized_pnl: rfloat(-30, 40, 2),
    }));
    const netPnl = rows.reduce((s, r) => s + r.realized_pnl, 0);
    const winRate = rows.filter(r => r.realized_pnl > 0).length / rows.length;
    const days = 14;
    const pmStats = { total: 80, resolved: 60, correct: 34, wrong: 26, accuracy: 0.567 };
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: 'Should we tighten risk gates today? Ground your answer in real data.' },
        { role: 'assistant', content: toolCall('query_hedge_history', { hours: 168, status: 'closed' }) },
        { role: 'tool', content: toolResponse(rows) },
        { role: 'assistant', content: toolCall('query_postmortem_stats', { days }) },
        { role: 'tool', content: toolResponse(pmStats) },
        {
          role: 'assistant',
          content: `Yes — 7d hedges: ${nHedges} closed, ${(winRate * 100).toFixed(0)}% win rate, net ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(2)}. 14d signal accuracy ${(pmStats.accuracy * 100).toFixed(0)}%. Recommend halving stake until win rate returns above 55%.`,
        },
      ],
    });
  }

  return out;
}

// ── Category 3: Tool error handling (20) ────────────────────────────────

function makeToolErrors(): Example[] {
  const out: Example[] = [];

  for (let i = 0; i < 10; i++) {
    const asset = rand(ASSETS);
    const err = rand([
      'ECONNREFUSED: unified-price-provider unreachable',
      'timeout after 5000ms',
      `no valid source for ${asset}`,
      'rate limited by upstream provider',
    ]);
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: `What's the current ${asset} price?` },
        { role: 'assistant', content: toolCall('get_asset_price', { asset }) },
        { role: 'tool', content: toolError(err) },
        {
          role: 'assistant',
          content: `I couldn't fetch the ${asset} price — ${err}. I can retry or you can check a venue directly.`,
        },
      ],
    });
  }

  for (let i = 0; i < 5; i++) {
    const err = 'relation "signal_interpretations" does not exist';
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: 'How accurate has the AI been over the past 30 days?' },
        { role: 'assistant', content: toolCall('query_postmortem_stats', { days: 30 }) },
        { role: 'tool', content: toolError(err) },
        {
          role: 'assistant',
          content: `Postmortem stats are unavailable — the signal_interpretations table doesn't exist yet in this environment. Once the migration lands and interpretations start being recorded, I'll be able to answer this.`,
        },
      ],
    });
  }

  for (let i = 0; i < 5; i++) {
    const key = 'cron:doesnotexist:foo';
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: `Read cron_state key "${key}".` },
        { role: 'assistant', content: toolCall('get_cron_state', { key }) },
        { role: 'tool', content: toolResponse({ key, value: null, exists: false }) },
        {
          role: 'assistant',
          content: `The key \`${key}\` has never been written. This isn't an error — the state simply doesn't exist.`,
        },
      ],
    });
  }

  return out;
}

// ── Category 4: No tool needed (15) ─────────────────────────────────────

function makeNoTool(): Example[] {
  const out: Example[] = [];
  const items: Array<[string, string]> = [
    ['What is 12 + 30?', '42.'],
    ['What is a hedge in trading?', 'A hedge is a position taken to offset risk from another position — usually a short perp against a long spot holding, sized so the combined P&L is insensitive to price direction.'],
    ['Explain leverage.', 'Leverage lets you control a larger notional position with a smaller collateral amount. 5× leverage on $100 collateral controls $500 notional; both gains and losses are 5× the underlying move.'],
    ['What does BINARY_YES mean in our schema?', 'BINARY_YES is the direction label for prediction-market questions whose YES resolution isn\'t a directional asset call — e.g. "will X launch by Y date". Contrast with UP/DOWN which are directional price calls.'],
    ['What is a 5-min signal window?', 'A 5-min signal window is a short-horizon prediction where the resolution happens ~5 minutes after the signal is observed. Used by our Polymarket 5-min BTC binaries.'],
    ['What is realized_pnl vs current_pnl?', 'realized_pnl is settled by the venue on close. current_pnl mirrors realized_pnl on closed rows (invariant since f46b5289) and reflects the live mark-to-market for active hedges.'],
    ['Define funding rate.', 'Funding rate is a periodic payment between longs and shorts on perpetual futures — usually every 8h — that keeps the perp price anchored to spot. Positive funding means longs pay shorts.'],
    ['Summarize this text: "The market fell 3% overnight then recovered by 1% in Asian trading."', 'Market dropped 3% overnight, partially recovered +1% in Asian hours; net -2%.'],
    ['What does slippage mean?', 'Slippage is the price difference between when you submit an order and when it fills. Higher volatility or thin liquidity means more slippage.'],
    ['What is a step size on Bluefin?', 'Step size is the minimum quantity increment for a symbol — BTC=0.001, ETH=0.01, SUI=1. Orders not snapped to step size get silently rejected.'],
    ['What does SUI\'s TVL cap mean?', 'TVL cap is the maximum total value locked the pool contract will accept. Currently $10K on our SUI USDC pool. Deposits above the cap revert on-chain.'],
    ['Explain the Layer 1 vs Layer 3 separation.', 'Layer 1 is the fine-tuned Signal Interpreter — a narrow specialist that maps prediction-market titles to structured JSON. Layer 3 is the reasoning agents (Risk, Hedging, Reporting) that use tools to query live state. Layer 1 doesn\'t call tools; Layer 3 does.'],
    ['What is phantom rate?', 'Phantom rate is the fraction of closed hedges with $0 realized PnL — usually a sign that trades opened but never actually filled on the venue. Anything above 1% is a warning; above 5% halts the trader.'],
    ['What is greedy decoding?', 'Greedy decoding picks the highest-probability next token at each step, without sampling. Produces deterministic output — same input yields same output every time.'],
    ['What is regret weighting?', 'Regret weighting scales stake size by past decision quality. High-confidence losses shrink the multiplier; high-confidence wins grow it. Recovers automatically when accuracy returns.'],
  ];
  for (const [q, a] of items) {
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: q },
        { role: 'assistant', content: a },
      ],
    });
  }
  return out;
}

// ── Category 5: Signal-interp preserved with tool context (5) ───────────

function makeSignalWithContext(): Example[] {
  const out: Example[] = [];
  const items: Array<[string, string, string, Record<string, unknown>, string]> = [
    ['Will Bitcoin be above $80,000 on September 30?', 'BTC', 'price-target', { asset: 'BTC', price: 68234, confidence: 'high', sources: 3 },
     '{"asset":"BTC","direction":"UP","threshold":80000,"horizon":"daily","horizon_end":"2023-09-30T00:00:00Z","confidence":0.85,"reasoning":"Price-target above current spot by ~17%.","meta":{"novelty":0.15,"improvement_ask":"","generalization_note":""}}'],
    ['Will ETH drop below $2500 this week?', 'ETH', 'price-target', { asset: 'ETH', price: 3120, confidence: 'high', sources: 4 },
     '{"asset":"ETH","direction":"DOWN","threshold":2500,"horizon":"weekly","horizon_end":null,"confidence":0.8,"reasoning":"Below-threshold weekly question.","meta":{"novelty":0.1,"improvement_ask":"","generalization_note":""}}'],
    ['Will SOL reach $250 by end of year?', 'SOL', 'price-target', { asset: 'SOL', price: 178, confidence: 'high', sources: 3 },
     '{"asset":"SOL","direction":"UP","threshold":250,"horizon":"longer","horizon_end":null,"confidence":0.75,"reasoning":"End-of-year price target above current spot.","meta":{"novelty":0.1,"improvement_ask":"","generalization_note":""}}'],
    ['Will DOGE break $0.15 today?', 'DOGE', 'price-target', { asset: 'DOGE', price: 0.11, confidence: 'medium', sources: 2 },
     '{"asset":"DOGE","direction":"UP","threshold":0.15,"horizon":"daily","horizon_end":null,"confidence":0.7,"reasoning":"Daily upside break above current spot.","meta":{"novelty":0.15,"improvement_ask":"","generalization_note":""}}'],
    ['Will XRP close below $1.50 this weekend?', 'XRP', 'price-target', { asset: 'XRP', price: 1.85, confidence: 'high', sources: 3 },
     '{"asset":"XRP","direction":"DOWN","threshold":1.5,"horizon":"weekly","horizon_end":null,"confidence":0.7,"reasoning":"Weekend downside break below current spot.","meta":{"novelty":0.15,"improvement_ask":"","generalization_note":""}}'],
  ];
  for (const [title, asset, cat, price, json] of items) {
    out.push({
      messages: [
        ...base(),
        { role: 'user', content: `Interpret this prediction market:\nTitle: ${title}\nCategory: ${cat}\n\nBefore deciding, check current spot to gauge distance to threshold.` },
        { role: 'assistant', content: toolCall('get_asset_price', { asset }) },
        { role: 'tool', content: toolResponse(price) },
        { role: 'assistant', content: json },
      ],
    });
  }
  return out;
}

function main() {
  const all: Example[] = [
    ...makeSingleTool(),
    ...makeMultiTool(),
    ...makeToolErrors(),
    ...makeNoTool(),
    ...makeSignalWithContext(),
  ];

  // Shuffle so categories interleave (deterministic seed via slug hash would
  // be nicer, but this is one-shot data generation).
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }

  fs.mkdirSync('data/signal-interpreter', { recursive: true });
  fs.writeFileSync(OUT, all.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  console.log(`Wrote ${all.length} tool-use examples → ${OUT}`);
  const counts = { single: makeSingleTool.length, multi: 30, errors: 20, noTool: 15, signalCtx: 5 };
  console.log('  breakdown:', {
    single: all.filter(e => e.messages.length === 5 && e.messages.some(m => m.role === 'tool')).length,
    multi: all.filter(e => e.messages.length > 5).length,
    noTool: all.filter(e => e.messages.length === 3).length,
  });
}

main();
