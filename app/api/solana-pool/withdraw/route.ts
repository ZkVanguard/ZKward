/**
 * Withdrawals — the pool pays out vault tokens for burned shares.
 *
 * Ownership proof, not sessions: the wallet signs a single-use nonce that
 * BINDS the amount (`zkward-solana-withdraw:<nonce>:<sharesUi>`), and the
 * server verifies the ed25519 signature with node:crypto against the
 * wallet's public key.
 *
 * Reserve, then pay. The shares are burned in the ledger as a pending row
 * before anything is signed, the payout's own signature is stored before it
 * is sent, and the row becomes final only when the chain shows the
 * transfer. The old order (check, pay, record) paid twice when two requests
 * raced or when a confirmation timed out after the transfer had landed.
 *
 * GET  ?wallet=<pubkey>                          → { nonce } (5-min TTL, single use)
 * POST { wallet, sharesUi, signatureHex }        → 200 { txSignature, amountUi }
 *                                                  202 { pending, txSignature } when the chain has not answered yet
 */
import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { envFlag } from '@/lib/utils/env-flag';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { mutationLimiter, readLimiter } from '@/lib/security/rate-limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NONCE_TTL_MS = 5 * 60 * 1000;
/** Wait this long for the chain before answering "pending"; the function's own limit is 60 s. */
const CONFIRM_WAIT_MS = 40_000;
const nonceKey = (wallet: string) => `solana-pool:wnonce:${wallet}`;

function bad(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(request);
  if (limited) return limited;
  if (!envFlag('SOLANA_POOL_ENABLED')) return bad(404, 'pool disabled');
  const wallet = (request.nextUrl.searchParams.get('wallet') || '').trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return bad(400, 'invalid wallet');
  const nonce = crypto.randomBytes(16).toString('hex');
  await setCronState(nonceKey(wallet), { nonce, exp: Date.now() + NONCE_TTL_MS });
  return NextResponse.json({ nonce, message: withdrawMessage(nonce, '<sharesUi>') });
}

const withdrawMessage = (nonce: string, sharesUi: string | number): string =>
  `zkward-solana-withdraw:${nonce}:${sharesUi}`;

