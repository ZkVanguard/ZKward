/**
 * The feedback loop's judgment: what the signal ledger has shown, with the
 * error counted honestly, and which of it is firm enough to act on.
 *
 * Three rules, each from a failure measured on 2026-10-05:
 *
 *   1. Coins move together. Five coins' windows in the same hour are one
 *      observation, not five, so a source family pooled across coins takes
 *      its error across windows only. Counting them as five read two
 *      families as decided (one wrong-way, one proven) that were neither.
 *   2. Many cells, mostly noise. At two standard errors about one cell in
 *      twenty is "decided" by chance: with 49 cells the loop held three
 *      verdicts where chance alone gives two. A verdict must also survive a
 *      false-discovery check across its group.
 *   3. A verdict is in force only when it also holds without the last day
 *      of data, so a cell hovering at the bar does not flip an action daily.
 *      The check is made from the rows, not from stored state: a lost or
 *      unreadable state cannot change what is in force.
 *
 * Nothing here acts. The stored state is read by the shadow vote, the
 * health endpoint and the reports.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { getLedgerBucketRows, type LedgerBucketRow } from '@/lib/db/signal-outcomes';
import {
  LEDGER_EPOCH_MS,
  LEDGER_MIN_WINDOWS,
  LEDGER_TIMING_SE,
  LEDGER_WEIGHT_HORIZON_MIN,
  LEDGER_WINDOW_DAYS,
  type TimingVerdict,
} from './ledger-cells';

/** Share of the verdicts in a group that may be false, in expectation. */
export const LOOP_FALSE_DISCOVERY_RATE = (() => {
  const v = Number((process.env.SIGNAL_LOOP_FDR || '').trim());
  return Number.isFinite(v) && v > 0 && v < 1 ? v : 0.1;
})();
export const LOOP_STATE_KEY = 'feedback-loop:verdicts';
const DAY_MS = 24 * 60 * 60_000;

// ── Families ─────────────────────────────────────────────────────────

const FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/cross-asset/, 'cross-asset-alignment'],
  [/long-short/, 'long-short-ratio'],
  [/funding/, 'funding'],
  [/orderbook/, 'order-book-imbalance'],
  [/kalshi/, 'kalshi'],
  [/polymarket-5min.*synth/, 'polymarket-5min-synth'],
  [/polymarket-5min.*ticker/, 'polymarket-5min-ticker'],
  [/polymarket-5min/, 'polymarket-5min'],
  [/polymarket-(daily|hourly)/, 'polymarket-daily-hourly'],
  [/crypto-com/, 'momentum-24h'],
  [/options-skew/, 'options-skew'],
  [/^delphi/, 'delphi'],
  [/^manifold/, 'manifold'],
  // Model readings of single market questions: each question lives for hours, the family for good.
  [/(^|:)ai-/, 'ai-interpretation'],
];

/**
 * The family a ledger source is pooled in across coins. Most source keys
 * carry their coin ("short_term:kalshi-eth"), so the family is the only
 * level at which one source's coins can be read together. The combined
 * signals and the gates are their own families; so is an unknown source.
 */
export function sourceFamily(source: string): string {
  if (source === 'aggregate' || source.startsWith('aggregate:') || source.startsWith('gate:')) return source;
  const s = source.toLowerCase();
  for (const [pattern, family] of FAMILIES) if (pattern.test(s)) return family;
  return source;
}

export const cellKey = (source: string, asset: string): string => `${source}|${asset.toUpperCase()}`;

/**
 * Which verdicts are checked against each other for false discoveries.
 * Sources compete with sources; a combined signal's coins with each other.
 * A gate is one rule for every coin, so it is judged pooled only (null).
 */
function cellGroup(source: string): string | null {
  if (source.startsWith('gate:')) return null;
  if (source === 'aggregate' || source.startsWith('aggregate:')) return source;
  return 'source';
}
function familyGroup(family: string): string {
  if (family.startsWith('gate:')) return 'gate';
  if (family === 'aggregate' || family.startsWith('aggregate:')) return family;
  return 'source';
}

// ── Evidence ─────────────────────────────────────────────────────────

