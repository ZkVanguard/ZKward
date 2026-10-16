'use client';

/**
 * Wallet profile hook — single source of truth for display names.
 *
 * Every UI that shows or edits a wallet's display name should go through
 * this hook, not fetch `/api/profile` directly. Reason: React Query gives
 * us cache coherence — when the user edits their name in ProfileTab, the
 * NameAndAvatarRow inside the Pool tab (same query key) invalidates and
 * re-renders with the new name. No prop drilling, no manual sync.
 *
 * Also batches multiple simultaneous callers to the same address into
 * one request via React Query's built-in dedup.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSignMessage } from '@/lib/evm-wallet/hooks';

interface ProfileResponse {
  profiles?: Record<string, { displayName: string | null }>;
}

interface WriteResponse {
  ok?: boolean;
  error?: string;
}

export function walletProfileKey(address: string | null | undefined) {
  return ['wallet-profile', (address ?? '').toLowerCase()] as const;
}

/**
 * Read a single wallet's display name. Returns null while loading /
 * if no name is set.
 */
export function useWalletProfile(address: string | null | undefined) {
  return useQuery({
    queryKey: walletProfileKey(address),
    enabled: !!address && /^0x[a-fA-F0-9]{40}$/.test(address),
    queryFn: async (): Promise<{ displayName: string | null }> => {
      const r = await fetch(`/api/profile?addresses=${address}`);
      const j = (await r.json()) as ProfileResponse;
      const name = j.profiles?.[(address ?? '').toLowerCase()]?.displayName ?? null;
      return { displayName: name };
    },
    staleTime: 60_000,
  });
}

/**
 * Mutation to update the current user's display name. The wallet signs the
 * request: the server sets a name only for the wallet that signed. On
 * success invalidates the shared query key so every mounted useWalletProfile
 * refetches automatically.
 */
export function useSetWalletProfile() {
  const qc = useQueryClient();
  const { signMessageAsync } = useSignMessage();
  return useMutation({
    mutationFn: async (args: { address: string; displayName: string }): Promise<{ ok: boolean; error?: string }> => {
      const message = `ZKward Profile\n\nWallet: ${args.address}\ntimestamp:${Math.floor(Date.now() / 1000)}`;
      const signature = await signMessageAsync({ message });
      const r = await fetch('/api/profile', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-wallet-address': args.address,
          'x-wallet-signature': signature,
          'x-wallet-message': btoa(message),
        },
        body: JSON.stringify(args),
      });
      const j = (await r.json()) as WriteResponse;
      if (!j.ok) return { ok: false, error: j.error || 'save failed' };
      return { ok: true };
    },
    onSuccess: (_data, variables) => {
      // Force every consumer of this address's profile to refetch — the
      // NameAndAvatarRow in Pool tab, the ProfileTab, and any leaderboard
      // row that happens to hover the current user's address.
      qc.invalidateQueries({ queryKey: walletProfileKey(variables.address) });
      // Also invalidate the leaderboard so the enriched displayName field
      // reflects the change on next refresh.
      qc.invalidateQueries({ queryKey: ['leaderboard'] });
    },
  });
}
