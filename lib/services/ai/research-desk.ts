/**
 * The research desk: a Meta model proposes trading rules, code tests them.
 *
 * Each round the model reads every rule tried so far with its result on the
 * training years, and proposes new ones. A rule is plain JSON (conditions on
 * price features and a share of the book to hold), so the model never runs
 * code. The test is deterministic: daily closes, a cost on every change, and
 * a score for whether the timing beats simply holding the same share.
 *
 * Everything after TRAIN_END is held out. The model never sees a result from
 * it; only the leading rule is scored there, and it passes only if its
 * training score also clears a bar that rises with the number of rules tried
 * (the best of many random rules looks good by chance).
 */
import { query } from '@/lib/db/postgres';
import { resolveProvider, runWithTools } from './tool-runner';

export const FEATURES = ['ret', 'maGap', 'vol', 'drawdown'] as const;
export type Feature = (typeof FEATURES)[number];
export const ASSETS = ['BTC', 'ETH'] as const;
export type Asset = (typeof ASSETS)[number];

export interface Condition {
  feature: Feature;
  days: number;
  op: '>' | '<';
  value: number;
}
export interface Rule {
  asset: Asset;
  when: Condition[];
  exposure: number;
}
export interface Score {
  days: number;
  returnPct: number;
  holdReturnPct: number;
  /** t-statistic of the daily return over holding the same share all the time. */
  edgeT: number;
  maxDrawdownPct: number;
  inMarketPct: number;
  changes: number;
}

export const COST_BP = 10;
export const MAX_DAYS = 120;
const MAX_CONDITIONS = 3;
const DATA_START = Date.UTC(2021, 6, 1); // 120-day features are warm by TRAIN_START
export const TRAIN_START = Date.UTC(2021, 10, 1);
export const TRAIN_END = Date.UTC(2025, 10, 1);
/** Our live trend book's rule, scored by the same code so the model has something real to beat. */
export const TREND_RULE: Rule = { asset: 'BTC', when: [{ feature: 'maGap', days: 100, op: '>', value: 0 }], exposure: 0.25 };
const PROPOSALS_PER_ROUND = 4;
const KEEP_TRIALS = 5000;
const DAY_MS = 86_400_000;

// ── rules ──

const round2 = (x: number) => Math.round(x * 100) / 100;

/** A rule from untrusted model output, or null. Values are clamped to what the test can compute. */
export function parseRule(x: unknown): Rule | null {
  if (!x || typeof x !== 'object') return null;
  const r = x as Record<string, unknown>;
  const asset = String(r.asset ?? '').toUpperCase();
  if (!(ASSETS as readonly string[]).includes(asset)) return null;
  const exposure = Number(r.exposure);
  if (!(exposure >= 0.05 && exposure <= 1)) return null;
  if (!Array.isArray(r.when) || r.when.length < 1 || r.when.length > MAX_CONDITIONS) return null;
  const when: Condition[] = [];
  for (const c of r.when as Array<Record<string, unknown>>) {
    const feature = c?.feature as Feature;
    const days = Number(c?.days);
    const value = Number(c?.value);
    if (!FEATURES.includes(feature)) return null;
    if (!Number.isInteger(days) || days < 2 || days > MAX_DAYS) return null;
    if (c.op !== '>' && c.op !== '<') return null;
    if (!Number.isFinite(value) || Math.abs(value) > 1000) return null;
    when.push({ feature, days, op: c.op, value: round2(value) });
  }
  when.sort((a, b) => (a.feature + a.days + a.op + a.value).localeCompare(b.feature + b.days + b.op + b.value));
  return { asset: asset as Asset, when, exposure: round2(exposure) };
}

export const ruleKey = (r: Rule) => JSON.stringify([r.asset, r.exposure, r.when.map((c) => [c.feature, c.days, c.op, c.value])]);

const FEATURE_WORDS: Record<Feature, string> = {
  ret: 'return over',
  maGap: 'gap to its average over',
  vol: 'yearly volatility over',
  drawdown: 'fall from its high over',
};
export function describeRule(r: Rule): string {
  const conds = r.when.map((c) => `${FEATURE_WORDS[c.feature]} ${c.days} days ${c.op} ${c.value}%`).join(' and ');
  return `Hold ${Math.round(r.exposure * 100)}% of the book in ${r.asset} while ${conds}; otherwise cash.`;
}

