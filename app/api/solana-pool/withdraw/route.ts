/**
 * Withdrawals — the pool pays out vault tokens for burned shares.
 *
 * Ownership proof, not sessions: the wallet signs a single-use nonce that
 * BINDS the amount (`zkward-solana-withdraw:<nonce>:<sharesUi>`), the
 * server verifies the ed25519 signature with node:crypto against the
 * wallet's public key, burns shares in the ledger, and sends the SPL
 * transfer from the vault. Payout amount follows live share price
 * (vaultTokens/totalShares — 1:1 until buybacks exist).
 *
 * GET  ?wallet=<pubkey>                          → { nonce } (5-min TTL, single use)
 * POST { wallet, sharesUi, signatureHex }        → { txSignature, amountUi }
 */
import { NextRequest, NextResponse } from 'next/server';
import * as crypto from 'crypto';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { envFlag } from '@/lib/utils/env-flag';
import { getCronState, setCronState } from '@/lib/db/cron-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const NONCE_TTL_MS = 5 * 60 * 1000;
const nonceKey = (wallet: string) => `solana-pool:wnonce:${wallet}`;

function bad(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
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

    // Single-use nonce, amount-bound message
    const stored = await getCronState<{ nonce: string; exp: number }>(nonceKey(wallet));
    if (!stored || stored.exp < Date.now()) return bad(400, 'nonce expired — request a new one');
    await setCronState(nonceKey(wallet), null);
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

    const { getWalletSharesRaw, getTotalSharesRaw, recordWithdrawal } = await import(
      '@/lib/db/solana-pool'
    );
    const { fromUi, toUi, sharePrice } = await import('@/lib/services/solana/pool-state');
    const { getTokenAccountBalance } = await import('@/lib/services/solana/rpc');
    const { vaultAta, solanaCluster } = await import(
      '@/lib/services/solana/SolanaPoolService'
    );

    const sharesRaw = fromUi(sharesUi);
    const owned = await getWalletSharesRaw(wallet);
    if (sharesRaw > owned) {
      return bad(400, `insufficient shares: own ${toUi(owned)}, requested ${sharesUi}`);
    }

    // Payout at live share price (floor — the pool never overpays dust).
    const [balance, totalShares] = await Promise.all([
      getTokenAccountBalance(vaultAta()),
      getTotalSharesRaw(),
    ]);
    const p = sharePrice(BigInt(balance.amount), totalShares);
    const amountRaw = (sharesRaw * p.num) / p.den;
    if (amountRaw <= 0n) return bad(400, 'payout rounds to zero');

    const { transferFromVault } = await import('@/lib/services/solana/signer');
    const txSignature = await transferFromVault(wallet, amountRaw);
    await recordWithdrawal({
      signature: txSignature,
      wallet,
      sharesBurnedRaw: sharesRaw,
      amountRaw,
      cluster: solanaCluster(),
    });

    logger.info('[SolanaPool] withdrawal paid', {
      wallet: wallet.slice(0, 8),
      sharesUi,
      amountUi: toUi(amountRaw),
      tx: txSignature.slice(0, 16),
    });
    return NextResponse.json({ txSignature, amountUi: toUi(amountRaw) });
  } catch (e) {
    logger.warn('[SolanaPool] withdraw failed', { error: errMsg(e) });
    return bad(500, errMsg(e));
  }
}