export interface Evidence {
  /** Mean drift-removed return in the source's direction, in bp, over the windows. */
  timingBp: number;
  /** Standard error of that mean across windows, in bp. */
  seBp: number;
  /** Independent (non-overlapping) windows behind it. */
  windows: number;
  /** Ledger rows behind it; for display only. */
  n: number;
}

function summarize(perWindow: readonly number[], n: number): Evidence {
  const w = perWindow.length;
  if (w === 0) return { timingBp: 0, seBp: Number.POSITIVE_INFINITY, windows: 0, n };
  const mean = perWindow.reduce((s, x) => s + x, 0) / w;
  if (w === 1) return { timingBp: mean, seBp: Number.POSITIVE_INFINITY, windows: 1, n };
  const variance = perWindow.reduce((s, x) => s + (x - mean) ** 2, 0) / (w - 1);
  return { timingBp: mean, seBp: Math.sqrt(variance / w), windows: w, n };
}

/** One source on one coin: a window is one horizon-length bucket of that coin. */
export function cellEvidence(rows: readonly LedgerBucketRow[], horizonMin: number): Map<string, Evidence> {
  const by = new Map<string, { perWindow: number[]; n: number }>();
  for (const r of rows) {
    if (r.horizonMin !== horizonMin) continue;
    const key = cellKey(r.source, r.asset);
    const e = by.get(key) ?? { perWindow: [], n: 0 };
    e.perWindow.push(r.timingBp);
    e.n += r.n;
    by.set(key, e);
  }
  return new Map([...by].map(([key, e]) => [key, summarize(e.perWindow, e.n)]));
}

/**
 * One family across every coin. The coins inside a window are averaged
 * first (each coin once, whatever its row count) and the error is taken
 * across windows only: rule 1 above.
 */
export function familyEvidence(
  rows: readonly LedgerBucketRow[],
  horizonMin: number,
  familyOf: (source: string) => string = sourceFamily,
): Map<string, Evidence> {
  const by = new Map<string, { n: number; windows: Map<number, Map<string, { sum: number; n: number }>> }>();
  for (const r of rows) {
    if (r.horizonMin !== horizonMin) continue;
    const family = familyOf(r.source);
    const f = by.get(family) ?? { n: 0, windows: new Map() };
    const coins = f.windows.get(r.bucket) ?? new Map<string, { sum: number; n: number }>();
    const coin = coins.get(r.asset.toUpperCase()) ?? { sum: 0, n: 0 };
    coin.sum += r.timingBp * r.n;
    coin.n += r.n;
    coins.set(r.asset.toUpperCase(), coin);
    f.windows.set(r.bucket, coins);
    f.n += r.n;
    by.set(family, f);
  }
  const out = new Map<string, Evidence>();
  for (const [family, f] of by) {
    const perWindow = [...f.windows.values()].map((coins) => {
      const perCoin = [...coins.values()].map((c) => c.sum / c.n);
      return perCoin.reduce((s, x) => s + x, 0) / perCoin.length;
    });
    out.set(family, summarize(perWindow, f.n));
  }
  return out;
}

// ── Verdicts ─────────────────────────────────────────────────────────

function lnGamma(x: number): number {
  const c = [76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155, 1.208650973866179e-3, -5.395239384953e-6];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const cj of c) ser += cj / ++y;
  return -tmp + Math.log((Math.sqrt(2 * Math.PI) * ser) / x);
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const TINY = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 3e-12) break;
  }
  return h;
}

function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

/**
 * Two-sided p-value of a t statistic. The small-sample form matters here:
 * at 12 windows, two standard errors is p = 0.07, not the 0.05 a normal
 * curve gives.
 */
export function twoSidedP(t: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(t) || degreesOfFreedom < 1) return 1;
  return regularizedIncompleteBeta(degreesOfFreedom / (degreesOfFreedom + t * t), degreesOfFreedom / 2, 0.5);
}

/** Benjamini-Hochberg: which of these p-values stand when at most a share q of the survivors may be false. */
export function survivesFalseDiscovery(pValues: readonly number[], q: number): boolean[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let last = -1;
  for (let k = 0; k < m; k++) if (order[k].p <= (q * (k + 1)) / m) last = k;
  const out = new Array<boolean>(m).fill(false);
  for (let k = 0; k <= last; k++) out[order[k].i] = true;
  return out;
}

