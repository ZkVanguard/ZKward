/**
 * Proof that a wallet really deposited into or withdrew from the pool.
 *
 * The record-deposit and record-withdraw actions are called by the browser
 * after the wallet signs, so their body is untrusted. The pool contract emits
 * an event for every deposit and withdrawal, and only the contract can emit
 * it, so the event is the record: who, how much, how many shares.
 */
import { NextResponse } from 'next/server';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { logger } from '@/lib/utils/logger';
import type { ActionCtx, NetworkType } from './types';

export type PoolEventKind = 'UsdcDeposited' | 'UsdcWithdrawn';

export interface PoolTxProof {
  amountUsdc: number;
  shares: number;
}

export type PoolTxCheck =
  | ({ ok: true } & PoolTxProof)
  | { ok: false; reason: 'tx-failed' | 'no-pool-event' | 'not-your-transaction' | 'bad-event' };

interface TxLike {
  effects?: { status?: { status?: string } } | null;
  events?: Array<{ type?: string; packageId?: string; parsedJson?: unknown }> | null;
}

const USDC_SCALE = 1_000_000;

function sameAddress(a: string, b: string): boolean {
  try {
    return normalizeSuiAddress(a) === normalizeSuiAddress(b);
  } catch {
    return false;
  }
}

export function checkPoolTx(
  tx: TxLike,
  expect: { kind: PoolEventKind; packageId: string; moduleName: string; wallet: string },
): PoolTxCheck {
  if (tx.effects?.status?.status !== 'success') return { ok: false, reason: 'tx-failed' };

  const suffix = `::${expect.moduleName}::${expect.kind}`;
  // After a package upgrade the event type keeps the id of the package that
  // first defined it, while `packageId` is the package that ran. Either one
  // being ours means our code emitted it.
  const ours = (tx.events ?? []).filter((e) => {
    if (typeof e.type !== 'string' || !e.type.endsWith(suffix)) return false;
    const typePkg = e.type.slice(0, e.type.length - suffix.length);
    return sameAddress(typePkg, expect.packageId) || (!!e.packageId && sameAddress(e.packageId, expect.packageId));
  });
  if (ours.length === 0) return { ok: false, reason: 'no-pool-event' };

  let amountRaw = 0;
  let sharesRaw = 0;
  let mine = 0;
  for (const e of ours) {
    const j = (e.parsedJson ?? {}) as Record<string, unknown>;
    if (typeof j.member !== 'string' || !sameAddress(j.member, expect.wallet)) continue;
    const amount = Number(j.amount_usdc);
    const shares = Number(expect.kind === 'UsdcDeposited' ? j.shares_received : j.shares_burned);
    if (!Number.isFinite(amount) || !Number.isFinite(shares) || amount <= 0 || shares <= 0) {
      return { ok: false, reason: 'bad-event' };
    }
    amountRaw += amount;
    sharesRaw += shares;
    mine++;
  }
  if (mine === 0) return { ok: false, reason: 'not-your-transaction' };

  return { ok: true, amountUsdc: amountRaw / USDC_SCALE, shares: sharesRaw / USDC_SCALE };
}

/**
 * The whole front half of a record action: validate the two fields the body
 * may carry, answer a repeat of an already-recorded transaction, then prove
 * the transaction. Returns the response to send when the request stops here.
 */
export async function provePoolTx(
  ctx: ActionCtx,
  kind: PoolEventKind,
): Promise<NextResponse | { walletAddress: string; txDigest: string; proof: PoolTxProof }> {
  const { network, body } = ctx;
  const walletAddress = body.walletAddress;
  const txDigest = body.txDigest;

  if (typeof walletAddress !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(walletAddress)) {
    return NextResponse.json({ success: false, error: 'Valid SUI wallet address required (0x + 64 hex chars)' }, { status: 400 });
  }
  if (typeof txDigest !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(txDigest)) {
    return NextResponse.json({ success: false, error: 'txDigest of the on-chain transaction is required' }, { status: 400 });
  }

  const { txHashExists } = await import('@/lib/db/community-pool');
  if (await txHashExists(txDigest)) {
    return NextResponse.json({
      success: true,
      data: { walletAddress, message: 'Transaction already recorded (idempotent)' },
      chain: 'sui',
      network,
    });
  }

  let check: PoolTxCheck;
  try {
    check = await readPoolTxProof(network, txDigest, kind, walletAddress);
  } catch (err) {
    if (!(err instanceof PoolTxUnavailableError)) throw err;
    logger.warn('[SUI-API] Pool transaction could not be read', { kind, error: err.message });
    return NextResponse.json(
      { success: false, error: 'The transaction could not be read from the chain yet. Try again shortly.', chain: 'sui', network },
      { status: 503 },
    );
  }
  if (!check.ok) {
    logger.warn('[SUI-API] Pool transaction rejected', { kind, reason: check.reason, wallet: walletAddress.slice(0, 10) + '...' });
    return NextResponse.json(
      { success: false, error: 'That transaction is not a matching pool transaction by this wallet', reason: check.reason, chain: 'sui', network },
      { status: 403 },
    );
  }
  return { walletAddress, txDigest, proof: { amountUsdc: check.amountUsdc, shares: check.shares } };
}

export class PoolTxUnavailableError extends Error {}

/**
 * Read the transaction and check it. A node can lag a few seconds behind the
 * wallet that just executed, so a not-found is retried before giving up.
 * Throws PoolTxUnavailableError when the transaction cannot be read at all:
 * that is "try again", not "rejected".
 */
export async function readPoolTxProof(
  network: NetworkType,
  digest: string,
  kind: PoolEventKind,
  wallet: string,
): Promise<PoolTxCheck> {
  const { getSuiUsdcPoolService } = await import('@/lib/services/sui/SuiCommunityPoolService');
  const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
  const info = getSuiUsdcPoolService(network).getContractInfo();
  if (!info.packageId) throw new PoolTxUnavailableError('pool package id is not configured');

  const client = createFailoverSuiClient(network);
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
    try {
      const tx = await client.getTransactionBlock({ digest, options: { showEffects: true, showEvents: true } });
      return checkPoolTx(tx, { kind, packageId: info.packageId, moduleName: info.moduleName, wallet });
    } catch (err) {
      lastError = err;
    }
  }
  throw new PoolTxUnavailableError(
    `transaction ${digest} could not be read: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
