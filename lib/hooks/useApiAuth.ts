'use client';

import { useCallback, useRef } from 'react';
import { useSignMessage } from '@/lib/evm-wallet/hooks';

/**
 * Session-cached wallet-signed auth headers for auth-guarded API routes
 * (requireAuth in lib/security/auth-middleware.ts).
 *
 * The user signs once per session; the same headers are reused for 4 min
 * (the verifier accepts signatures up to 5 min old). Components call
 * getAuthHeaders() before hitting the endpoint and merge the returned
 * headers into their fetch request.
 *
 * Throws 'Wallet not connected' when no address is available and
 * whatever the wallet layer throws when the user rejects the signature
 * prompt — callers should surface those to the user distinctly from
 * generic network errors.
 */
export function useApiAuth(address?: string | null) {
  const { signMessageAsync } = useSignMessage();
  const cacheRef = useRef<{ headers: Record<string, string>; expiresAt: number } | null>(null);

  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const now = Date.now();
    if (cacheRef.current && cacheRef.current.expiresAt > now) {
      return cacheRef.current.headers;
    }
    if (!address) throw new Error('Wallet not connected');
    const timestamp = Math.floor(now / 1000);
    const message = `ZKward AI Chat\n\nWallet: ${address}\ntimestamp:${timestamp}`;
    const signature = await signMessageAsync({ message });
    const headers = {
      'x-wallet-address': address,
      'x-wallet-signature': signature,
      'x-wallet-message': btoa(message),
    };
    cacheRef.current = { headers, expiresAt: now + 4 * 60_000 };
    return headers;
  }, [address, signMessageAsync]);

  return { getAuthHeaders };
}