export interface Judged extends Evidence {
  verdict: TimingVerdict;
  /** False when there were too few windows to test, or the entry belongs to no group. */
  tested: boolean;
  /** Two-sided p-value; 1 when not tested. */
  p: number;
}

/**
 * A verdict for every entry: decided only with enough windows, beyond
 * LEDGER_TIMING_SE standard errors, and surviving the false-discovery check
 * among the entries of its group (rule 2). `groupOf` returning null leaves
 * an entry unjudged.
 */
export function judge(
  evidence: ReadonlyMap<string, Evidence>,
  groupOf: (key: string) => string | null,
  q: number = LOOP_FALSE_DISCOVERY_RATE,
): Map<string, Judged> {
  const out = new Map<string, Judged>();
  const groups = new Map<string, Array<{ key: string; t: number; p: number }>>();
  for (const [key, e] of evidence) {
    out.set(key, { ...e, verdict: 'unproven', tested: false, p: 1 });
    const group = groupOf(key);
    if (group === null || e.windows < LEDGER_MIN_WINDOWS || !Number.isFinite(e.seBp) || e.seBp <= 0) continue;
    const t = e.timingBp / e.seBp;
    const p = twoSidedP(t, e.windows - 1);
    Object.assign(out.get(key)!, { tested: true, p });
    const members = groups.get(group) ?? [];
    members.push({ key, t, p });
    groups.set(group, members);
  }
  for (const members of groups.values()) {
    const stands = survivesFalseDiscovery(members.map((m) => m.p), q);
    members.forEach((m, i) => {
      if (stands[i] && Math.abs(m.t) >= LEDGER_TIMING_SE) out.get(m.key)!.verdict = m.t > 0 ? 'proven' : 'wrong-way';
    });
  }
  return out;
}

// ── The daily evaluation ─────────────────────────────────────────────

export interface VerdictInForce {
  verdict: 'proven' | 'wrong-way';
  timingBp: number;
  seBp: number;
  windows: number;
}

