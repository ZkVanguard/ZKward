'use client';

/**
 * Shape of /api/solana-pool/status plus the one cached query every Solana
 * pool component reads (react-query dedupes, so the cards share a fetch).
 */
import { queryOptions, useQuery } from '@tanstack/react-query';

export interface SolanaDepositRow {
  signature: string;
  sender: string;
  amount: number;
  shares: number;
  slot: number;
  blockTime: string | null;
}

export interface SolanaMember {
  wallet: string;
  shares: number;
  percentage: number;
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
  /** Largest holders first, at most 25; memberCount is the full total. */
  members?: SolanaMember[];
  sleeve?: SolanaSleeve | null;
  recentDeposits?: SolanaDepositRow[];
  error?: string;
}

export const solanaPoolStatusQuery = queryOptions({
  queryKey: ['solana-pool-status'],
  queryFn: async (): Promise<SolanaPoolStatus> => {
      const r = await fetch('/api/solana-pool/status', { cache: 'no-store' });
      const body = (await r.json().catch(() => null)) as SolanaPoolStatus | null;
      // A failed read is an error, never an empty pool: the route answers 500
      // with `{ enabled, error }`, which used to render as "No members yet".
      if (!r.ok || !body || body.error) throw new Error(body?.error || `Pool status failed (${r.status})`);
      return body;
  },
  // The route waits out the database's own timeout before failing, so the
  // default three retries kept the cards "loading" for over a minute. The
  // 30 s refetch below is the retry.
  retry: false,
  staleTime: 15_000,
});

export function useSolanaPoolStatus() {
  return useQuery({ ...solanaPoolStatusQuery, refetchInterval: 30_000 });
}

export const shortAddr = (s: string, head = 4, tail = 4) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

export const explorerTx = (sig: string, cluster = 'devnet') =>
  `https://explorer.solana.com/tx/${sig}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;

export const explorerAddress = (addr: string, cluster = 'devnet') =>
  `https://explorer.solana.com/address/${addr}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}`;