// ── features and the test ──

export interface Series {
  t: number[];
  close: number[];
}

/** Feature value at each day, in percent; NaN until `days` of history exist. */
export function featureSeries(s: Series, f: Feature, days: number): number[] {
  const p = s.close;
  const out = new Array<number>(p.length).fill(NaN);
  if (f === 'ret') {
    for (let i = days; i < p.length; i++) out[i] = (p[i] / p[i - days] - 1) * 100;
  } else if (f === 'maGap') {
    let sum = 0;
    for (let i = 0; i < p.length; i++) {
      sum += p[i];
      if (i >= days) sum -= p[i - days];
      if (i >= days - 1) out[i] = (p[i] / (sum / days) - 1) * 100;
    }
  } else if (f === 'vol') {
    let s1 = 0, s2 = 0;
    const lr = p.map((x, i) => (i ? Math.log(x / p[i - 1]) : 0));
    for (let i = 1; i < p.length; i++) {
      s1 += lr[i]; s2 += lr[i] * lr[i];
      if (i > days) { s1 -= lr[i - days]; s2 -= lr[i - days] * lr[i - days]; }
      if (i >= days) {
        const m = s1 / days;
        out[i] = Math.sqrt(Math.max(s2 / days - m * m, 0) * 365) * 100;
      }
    }
  } else {
    for (let i = days - 1; i < p.length; i++) {
      let hi = 0;
      for (let k = i - days + 1; k <= i; k++) hi = Math.max(hi, p[k]);
      out[i] = (p[i] / hi - 1) * 100;
    }
  }
  return out;
}

const tStat = (x: number[]) => {
  const n = x.length;
  if (n < 2) return 0;
  const m = x.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1));
  return sd > 1e-12 ? m / (sd / Math.sqrt(n)) : 0;
};

/**
 * Scores a rule on days with fromMs <= t < toMs. The position is decided at a
 * day's close from that day's features and earns the next day's move; every
 * change pays COST_BP on the share traded.
 */
export function backtest(rule: Rule, s: Series, fromMs: number, toMs: number): Score {
  const feats = rule.when.map((c) => featureSeries(s, c.feature, c.days));
  const on = (i: number) =>
    rule.when.every((c, k) => {
      const v = feats[k][i];
      return Number.isFinite(v) && (c.op === '>' ? v > c.value : v < c.value);
    });
  let eq = 1, hold = 1, peak = 1, maxDd = 0, inMarket = 0, changes = 0, prevW = 0;
  const edge: number[] = [];
  for (let i = 1; i < s.t.length; i++) {
    if (s.t[i] < fromMs || s.t[i] >= toMs) continue;
    const w = on(i - 1) ? rule.exposure : 0;
    const move = s.close[i] / s.close[i - 1] - 1;
    const cost = (Math.abs(w - prevW) * COST_BP) / 1e4;
    if (w !== prevW) changes++;
    prevW = w;
    const r = w * move - cost;
    eq *= 1 + r;
    hold *= 1 + rule.exposure * move;
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    if (w > 0) inMarket++;
    edge.push(r - rule.exposure * move);
  }
  return {
    days: edge.length,
    returnPct: round2((eq - 1) * 100),
    holdReturnPct: round2((hold - 1) * 100),
    edgeT: round2(tStat(edge)),
    maxDrawdownPct: round2(maxDd * 100),
    inMarketPct: edge.length ? round2((inMarket / edge.length) * 100) : 0,
    changes,
  };
}

/** The bar a training score must clear after n rules: about the best t that n useless rules would reach. */
export const barFor = (n: number) => round2(Math.max(2, Math.sqrt(2 * Math.log(Math.max(n, 2)))));

// ── prices ──

let cache: { at: number; data: Record<Asset, Series> } | null = null;

/** Closed daily candles from DATA_START, oldest first. Throws on a failed read. */
async function dailySeries(asset: Asset, now: number): Promise<Series> {
  const byT = new Map<number, number>();
  for (let from = DATA_START; from < now; from += 299 * DAY_MS) {
    const to = Math.min(from + 299 * DAY_MS, now);
    const url = `https://api.exchange.coinbase.com/products/${asset}-USD/candles?granularity=86400&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'zkward' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`daily candles ${asset}: HTTP ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error(`daily candles ${asset}: not a list`);
    for (const c of rows as number[][]) if (c[0] * 1000 + DAY_MS <= now) byT.set(c[0] * 1000, Number(c[4]));
  }
  const t = [...byT.keys()].sort((a, b) => a - b);
  if (t.length < 1000) throw new Error(`daily candles ${asset}: only ${t.length} days`);
  return { t, close: t.map((k) => byT.get(k)!) };
}

