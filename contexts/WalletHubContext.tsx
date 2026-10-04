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
import { CONSENT_EVENT, CONSENT_KEY } from '@/components/CookieConsent';
import { installedSuiWallets, suggestChain, type SuggestReason } from '@/lib/wallet/suggest-chain';
import { CHAIN_META, WALLET_CHAINS, type ChainMeta, type WalletChain } from '@/lib/wallet/chain-meta';

// Names, tiers, marks and colours live in a plain module so marketing
// pages can draw them without this provider's wallet SDKs.
export { WALLET_CHAINS };
export type { WalletChain };
/** Which chain wins when several come back connected after a reload and no preference is stored. */
const ADOPTION_ORDER: readonly WalletChain[] = ['sui', 'hedera', 'solana'];
const ACTIVE_KEY = 'zkward.activeChain';
/** Set once the user has chosen (or dismissed the choice); the welcome chooser never shows again on this device. */
const ONBOARDED_KEY = 'zkward.onboarded';

/** Chain facts plus the English copy a few prompts still use (the chooser reads `wallet.*`). */
export const CHAIN_INFO: Record<WalletChain, ChainMeta & { pool: string; how: string; cta: string; installLabel: string }> = {
  hedera: { ...CHAIN_META.hedera, pool: 'USDC pool on Hedera testnet', how: 'Sign in with email or Google. We create a wallet for you, nothing to install.', cta: 'Sign in with Hedera', installLabel: '' },
  sui: { ...CHAIN_META.sui, pool: 'Live USDC pool on SUI mainnet', how: 'Uses a SUI browser wallet such as Slush, Suiet or Ethos.', cta: 'Use SUI', installLabel: 'Get Slush' },
  solana: { ...CHAIN_META.solana, pool: 'JIMP test pool on Solana devnet', how: 'Uses Phantom. Switch it to Devnet for the test pool.', cta: 'Use Solana', installLabel: 'Get Phantom' },
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
  /** An injected Solana wallet (Phantom or compatible) is present. */
  solanaWalletFound: boolean;
  /** The network this visitor most likely wants, and why (lib/wallet/suggest-chain). */
  suggestion: { chain: WalletChain; reason: SuggestReason };
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
  const [solanaWalletFound, setSolanaWalletFound] = useState(false);
  useEffect(() => {
    const look = () => setSolanaWalletFound(!!getPhantom());
    look();
    const t = setTimeout(look, 1500);
    return () => clearTimeout(t);
  }, []);
  // `?chain=` on arrival and the last network used: read once, they are what the visitor came with.
  const [arrival, setArrival] = useState<{ link: WalletChain | null; last: WalletChain | null }>({ link: null, last: null });
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
    const linkParam = new URLSearchParams(window.location.search).get('chain');
    setArrival({
      link: linkParam && (WALLET_CHAINS as readonly string[]).includes(linkParam) ? (linkParam as WalletChain) : null,
      last: stored,
    });
    // First visit on this device: ask which network to use, once. The
    // dashboard stays browsable behind it and the choice is never forced.
    // One first-visit prompt at a time: it waits for the cookie choice.
    if (stored || readFlag(ONBOARDED_KEY)) return;
    const welcome = () => {
      if (!readFlag(ONBOARDED_KEY) && !readStoredChain()) setChooser({ open: true, chain: null, reason: null, welcome: true });
    };
    let cookiesDecided = false;
    try {
      cookiesDecided = localStorage.getItem(CONSENT_KEY) !== null;
    } catch {
      cookiesDecided = true;
    }
    if (cookiesDecided) {
      welcome();
      return;
    }
    window.addEventListener(CONSENT_EVENT, welcome, { once: true });
    return () => window.removeEventListener(CONSENT_EVENT, welcome);
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
        // The error is only shown in the chooser. Opening it here means a
        // connect button outside the chooser (the reconnect banner) never
        // fails silently: no wallet in a phone browser lands on the
        // wallet-app links, a locked or dismissed wallet on a retry.
        setChooser((c) => (c.open ? c : { open: true, chain, reason: null, welcome: false }));
        return { ok: false, error };
      } finally {
        switching.current = false;
      }
    },
    [wallets, disconnectRaw, setActive, login, suiWallets, connectSuiWallet],
  );

  // Arrived inside a wallet app's browser from a handoff link
  // (?connect=<chain>, lib/utils/mobile-wallet): connect as soon as that
  // wallet is visible, once, then drop the parameter so a reload does not
  // prompt again.
  const handoffDone = useRef(false);
  useEffect(() => {
    if (!hydrated || handoffDone.current) return;
    const params = new URLSearchParams(window.location.search);
    const want = params.get('connect');
    if (want !== 'solana' && want !== 'sui') return;
    const suiPick = suiWallets.find((w) => installedSuiWallets([w.name]).length > 0);
    if (want === 'solana' ? !solanaWalletFound : !suiPick) return;
    handoffDone.current = true;
    params.delete('connect');
    const q = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash);
    void connect(want, want === 'sui' ? suiPick : undefined);
  }, [hydrated, solanaWalletFound, suiWallets, connect]);

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

  const suiWalletNames = useMemo(() => suiWallets.map((w) => w.name), [suiWallets]);
  const suggestion = useMemo(
    () => suggestChain({ linkChain: arrival.link, lastChain: arrival.last, suiWallets: suiWalletNames, solanaWallet: solanaWalletFound }),
    [arrival, suiWalletNames, solanaWalletFound],
  );

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
      solanaWalletFound,
      suggestion,
    }),
    [activeChain, active, hedera, suiWallet, solana, suiWallets, connect, disconnect, chooser, openChooser, closeChooser, errors, solanaWalletFound, suggestion],
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
