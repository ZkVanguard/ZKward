/**
 * A prediction market's QUESTION is not its forecast.
 *
 * "Will BTC be above $88k?" is worded UP, yet at 3% YES the market expects
 * BTC to stay BELOW $88k. "Will BTC dip to $82.5k?" at 10% YES says nothing
 * about direction while spot sits above the strike — the likely outcome is
 * already true. Reading the wording (or "YES is likely") as a price
 * direction turned ladders of such markets into confident, meaningless
 * votes. The forecast is the YES price read against spot: a market carries
 * a direction only when its likely outcome requires price to CROSS the
 * strike from where it trades now.
 */

export type ImpliedSide = 'LONG' | 'SHORT';
export type ImpliedDirection = 'UP' | 'DOWN';

/** Probability the likely outcome must reach before the market counts as a forecast. */
export const DEFAULT_MIN_CONVICTION = 0.6;
/** Up/Down binaries: |YES − 0.5| below this is a coin flip. */
const UPDOWN_DEADBAND = 0.03;
/** Strikes outside [spot/4, spot×4] are mis-parses (years, supplies) or foregone questions. */
const MAX_STRIKE_RATIO = 4;

/**
 * Side implied by a threshold market's odds. `condition` is what YES asserts
 * about price at resolution: 'UP' = above the strike, 'DOWN' = below it.
 * A side is returned only when the likely outcome (probability ≥
 * minConviction) requires price to cross the strike from spot.
 */
export function marketImpliedSide(
  condition: string | null,
  yesPrice: number | null,
  spot: number,
  threshold: number | null,
  minConviction: number = DEFAULT_MIN_CONVICTION,
): ImpliedSide | null {
  if (condition !== 'UP' && condition !== 'DOWN') return null;
  if (yesPrice === null || !(yesPrice > 0 && yesPrice < 1)) return null;
  if (!(spot > 0) || threshold === null || !(threshold > 0)) return null;
  const likelyYes = yesPrice >= minConviction;
  const likelyNo = 1 - yesPrice >= minConviction;
  if (!likelyYes && !likelyNo) return null;
  const expectAbove = condition === 'UP' ? likelyYes : likelyNo;
  if (expectAbove && spot < threshold) return 'LONG';
  if (!expectAbove && spot > threshold) return 'SHORT';
  return null;
}

export type ParsedQuestion =
  | { kind: 'updown' }
  | { kind: 'threshold'; wording: ImpliedDirection; touch: boolean; strike: number };

// Touch verbs resolve YES the moment price trades at the strike, so which
// way they point depends on where the strike sits relative to spot
// ("reach $75k" from $84k is a move DOWN). Comparison words resolve on the
// price at expiry and point the way they read. A number only counts as a
// price with a marker ($, k/m/b, USD, or a thousands separator) so "top 10"
// or "over 1 billion users" never parse as strikes.
const QUESTION_RE = new RegExp(
  String.raw`\b(?:` +
    String.raw`(?<touchUp>reach(?:es)?|hits?|touch(?:es)?|(?:rise|rises|climb|climbs|jump|jumps)\s+(?:to|above|past)|surpass(?:es)?|exceeds?|breaks?(?:\s+above)?|cross(?:es)?(?:\s+above)?)` +
    String.raw`|(?<touchDown>(?:dip|dips|drop|drops|fall|falls|sink|sinks|crash|crashes|plunge|plunges|decline|declines)(?:\s+(?:to|below|under))?)` +
    String.raw`|(?<termUp>above|over|higher\s+than|greater\s+than)` +
    String.raw`|(?<termDown>below|under|lower\s+than|less\s+than)` +
  String.raw`)\s+(?<dollar>\$)?\s?(?<num>\d[\d,]*(?:\.\d+)?)(?!\d|\s?%)(?:\s?(?<unit>[kmb])\b)?(?<usd>\s?usd\b)?`,
  'gi',
);

function toNumber(num: string, unit: string | undefined): number {
  const base = Number(num.replace(/,/g, ''));
  const mult = unit?.toLowerCase() === 'k' ? 1e3 : unit?.toLowerCase() === 'm' ? 1e6 : unit?.toLowerCase() === 'b' ? 1e9 : 1;
  return base * mult;
}

/**
 * Classify a market question. Returns null for ranges, events, and anything
 * whose threshold clauses disagree ("hit $100k or dip to $70k first").
 */
export function parseMarketQuestion(question: string): ParsedQuestion | null {
  if (/\bup or down\b/i.test(question)) return { kind: 'updown' };
  if (/\bbetween\b/i.test(question)) return null;
  const hits = [...question.matchAll(QUESTION_RE)]
    .map((m) => m.groups ?? {})
    .filter((g) => g.dollar || g.unit || g.usd || /,\d{3}/.test(g.num))
    .map((g) => ({
      wording: (g.touchUp || g.termUp ? 'UP' : 'DOWN') as ImpliedDirection,
      touch: Boolean(g.touchUp || g.touchDown),
      strike: toNumber(g.num, g.unit),
    }));
  if (hits.length === 0) return null;
  const first = hits[0];
  if (hits.some((h) => h.wording !== first.wording || h.touch !== first.touch)) return null;
  if (!(first.strike > 0)) return null;
  return { kind: 'threshold', ...first };
}

/**
 * UP/DOWN implied by a market's question and YES price (0-1) read against
 * spot; null when the market makes no directional forecast.
 */
export function marketImpliedDirection(
  question: string,
  yesPrice: number | null,
  spot: number | null | undefined,
  minConviction: number = DEFAULT_MIN_CONVICTION,
): ImpliedDirection | null {
  const q = parseMarketQuestion(question);
  if (!q || yesPrice === null || !(yesPrice > 0 && yesPrice < 1)) return null;
  if (q.kind === 'updown') {
    if (yesPrice >= 0.5 + UPDOWN_DEADBAND) return 'UP';
    if (yesPrice <= 0.5 - UPDOWN_DEADBAND) return 'DOWN';
    return null;
  }
  if (!spot || !(spot > 0)) return null;
  const ratio = q.strike / spot;
  if (ratio < 1 / MAX_STRIKE_RATIO || ratio > MAX_STRIKE_RATIO) return null;
  const condition: ImpliedDirection = q.touch ? (q.strike > spot ? 'UP' : 'DOWN') : q.wording;
  const side = marketImpliedSide(condition, yesPrice, spot, q.strike, minConviction);
  return side === 'LONG' ? 'UP' : side === 'SHORT' ? 'DOWN' : null;
}
