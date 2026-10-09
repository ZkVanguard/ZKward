/**
 * Perp venue client for the Solana pool's sleeve — plain signed REST, no SDK.
 *
 * The venue is an order-book perp exchange settled on Solana. Reads are
 * public. A write is a JSON body signed with an Ed25519 key: the signed
 * bytes are the compact JSON of `{ timestamp, expiry_window, type, data }`
 * with every level's keys sorted, and the signature travels base58-encoded
 * beside the unwrapped fields.
 *
 * Two keys, on purpose. `SOLANA_PERPS_ACCOUNT` is the account that holds
 * the collateral; only its public address is ever configured here.
 * `SOLANA_PERPS_SIGNER_SECRET` is an API agent key bound to that account on
 * the venue: it can trade for the account, and the account's own key never
 * reaches this server. If the signer IS the account, the request is signed
 * as the account itself.
 *
 * Money fields are strings on the wire and are parsed with `num`, which
 * throws on anything that is not a finite number: an absent field is an
 * error here, never a zero.
 */
import * as crypto from 'crypto';
import { base58Decode, base58Encode } from './cluster';

export type PerpNetwork = 'mainnet' | 'testnet';
export type PerpSide = 'LONG' | 'SHORT';

const HOSTS: Record<PerpNetwork, string> = {
  mainnet: 'https://api.pacifica.fi',
  testnet: 'https://test-api.pacifica.fi',
};
const TIMEOUT_MS = 10_000;
const EXPIRY_WINDOW_MS = 30_000;

/** Test network unless mainnet is named: real orders are an explicit choice. */
export function perpNetwork(): PerpNetwork {
  return (process.env.SOLANA_PERPS_NETWORK || '').trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'testnet';
}

export const perpAccount = (): string => (process.env.SOLANA_PERPS_ACCOUNT || '').trim();

export const perpVenueConfigured = (): boolean =>
  !!perpAccount() && !!(process.env.SOLANA_PERPS_SIGNER_SECRET || '').trim();

function num(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) throw new Error(`perp venue: ${field} is not a number`);
  return n;
}

// ── Signing ──────────────────────────────────────────────────────────

/** Every level's keys in alphabetical order; arrays keep their order. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object).sort().map((k) => [k, sortKeysDeep((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The exact bytes the venue verifies for one operation. */
export function signingMessage(type: string, data: Record<string, unknown>, timestamp: number, expiryWindow: number): string {
  return JSON.stringify(sortKeysDeep({ timestamp, expiry_window: expiryWindow, type, data }));
}

interface Signer {
  publicKey: string;
  sign(message: string): string;
}

let cachedSigner: Signer | null = null;

/** The 32-byte seed from either keypair format wallets export: a JSON byte array or base58. */
function seedFromSecret(raw: string): Uint8Array {
  const bytes = raw.startsWith('[') ? new Uint8Array(JSON.parse(raw) as number[]) : base58Decode(raw);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('SOLANA_PERPS_SIGNER_SECRET is not an Ed25519 key');
  return bytes.slice(0, 32);
}

export function signerFromSecret(raw: string): Signer {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedFromSecret(raw))]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
  return {
    publicKey: base58Encode(new Uint8Array(spki.subarray(spki.length - 32))),
    sign: (message) => base58Encode(new Uint8Array(crypto.sign(null, Buffer.from(message, 'utf8'), key))),
  };
}

function signer(): Signer {
  if (cachedSigner) return cachedSigner;
  const raw = (process.env.SOLANA_PERPS_SIGNER_SECRET || '').trim();
  if (!raw) throw new Error('SOLANA_PERPS_SIGNER_SECRET not configured');
  cachedSigner = signerFromSecret(raw);
  return cachedSigner;
}

/** The request body for a signed operation: the signature header beside the operation's own fields. */
export function signedBody(
  type: string,
  data: Record<string, unknown>,
  opts: { account: string; signer: Signer; now?: number },
): Record<string, unknown> {
  const timestamp = opts.now ?? Date.now();
  return {
    account: opts.account,
    // An agent key signs for the account and says so; the account's own key does not.
    agent_wallet: opts.signer.publicKey === opts.account ? null : opts.signer.publicKey,
    signature: opts.signer.sign(signingMessage(type, data, timestamp, EXPIRY_WINDOW_MS)),
    timestamp,
    expiry_window: EXPIRY_WINDOW_MS,
    ...data,
  };
}

// ── Transport ────────────────────────────────────────────────────────

