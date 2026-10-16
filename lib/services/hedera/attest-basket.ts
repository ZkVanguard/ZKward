/**
 * What `/api/hedera/attest-hedges` will write to the consensus topic. The
 * browser builds the basket, so the server holds it to real prices and sane
 * numbers: the topic is the project's public record, and each message costs
 * the operator's HBAR.
 */

export const ATTEST_ASSETS = ['BTC', 'ETH', 'SUI'] as const;
/** One message per this interval across all callers. */
export const ATTEST_MIN_INTERVAL_MS = 5 * 60_000;
/** An entry price further than this from the server's own price is not today's. */
const MAX_PRICE_DEVIATION = 0.01;
const MAX_LEVERAGE = 20;

export interface AttestPosition {
  symbol: string;
  side: string;
  entryPrice: number;
  notionalUsd: number;
  marginUsd: number;
  leverage: number;
  signalConfidence?: number;
}

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Null when the basket may be attested, else the reason. `livePrice` is the server's price per symbol. */
export function basketProblem(positions: AttestPosition[], navUsd: number, livePrice: Record<string, number>): string | null {
  if (!positive(navUsd)) return 'poolNavUsd must be > 0';
  if (positions.length === 0 || positions.length > ATTEST_ASSETS.length) return `1 to ${ATTEST_ASSETS.length} positions`;
  const seen = new Set<string>();
  for (const p of positions) {
    if (!(ATTEST_ASSETS as readonly string[]).includes(p.symbol)) return `unknown symbol ${String(p.symbol)}`;
    if (seen.has(p.symbol)) return `${p.symbol} twice`;
    seen.add(p.symbol);
    if (p.side !== 'LONG' && p.side !== 'SHORT') return `${p.symbol}: side must be LONG or SHORT`;
    if (!positive(p.entryPrice) || !positive(p.notionalUsd) || !positive(p.marginUsd)) return `${p.symbol}: prices and sizes must be positive numbers`;
    if (!positive(p.leverage) || p.leverage > MAX_LEVERAGE) return `${p.symbol}: leverage must be between 0 and ${MAX_LEVERAGE}`;
    if (p.signalConfidence !== undefined && !(Number.isFinite(p.signalConfidence) && p.signalConfidence >= 0 && p.signalConfidence <= 100)) {
      return `${p.symbol}: signalConfidence must be 0 to 100`;
    }
    const live = livePrice[p.symbol];
    if (!positive(live)) return `${p.symbol}: no server price to check against`;
    if (Math.abs(p.entryPrice / live - 1) > MAX_PRICE_DEVIATION) return `${p.symbol}: entry price ${p.entryPrice} is not the current price`;
  }
  return null;
}