export async function loadSeries(now = Date.now()): Promise<Record<Asset, Series>> {
  if (cache && now - cache.at < 3_600_000) return cache.data;
  const [BTC, ETH] = await Promise.all([dailySeries('BTC', now), dailySeries('ETH', now)]);
  cache = { at: now, data: { BTC, ETH } };
  return cache.data;
}

// ── the trial store ──

export interface Trial {
  id: number;
  round: number;
  model: string;
  createdAt: string;
  rule: Rule;
  hypothesis: string;
  train: Score;
}

let ready = false;
async function ensureTable(): Promise<void> {
  if (ready) return;
  await query(`
    CREATE TABLE IF NOT EXISTS research_trials (
      id          BIGSERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      round       INT NOT NULL,
      model       TEXT NOT NULL,
      spec_key    TEXT NOT NULL UNIQUE,
      rule        JSONB NOT NULL,
      hypothesis  TEXT NOT NULL,
      train       JSONB NOT NULL
    )
  `);
  ready = true;
}

export async function readTrials(): Promise<Trial[]> {
  await ensureTable();
  const rows = await query<{ id: string; round: number; model: string; created_at: Date; rule: Rule; hypothesis: string; train: Score }>(
    `SELECT id, round, model, created_at, rule, hypothesis, train FROM research_trials ORDER BY id`,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    round: r.round,
    model: r.model,
    createdAt: new Date(r.created_at).toISOString(),
    rule: r.rule,
    hypothesis: r.hypothesis,
    train: r.train,
  }));
}

// ── one round ──

const SYSTEM = `You are the research desk of a crypto fund that trades only rules proven on data. You propose rules; code tests them. You never see the test code or the held-out year.`;

