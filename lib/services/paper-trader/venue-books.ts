/**
 * Paper books on the perp venue's TEST network (the user's direction, 2026-11-14: only paper trading is
 * simulated, and it runs on the Solana test network; nothing else is mocked).
 *
 * A book listed in PAPER_VENUE_BOOKS places real orders on the venue's test network instead of
 * simulating them. What the rows record is what the venue did:
 *   • Each book trades from its own venue subaccount, so positions never net across books. The
 *     subaccount's key is derived from the configured test key and the book's id: one secret, one
 *     account per book. `scripts/_local/paper-money-2026-11-12/12-venue-book-accounts.ts` creates and
 *     funds them.
 *   • A lot's entry and exit are the venue's own fills for our order id (trades/history): size,
 *     volume-weighted price and fee. An accepted order is not a fill; a lot exists only once its fill does.
 *   • A lot's close order id is fixed by the lot, so a retry finds the first attempt's fill instead of
 *     sending a second order; each tick reconciles the venue's position with the rows (reconcileVenueBook).
 *   • A lot's funding is its share of the subaccount's real funding payments while it was open
 *     (payout × lot size ÷ position size at each payment).
 *   • A book's value is read from the venue: its start, plus what it carried from before it moved,
 *     plus the subaccount's equity over the capital it was funded with.
 * Only the test network is ever used: a book is on the venue only when SOLANA_PERPS_NETWORK=testnet.
 */
import * as crypto from 'crypto';
import {
  cancelOrder, clientOrderId, getAccount, getFills, getFundingHistory, getMarket, getMarkPrice, getOrderHistory, getPositions,
  perpNetwork, perpVenueConfigured, priceOnTick, seedFromSecret, signerFromSeed, sizeForNotional, submitLimitOrder, submitMarketOrder,
  type VenueActor, type VenueFill, type VenueOrder,
} from '@/lib/services/venue/perp-venue';
import type { Side, SimulatedCloseResult, SimulatedPosition } from './simulated-executor';

/** Test USDP each book's subaccount is funded with. A book's gain is its equity over this. */
export const VENUE_BOOK_CAPITAL_USD = 12_000;
/** Recorded on each row the venue filled. */
export const VENUE_EXECUTION = 'venue-testnet';
const FILL_WAIT_MS = 30_000;
/**
 * Venue orders one book sends in one tick. Each waits for its fill (a few seconds), and the whole fast tick has
 * 60 s; what is left waits for the next tick, a minute later.
 */
export const VENUE_ORDERS_PER_TICK = 2;
const POLL_MS = 2_000;
const FINISHED = new Set(['filled', 'cancelled', 'canceled', 'rejected', 'expired']);

/** The books that trade on the venue: PAPER_VENUE_BOOKS ("-10,-11,-12"), and only on the test network. */
export function venueBookIds(env: NodeJS.ProcessEnv = process.env): Set<number> {
  if ((env.SOLANA_PERPS_NETWORK || '').trim().toLowerCase() !== 'testnet') return new Set();
  return new Set((env.PAPER_VENUE_BOOKS || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n < 0));
}

export function onVenue(portfolioId: number): boolean {
  return venueBookIds().has(portfolioId) && perpVenueConfigured() && perpNetwork() === 'testnet';
}

/** A book's subaccount, derived from the configured test key and the book's id. */
export function bookActor(portfolioId: number, secret: string = process.env.SOLANA_PERPS_SIGNER_SECRET || ''): VenueActor {
  const main = seedFromSecret(secret.trim());
  const seed = crypto.createHash('sha256').update(`zkward-paper-book:${portfolioId}:`).update(main).digest();
  const signer = signerFromSeed(new Uint8Array(seed));
  return { account: signer.publicKey, signer };
}

/** The close order id of a lot: one per lot, so a retry of the close is the same order. */
export const closeOrderIdOf = (lotOrderId: string): string => `${lotOrderId}:close`;

