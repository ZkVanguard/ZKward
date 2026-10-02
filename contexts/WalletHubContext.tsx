'use client';

/**
 * One source of truth for "what is connected" across the dashboard.
 *
 * Three wallet systems feed it: Privy (Hedera, embedded EVM wallet behind
 * the email/Google sign-in), dapp-kit (SUI browser wallets) and the injected
 * Phantom provider (Solana). Every surface asks the hub instead of its own
 * hook, so connecting once in the navbar counts everywhere. `openChooser`
 * is the single connect flow: the navbar opens it with no preference, a
 * section opens it pre-selected on the chain it needs.
 *
 * Dashboard-only: it relies on PrivyProvider + SuiWalletProviders from
 * app/wallet-providers.tsx, like useUserSession does.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLogin } from '@privy-io/react-auth';
import { useConnectWallet, useWallets } from '@mysten/dapp-kit';
import type { WalletWithRequiredFeatures } from '@mysten/wallet-standard';
import { useUserSession } from '@/lib/hooks/useUserSession';
import { useSuiSafe } from '@/app/sui-providers';
import { connectWallet as connectPhantom, getProvider as getPhantom } from '@/components/solana/wallet';
import { ChainChooser } from '@/components/wallet/ChainChooser';

export type WalletChain = 'hedera' | 'sui' | 'solana';
export const WALLET_CHAINS: readonly WalletChain[] = ['hedera', 'sui', 'solana'];

/** Plain-language copy for the chooser and the prompts. */
export const CHAIN_INFO: Record<WalletChain, { name: string; pool: string; how: string; cta: string; color: string; installUrl: string; installLabel: string }> = {
  hedera: {
    name: 'Hedera',
    pool: 'USDC pool on Hedera testnet',
    how: 'Sign in with email or Google. We create a wallet for you, nothing to install.',
    cta: 'Sign in',
    color: '#1d1d1f',
    installUrl: '',
    installLabel: '',
  },
  sui: {
    name: 'SUI',
    pool: 'Live USDC pool on SUI mainnet',
    how: 'Uses a SUI browser wallet such as Slush, Suiet or Ethos.',
    cta: 'Connect SUI wallet',
    color: '#4DA2FF',
    installUrl: 'https://slush.app/',
    installLabel: 'Get Slush',
  },
  solana: {
    name: 'Solana',
    pool: 'JIMP test pool on Solana devnet',
    how: 'Uses Phantom. Switch it to Devnet for the test pool.',
    cta: 'Connect Phantom',
    color: '#9945FF',
    installUrl: 'https://phantom.app/download',
    installLabel: 'Get Phantom',
  },
};

export interface ChainWallet {
  address: string | null;
  connected: boolean;
  /** Connecting, signing in, or the embedded wallet is still being created. */
  busy: boolean;
}

export interface ChooserState {
  open: boolean;
  chain: WalletChain | null;
  reason: string | null;
}

export type ConnectResult = { ok: true } | { ok: false; error: string };

export interface WalletHub {
  hedera: ChainWallet;
  sui: ChainWallet;
  solana: ChainWallet;
  anyConnected: boolean;
  /** SUI wallets the browser exposes; the chooser lists them when there is more than one. */
  suiWallets: WalletWithRequiredFeatures[];
  connect: (chain: WalletChain, pick?: WalletWithRequiredFeatures) => Promise<ConnectResult>;
  disconnect: (chain: WalletChain) => Promise<void>;
  chooser: ChooserState;
  openChooser: (opts?: { chain?: WalletChain; reason?: string }) => void;
  closeChooser: () => void;
  /** Last connect error per chain; the chooser shows it next to the install link. */
  errors: Partial<Record<WalletChain, string>>;
}

const Ctx = createContext<WalletHub | null>(null);