/** The model's answer as rules with their hypotheses; anything malformed is dropped. */
export function parseProposals(text: string): Array<{ rule: Rule; hypothesis: string }> {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(a, b + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: Array<{ rule: Rule; hypothesis: string }> = [];
  for (const p of raw as Array<Record<string, unknown>>) {
    const rule = parseRule(p?.rule ?? p);
    if (rule) out.push({ rule, hypothesis: String(p?.hypothesis ?? '').slice(0, 300) });
  }
  return out;
}

export function buildPrompt(trials: Trial[], trend: Score): string {
  const fmt = (t: Trial) => `- round ${t.round}: ${JSON.stringify(t.rule)} → edgeT ${t.train.edgeT}, return ${t.train.returnPct}% vs hold ${t.train.holdReturnPct}%, worst fall ${t.train.maxDrawdownPct}%, in market ${t.train.inMarketPct}%, ${t.train.changes} changes`;
  const best = [...trials].sort((x, y) => y.train.edgeT - x.train.edgeT).slice(0, 12);
  const recent = trials.slice(-12).filter((t) => !best.includes(t));
  return `Propose ${PROPOSALS_PER_ROUND} NEW long-only rules for BTC or ETH on daily closes.

A rule: {"asset":"BTC"|"ETH","exposure":0.05..1,"when":[1 to ${MAX_CONDITIONS} conditions, all must hold]}
A condition: {"feature": one of "ret" (% return over N days) | "maGap" (% above the N-day average) | "vol" (% yearly volatility over N days) | "drawdown" (% below the N-day high, 0 or negative), "days": 2..${MAX_DAYS}, "op": ">"|"<", "value": number in %}
At each daily close the book holds "exposure" of itself in the coin if every condition holds, else cash. Every change costs ${COST_BP} bp of the share traded.
Score (edgeT): t-statistic of the daily return over simply holding the same share all the time, on ${new Date(TRAIN_START).toISOString().slice(0, 10)} to ${new Date(TRAIN_END).toISOString().slice(0, 10)}. Above 0 means the timing helped. ${trials.length} rules have been tried; the best of that many will look good by luck, so the bar is edgeT ${barFor(trials.length + PROPOSALS_PER_ROUND)}.

Our live trend rule ${JSON.stringify(TREND_RULE)} scores edgeT ${trend.edgeT}, return ${trend.returnPct}% vs hold ${trend.holdReturnPct}%.
${trials.length ? `Best rules so far:\n${best.map(fmt).join('\n')}${recent.length ? `\nMost recent:\n${recent.map(fmt).join('\n')}` : ''}` : 'No rules tried yet.'}

Learn from these results: say what they suggest, then explore something different from what failed. Do not repeat a rule. Prefer simple rules that trade rarely.
Answer with only a JSON array: [{"hypothesis":"one sentence on why it should work","rule":{...}}, ...]`;
}

export interface RoundResult {
  round: number;
  model: string;
  proposed: number;
  added: number;
  best: { rule: string; edgeT: number } | null;
}

export async function runResearchRound(): Promise<RoundResult> {
  const provider = await resolveProvider();
  if (!provider) throw new Error('no model provider configured');
  const [series, trials] = await Promise.all([loadSeries(), readTrials()]);
  const trend = backtest(TREND_RULE, series.BTC, TRAIN_START, TRAIN_END);
  const round = trials.reduce((m, t) => Math.max(m, t.round), 0) + 1;
  const { finalText } = await runWithTools({
    systemPrompt: SYSTEM,
    userPrompt: buildPrompt(trials, trend),
    tools: [],
    maxIterations: 1,
    client: provider.client,
    model: provider.model,
  });
  const seen = new Set(trials.map((t) => ruleKey(t.rule)));
  const proposals = parseProposals(finalText);
  let added = 0;
  let best: RoundResult['best'] = null;
  for (const p of proposals) {
    const key = ruleKey(p.rule);
    if (seen.has(key)) continue;
    seen.add(key);
    const train = backtest(p.rule, series[p.rule.asset], TRAIN_START, TRAIN_END);
    const rows = await query(
      `INSERT INTO research_trials (round, model, spec_key, rule, hypothesis, train)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (spec_key) DO NOTHING RETURNING 1`,
      [round, provider.model, key, JSON.stringify(p.rule), p.hypothesis, JSON.stringify(train)],
    );
    added += rows.length;
    if (!best || train.edgeT > best.edgeT) best = { rule: describeRule(p.rule), edgeT: train.edgeT };
  }
  await query(
    `DELETE FROM research_trials WHERE id < (SELECT MIN(id) FROM (SELECT id FROM research_trials ORDER BY id DESC LIMIT ${KEEP_TRIALS}) k)`,
  );
  return { round, model: provider.model, proposed: proposals.length, added, best };
}

// ── what the desk has found ──

export async function readDesk() {
  const [series, trials] = await Promise.all([loadSeries(), readTrials()]);
  const now = Date.now();
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const bar = barFor(trials.length);
  const leader = [...trials].sort((a, b) => b.train.edgeT - a.train.edgeT)[0];
  const heldOut = leader ? backtest(leader.rule, series[leader.rule.asset], TRAIN_END, now) : null;
  return {
    rulesTried: trials.length,
    rounds: trials.reduce((m, t) => Math.max(m, t.round), 0),
    lastRoundAt: trials.at(-1)?.createdAt ?? null,
    models: [...new Set(trials.map((t) => t.model))],
    trainingYears: `${day(TRAIN_START)} to ${day(TRAIN_END)}`,
    heldOutFrom: day(TRAIN_END),
    costPerChangeBp: COST_BP,
    barEdgeT: bar,
    leader: leader && heldOut
      ? {
          rule: describeRule(leader.rule),
          hypothesis: leader.hypothesis,
          round: leader.round,
          training: leader.train,
          heldOut,
          passes: leader.train.edgeT >= bar && heldOut.edgeT >= 2,
        }
      : null,
    ourTrendRule: {
      rule: describeRule(TREND_RULE),
      training: backtest(TREND_RULE, series.BTC, TRAIN_START, TRAIN_END),
      heldOut: backtest(TREND_RULE, series.BTC, TRAIN_END, now),
    },
    recent: trials.slice(-5).reverse().map((t) => ({ round: t.round, rule: describeRule(t.rule), trainingEdgeT: t.train.edgeT })),
  };
}