export interface VenueDeps {
  getOrderHistory: typeof getOrderHistory;
  getFills: typeof getFills;
  sleep: (ms: number) => Promise<void>;
}
const DEPS: VenueDeps = { getOrderHistory, getFills, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const isRateLimit = (e: unknown) => /HTTP 429/.test(e instanceof Error ? e.message : String(e));

/** One of our orders on the venue, or null if the venue has no such order. A rate limit is waited out. */
async function findOrder(account: string, orderId: string, deps: VenueDeps): Promise<VenueOrder | null> {
  const cid = clientOrderId(orderId);
  return (await deps.getOrderHistory(account, 200)).find((o) => o.clientOrderId === cid) ?? null;
}

/** Size, volume-weighted price and fee of one order's fills; null while the fills do not add up to its filled size. */
async function fillsOf(account: string, orderId: string, filledSize: number, deps: VenueDeps): Promise<{ size: number; price: number; feeUsd: number } | null> {
  const cid = clientOrderId(orderId);
  const fills = (await deps.getFills(account, 200)).filter((f: VenueFill) => f.clientOrderId === cid);
  const size = fills.reduce((s, f) => s + f.size, 0);
  if (!(size > 0) || Math.abs(size - filledSize) > 1e-9 * Math.max(1, size)) return null;
  return { size, price: fills.reduce((s, f) => s + f.size * f.price, 0) / size, feeUsd: fills.reduce((s, f) => s + f.feeUsd, 0) };
}

/** The venue's fills for one of our market orders, once it is finished. Throws if it never shows. */
export async function settledFill(account: string, orderId: string, deps: VenueDeps = DEPS): Promise<{ size: number; price: number; feeUsd: number }> {
  for (let waited = 0; waited <= FILL_WAIT_MS; waited += POLL_MS) {
    try {
      const order = await findOrder(account, orderId, deps);
      if (order && FINISHED.has(order.status)) {
        if (!(order.filledSize > 0)) return { size: 0, price: 0, feeUsd: 0 };
        const fill = await fillsOf(account, orderId, order.filledSize, deps);
        if (fill) return fill;
      }
    } catch (e) {
      if (!isRateLimit(e)) throw e;
    }
    await deps.sleep(POLL_MS);
  }
  throw new Error(`venue: order ${orderId} did not settle within ${FILL_WAIT_MS / 1000}s`);
}

/** Open one lot with a market order on the book's subaccount; the position is the venue's fill. */
export async function venueOpenLot(portfolioId: number, asset: string, side: Side, notionalUsd: number, orderId: string, now: number): Promise<SimulatedPosition> {
  if (perpNetwork() !== 'testnet') throw new Error('venue: paper books trade the test network only');
  const actor = bookActor(portfolioId);
  const [market, mark] = await Promise.all([getMarket(asset), getMarkPrice(asset)]);
  const size = sizeForNotional(notionalUsd, mark, market.lotSize);
  if (!(size * mark >= market.minOrderUsd)) throw new Error(`venue: ${asset} lot of $${notionalUsd} is under the venue's minimum`);
  await submitMarketOrder({ symbol: asset, side, size, reduceOnly: false, orderId, as: actor });
  const fill = await settledFill(actor.account, orderId);
  if (!(fill.size > 0)) throw new Error(`venue: ${asset} ${side} order ${orderId} did not fill`);
  return {
    asset, side, entryPrice: fill.price, size: fill.size, notionalUsd: fill.size * fill.price, leverage: 1,
    openedAt: now, openFeeUsd: fill.feeUsd, slippageOpenUsd: 0,
  };
}

/** A lot's share of the subaccount's funding payments on its coin while it was open. */
export async function lotFundingUsd(account: string, pos: Pick<SimulatedPosition, 'asset' | 'size' | 'openedAt'>, now: number, deps = { getFundingHistory }): Promise<number> {
  const payments = await deps.getFundingHistory(account, 500);
  return payments
    .filter((p) => p.symbol === pos.asset && p.atMs > pos.openedAt && p.atMs <= now && p.positionSize > 0)
    .reduce((s, p) => s + p.payoutUsd * Math.min(1, pos.size / p.positionSize), 0);
}

/** The result of closing a lot at `fill`, with its funding. */
export function closeResult(pos: SimulatedPosition, fill: { size: number; price: number; feeUsd: number }, fundingUsd: number, now: number): SimulatedCloseResult {
  const grossPnlUsd = (fill.price - pos.entryPrice) * fill.size * (pos.side === 'LONG' ? 1 : -1);
  return {
    asset: pos.asset, side: pos.side, entryPrice: pos.entryPrice, exitPrice: fill.price, notionalUsd: pos.notionalUsd, size: fill.size,
    holdSeconds: Math.round(Math.max(0, now - pos.openedAt) / 1000), grossPnlUsd,
    openFeeUsd: pos.openFeeUsd, closeFeeUsd: fill.feeUsd, slippageUsd: 0, fundingUsd,
    realizedPnlUsd: grossPnlUsd - pos.openFeeUsd - fill.feeUsd + fundingUsd,
  };
}

/**
 * Close one lot with a reduce-only market order whose id is fixed by the lot. A close an earlier tick already
 * sent is not sent again: its fill is read instead.
 */
export async function venueCloseLot(portfolioId: number, pos: SimulatedPosition, lotOrderId: string, now: number, deps: VenueDeps = DEPS): Promise<SimulatedCloseResult> {
  const actor = bookActor(portfolioId);
  const closeId = closeOrderIdOf(lotOrderId);
  if (!(await findOrder(actor.account, closeId, deps))) {
    await submitMarketOrder({ symbol: pos.asset, side: pos.side === 'LONG' ? 'SHORT' : 'LONG', size: pos.size, reduceOnly: true, orderId: closeId, as: actor });
  }
  const fill = await settledFill(actor.account, closeId, deps);
  if (!(fill.size > 0)) throw new Error(`venue: close of ${pos.asset} lot ${lotOrderId} did not fill`);
  return closeResult(pos, fill, await lotFundingUsd(actor.account, pos, now), now);
}

export interface VenueLot { orderId: string; position: SimulatedPosition }

/**
 * Hold the rows and the venue to the same position, before a book trades:
 *   • a lot whose close already filled on the venue (a tick that failed after sending it) comes back closed,
 *     with its fill, for the book to settle;
 *   • exposure the venue holds beyond the rows' lots (an open whose fill was never recorded) is flattened
 *     with a reduce-only market order, since no row owns it.
 */
export async function reconcileVenueBook(portfolioId: number, lots: readonly VenueLot[], now: number, deps: VenueDeps = DEPS): Promise<{ closed: Array<{ lot: VenueLot; result: SimulatedCloseResult }>; flattened: string[] }> {
  const actor = bookActor(portfolioId);
  const closed: Array<{ lot: VenueLot; result: SimulatedCloseResult }> = [];
  for (const lot of lots) {
    const order = await findOrder(actor.account, closeOrderIdOf(lot.orderId), deps);
    if (!order || !FINISHED.has(order.status) || !(order.filledSize > 0)) continue;
    const fill = await fillsOf(actor.account, closeOrderIdOf(lot.orderId), order.filledSize, deps);
    if (fill) closed.push({ lot, result: closeResult(lot.position, fill, await lotFundingUsd(actor.account, lot.position, now), now) });
  }
  const open = lots.filter((l) => !closed.some((c) => c.lot.orderId === l.orderId));
  const flattened: string[] = [];
  for (const p of await getPositions(actor.account)) {
    const rows = open.filter((l) => l.position.asset === p.symbol);
    const rowsSigned = rows.reduce((s, l) => s + (l.position.side === 'LONG' ? 1 : -1) * l.position.size, 0);
    const venueSigned = (p.side === 'LONG' ? 1 : -1) * p.size;
    const excess = venueSigned - rowsSigned;
    const market = await getMarket(p.symbol);
    // Only exposure in the same direction as the venue's, beyond the rows', is unowned.
    if (Math.sign(excess) !== Math.sign(venueSigned) || Math.abs(excess) < market.lotSize) continue;
    const size = Number(Math.min(Math.abs(excess), p.size).toFixed(Math.max(0, Math.ceil(-Math.log10(market.lotSize)))));
    await submitMarketOrder({ symbol: p.symbol, side: p.side === 'LONG' ? 'SHORT' : 'LONG', size, reduceOnly: true, orderId: `reconcile_${portfolioId}_${p.symbol}_${Math.floor(now / 1000)}`, as: actor });
    flattened.push(`${p.symbol} ${p.side} ${size}`);
  }
  return { closed, flattened };
}

/** The book's trading value from the venue: start + carried + (subaccount equity − its capital). */
export async function venueBookValueUsd(portfolioId: number, startUsd: number, carriedUsd: number): Promise<number> {
  const { equityUsd } = await getAccount(bookActor(portfolioId).account);
  if (!(equityUsd > 0)) throw new Error(`venue: book ${portfolioId}'s subaccount holds nothing; fund it first`);
  return startUsd + carriedUsd + (equityUsd - VENUE_BOOK_CAPITAL_USD);
}

// ── Resting entries (the lead and proven books) ──────────────────────

/** Rest a post-only limit order at `price` for `notionalUsd`; the venue refuses it rather than let it take. */
export async function venuePlaceEntry(portfolioId: number, asset: string, side: Side, notionalUsd: number, price: number, orderId: string): Promise<void> {
  if (perpNetwork() !== 'testnet') throw new Error('venue: paper books trade the test network only');
  const market = await getMarket(asset);
  const size = sizeForNotional(notionalUsd, price, market.lotSize);
  if (!(size * price >= market.minOrderUsd)) throw new Error(`venue: ${asset} entry of $${notionalUsd} is under the venue's minimum`);
  await submitLimitOrder({ symbol: asset, side, size, price: priceOnTick(price, market.tickSize, side), tif: 'ALO', reduceOnly: false, orderId, as: bookActor(portfolioId) });
}

/**
 * A resting entry's state on the venue. Once it has expired, the rest is cancelled and what filled (if anything)
 * comes back as the position.
 */
export async function venueEntryState(
  portfolioId: number, asset: string, side: Side, orderId: string, expired: boolean, now: number, deps: VenueDeps = DEPS,
): Promise<{ state: 'resting' } | { state: 'gone' } | { state: 'filled'; position: SimulatedPosition }> {
  const actor = bookActor(portfolioId);
  let order = await findOrder(actor.account, orderId, deps);
  if (!order) return { state: expired ? 'gone' : 'resting' };
  if (!FINISHED.has(order.status) && !expired) return { state: 'resting' };
  if (!FINISHED.has(order.status)) {
    await cancelOrder({ symbol: asset, orderId, as: actor }).catch(() => undefined);
    order = (await findOrder(actor.account, orderId, deps)) ?? order;
  }
  if (!(order.filledSize > 0)) return { state: 'gone' };
  const fill = await fillsOf(actor.account, orderId, order.filledSize, deps);
  if (!fill) return { state: 'resting' };
  return {
    state: 'filled',
    position: { asset, side, entryPrice: fill.price, size: fill.size, notionalUsd: fill.size * fill.price, leverage: 1, openedAt: now, openFeeUsd: fill.feeUsd, slippageOpenUsd: 0 },
  };
}