interface Envelope<T> {
  success?: boolean;
  data?: T;
  error?: string | null;
  code?: number | null;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${HOSTS[perpNetwork()]}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as (Envelope<T> & Record<string, unknown>) | null;
  if (!res.ok || !json || json.success === false || (typeof json.error === 'string' && json.error)) {
    throw new Error(`perp venue ${path}: ${json?.error || `HTTP ${res.status}`}`);
  }
  // Reads wrap their payload in `data`; an accepted order answers with its fields at the top.
  return (json.data ?? json) as T;
}

// ── Reads ────────────────────────────────────────────────────────────

export interface PerpMarket {
  symbol: string;
  /** Order sizes are multiples of this many tokens. */
  lotSize: number;
  /** Smallest order, in dollars. */
  minOrderUsd: number;
  maxLeverage: number;
}

export async function getMarket(symbol: string): Promise<PerpMarket> {
  const rows = await call<Array<Record<string, unknown>>>('GET', '/api/v1/info');
  const row = rows.find((r) => r.symbol === symbol);
  if (!row) throw new Error(`perp venue: no ${symbol} market`);
  return {
    symbol,
    lotSize: num(row.lot_size, 'lot_size'),
    minOrderUsd: num(row.min_order_size, 'min_order_size'),
    maxLeverage: num(row.max_leverage, 'max_leverage'),
  };
}

export async function getMarkPrice(symbol: string): Promise<number> {
  const rows = await call<Array<Record<string, unknown>>>('GET', '/api/v1/info/prices');
  const row = rows.find((r) => r.symbol === symbol);
  if (!row) throw new Error(`perp venue: no ${symbol} price`);
  return num(row.mark, 'mark');
}

export interface PerpPosition {
  symbol: string;
  side: PerpSide;
  /** Tokens, always positive; the side carries the direction. */
  size: number;
  entryPrice: number;
}

export async function getPositions(account: string = perpAccount()): Promise<PerpPosition[]> {
  const rows = await call<Array<Record<string, unknown>>>('GET', `/api/v1/positions?account=${encodeURIComponent(account)}`);
  return rows.map((r) => ({
    symbol: String(r.symbol),
    side: r.side === 'bid' ? 'LONG' : 'SHORT',
    size: num(r.amount, 'amount'),
    entryPrice: num(r.entry_price, 'entry_price'),
  }));
}

export interface PerpAccount {
  /** Settled dollars: moves only by realized profit, fees, funding, deposits and withdrawals. */
  balanceUsd: number;
  equityUsd: number;
  availableToSpendUsd: number;
}

export async function getAccount(account: string = perpAccount()): Promise<PerpAccount> {
  const r = await call<Record<string, unknown>>('GET', `/api/v1/account?account=${encodeURIComponent(account)}`);
  return {
    balanceUsd: num(r.balance, 'balance'),
    equityUsd: num(r.account_equity, 'account_equity'),
    availableToSpendUsd: num(r.available_to_spend, 'available_to_spend'),
  };
}

// ── Writes ───────────────────────────────────────────────────────────

/** A request id the venue accepts (UUID shape), the same for every retry of one of our order ids. */
export function clientOrderId(orderId: string): string {
  const h = crypto.createHash('sha256').update(orderId).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Tokens for a dollar amount, rounded DOWN to the market's lot so an order never exceeds what was asked. */
export function sizeForNotional(notionalUsd: number, price: number, lotSize: number): number {
  if (!(notionalUsd > 0) || !(price > 0) || !(lotSize > 0)) return 0;
  const lots = Math.floor(notionalUsd / price / lotSize + 1e-9);
  const decimals = Math.max(0, Math.ceil(-Math.log10(lotSize)));
  return Number((lots * lotSize).toFixed(decimals));
}

/**
 * Send a market order. Returns the venue's order id, which only says the
 * order was ACCEPTED: the caller decides whether it filled from the change
 * in the account's position.
 */
export async function submitMarketOrder(args: {
  symbol: string;
  side: PerpSide;
  size: number;
  reduceOnly: boolean;
  orderId: string;
  slippagePercent?: number;
}): Promise<{ orderId: number }> {
  const data = {
    symbol: args.symbol,
    amount: String(args.size),
    side: args.side === 'LONG' ? 'bid' : 'ask',
    slippage_percent: String(args.slippagePercent ?? 0.5),
    reduce_only: args.reduceOnly,
    client_order_id: clientOrderId(args.orderId),
  };
  const r = await call<Record<string, unknown>>(
    'POST',
    '/api/v1/orders/create_market',
    signedBody('create_market_order', data, { account: perpAccount(), signer: signer() }),
  );
  return { orderId: num(r.order_id, 'order_id') };
}

/** Test hook: forget the cached signer after the environment changes. */
export function __resetPerpSignerForTests(): void {
  cachedSigner = null;
}
