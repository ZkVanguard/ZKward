/**
 * Regex-only message analyzer for the AI chat. Fast, deterministic,
 * no LLM call. Extracts entities + intent + complexity from a user
 * message so the route can pre-fetch relevant context and shape the
 * LLM prompt dynamically.
 *
 * Design: bias toward FALSE-POSITIVES over FALSE-NEGATIVES. Better to
 * pre-fetch data the LLM doesn't need than miss data it does. Extra
 * context costs ~200 tokens; missed context costs a shallow answer.
 */

export type ChatIntent =
  | 'lookup'         // "how is BTC" / "what's XRP at"
  | 'compare'        // "BTC vs ETH" / "which is stronger"
  | 'diagnose'       // "why did we lose" / "what went wrong"
  | 'diagnose_move'  // "why is BTC pumping" / "what's driving DOGE"
  | 'advise'         // "should I buy" / "is now a good time"
  | 'explain'        // "what is a perp" / "how does funding work"
  | 'market_wide'    // "top movers" / "market state" / "market update"
  | 'vault_state'    // "how is our vault" / "our positions" / "our pnl"
  | 'sentiment'      // "fear and greed" / "market sentiment" / "sentiment"
  | 'defi'           // "TVL" / "aave" / "uniswap" / "curve" / "defi"
  | 'news'           // "what news" / "trending" / "hot right now"
  | 'historical'     // "BTC last week" / "ETH from ATH" / "SOL 30-day"
  | 'onchain'        // "gas fees" / "L2 TVL" / "which chain"
  | 'options'        // "IV" / "put call ratio" / "options market"
  | 'other';

export type DeterministicRoute =
  | 'market-overview'  // "how are things", "what's up", "market update"
  | 'self-meta'        // "what tools do you have", "how do you work", "what can you do"
  | 'self-criticism'   // "your ai sucks", "your answers are bad"
  | null;

export interface MessageAnalysis {
  /** Uppercase asset tickers detected in the message. Deduped. */
  assets: string[];
  /** Whether any detected asset is one of the vault's tracked assets. */
  hasTrackedAsset: boolean;
  /** Whether any detected asset is a broader crypto (not tracked). */
  hasBroaderAsset: boolean;
  /** Best-guess intent from the language shape. */
  intent: ChatIntent;
  /** Time window hint in hours if the user referenced one, else null. */
  timeframeHours: number | null;
  /** Detected protocol name(s) (uniswap/aave/curve/etc). Lowercase. */
  protocols: string[];
  /** Complexity → drives maxIterations + tool subset. */
  complexity: 'simple' | 'medium' | 'complex';
  /** Suggested `maxIterations` for the LLM tool loop. */
  suggestedMaxIterations: number;
  /** The subset of tool names most relevant. Empty = expose all. */
  suggestedTools: string[];
  /** If non-null, skip LLM entirely — server responds deterministically. */
  deterministicRoute: DeterministicRoute;
  /** True when the message is vague enough that we should inject the
   *  baseline market pulse as fallback context so the LLM never has
   *  zero grounding. False when specific pre-fetch has coverage. */
  needsBaselinePulse: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────

const TRACKED = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'CRO', 'SUI', 'ATOM']);

// Common non-tracked crypto tickers we should recognize. Keep short — this
// isn't an exhaustive registry, just a hit-list so the broader-market tool
// gets pre-fetched on obvious mentions.
const BROADER = new Set([
  'ADA', 'LINK', 'AVAX', 'MATIC', 'DOT', 'BNB', 'TON', 'TRX', 'LTC', 'BCH',
  'UNI', 'AAVE', 'CRV', 'MKR', 'COMP', 'SNX', 'YFI', 'GRT', 'FIL', 'NEAR',
  'ARB', 'OP', 'APT', 'INJ', 'RUNE', 'RNDR', 'FTM', 'ALGO', 'ICP', 'HBAR',
  'VET', 'EGLD', 'SAND', 'MANA', 'AXS', 'PEPE', 'SHIB', 'WIF', 'FLOKI',
  'ONDO', 'JUP', 'JTO', 'PYTH', 'W', 'TIA',
]);

