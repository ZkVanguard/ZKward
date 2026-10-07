/**
 * Admin: seed a SimpleUsdcVault(V2) with test USDC to scale demo NAV.
 *
 * Works against the Hedera testnet vault.
 * Mints `amount` USDC to the operator, approves the vault, deposits.
 * CRON_SECRET-gated — not public.
 *
 * POST body: { chain: 'hedera', amount?: number }
 * Response : { txMint, txApprove, txDeposit, totalAssetsUsdc, explorerUrl }
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { cronSecretMatches } from '@/lib/security/cron-auth';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const DECIMALS = 6;

interface ChainConfig {
  usdc: string;
  vault: string;
  rpc: string;
  keyEnvVar: 'HEDERA_OPERATOR_KEY' | 'PRIVATE_KEY';
  explorerTxUrl: (hash: string) => string;
  gasFee: () => Promise<Record<string, unknown>>;
}

async function getChain(chain: 'hedera'): Promise<ChainConfig> {
  const { ethers } = await import('ethers');
  if (chain === 'hedera') {
    return {
      usdc: HEDERA_CONTRACT_ADDRESSES.testnet.usdtToken,
      vault: HEDERA_CONTRACT_ADDRESSES.testnet.communityPool,
      rpc: 'https://testnet.hashio.io/api',
      keyEnvVar: 'HEDERA_OPERATOR_KEY',
      explorerTxUrl: (h) => `https://hashscan.io/testnet/transaction/${h}`,
      // Hashio min gas price is ~1110 gwei; use 1500 for headroom.
      gasFee: async () => ({
        gasLimit: 800_000,
        maxFeePerGas: ethers.parseUnits('1500', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
        type: 2 as const,
      }),
    };
  }
  throw new Error(`Unsupported chain: ${chain}`);
}

const ABI_USDC = [
  'function mint(address to, uint256 amount) external',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];
const ABI_VAULT = [
  'function deposit(uint256 amount) external returns (uint256 shares)',
  'function totalAssets() view returns (uint256)',
];

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!cronSecretMatches(request.headers.get('authorization') || '', process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { chain?: 'hedera'; amount?: number } = {};
  try { body = (await request.json()) as typeof body; } catch { /* default */ }
  const chain = body.chain ?? 'hedera';
  if (chain !== 'hedera') {
    return NextResponse.json({ error: `unsupported chain: ${chain}` }, { status: 400 });
  }
  const human = Math.max(1, Math.min(1_000_000, Number(body.amount ?? 10_000)));

  const cfg = await getChain(chain);
  const key = (process.env[cfg.keyEnvVar] || '').trim();
  if (!key) return NextResponse.json({ error: `${cfg.keyEnvVar} missing` }, { status: 503 });

  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(cfg.rpc);
    const wallet = new ethers.Wallet(key.startsWith('0x') ? key : '0x' + key, provider);

    const usdc = new ethers.Contract(cfg.usdc, ABI_USDC, wallet);
    const vault = new ethers.Contract(cfg.vault, ABI_VAULT, wallet);
    const amount = ethers.parseUnits(String(human), DECIMALS);
    const fee = await cfg.gasFee();

    const t1 = await usdc.mint(wallet.address, amount, fee);
    await t1.wait();
    const t2 = await usdc.approve(cfg.vault, amount, fee);
    await t2.wait();
    const t3 = await vault.deposit(amount, fee);
    await t3.wait();

    const totalAssets = await vault.totalAssets();
    logger.info('[admin/seed-vault] deposited', { chain, human, txDeposit: t3.hash });

    return NextResponse.json({
      ok: true,
      chain,
      amount: human,
      operator: wallet.address,
      txMint: t1.hash,
      txApprove: t2.hash,
      txDeposit: t3.hash,
      totalAssetsUsdc: Number(ethers.formatUnits(totalAssets, DECIMALS)),
      explorerUrl: cfg.explorerTxUrl(t3.hash),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('[admin/seed-vault] failed', { chain, error: msg });
    return NextResponse.json({ error: msg.slice(0, 400) }, { status: 500 });
  }
}
