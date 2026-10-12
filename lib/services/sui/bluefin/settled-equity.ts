/**
 * What a fill actually cost or earned, read from the venue account.
 *
 * Until 2026-10 a close recorded the position's mark-to-market just before
 * the order, with the fee read as zero, whenever the venue's response carried
 * no figure. The live trader's rows then showed -$3.66 over 227 trades while
 * the account had lost several times that: fees and the exit fill were never
 * in the record.
 *
 * "Settled equity" is the account's cash plus the margin locked in isolated
 * positions. Opening or closing a position moves value between those two, so
 * their sum changes only by what the fill settled: realised P&L, less fees.
 * Unrealised P&L of positions that stay open is in neither, so they do not
 * disturb the difference.
 */

export interface AccountSnapshot {
  settledEquityUsd: number;
  /** Size per `SYMBOL` as the account reports it; a symbol with no position is absent. */
  sizes: Record<string, number>;
}

const e9 = (v: unknown): number => {
  const n = v === undefined || v === null || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n / 1e9 : NaN;
};

/** Throws when a figure it needs is missing: an absent balance is unknown, not zero. */
export function accountSnapshot(data: unknown): AccountSnapshot {
  const d = data as { assets?: Array<{ symbol?: string; quantityE9?: unknown }>; positions?: Array<Record<string, unknown>> } | null;
  const usdc = d?.assets?.find((a) => a.symbol === 'USDC');
  const cash = e9(usdc?.quantityE9);
  if (!Number.isFinite(cash)) throw new Error('venue account has no USDC balance figure');
  if (!Array.isArray(d?.positions)) throw new Error('venue account has no positions list');
  let isolated = 0;
  const sizes: Record<string, number> = {};
  for (const p of d!.positions!) {
    const size = e9(p.sizeE9);
    if (!Number.isFinite(size)) throw new Error('venue position has no size figure');
    if (typeof p.symbol === 'string') sizes[p.symbol] = size;
    if (p.isIsolated === true) {
      const m = e9(p.isolatedMarginE9);
      if (!Number.isFinite(m)) throw new Error('isolated position has no margin figure');
      isolated += m;
    }
  }
  return { settledEquityUsd: cash + isolated, sizes };
}

export interface SettledReader {
  walletAddress: string | null;
  apiRequest<T>(method: 'GET' | 'POST', path: string, body: unknown, apiType: 'exchange' | 'trade'): Promise<T>;
}

/** Null when the account could not be read or understood. */
export async function readAccountSnapshot(ctx: SettledReader): Promise<AccountSnapshot | null> {
  try {
    return accountSnapshot(await ctx.apiRequest<unknown>('GET', `/api/v1/account?accountAddress=${ctx.walletAddress}`, undefined, 'exchange'));
  } catch {
    return null;
  }
}

/**
 * A difference in settled equity is only the fill's result if nothing else
 * moved the account in the same seconds (a deposit, another position closing).
 * Fees and slippage on a fill are a few basis points of its notional; a
 * difference far from the mark-based estimate is something else.
 */
export function plausibleSettled(settledUsd: number, estimateUsd: number, notionalUsd: number): boolean {
  if (!Number.isFinite(settledUsd)) return false;
  return Math.abs(settledUsd - estimateUsd) <= Math.max(0.25, Math.abs(notionalUsd) * 0.02);
}

/**
 * Settled result of a fill: equity after less equity before, once the account
 * shows the position at its new size. Null when it cannot be established;
 * the caller then keeps its estimate and says so.
 */
export async function settledDeltaUsd(args: {
  ctx: SettledReader;
  before: AccountSnapshot | null;
  symbol: string;
  /** True once the account's size for the symbol reflects the fill. */
  reflectsFill: (sizeNow: number) => boolean;
  estimateUsd: number;
  notionalUsd: number;
  attempts?: number;
  waitMs?: number;
}): Promise<number | null> {
  if (!args.before) return null;
  const attempts = args.attempts ?? 3;
  for (let i = 0; i < attempts; i++) {
    const after = await readAccountSnapshot(args.ctx);
    if (after && args.reflectsFill(after.sizes[args.symbol] ?? 0)) {
      const delta = after.settledEquityUsd - args.before.settledEquityUsd;
      return plausibleSettled(delta, args.estimateUsd, args.notionalUsd) ? delta : null;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, args.waitMs ?? 500));
  }
  return null;
}
