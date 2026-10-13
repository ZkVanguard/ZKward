/**
 * Strike ladder — how far the market expects a coin to move.
 *
 * Each day the prediction market lists a ladder of "above $K at noon ET"
 * markets per coin. One of them says little; read together they are a full
 * forecast of the price at that time. The ladder's WIDTH tracked the size of
 * the move that followed better than the coin's own price history did (300
 * daily ladders per coin, read 24 to 72 hours ahead). Its middle sits on spot
 * and says nothing about direction, so this reports the width and the odds
 * at each strike, never a lean.
 */
import { normalInv } from '@/lib/services/hedging/quant-models';
import type { ExpectedMove } from '@/lib/types/market-signals';

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
/** The venue's series ids for its daily strike ladders. */
const LADDER_SERIES: Record<string, number> = { BTC: 45, ETH: 42 };
export const LADDER_ASSETS: readonly string[] = Object.keys(LADDER_SERIES);
const FETCH_TIMEOUT_MS = 8_000;
/** Outside this band a strike is decided and its odds carry no width. */
const LIVE_LOW = 0.03;
const LIVE_HIGH = 0.97;
/** A ladder nearer to resolution than this has too few undecided strikes left to read. */
const MIN_HOURS_AHEAD = 12;
/** The width was checked against what followed for ladders up to three days out, and no further. */
const MAX_HOURS_AHEAD = 84;

export interface LadderStrike {
  strike: number;
  /** Price of "ends above the strike", 0 to 1. */
  yes: number;
}

export interface LadderReading {
  /** One standard deviation of the move the ladder prices between now and resolution, as a share of price. */
  width: number;
  /** The price the ladder treats as even odds. */
  middle: number;
  /** Undecided strikes under the middle, nearest first, with the chance the ladder gives of ending below each. */
  downside: Array<{ price: number; chance: number }>;
  /** Undecided strikes the width was read from. */
  strikes: number;
}

/**
 * Read one ladder. Null when it cannot be read: fewer than three undecided
 * strikes, or prices that do not form a ladder.
 */
export function readLadder(input: LadderStrike[]): LadderReading | null {
  const strikes = input
    .filter((s) => s.strike > 0 && s.yes > 0 && s.yes < 1)
    .sort((a, b) => a.strike - b.strike);
  // A higher strike cannot be the likelier one; when it is, the book behind it is empty or stale.
  for (let i = 1; i < strikes.length; i++) {
    if (strikes[i].yes > strikes[i - 1].yes + 0.05) return null;
  }
  const live = strikes.filter((s) => s.yes >= LIVE_LOW && s.yes <= LIVE_HIGH);
  if (live.length < 3) return null;

  // Probit line through the undecided strikes: z = (ln middle − ln K) / width.
  // Weighted the way a probit fit weights its points, so a strike near even
  // odds counts for more than one near the edge of the band.
  let sw = 0, swx = 0, swz = 0, swxx = 0, swxz = 0;
  for (const s of live) {
    const z = normalInv(s.yes);
    const x = Math.log(s.strike);
    const w = Math.exp(-z * z) / (s.yes * (1 - s.yes));
    sw += w; swx += w * x; swz += w * z; swxx += w * x * x; swxz += w * x * z;
  }
  const beta = (sw * swxz - swx * swz) / (sw * swxx - swx * swx);
  const alpha = (swz - beta * swx) / sw;
  if (!(beta < 0)) return null;
  const width = -1 / beta;
  const middle = Math.exp(-alpha / beta);
  if (!(width > 0.002 && width < 0.4) || !Number.isFinite(middle)) return null;

  const downside = live
    .filter((s) => s.strike < middle)
    .map((s) => ({ price: s.strike, chance: 1 - s.yes }))
    .reverse();
  return { width, middle, downside, strikes: live.length };
}

/**
 * The ladders worth trying, nearest first. The nearest is preferred, but a
 * day from resolution a coin whose strikes sit far apart can have fewer than
 * three still undecided, and the next ladder out is then the first that can
 * be read.
 */
export function ladderCandidates<T extends { resolvesAtMs: number }>(ladders: T[], now: number): T[] {
  return ladders
    .filter((l) => {
      const hoursAhead = (l.resolvesAtMs - now) / 3_600_000;
      return hoursAhead >= MIN_HOURS_AHEAD && hoursAhead <= MAX_HOURS_AHEAD;
    })
    .sort((a, b) => a.resolvesAtMs - b.resolvesAtMs);
}

interface VenueEvent {
  endDate?: string;
  markets?: Array<{ groupItemTitle?: string; outcomePrices?: string }>;
}

function toLadder(event: VenueEvent): { resolvesAtMs: number; strikes: LadderStrike[] } | null {
  const resolvesAtMs = Date.parse(event.endDate ?? '');
  if (!Number.isFinite(resolvesAtMs)) return null;
  const strikes: LadderStrike[] = [];
  for (const m of event.markets ?? []) {
    const strike = Number(String(m.groupItemTitle ?? '').replace(/[^0-9.]/g, ''));
    let yes = NaN;
    try {
      yes = Number((JSON.parse(m.outcomePrices ?? '') as string[])[0]);
    } catch { /* a market without prices is left out of the ladder */ }
    if (strike > 0 && Number.isFinite(yes)) strikes.push({ strike, yes });
  }
  return { resolvesAtMs, strikes };
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** The move the ladder prices for `asset`. Throws when it cannot be read: an unread ladder is not a calm market. */
export async function getExpectedMove(asset: string, now: number = Date.now()): Promise<ExpectedMove> {
  const series = LADDER_SERIES[asset];
  if (!series) throw new Error(`no strike ladder for ${asset}`);
  const res = await fetch(
    `${POLYMARKET_API}/events?series_id=${series}&closed=false&limit=20&order=endDate&ascending=true`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`strike ladder ${asset}: upstream ${res.status}`);
  const events = (await res.json()) as VenueEvent[];
  const ladders = (Array.isArray(events) ? events : []).map(toLadder).filter((l): l is NonNullable<typeof l> => l !== null);
  const candidates = ladderCandidates(ladders, now);
  if (candidates.length === 0) {
    throw new Error(`strike ladder ${asset}: none resolves ${MIN_HOURS_AHEAD} to ${MAX_HOURS_AHEAD} hours ahead`);
  }
  for (const ladder of candidates) {
    const reading = readLadder(ladder.strikes);
    if (!reading) continue;
    return {
      resolvesAt: new Date(ladder.resolvesAtMs).toISOString(),
      movePct: round(reading.width * 100, 2),
      downside: reading.downside.map((d) => ({ price: d.price, chancePct: round(d.chance * 100, 1) })),
      strikes: reading.strikes,
    };
  }
  throw new Error(`strike ladder ${asset}: not readable`);
}