// Full-word aliases → ticker
const ALIASES: Record<string, string> = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP',
  dogecoin: 'DOGE', cardano: 'ADA', chainlink: 'LINK', avalanche: 'AVAX',
  polkadot: 'DOT', polygon: 'MATIC', binance: 'BNB', litecoin: 'LTC',
  toncoin: 'TON', tron: 'TRX', arbitrum: 'ARB', optimism: 'OP',
  cosmos: 'ATOM', filecoin: 'FIL', 'near protocol': 'NEAR',
  aptos: 'APT', injective: 'INJ', thorchain: 'RUNE',
};

// DeFi protocols recognized by DefiLlama slugs (partial list; DefiLlama
// itself handles thousands, this is just for smart pre-fetch triggering).
const PROTOCOLS = new Set([
  'uniswap', 'aave', 'curve', 'compound', 'makerdao', 'lido', 'rocket-pool',
  'gmx', 'dydx', 'pendle', 'ethena', 'eigenlayer', 'maverick', 'radiant',
  'jupiter', 'raydium', 'marinade', 'kamino', 'jito', 'drift',
  'suilend', 'navi', 'cetus', 'scallop', 'suistake',
]);

// Intent keyword clusters — regex-hit order matters, earlier wins.
// More specific patterns MUST come first to avoid stealing broader ones.
const INTENT_PATTERNS: Array<{ intent: ChatIntent; re: RegExp }> = [
  // Options — very specific, must come before generic 'market'
  // "implied vol" / "implied volatility" — vol\w* so "volatility" also matches
  // (previously \bvol\b required a word boundary after "vol" which "volatility"
  // does not have, so "ETH implied volatility" wrongly fell through to lookup).
  { intent: 'options', re: /\b(options?\s+market|put\/?call|put[- ]?call\s+ratio|implied\s+vol\w*|iv\b|max\s+pain|open\s+interest|strikes?|expir(y|ies))\b/i },
  // On-chain / gas — specific
  { intent: 'onchain', re: /\b(gas\s+(fee|price|now)|gwei|eth\s+gas|l2\s+(tvl|growth)|which\s+chain|chain\s+(tvl|growth|ranking))\b/i },
  // Historical — specific. Accept 'last 30 days' (plural), 'past 7d',
  // 'over the last month', etc. Previously missed 'days' (with 's').
  { intent: 'historical', re: /\b(last\s+(week|month|\d+\s*days?|\d+\s*d\b)|past\s+(\d+\s*days?|week|month)|over\s+the\s+(last|past)\s+\w+|from\s+ath|all[- ]time\s+high|\bath\b|historical|chart|range\s+over)\b/i },
  // News — specific
  { intent: 'news', re: /\b(news|trending|hot\s+right\s+now|what.s\s+trending|any\s+news|breaking\s+news|new\s+(coin|launch|listing))\b/i },
  // Diagnose asset move — specific, must come before generic 'diagnose'
  { intent: 'diagnose_move', re: /\b(why\s+is\s+\w+\s+(pumping|dumping|up|down|rising|falling|moving|mooning|crashing|rallying)|what.s\s+(moving|driving|pushing)\s+\w+|catalyst\s+for)\b/i },
  { intent: 'advise', re: /\b(should\s+(i|we)|worth\s+(buying|selling)|good\s+(time|move)|time\s+to\s+(buy|sell|enter|exit))\b/i },
  { intent: 'diagnose', re: /\b(why\s+(did|is|are|has|does)|what\s+went\s+wrong|what\s+happened|explain\s+the\s+(loss|drop|dip|crash|move))\b/i },
  { intent: 'compare', re: /\b(compare|vs\.?|versus|better|stronger|weaker|between\s+\w+\s+and)\b/i },
  { intent: 'defi', re: /\b(tvl|total\s+value\s+locked|defi|protocol|yield|apy|apr)\b/i },
  { intent: 'sentiment', re: /\b(fear|greed|sentiment|f&g|fng|feeling|mood)\b/i },
  { intent: 'vault_state', re: /\b(our\s+(vault|position|hedge|pnl|treasury|trader)|zkward|the\s+vault)\b/i },
  { intent: 'market_wide', re: /\b(top\s+(mover|gainer|loser)|market\s+(update|state|today|now)|what.s\s+hot|movers)\b/i },
  { intent: 'lookup', re: /\b(how\s+is|what.s|whats|price\s+of|update\s+on)\b/i },
  { intent: 'explain', re: /\b(what\s+is|what.s\s+a|explain|how\s+does|how\s+do|meaning\s+of)\b/i },
];