export function WalletHubProvider({ children }: { children: ReactNode }) {
  // Hedera: Privy session (embedded wallet) — the navbar's "Sign in".
  const session = useUserSession();
  const { login } = useLogin();

  // SUI: dapp-kit wallets + connect mutation (the same ones the navbar uses).
  const sui = useSuiSafe();
  const allWallets = useWallets();
  const { mutateAsync: connectSuiWallet, isPending: suiConnecting } = useConnectWallet();
  const suiWallets = useMemo(
    () => allWallets.filter((w) => w.chains?.some((c: string) => c.includes('sui'))),
    [allWallets],
  );

  // Solana: injected Phantom. State lives here so the pool card, the navbar
  // and the chooser all see the same address.
  const [solanaAddress, setSolanaAddress] = useState<string | null>(null);
  const [solanaBusy, setSolanaBusy] = useState(false);
  useEffect(() => {
    const p = getPhantom();
    if (!p) return;
    if (p.publicKey) {
      setSolanaAddress(p.publicKey.toBase58());
      return;
    }
    // Returning visitors reconnect silently if they already trusted the site.
    p.connect({ onlyIfTrusted: true })
      .then(({ publicKey }) => setSolanaAddress(publicKey.toBase58()))
      .catch(() => undefined);
  }, []);

  const [errors, setErrors] = useState<Partial<Record<WalletChain, string>>>({});
  const [chooser, setChooser] = useState<ChooserState>({ open: false, chain: null, reason: null });

  const hedera: ChainWallet = useMemo(
    () => ({
      address: session.address,
      connected: session.authenticated && !!session.address,
      busy: !session.ready || session.isCreating,
    }),
    [session.address, session.authenticated, session.ready, session.isCreating],
  );
  const suiWallet: ChainWallet = useMemo(
    () => ({ address: sui?.address ?? null, connected: !!sui?.isConnected && !!sui?.address, busy: suiConnecting || !!sui?.isConnecting }),
    [sui?.address, sui?.isConnected, sui?.isConnecting, suiConnecting],
  );
  const solana: ChainWallet = useMemo(
    () => ({ address: solanaAddress, connected: !!solanaAddress, busy: solanaBusy }),
    [solanaAddress, solanaBusy],
  );
  const connectedCount = Number(hedera.connected) + Number(suiWallet.connected) + Number(solana.connected);

  const connect = useCallback(
    async (chain: WalletChain, pick?: WalletWithRequiredFeatures): Promise<ConnectResult> => {
      setErrors((e) => ({ ...e, [chain]: undefined }));
      try {
        if (chain === 'hedera') {
          login();
          return { ok: true };
        }
        if (chain === 'sui') {
          const wallet = pick ?? (suiWallets.length === 1 ? suiWallets[0] : null);
          if (!wallet) {
            if (suiWallets.length === 0) throw new Error('No SUI wallet found in this browser.');
            // Several wallets detected: the chooser lists them, the user picks one.
            setChooser((c) => (c.open ? c : { open: true, chain: 'sui', reason: c.reason }));
            return { ok: true };
          }
          await connectSuiWallet({ wallet });
          return { ok: true };
        }
        setSolanaBusy(true);
        try {
          setSolanaAddress(await connectPhantom());
        } finally {
          setSolanaBusy(false);
        }
        return { ok: true };
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Could not connect';
        setErrors((prev) => ({ ...prev, [chain]: error }));
        return { ok: false, error };
      }
    },
    [login, suiWallets, connectSuiWallet],
  );

  const disconnect = useCallback(
    async (chain: WalletChain) => {
      if (chain === 'hedera') await session.logout();
      else if (chain === 'sui') sui?.disconnectWallet();
      else {
        await getPhantom()?.disconnect().catch(() => undefined);
        setSolanaAddress(null);
      }
    },
    [session, sui],
  );

  // The chooser closes itself once the user has connected what they came for:
  // the requested chain, or any new chain when opened without a preference.
  const countAtOpen = useRef(0);
  const openChooser = useCallback(
    (opts?: { chain?: WalletChain; reason?: string }) => {
      countAtOpen.current = connectedCount;
      setChooser({ open: true, chain: opts?.chain ?? null, reason: opts?.reason ?? null });
    },
    [connectedCount],
  );
  const closeChooser = useCallback(() => setChooser({ open: false, chain: null, reason: null }), []);
  useEffect(() => {
    if (!chooser.open) return;
    const wanted = chooser.chain;
    const satisfied = wanted
      ? (wanted === 'hedera' ? hedera : wanted === 'sui' ? suiWallet : solana).connected
      : connectedCount > countAtOpen.current;
    if (satisfied) closeChooser();
  }, [chooser.open, chooser.chain, hedera, suiWallet, solana, connectedCount, closeChooser]);

  const value = useMemo<WalletHub>(
    () => ({
      hedera,
      sui: suiWallet,
      solana,
      anyConnected: connectedCount > 0,
      suiWallets,
      connect,
      disconnect,
      chooser,
      openChooser,
      closeChooser,
      errors,
    }),
    [hedera, suiWallet, solana, connectedCount, suiWallets, connect, disconnect, chooser, openChooser, closeChooser, errors],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      <ChainChooser />
    </Ctx.Provider>
  );
}

export function useWalletHub(): WalletHub {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWalletHub must be used inside WalletHubProvider (dashboard only)');
  return v;
}

/** Null outside the dashboard (marketing routes don't mount the providers). */
export function useWalletHubSafe(): WalletHub | null {
  return useContext(Ctx);
}
