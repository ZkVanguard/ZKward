'use client';

/**
 * useUserSession — the single top-level hook for anything wallet-adjacent.
 *
 * Composes:
 *   - Privy auth state (ready, authenticated, isCreating)
 *   - Primary EVM address (Privy embedded > wagmi injected fallback)
 *   - Chain state (current chainId, needsChainSwitch to Hedera Testnet)
 *   - Identity (display name via /api/profile, auth method + email + joinedAt from Privy user)
 *   - Balances (HBAR, USDC, vault shares — reactive, 15s refetch)
 *   - Actions (refreshBalances, logout)
 *
 * Every dashboard surface that reasons about "the current user" should
 * read from THIS hook — one call, one object, everything coherent.
 * Individual pieces (useWalletProfile, useTokenBalances, etc.) remain
 * available for surfaces that only need a slice.
 *
 * Dashboard-only. Do not import from marketing routes — the Privy hooks
 * used here require PrivyProvider in the tree.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useChainId } from 'wagmi';
import { usePrivy, useLogout } from '@privy-io/react-auth';
import { usePrivyEmbeddedAddress, usePrivyEmbeddedStatus } from '@/lib/evm-wallet/usePrivyEmbeddedAddress';
import { useWalletProfile, useSetWalletProfile } from './useWalletProfile';
import { useTokenBalances, type TokenBalances } from './useTokenBalances';

const HEDERA_TESTNET_ID = 296;

export type AuthMethod = 'email' | 'google' | 'wallet' | null;

export interface UserSession {
  // Auth state
  ready: boolean;
  authenticated: boolean;
  isCreating: boolean;

  // Primary EVM address (Hedera Testnet)
  address: `0x${string}` | null;

  // Chain state
  chainId: number | null;
  needsChainSwitch: boolean; // true when connected but on wrong chain

  // Identity — populated only when authenticated
  displayName: string | null;
  authMethod: AuthMethod;
  emailAddress: string | null;
  joinedAt: Date | null;

  // Balances
  balances: TokenBalances;

  // Actions
  refreshBalances: () => void;
  logout: () => Promise<void>;
}

interface PrivyUserLike {
  email?: { address?: string } | null;
  google?: { email?: string; name?: string } | null;
  createdAt?: number | string;
}

/**
 * Derive a display name from a Privy user identity. Google `name` wins
 * (comes from OAuth profile, real full name); otherwise title-case the
 * email prefix. Returns null for wallet-only users — nothing to derive.
 */
function deriveDisplayName(user: PrivyUserLike | null): string | null {
  const googleName = user?.google?.name?.trim();
  if (googleName) return googleName.slice(0, 40);
  const email = user?.email?.address ?? user?.google?.email ?? null;
  if (!email) return null;
  const prefix = email.split('@')[0];
  if (!prefix) return null;
  const parts = prefix.split(/[.\-_]/).filter(Boolean);
  const nice = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  return (nice || prefix).slice(0, 40);
}

export function useUserSession(): UserSession {
  const address = usePrivyEmbeddedAddress();
  const privyStatus = usePrivyEmbeddedStatus();
  const chainId = useChainId();
  const { data: profile } = useWalletProfile(address);
  const balances = useTokenBalances(address);
  const { user } = usePrivy() as { user: PrivyUserLike | null };
  const { logout } = useLogout();
  const setProfile = useSetWalletProfile();

  // Auto-populate the wallet_profiles display name from the Privy user
  // identity the first time a Google/email user's embedded wallet lands
  // without a name. Without this, fresh users show as "no name set" in
  // the Leaderboard until they visit ProfileTab. Guarded per-address so
  // we don't fight a user who deliberately clears their name.
  const autoSetForAddress = useRef<string | null>(null);
  useEffect(() => {
    if (!privyStatus.ready || !privyStatus.authenticated || !address) return;
    if (profile === undefined) return; // still loading
    if (profile.displayName) return; // already named
    if (autoSetForAddress.current === address.toLowerCase()) return;
    const derived = deriveDisplayName(user);
    if (!derived) return;
    autoSetForAddress.current = address.toLowerCase();
    setProfile.mutate({ address, displayName: derived });
  }, [privyStatus.ready, privyStatus.authenticated, address, profile, user, setProfile]);

  return useMemo<UserSession>(() => {
    const emailAddress = user?.email?.address ?? user?.google?.email ?? null;
    const authMethod: AuthMethod =
      user?.google?.email ? 'google' :
      user?.email?.address ? 'email' :
      user ? 'wallet' :
      null;
    const joined = user?.createdAt ? new Date(user.createdAt) : null;
    return {
      ready: privyStatus.ready,
      authenticated: privyStatus.authenticated,
      isCreating: privyStatus.isCreating,
      address,
      chainId: chainId ?? null,
      needsChainSwitch: !!address && !!chainId && chainId !== HEDERA_TESTNET_ID,
      displayName: profile?.displayName ?? null,
      authMethod,
      emailAddress,
      joinedAt: joined && !isNaN(joined.getTime()) ? joined : null,
      balances,
      refreshBalances: balances.refetch,
      logout,
    };
  }, [
    privyStatus.ready,
    privyStatus.authenticated,
    privyStatus.isCreating,
    address,
    chainId,
    profile?.displayName,
    user,
    balances,
    logout,
  ]);
}