/** Raw 32-byte ed25519 key → SPKI DER so node:crypto can verify. */
function ed25519SpkiFromRaw(raw32: Uint8Array): crypto.KeyObject {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, Buffer.from(raw32)]),
    format: 'der',
    type: 'spki',
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = mutationLimiter.check(request);
  if (limited) return limited;
  if (!envFlag('SOLANA_POOL_ENABLED')) return bad(404, 'pool disabled');
  try {
    const body = (await request.json()) as {
      wallet?: string;
      sharesUi?: number;
      signatureHex?: string;
    };
    const wallet = (body.wallet || '').trim();
    const sharesUi = Number(body.sharesUi);
    const sigHex = (body.signatureHex || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return bad(400, 'invalid wallet');
    if (!isFinite(sharesUi) || sharesUi <= 0) return bad(400, 'invalid sharesUi');
    if (!/^[0-9a-fA-F]{128}$/.test(sigHex)) return bad(400, 'invalid signature');

    const svc = await import('@/lib/services/solana/SolanaPoolService');
    if (svc.withdrawalsPaused()) return bad(503, 'withdrawals are paused');

    // Amount-bound message over a nonce the server issued to this wallet.
    // The nonce is consumed by the reservation below (its key), so a
    // replayed request collides there even if two arrive at once.
    const stored = await getCronState<{ nonce: string; exp: number }>(nonceKey(wallet));
    if (!stored || stored.exp < Date.now()) return bad(400, 'nonce expired — request a new one');
    const message = withdrawMessage(stored.nonce, sharesUi);

    const { PublicKey } = await import('@solana/web3.js');
    const pubRaw = new PublicKey(wallet).toBytes();
    const ok = crypto.verify(
      null,
      Buffer.from(message, 'utf8'),
      ed25519SpkiFromRaw(pubRaw),
      Buffer.from(sigHex, 'hex'),
    );
    if (!ok) return bad(401, 'signature verification failed');
    await setCronState(nonceKey(wallet), null);

    const db = await import('@/lib/db/solana-pool');
    const { fromUi, toUi, payoutForShares } = await import('@/lib/services/solana/pool-state');
    const { getTokenAccountBalance } = await import('@/lib/services/solana/rpc');

    const sharesRaw = fromUi(sharesUi);
    const owned = await db.getWalletSharesRaw(wallet);
    if (sharesRaw > owned) {
      return bad(400, `insufficient shares: own ${toUi(owned)}, requested ${sharesUi}`);
    }

    // Price off the ledger (pending uncredited deposits must not leak to
    // withdrawers); the chain balance is only the solvency check.
    const [accounted, totalShares, balance] = await Promise.all([
      db.getAccountedTokensRaw(),
      db.getTotalSharesRaw(),
      getTokenAccountBalance(svc.vaultAta()),
    ]);
    const amountRaw = payoutForShares(sharesRaw, accounted, totalShares);
    if (amountRaw <= 0n) return bad(400, 'payout rounds to zero');
    const cap = svc.maxWithdrawRaw();
    if (cap !== null && amountRaw > cap) {
      return bad(400, `one withdrawal is limited to ${toUi(cap).toLocaleString('en-US')} tokens; withdraw in parts`);
    }
    if (BigInt(balance.amount) < amountRaw) {
      return bad(503, 'vault holds less than the ledger owes — withdrawals paused');
    }

    // 1. Burn the shares. One pending withdrawal per wallet, keyed by the nonce.
    const reserved = await db.reserveWithdrawal({ nonce: stored.nonce, wallet, sharesBurnedRaw: sharesRaw, amountRaw });
    if (reserved === 'replay') return bad(409, 'this request was already used — start the withdrawal again');
    if (reserved === 'busy') return bad(409, 'another withdrawal for this wallet is still being confirmed — try again in a minute');
    const unsignedId = db.reservationId(stored.nonce);
    // The reservation is now counted: a balance below zero means a
    // withdrawal settled between the check above and the reservation.
    if ((await db.getWalletSharesRaw(wallet)) < 0n) {
      await db.releaseWithdrawal(unsignedId);
      return bad(400, 'insufficient shares');
    }

    // 2. Sign, and store the signature before the transfer exists.
    const signer = await import('@/lib/services/solana/signer');
    let payout: Awaited<ReturnType<typeof signer.signVaultPayout>>;
    try {
      payout = await signer.signVaultPayout(wallet, amountRaw);
    } catch (e) {
      await db.releaseWithdrawal(unsignedId); // nothing was sent
      throw e;
    }
    if (!(await db.attachPayoutSignature(stored.nonce, payout.signature, payout.lastValidBlockHeight))) {
      return bad(409, 'the withdrawal was cancelled before it was sent — start again');
    }

    // 3. Send. Whatever happens next, the chain is asked what became of it.
    let outcome: 'paid' | 'released' | 'pending';
    try {
      const sent = await Promise.race([
        signer.sendSignedPayout(payout),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), CONFIRM_WAIT_MS)),
      ]);
      if (sent === 'confirmed') {
        await db.settleWithdrawal(payout.signature);
        outcome = 'paid';
      } else {
        outcome = await svc.resolvePayout({ signature: payout.signature, lastValidBlockHeight: payout.lastValidBlockHeight, ageSeconds: 0 });
      }
    } catch (sendErr) {
      logger.warn('[SolanaPool] payout outcome unknown after send, asking the chain', { error: errMsg(sendErr) });
      outcome = await svc
        .resolvePayout({ signature: payout.signature, lastValidBlockHeight: payout.lastValidBlockHeight, ageSeconds: 0 })
        .catch(() => 'pending' as const);
    }

    const cluster = svc.solanaCluster();
    logger.info('[SolanaPool] withdrawal', { outcome, wallet: wallet.slice(0, 8), sharesUi, amountUi: toUi(amountRaw), tx: payout.signature.slice(0, 16) });
    if (outcome === 'paid') {
      if (cluster === 'mainnet-beta') {
        const { notifyDiscord } = await import('@/lib/utils/discord-notify');
        void notifyDiscord(
          `[SolanaPool] withdrawal paid: ${toUi(amountRaw).toLocaleString('en-US')} tokens to ${wallet.slice(0, 8)}…`,
          'TRADE',
          { chain: 'solana', cluster, signature: payout.signature },
        ).catch(() => {});
      }
      return NextResponse.json({ txSignature: payout.signature, amountUi: toUi(amountRaw) });
    }
    if (outcome === 'released') {
      return bad(502, 'the network did not accept the payout; nothing was moved and your shares are unchanged — try again');
    }
    return NextResponse.json(
      { pending: true, txSignature: payout.signature, amountUi: toUi(amountRaw) },
      { status: 202 },
    );
  } catch (e) {
    // The detail stays in the log: an RPC or database error can carry a URL.
    logger.warn('[SolanaPool] withdraw failed', { error: errMsg(e) });
    return bad(500, 'the withdrawal could not be completed right now. If a payout was already sent it will reach your wallet and your shares will update within a minute; otherwise try again.');
  }
}
