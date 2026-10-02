'use client';

/**
 * One active network per user, and one place that knows which.
 *
 * Three wallet systems feed the hub: Privy (Hedera, embedded EVM wallet
 * behind the email/Google sign-in), dapp-kit (SUI browser wallets) and the
 * injected Phantom provider (Solana). Exactly one chain is ACTIVE at a time:
 * choosing a network in the chooser makes it active and disconnects the
 * previous one, the choice is remembered on this device, and every surface
 * reads `activeChain` / `active` instead of its own hook. A surface that
 * needs a different chain guides the user to switch, never to "connect a
 * second wallet".
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
/** Which chain wins when several come back connected after a reload and no preference is stored. */
const ADOPTION_ORDER: readonly WalletChain[] = ['sui', 'hedera', 'solana'];
const ACTIVE_KEY = 'zkward.activeChain';
/** Set once the user has chosen (or dismissed the choice); the welcome chooser never shows again on this device. */
const ONBOARDED_KEY = 'zkward.onboarded';

/** Plain-language copy for the chooser, prompts and badges. */
export const CHAIN_INFO: Record<WalletChain, { name: string; net: string; pool: string; how: string; cta: string; color: string; installUrl: string; installLabel: string }> = {
  hedera: {
    name: 'Hedera',
    net: 'testnet',
    pool: 'USDC pool on Hedera testnet',
    how: 'Sign in with email or Google. We create a wallet for you, nothing to install.',
    cta: 'Sign in with Hedera',
    color: '#1d1d1f',
    installUrl: '',
    installLabel: '',
  },
  sui: {
    name: 'SUI',
    net: 'mainnet',
    pool: 'Live USDC pool on SUI mainnet',
    how: 'Uses a SUI browser wallet such as Slush, Suiet or Ethos.',
    cta: 'Use SUI',
    color: '#4DA2FF',
    installUrl: 'https://slush.app/',
    installLabel: 'Get Slush',
  },
  solana: {
    name: 'Solana',
    net: 'devnet',
    pool: 'JIMP test pool on Solana devnet',
    how: 'Uses Phantom. Switch it to Devnet for the test pool.',
    cta: 'Use Solana',
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
  /** First visit on this device: framed as a welcome, with a "browse first" exit. */
  welcome: boolean;
}

export type ConnectResult = { ok: true } | { ok: false; error: string };

export interface WalletHub {
  /** The one network in use. Set as soon as the user picks it, even while the wallet is still connecting. */
  activeChain: WalletChain | null;
  /** The active network's wallet; null until it is connected. */
  active: ChainWallet | null;
  /** activeChain is set and its wallet is connected. */
  isConnected: boolean;
  hedera: ChainWallet;
  sui: ChainWallet;
  solana: ChainWallet;
  /** SUI wallets the browser exposes; the chooser lists them when there is more than one. */
  suiWallets: WalletWithRequiredFeatures[];
  /** Switch to `chain`: disconnect the current network, make `chain` active, connect it. */
  connect: (chain: WalletChain, pick?: WalletWithRequiredFeatures) => Promise<ConnectResult>;
  disconnect: (chain: WalletChain) => Promise<void>;
  chooser: ChooserState;
  openChooser: (opts?: { chain?: WalletChain; reason?: string }) => void;
  closeChooser: () => void;
  /** Last connect error per chain; the chooser shows it next to the install link. */
  errors: Partial<Record<WalletChain, string>>;
}

const Ctx = createContext<WalletHub | null>(null);

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* per-device convenience only */
  }
}