// Timeframe patterns → hours
const TIMEFRAME_PATTERNS: Array<{ re: RegExp; hours: number }> = [
  { re: /\b(?:last|past|in the)\s*(\d+)\s*hour/i, hours: 0 }, // filled dynamically
  { re: /\bhour(?:ly)?\b/i, hours: 1 },
  { re: /\b(?:last|past)\s+24\s*h(?:ours)?\b/i, hours: 24 },
  { re: /\b(?:today|24h|last\s+day|past\s+day)\b/i, hours: 24 },
  { re: /\byesterday\b/i, hours: 48 },
  { re: /\b(?:this|past|last)\s+week\b/i, hours: 24 * 7 },
  { re: /\b(?:this|past|last)\s+month\b/i, hours: 24 * 30 },
  { re: /\b30\s*day/i, hours: 24 * 30 },
];

// ─── Analyzer ─────────────────────────────────────────────────────────

export function analyzeMessage(text: string): MessageAnalysis {
  const raw = text.trim();
  const lower = raw.toLowerCase();

  // Extract assets: full-word aliases first (so "bitcoin" doesn't miss BTC),
  // then bare tickers.
  const foundAssets = new Set<string>();

  for (const [alias, ticker] of Object.entries(ALIASES)) {
    if (lower.includes(alias)) foundAssets.add(ticker);
  }
  // Bare tickers — word-boundary, uppercase check to reduce false positives.
  // Skip common English words that happen to be 3-4 letters.
  const SKIP_WORDS = new Set(['THE', 'AND', 'FOR', 'YOU', 'ARE', 'CAN', 'OUR', 'HAS', 'HOW', 'WHY', 'WHO', 'ANY', 'ALL', 'NOT', 'BUT', 'DID', 'DOG', 'DO', 'IS', 'IT', 'ON', 'IN', 'AT', 'AS', 'OF', 'TO', 'A', 'I']);
  const tickerMatches = raw.match(/\b[A-Z]{2,5}\b/g) || [];
  for (const t of tickerMatches) {
    if (SKIP_WORDS.has(t)) continue;
    if (TRACKED.has(t) || BROADER.has(t)) foundAssets.add(t);
  }

  const assets = Array.from(foundAssets);
  const hasTrackedAsset = assets.some((a) => TRACKED.has(a));
  const hasBroaderAsset = assets.some((a) => BROADER.has(a) && !TRACKED.has(a));

  // Extract protocols
  const foundProtocols = new Set<string>();
  for (const p of PROTOCOLS) {
    if (lower.includes(p)) foundProtocols.add(p);
  }

  // Intent classification — first match wins
  let intent: ChatIntent = 'other';
  for (const p of INTENT_PATTERNS) {
    if (p.re.test(raw)) {
      intent = p.intent;
      break;
    }
  }
  // If no intent but assets present → treat as lookup
  if (intent === 'other' && assets.length > 0) intent = 'lookup';
  // If protocol present, override to defi
  if (foundProtocols.size > 0) intent = 'defi';

  // Timeframe extraction
  let timeframeHours: number | null = null;
  const numericHours = raw.match(/\b(?:last|past|in the)\s*(\d+)\s*hour/i);
  if (numericHours) {
    timeframeHours = Number(numericHours[1]);
  } else {
    for (const p of TIMEFRAME_PATTERNS) {
      if (p.hours > 0 && p.re.test(raw)) {
        timeframeHours = p.hours;
        break;
      }
    }
  }

  // Complexity heuristic: intent + entity count + question length
  let complexity: 'simple' | 'medium' | 'complex' = 'simple';
  const wordCount = raw.split(/\s+/).length;
  const isDiagnostic = intent === 'diagnose' || intent === 'advise' || intent === 'diagnose_move';
  const isMultiEntity = assets.length + foundProtocols.size >= 2;
  if (isDiagnostic || (isMultiEntity && wordCount > 8)) complexity = 'complex';
  else if (isMultiEntity || wordCount > 15 || intent === 'compare') complexity = 'medium';

  // Suggested iteration budget
  const suggestedMaxIterations = complexity === 'complex' ? 6 : complexity === 'medium' ? 4 : 2;

  // Suggested tool subset — narrow to what the intent needs.
  // Empty list means "expose all tools" (default fall-through in caller).
  const suggestedTools: string[] = [];
  switch (intent) {
    case 'lookup':
      suggestedTools.push('get_asset_context', 'get_broader_market');
      break;
    case 'compare':
      suggestedTools.push('get_asset_context', 'get_prediction_signal', 'get_market_snapshot');
      break;
    case 'diagnose':
      suggestedTools.push('query_hedge_history', 'get_asset_context', 'query_recent_interpretations', 'get_cron_state');
      break;
    case 'advise':
      suggestedTools.push('get_asset_context', 'get_prediction_signal', 'query_postmortem_stats');
      break;
    case 'explain':
      // Concept questions rarely need tools; leave empty so LLM leans on knowledge
      break;
    case 'market_wide':
      suggestedTools.push('get_broader_market', 'get_fear_greed_index', 'get_market_snapshot');
      break;
    case 'vault_state':
      suggestedTools.push('query_hedge_history', 'get_treasury_state', 'query_postmortem_stats', 'get_asset_context');
      break;
    case 'sentiment':
      suggestedTools.push('get_fear_greed_index', 'get_prediction_signal', 'get_broader_market');
      break;
    case 'defi':
      suggestedTools.push('get_defi_tvl', 'get_broader_market', 'get_asset_context');
      break;
    case 'news':
      suggestedTools.push('get_crypto_news', 'get_broader_market', 'get_fear_greed_index');
      break;
    case 'historical':
      suggestedTools.push('get_historical_summary', 'get_asset_context');
      break;
    case 'onchain':
      suggestedTools.push('get_onchain_snapshot', 'get_defi_tvl');
      break;
    case 'options':
      // Only get_options_data — asi1-mini otherwise falls back to
      // get_asset_context (which has no IV) and tells the user the tool
      // is unavailable. Narrowing forces the correct call.
      suggestedTools.push('get_options_data');
      break;
    case 'diagnose_move':
      // Multi-tool chain: context + news + funding for causal narrative
      suggestedTools.push('get_asset_context', 'get_crypto_news', 'get_historical_summary', 'get_fear_greed_index');
      break;
    default:
      // 'other' → expose all
      break;
  }

  // Deterministic route detection — ONLY for truly canonical questions
  // with a single correct answer. Market/critique questions were removed
  // 2026-09-21 after empirical comparison: LLM path with baseline pulse
  // (Layer 2) gives strictly better answers (real data + interpretation)
  // than a static table. Deterministic route now covers only:
  //   - self-meta: 'what tools do you have', 'help' — one canonical answer
  //
  // Market questions ('how are things', 'market update') → LLM + pulse
  // Self-criticism ('your AI sucks') → LLM + interpretation tools
  //   (Test #3 proved LLM engages with real data + gives useful critique)
  let deterministicRoute: DeterministicRoute = null;
  if (assets.length === 0 && foundProtocols.size === 0) {
    if (/\b(what|which)\s+(tools?|capabilities?|features?|can\s+you\s+do)\b/i.test(raw)
        || /\b(how\s+do\s+you\s+work|tell\s+me\s+about\s+yourself|what\s+are\s+you)\b/i.test(raw)
        || /\b(help|commands?)\b/i.test(raw) && wordCount <= 3) {
      deterministicRoute = 'self-meta';
    }
  }

  // Baseline pulse: inject top-5 asset snapshot + F&G into prompt when
  // no specific asset was detected AND no deterministic route fired.
  // This is the LLM-grounding layer — ensures the model never has zero
  // context and can add interpretation on top of guaranteed-real data.
  const needsBaselinePulse = assets.length === 0
    && foundProtocols.size === 0
    && deterministicRoute === null
    && !['sentiment', 'market_wide'].includes(intent); // those get their own pre-fetch

  return {
    assets,
    hasTrackedAsset,
    hasBroaderAsset,
    intent,
    timeframeHours,
    protocols: Array.from(foundProtocols),
    complexity,
    suggestedMaxIterations,
    suggestedTools,
    deterministicRoute,
    needsBaselinePulse,
  };
}
