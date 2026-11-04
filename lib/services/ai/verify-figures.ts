/**
 * Checks every money figure in a model's answer against the data the model
 * was handed: tool results, the pre-fetched live context and the question.
 *
 * A dollar amount, a bp figure or a percentage must equal, at the answer's
 * own rounding, a value of the same unit in that data, or a total, gap or
 * change computed from dollar values of one record. Units come from field
 * names (`openPnlUsd`, `avgBp`, `change24h`); a value whose unit cannot be
 * read from its field is a count and never matches; a bare number in prose
 * matches only at the exact rounding shown.
 *
 * Bare numbers (counts, dates, years) are not checked: they carry no money.
 */

export type FigureUnit = 'usd' | 'bp' | 'pct';

export interface Figure {
  text: string;
  value: number;
  unit: FigureUnit;
  /** Where the value came from, e.g. "get_paper_books › FloorTrader › open › openPnlUsd". */
  source?: string;
}

export interface FigureCheck {
  verified: Figure[];
  unverified: Figure[];
}

export interface FactSource {
  label: string;
  data: unknown;
}

interface Fact {
  value: number;
  unit: FigureUnit | 'any' | 'count';
  source: string;
  derived?: boolean;
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)`;

const parseNum = (raw: string) => Number(raw.replace(/,/g, ''));

/** Half a unit of the last digit shown, so "$1.9k" matches 1,871 and "$481" matches 480.79. */
function shownPrecision(raw: string, mult: number): number {
  const dot = raw.indexOf('.');
  return (10 ** -(dot < 0 ? 0 : raw.length - dot - 1) * mult) / 2;
}

export function extractFigures(text: string): Array<Figure & { tolerance: number }> {
  const out: Array<Figure & { tolerance: number }> = [];
  for (const m of text.matchAll(new RegExp(String.raw`\$\s?-?${NUM}\s?([kKmMbB](?![a-zA-Z]))?`, 'g'))) {
    const mult = m[2] ? SUFFIX[m[2].toLowerCase()] : 1;
    out.push({ text: m[0].trim(), value: parseNum(m[1]) * mult, unit: 'usd', tolerance: shownPrecision(m[1], mult) });
  }
  for (const m of text.matchAll(new RegExp(String.raw`${NUM}\s?bps?\b`, 'gi'))) {
    out.push({ text: m[0].trim(), value: parseNum(m[1]), unit: 'bp', tolerance: shownPrecision(m[1], 1) });
  }
  for (const m of text.matchAll(new RegExp(String.raw`${NUM}\s?%`, 'g'))) {
    out.push({ text: m[0].trim(), value: parseNum(m[1]), unit: 'pct', tolerance: shownPrecision(m[1], 1) });
  }
  return out;
}

/** A field whose name gives no unit is a count, and a count never stands in for money. */
function unitOfKey(key: string): FigureUnit | 'count' {
  if (/bps?$|Bp$/.test(key)) return 'bp';
  if (/pct|percent|change|rate|confidence|probability|odds|share$|ratio/i.test(key)) return 'pct';
  if (/usd|nav|pnl|notional|price|value|balance|tvl|cost|basis|paid|volume|cap|high|low|amount|fee|spot|mark|last|strike|entry|exit|target|floor|peak|equity|open$|close$/i.test(key)) return 'usd';
  return 'count';
}

/** A record's display name, so a source reads "FloorTrader" rather than "[5]". */
function nameOf(v: unknown, fallback: string): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const k of ['name', 'pool', 'symbol', 'asset', 'tool']) if (typeof o[k] === 'string') return o[k] as string;
  }
  return fallback;
}

interface Leaf {
  value: number;
  unit: Fact['unit'];
  path: string[];
}

/** The words around a number in prose, so a reader can judge a match that is only textual. */
function around(text: string, at: number, len: number): string {
  const s = Math.max(0, at - 40);
  return `“${s > 0 ? '…' : ''}${text.slice(s, at + len + 40).replace(/\s+/g, ' ').trim()}…”`;
}

function textLeaves(text: string, path: string[], out: Leaf[]): void {
  for (const f of extractFigures(text)) {
    out.push({ value: f.value, unit: f.unit, path: [...path, around(text, text.indexOf(f.text), f.text.length)] });
  }
  for (const m of text.matchAll(new RegExp(NUM, 'g'))) {
    out.push({ value: parseNum(m[1]), unit: 'any', path: [...path, around(text, m.index ?? 0, m[0].length)] });
  }
}

function leaves(v: unknown, path: string[], out: Leaf[]): void {
  const key = path.at(-1) ?? '';
  if (typeof v === 'number' && Number.isFinite(v)) out.push({ value: v, unit: unitOfKey(key), path });
  else if (typeof v === 'string') {
    if (v.trim() !== '' && Number.isFinite(Number(v))) out.push({ value: Number(v), unit: unitOfKey(key), path });
    else textLeaves(v, path, out);
  } else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, [...path, nameOf(x, `[${i}]`)], out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) leaves(x, [...path, k], out);
}

/** Every value a figure may honestly come from, each with where it came from. */
export function collectFacts(sources: FactSource[]): Fact[] {
  const facts: Fact[] = [];
  for (const { label, data } of sources) {
    const records = Array.isArray(data) ? data : [data];
    const all: Leaf[] = [];
    records.forEach((rec, i) => {
      const own: Leaf[] = [];
      if (typeof rec === 'string') textLeaves(rec, [label], own);
      else leaves(rec, Array.isArray(data) ? [label, nameOf(rec, `[${i}]`)] : [label], own);
      all.push(...own);
      // What a model derives from one record's dollar values: a total, a gap, a change.
      const usd = own.filter((l) => l.unit === 'usd');
      for (const [a, x] of usd.entries()) {
        for (const [b, y] of usd.entries()) {
          if (a === b) continue;
          const pair = `${x.path.join(' › ')} and ${y.path.at(-1)}`;
          if (a < b) facts.push({ value: x.value + y.value, unit: 'usd', source: `sum of ${pair}`, derived: true });
          facts.push({ value: x.value - y.value, unit: 'usd', source: `gap between ${pair}`, derived: true });
          if (y.value !== 0) {
            facts.push({ value: ((x.value - y.value) / y.value) * 100, unit: 'pct', source: `change from ${pair}`, derived: true });
            facts.push({ value: (x.value / y.value) * 100, unit: 'pct', source: `ratio of ${pair}`, derived: true });
          }
        }
      }
    });
    for (const l of all) {
      facts.push({ value: l.value, unit: l.unit, source: l.path.join(' › ') });
      // Fractions shown as percentages: confidence 0.73 is "73%".
      if (l.unit === 'pct' && Math.abs(l.value) <= 1) facts.push({ value: l.value * 100, unit: 'pct', source: l.path.join(' › ') });
    }
    // Totals across records: the same dollar field summed over every book or pool.
    if (Array.isArray(data) && data.length > 1) {
      const byField = new Map<string, number>();
      for (const l of all) {
        const field = l.path.slice(2).join(' › ');
        if (field && l.unit === 'usd') byField.set(field, (byField.get(field) ?? 0) + l.value);
      }
      for (const [field, sum] of byField) facts.push({ value: sum, unit: 'usd', source: `${label} › total of ${field}`, derived: true });
    }
  }
  return facts;
}

export function verifyFigures(answer: string, sources: FactSource[]): FigureCheck {
  const facts = collectFacts(sources);
  const verified: Figure[] = [];
  const unverified: Figure[] = [];
  for (const { tolerance, ...fig } of extractFigures(answer)) {
    // Signs are words in an answer ("lost $202", "down 67%"), so compare sizes.
    const gap = (f: Fact) => Math.abs(Math.abs(f.value) - fig.value);
    const near = (f: Fact) => {
      if (f.unit !== fig.unit && f.unit !== 'any') return false;
      const slack = f.unit === 'any' ? 0 : fig.value * 0.005;
      return gap(f) <= Math.max(tolerance, slack) + 1e-9;
    };
    // A field of the same unit beats a bare number in prose (a date's "19" is not "19bp"), a stored
    // value beats a derived one, and within a tier the closest wins ("$0" is a zero, not a 0.27 price).
    const closest = (fs: Fact[]) => fs.reduce<Fact | undefined>((best, f) => (!best || gap(f) < gap(best) ? f : best), undefined);
    const hits = facts.filter(near);
    const hit = closest(hits.filter((f) => !f.derived && f.unit !== 'any'))
      ?? closest(hits.filter((f) => !f.derived))
      ?? closest(hits);
    if (hit) verified.push({ ...fig, source: hit.source });
    else unverified.push(fig);
  }
  return { verified, unverified };
}
