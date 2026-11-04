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
}

export interface FloorProof {
  days: number;
  /** The book's change since it started, in percent. */
  bookPct: number;
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
  return {
    days: (nowMs - state.startedAtMs) / 86_400_000,
    bookPct,
    holdPct,
    coinPct,
    worstFallPct: state.maxDrawdown * 100,
    avoidedShare: holdPct < 0 ? 1 - bookPct / holdPct : null,
    exposureUsd: state.exposureUsd,
  };
}

const pct = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} %`;

/** One scoreboard line: `−1.1 % vs holding −3.4 % (BTC −1.9 %, ETH −4.8 %) · avoided 68 % of the fall · worst fall 1.9 % · day 7`. */
export function floorProofLine(p: FloorProof): string {
  const coins = ASSETS.map((a) => `${a} ${pct(p.coinPct[a])}`).join(', ');
  const avoided = p.avoidedShare === null ? '' : ` · avoided ${Math.round(100 * p.avoidedShare)} % of the fall`;
  return `${pct(p.bookPct)} vs holding ${pct(p.holdPct)} (${coins})${avoided}\nworst fall ${p.worstFallPct.toFixed(1)} % · holds $${Math.round(p.exposureUsd).toLocaleString('en-US')} in coins · day ${Math.floor(p.days) + 1}`;
}

/** The live figures for one floor book's state key; null before its first tick or without marks. Throws on a failed read. */
export async function readFloorProof(marks: ReadonlyMap<string, number>, nowMs: number = Date.now(), stateKey = 'floor-trader:state'): Promise<FloorProof | null> {
  const state = await getCronStateStrict<FloorStateView>(stateKey);
  return state ? floorProof(state, marks, nowMs) : null;
}

/** The scoreboard's floor field: the plain book, and its ladder-sized twin once it has started. */
export async function floorScoreboardText(marks: ReadonlyMap<string, number>, nowMs: number = Date.now()): Promise<string | null> {
  const [plain, twin, trend] = await Promise.all([
    readFloorProof(marks, nowMs, 'floor-trader:state'),
    readFloorProof(marks, nowMs, 'floor-ladder-trader:state'),
    readFloorProof(marks, nowMs, 'trend-trader:state'),
  ]);
  const parts: string[] = [];
  if (plain) parts.push(`**Plain (×3):** ${floorProofLine(plain)}`);
  if (twin) parts.push(`**Ladder-sized twin:** ${floorProofLine(twin)}`);
  if (trend) parts.push(`**Trend (25%, 100-day average):** ${floorProofLine(trend)}`);
  return parts.length ? parts.join('\n') : null;
}
