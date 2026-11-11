/**
 * Stable keys for the aggregator's sources.
 *
 * Market titles rotate (a 5-minute market every 5 minutes) and some embed a
 * live price, so a source is keyed by what it is, not by its title. The
 * signal ledger scores each key and the feedback loop judges it; nothing in
 * this file learns or weights.
 */

/**
 * Reduce a source's display name + type to a stable key. Rolling markets
 * (a new 5-minute BTC market every 5 minutes) share one key, so the ledger
 * judges the source and not each market.
 */
export function normalizeSourceKey(name: string, type: string = ''): string {
  const lower = (name || '').toLowerCase();

  // "Polymarket 5-Min BTC (synthetic STRONG)" — check BEFORE generic 5-min
  // so the "(synthetic" tail isn't swallowed by the shorter pattern below.
  const p5mSynth = lower.match(/^polymarket 5-min ([a-z]+) \(synthetic/);
  if (p5mSynth) return `polymarket-5min-${p5mSynth[1].toUpperCase()}-synth`;

  // Polymarket 5-min binaries per asset (with optional -ticker variant)
  const p5m = lower.match(/^polymarket 5-min ([a-z]+)(\s*\(ticker\))?/);
  if (p5m) return `polymarket-5min-${p5m[1].toUpperCase()}${p5m[2] ? '-ticker' : ''}`;

  // Delphi ⚡ 5-Min signal per asset (title rotates every 5 min)
  const d5m = lower.match(/delphi.*5-min ([a-z]+) signal/);
  if (d5m) return `delphi-5min-${d5m[1].toUpperCase()}`;

  // Cross-asset alignment (its dominance text varies, key it stably)
  if (lower.includes('cross-asset alignment')) return 'cross-asset-alignment';

  // Funding-rate proxies (Bluefin funding + approximate variants)
  if (lower.includes('funding rate') || lower.includes('funding proxy')) {
    return 'funding-rate';
  }

  // Generic Delphi markets — key by first 40 chars of question slug
  if (lower.startsWith('delphi:')) {
    return `delphi:${slugify(lower.slice(7))}`;
  }

  // Manifold markets — same pattern
  if (lower.startsWith('manifold:')) {
    return `manifold:${slugify(lower.slice(9))}`;
  }

  // Fallback — coarse key by type + name-slug head
  return `${(type || 'other').toLowerCase()}:${slugify(lower)}`;
}

/**
 * Slug with volatile numeric tails stripped, so a market whose title embeds
 * a live price keeps one key instead of a new one on every price change.
 */
function slugify(raw: string): string {
  return raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/currently-[0-9]+(-[0-9]+)*/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
