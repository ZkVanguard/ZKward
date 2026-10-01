'use client';

/**
 * Shape of /api/solana-pool/status plus the one cached query every Solana
 * pool component reads (react-query dedupes, so the cards share a fetch).
 */
import { useQuery } from '@tanstack/react-query';

export interface SolanaDepositRow {
  signature: string;
  sender: string;
  amount: number;
  shares: number;
  slot: number;
  blockTime: string | null;
}

export interface SolanaSleevePosition {
  orderId: string;
  asset: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  notionalUsd: number;
  markPrice: number | null;
  unrealizedPnlUsd: number | null;
  openedAt: number;
}

export interface SolanaSleeve {
  trades: number;
  wins: number;
  winRatePct: number | null;
  pendingBuybackUsd: number;
  position: SolanaSleevePosition | null;
}

export interface SolanaPoolStatus {
  enabled: boolean;
  testnet?: boolean;
  cluster?: string;
  vaultAta?: string | null;
  tokenMint?: string | null;
  rpcUrl?: string;
  vaultTokens?: number | null;
  accountedTokens?: number;
  pendingTokens?: number;
  solvent?: boolean | null;
  totalShares?: number;
  sharePrice?: number;
  tokenUsd?: number | null;
  navUsd?: number | null;
  memberCount?: number;
  sleeve?: SolanaSleeve | null;
  recentDeposits?: SolanaDepositRow[];
  error?: string;
}

export function useSolanaPoolStatus() {
  return useQuery({
    queryKey: ['solana-pool-status'],
    queryFn: async (): Promise<SolanaPoolStatus> => {
      const r = await fetch('/api/solana-pool/status', { cache: 'no-store' });
      return (await r.json()) as SolanaPoolStatus;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

export const shortAddr = (s: string, head = 4, tail = 4) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

export const explorerTx = (sig: string, cluster = 'devnet') =>
  `https://explorer.solana.com/tx/${sig}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;

export const explorerAddress = (addr: string, cluster = 'devnet') =>
  `https://explorer.solana.com/address/${addr}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;
