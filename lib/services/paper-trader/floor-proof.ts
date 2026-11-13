/**
 * Is the floor book doing its job? Its result set against simply holding the
 * coins from the same start prices, half BTC and half ETH.
 *
 * The book's claim is protection: when the coins fall, it should fall less,
 * and when they rise it should still rise. These are the figures that show
 * whether it does, live. Pure apart from `readFloorProof`.
 */
import { getCronStateStrict } from '@/lib/db/cron-state';
import { FLOOR_START_USD } from './FloorTrader';

const ASSETS = ['BTC', 'ETH'] as const;

export interface FloorStateView {
  startedAtMs: number;
  startPrices: Record<string, number>;
  valueUsd: number;
  maxDrawdown: number;
  exposureUsd: number;
  /** Assumed interest on the cash, already inside `valueUsd`. Only the core book has it. */
  interestUsd?: number;
}

export interface FloorProof {
  days: number;
  /** The book's change since it started, in percent, interest included. */
  bookPct: number;
  /** The part of `bookPct` that is assumed interest, not trading; null for a book without it. */
  interestPct: number | null;
  /** Holding half BTC and half ETH from the book's start prices, in percent. */
  holdPct: number;
  coinPct: Record<string, number>;
  /** The book's deepest fall from a peak, in percent. */
  worstFallPct: number;
  /** Share of the holding's fall the book avoided; null unless the holding is down. */
  avoidedShare: number | null;
  exposureUsd: number;
}

/** Null when a start price or a current mark is missing. */
export function floorProof(state: FloorStateView, marks: ReadonlyMap<string, number>, nowMs: number): FloorProof | null {
  const coinPct: Record<string, number> = {};
  for (const a of ASSETS) {
    const start = state.startPrices[a], now = marks.get(a);
    if (!(start > 0) || !(Number(now) > 0)) return null;
    coinPct[a] = (Number(now) / start - 1) * 100;
  }
  const holdPct = ASSETS.reduce((s, a) => s + coinPct[a], 0) / ASSETS.length;
  const bookPct = (state.valueUsd / FLOOR_START_USD - 1) * 100;
  const interestPct = typeof state.interestUsd === 'number' ? (state.interestUsd / FLOOR_START_USD) * 100 : null;
  // The fall avoided is the rule's, so assumed interest does not count toward it.
  const tradingPct = bookPct - (interestPct ?? 0);
  return {
    days: (nowMs - state.startedAtMs) / 86_400_000,
    bookPct,
    interestPct,
    holdPct,
    coinPct,
    worstFallPct: state.maxDrawdown * 100,
    avoidedShare: holdPct < 0 ? 1 - tradingPct / holdPct : null,
    exposureUsd: state.exposureUsd,
  };
}

const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} %`;

/**
 * One scoreboard line: `−1.1 % vs holding −3.4 % (BTC −1.9 %, ETH −4.8 %) · avoided 68 % of the fall · worst fall 1.9 % · day 7`.
 * A book whose trading gained while holding fell (the short book) says so, not "avoided 120 % of the fall".
 */
export function floorProofLine(p: FloorProof, held = 'in coins'): string {
  const coins = ASSETS.map((a) => `${a} ${pct(p.coinPct[a])}`).join(', ');
  const avoided = p.avoidedShare === null ? '' : p.avoidedShare > 1 ? ' · gained while the coins fell' : ` · avoided ${Math.round(100 * p.avoidedShare)} % of the fall`;
  const split = p.interestPct === null ? '' : ` (trading ${pct(p.bookPct - p.interestPct)}, assumed interest ${pct(p.interestPct)})`;
  return `${pct(p.bookPct)}${split} vs holding ${pct(p.holdPct)} (${coins})${avoided}\nworst fall ${p.worstFallPct.toFixed(1)} % · holds $${Math.round(p.exposureUsd).toLocaleString('en-US')} ${held} · day ${Math.floor(p.days) + 1}`;
}

/** The live figures for one floor book's state key; null before its first tick or without marks. Throws on a failed read. */
export async function readFloorProof(marks: ReadonlyMap<string, number>, nowMs: number = Date.now(), stateKey = 'floor-trader:state'): Promise<FloorProof | null> {
  const state = await getCronStateStrict<FloorStateView>(stateKey);
  return state ? floorProof(state, marks, nowMs) : null;
}

/** The rule books on the scoreboard, each with the state its figures are read from. */
const PROOF_BOOKS = [
  { id: -8, label: 'Plain (×3)', stateKey: 'floor-trader:state', held: 'in coins' },
  { id: -9, label: 'Ladder-sized twin', stateKey: 'floor-ladder-trader:state', held: 'in coins' },
  { id: -10, label: 'Trend (25%, 100-day average)', stateKey: 'trend-trader:state', held: 'in coins' },
  { id: -11, label: 'Core (floor + trend, 4% on cash)', stateKey: 'core-trader:state', held: 'in coins' },
  { id: -12, label: 'Short (falling coins sold short, 4% on cash)', stateKey: 'short-trader:state', held: 'short' },
] as const;

/** The scoreboard's rule-book field: every rule book that is switched on and has started. */
export async function floorScoreboardText(marks: ReadonlyMap<string, number>, nowMs: number = Date.now()): Promise<string | null> {
  const { PAPER_BOOKS, bookRunning } = await import('./books-summary');
  const shown = PROOF_BOOKS.filter((b) => {
    const def = PAPER_BOOKS.find((d) => d.id === b.id);
    return def ? bookRunning(def) : true;
  });
  const proofs = await Promise.all(shown.map((b) => readFloorProof(marks, nowMs, b.stateKey)));
  const parts = shown.flatMap((b, i) => {
    const p = proofs[i];
    return p ? [`**${b.label}:** ${floorProofLine(p, b.held)}`] : [];
  });
  return parts.length ? parts.join('\n') : null;
}