export interface LoopState {
  version: 1;
  /** UTC day of the evaluation. */
  day: string;
  evaluatedAt: number;
  horizonMin: number;
  /** Verdicts in force, keyed `source|COIN`. Everything absent is unproven. */
  cells: Record<string, VerdictInForce>;
  /** Verdicts in force, keyed by family. */
  families: Record<string, VerdictInForce>;
  /** Decided on today's data but not without the last day: in force tomorrow if they hold. */
  pending: string[];
  counts: { cellsJudged: number; familiesJudged: number; proven: number; wrongWay: number; pending: number };
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

function judgeRows(rows: readonly LedgerBucketRow[], horizonMin: number): { cells: Map<string, Judged>; families: Map<string, Judged> } {
  return {
    cells: judge(cellEvidence(rows, horizonMin), (key) => cellGroup(key.slice(0, key.lastIndexOf('|')))),
    families: judge(familyEvidence(rows, horizonMin), familyGroup),
  };
}

/**
 * Judge the ledger as of `now`: on every window, and again on the windows
 * that had closed a day earlier. A verdict is in force when both agree
 * (rule 3). Pure: the same rows give the same state.
 */
export function evaluateLoop(rows: readonly LedgerBucketRow[], now: number, horizonMin: number = LEDGER_WEIGHT_HORIZON_MIN): LoopState {
  const horizonMs = horizonMin * 60_000;
  const today = judgeRows(rows, horizonMin);
  const yesterday = judgeRows(rows.filter((r) => (r.bucket + 1) * horizonMs <= now - DAY_MS), horizonMin);

  const pending: string[] = [];
  const settle = (level: 'cell' | 'family', current: Map<string, Judged>, before: Map<string, Judged>): Record<string, VerdictInForce> => {
    const inForce: Record<string, VerdictInForce> = {};
    for (const [key, j] of current) {
      if (j.verdict === 'unproven') continue;
      if (before.get(key)?.verdict === j.verdict) inForce[key] = { verdict: j.verdict, timingBp: j.timingBp, seBp: j.seBp, windows: j.windows };
      else pending.push(`${level}:${key}`);
    }
    return inForce;
  };
  const cells = settle('cell', today.cells, yesterday.cells);
  const families = settle('family', today.families, yesterday.families);

  const judgedCount = (m: Map<string, Judged>) => [...m.values()].filter((j) => j.tested).length;
  const all = [...Object.values(cells), ...Object.values(families)];
  return {
    version: 1,
    day: utcDay(now),
    evaluatedAt: now,
    horizonMin,
    cells,
    families,
    pending,
    counts: {
      cellsJudged: judgedCount(today.cells),
      familiesJudged: judgedCount(today.families),
      proven: all.filter((v) => v.verdict === 'proven').length,
      wrongWay: all.filter((v) => v.verdict === 'wrong-way').length,
      pending: pending.length,
    },
  };
}

/**
 * The verdict that applies to one source on one coin: its own cell when
 * that is decided, else its family's. Evidence in conflict (the cell one
 * way, the family the other) decides nothing.
 */
export function resolveVerdict(
  state: Pick<LoopState, 'cells' | 'families'> | null | undefined,
  source: string,
  asset: string,
): { verdict: TimingVerdict; level: 'cell' | 'family' | null } {
  const cell = state?.cells[cellKey(source, asset)]?.verdict;
  const family = state?.families[sourceFamily(source)]?.verdict;
  if (cell && family && cell !== family) return { verdict: 'unproven', level: null };
  if (cell) return { verdict: cell, level: 'cell' };
  if (family) return { verdict: family, level: 'family' };
  return { verdict: 'unproven', level: null };
}

/** Weight a proven source carries against its base weight; the figure the current weighting uses. */
export const LOOP_PROVEN_MULTIPLIER = (() => {
  const v = Number((process.env.SOURCE_LEDGER_PROVEN_MULTIPLIER || '').trim());
  return Number.isFinite(v) && v > 0 ? v : 1.5;
})();

/**
 * The loop's verdicts applied to a coin's raw votes: a wrong-way source is
 * removed, a proven one lifted, the rest keep their base weight; weights
 * then sum to 1. If fewer than two voices would be left, nothing is
 * removed: one source is not a vote.
 */
export function applyLoopVerdicts<S extends { name: string; type?: string; weight: number }>(
  sources: readonly S[],
  state: Pick<LoopState, 'cells' | 'families'> | null | undefined,
  asset: string,
  keyOf: (name: string, type: string) => string,
): S[] {
  const judged = sources.map((s) => ({ s, verdict: resolveVerdict(state, keyOf(s.name, s.type ?? ''), asset).verdict }));
  const kept = judged.filter((j) => j.verdict !== 'wrong-way');
  const voting = kept.length >= 2 ? kept : judged;
  const weighted = voting.map(({ s, verdict }) => ({ ...s, weight: s.weight * (verdict === 'proven' ? LOOP_PROVEN_MULTIPLIER : 1) }));
  const total = weighted.reduce((sum, s) => sum + s.weight, 0);
  return total > 0 ? weighted.map((s) => ({ ...s, weight: s.weight / total })) : [...sources];
}

export async function getLoopState(): Promise<LoopState | null> {
  const state = await getCronState<LoopState>(LOOP_STATE_KEY);
  return state?.version === 1 ? state : null;
}

/**
 * Re-judge the ledger once per UTC day and store the result. Returns the
 * new state, or null when today's is already stored. A failed ledger read
 * throws and leaves the stored state as it was.
 */
export async function runFeedbackLoopEvaluation(now: number = Date.now()): Promise<LoopState | null> {
  if ((await getLoopState())?.day === utcDay(now)) return null;
  const rows = await getLedgerBucketRows({
    sinceMs: Math.max(now - LEDGER_WINDOW_DAYS * DAY_MS, LEDGER_EPOCH_MS),
    horizonsMin: [LEDGER_WEIGHT_HORIZON_MIN],
  });
  // The snapshot loop writes every ten minutes; an empty window is a broken read, not an empty market.
  if (rows.length === 0) throw new Error('signal ledger returned no resolved rows');
  const state = evaluateLoop(rows, now);
  await setCronState(LOOP_STATE_KEY, state);
  return state;
}