function readStoredChain(): WalletChain | null {
  try {
    const v = localStorage.getItem(ACTIVE_KEY);
    return v && (WALLET_CHAINS as readonly string[]).includes(v) ? (v as WalletChain) : null;
  } catch {
    return null;
  }
}

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

  const [activeChain, setActiveChainState] = useState<WalletChain | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    const stored = readStoredChain();
    setActiveChainState(stored);
    setHydrated(true);
    // First visit on this device: ask which network to use, once. The
    // dashboard stays browsable behind it and the choice is never forced.
    if (!stored && !readFlag(ONBOARDED_KEY)) {
      setChooser({ open: true, chain: null, reason: null, welcome: true });
    }
  }, []);
  const setActive = useCallback((chain: WalletChain | null) => {
    setActiveChainState(chain);
    try {
      if (chain) localStorage.setItem(ACTIVE_KEY, chain);
      else localStorage.removeItem(ACTIVE_KEY);
    } catch {
      /* per-device convenience only */
    }
  }, []);

  const [errors, setErrors] = useState<Partial<Record<WalletChain, string>>>({});
  const [chooser, setChooser] = useState<ChooserState>({ open: false, chain: null, reason: null, welcome: false });

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
  const wallets = useMemo(() => ({ hedera, sui: suiWallet, solana }), [hedera, suiWallet, solana]);

  const disconnectRaw = useCallback(
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

  // Enforce "one network at a time". Runs whenever a connection appears or
  // drops: keeps the active chain, drops any other connected wallet, and
  // adopts a connected wallet when nothing is active (ADOPTION_ORDER).
  // Paused while a switch is in flight so the half-done state is not
  // mistaken for a user choice.
  const switching = useRef(false);
  useEffect(() => {
    if (!hydrated || !session.ready || switching.current) return;
    const connected = WALLET_CHAINS.filter((c) => wallets[c].connected);
    if (activeChain && wallets[activeChain].connected) {
      for (const other of connected) if (other !== activeChain) void disconnectRaw(other);
      return;
    }
    if (connected.length === 0) return;
    const pick = ADOPTION_ORDER.find((c) => connected.includes(c))!;
    setActive(pick);
    for (const other of connected) if (other !== pick) void disconnectRaw(other);
  }, [hydrated, session.ready, activeChain, wallets, disconnectRaw, setActive]);

  const connect = useCallback(
    async (chain: WalletChain, pick?: WalletWithRequiredFeatures): Promise<ConnectResult> => {
      setErrors((e) => ({ ...e, [chain]: undefined }));
      switching.current = true;
      writeFlag(ONBOARDED_KEY);
      try {
        for (const other of WALLET_CHAINS) if (other !== chain && wallets[other].connected) await disconnectRaw(other);
        setActive(chain);
        if (chain === 'hedera') {
          if (!wallets.hedera.connected) login();
          return { ok: true };
        }
        if (chain === 'sui') {
          if (wallets.sui.connected) return { ok: true };
          const wallet = pick ?? (suiWallets.length === 1 ? suiWallets[0] : null);
          if (!wallet) {
            if (suiWallets.length === 0) throw new Error('No SUI wallet found in this browser.');
            // Several wallets detected: the chooser lists them, the user picks one.
            setChooser((c) => (c.open ? c : { open: true, chain: 'sui', reason: c.reason, welcome: false }));
            return { ok: true };
          }
          await connectSuiWallet({ wallet });
          return { ok: true };
        }
        if (wallets.solana.connected) return { ok: true };
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
      } finally {
        switching.current = false;
      }
    },
    [wallets, disconnectRaw, setActive, login, suiWallets, connectSuiWallet],
  );

  const disconnect = useCallback(
    async (chain: WalletChain) => {
      await disconnectRaw(chain);
      if (chain === activeChain) setActive(null);
    },
    [disconnectRaw, activeChain, setActive],
  );

  const openChooser = useCallback((opts?: { chain?: WalletChain; reason?: string }) => {
    setChooser({ open: true, chain: opts?.chain ?? null, reason: opts?.reason ?? null, welcome: false });
  }, []);
  const closeChooser = useCallback(() => {
    writeFlag(ONBOARDED_KEY);
    setChooser({ open: false, chain: null, reason: null, welcome: false });
  }, []);
  // The chooser closes itself once the network the user came for is active and connected.
  const openedWith = useRef<{ chain: WalletChain | null; active: WalletChain | null; connected: boolean } | null>(null);
  useEffect(() => {
    if (!chooser.open) {
      openedWith.current = null;
      return;
    }
    if (!openedWith.current) {
      openedWith.current = { chain: chooser.chain, active: activeChain, connected: !!(activeChain && wallets[activeChain].connected) };
      return;
    }
    const o = openedWith.current;
    const target = o.chain ?? activeChain;
    const satisfied =
      !!target && activeChain === target && wallets[target].connected && (o.chain ? true : !(o.connected && o.active === target));
    if (satisfied) closeChooser();
  }, [chooser.open, chooser.chain, activeChain, wallets, closeChooser]);

  const active = activeChain ? wallets[activeChain] : null;
  const value = useMemo<WalletHub>(
    () => ({
      activeChain,
      active: active && active.connected ? active : null,
      isConnected: !!active?.connected,
      hedera,
      sui: suiWallet,
      solana,
      suiWallets,
      connect,
      disconnect,
      chooser,
      openChooser,
      closeChooser,
      errors,
    }),
    [activeChain, active, hedera, suiWallet, solana, suiWallets, connect, disconnect, chooser, openChooser, closeChooser, errors],
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
