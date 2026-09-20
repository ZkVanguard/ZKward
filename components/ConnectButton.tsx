'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePathname } from 'next/navigation';
import { logger } from '@/lib/utils/logger';
import {
  Wallet,
  ChevronDown,
  ExternalLink,
  Copy,
  Check,
  LogOut,
  AlertTriangle,
} from 'lucide-react';
import {
  useWallets,
  useCurrentAccount,
  useConnectWallet,
  useDisconnectWallet,
  useCurrentWallet,
} from '@mysten/dapp-kit';
import type { WalletAccount, WalletWithRequiredFeatures } from '@mysten/wallet-standard';
import { useSuiSafe } from '@/app/sui-providers';
import { EvmConnectSection } from './EvmConnectSection';
import { PrivyConnectSection } from './PrivyConnectSection';
import { isPrivyEnabled } from '@/lib/evm-wallet/privy-config';
import {
  SUI_MOBILE_WALLETS,
  isMobileBrowser,
  buildMobileWalletLink,
  type MobileWalletOption,
} from '@/lib/utils/mobile-wallet'; // Safe hook wrapper for Sui wallet functionality
// ─── Sui wallet picker (desktop dropdown) ───────────────────────────────
// Renders every wallet dapp-kit's useWallets() returned. If none detected,
// surfaces the install links for the top three so the user is one click
// away from having a wallet. The click-outside layer closes on backdrop tap.
const SUI_INSTALL_LINKS: Array<{ name: string; url: string; icon: string }> = [
  { name: 'Slush', url: 'https://slush.app/download', icon: '💧' },
  { name: 'Suiet', url: 'https://suiet.app/', icon: '🟣' },
  { name: 'Sui Wallet', url: 'https://chromewebstore.google.com/detail/sui-wallet/opcgpfmipidbgpenhmajoajpbobppdil', icon: '🔵' },
];

function SuiWalletPicker({
  wallets,
  onPick,
  onClose,
}: {
  wallets: WalletWithRequiredFeatures[];
  onPick: (w: WalletWithRequiredFeatures) => void;
  onClose: () => void;
}) {
  const hasWallets = wallets.length > 0;
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute top-full mt-2 right-0 w-72 bg-white dark:bg-[#1c1c1e] border border-[#E5E5EA] dark:border-[#38383a] rounded-xl shadow-lg overflow-hidden z-50">
        <div className="p-3">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-[#4DA2FF] flex items-center justify-center text-white text-[10px] font-bold">SUI</div>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-label-primary dark:text-white truncate">
                {hasWallets ? 'Pick a wallet' : 'Install a wallet'}
              </div>
              <div className="text-[11px] text-label-tertiary">
                {hasWallets ? `${wallets.length} detected` : 'No SUI wallet found in this browser'}
              </div>
            </div>
          </div>

          {hasWallets ? (
            <div className="space-y-1.5">
              {wallets.map((w) => (
                <button
                  key={w.name}
                  onClick={() => onPick(w)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] active:scale-[0.98] transition-all"
                >
                  {w.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={w.icon} alt="" className="w-6 h-6 rounded flex-shrink-0" />
                  ) : (
                    <span className="w-6 h-6 rounded bg-[#4DA2FF]/10 flex items-center justify-center text-[12px]">💧</span>
                  )}
                  <span className="text-[13px] font-medium text-label-primary dark:text-white flex-1 text-left truncate">
                    {w.name}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-1.5">
              {SUI_INSTALL_LINKS.map((link) => (
                <a
                  key={link.name}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] active:scale-[0.98] transition-all"
                >
                  <span className="w-6 h-6 rounded bg-[#4DA2FF]/10 flex items-center justify-center text-[12px] flex-shrink-0">
                    {link.icon}
                  </span>
                  <span className="text-[13px] font-medium text-label-primary dark:text-white flex-1 text-left truncate">
                    Install {link.name}
                  </span>
                  <span className="text-[11px] text-label-tertiary flex-shrink-0">↗</span>
                </a>
              ))}
              <div className="mt-2 text-[10px] text-label-tertiary leading-relaxed">
                On mobile? Open this page inside a wallet app&apos;s browser.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function useSuiWalletSafe() {
  let wallets: WalletWithRequiredFeatures[] = [];
  let suiAccount: WalletAccount | null = null;
  let currentWallet: WalletWithRequiredFeatures | null = null;
  let connectionStatus = 'disconnected';
  let connectSui: (args: { wallet: WalletWithRequiredFeatures }) => void = () => {};
  let disconnectSui: () => void = () => {};
  let isConnectingSui = false;

  try {
    wallets = useWallets() || [];
    suiAccount = useCurrentAccount();
    const walletState = useCurrentWallet();
    currentWallet = walletState?.currentWallet || null;
    connectionStatus = walletState?.connectionStatus || 'disconnected';
    const connectState = useConnectWallet();
    connectSui = connectState?.mutate || (() => {});
    isConnectingSui = connectState?.isPending || false;
    const disconnectState = useDisconnectWallet();
    disconnectSui = disconnectState?.mutate || (() => {});
  } catch (e) {
    logger.warn('Sui wallet hooks unavailable', { component: 'ConnectButton', error: String(e) });
  }

  return {
    wallets,
    suiAccount,
    currentWallet,
    connectionStatus,
    connectSui,
    disconnectSui,
    isConnectingSui,
  };
}

export function ConnectButton() {
  const [showSelector, setShowSelector] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showNetworkHelp, setShowNetworkHelp] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setMounted(true);
    setIsMobile(isMobileBrowser());
  }, []);

  // Show the mobile-wallet chooser sheet (Slush / Sui Wallet / Suiet /
  // Ethos) instead of hardcoding a Slush redirect. State lives here
  // because it's paired with the mobile-branch of handleConnectSui.
  const [showMobileWallets, setShowMobileWallets] = useState(false);
  const [pendingMobileWallet, setPendingMobileWallet] = useState<string | null>(null);
  // Client-computed deep link. Recomputed on every mount so it always
  // reflects the current route (window.location.href changes as the
  // user navigates within the SPA before hitting Connect). Empty on
  // SSR; the anchor renders with # and gets filled once mounted.
  const [slushDeepLink, setSlushDeepLink] = useState<string>('#');
  useEffect(() => {
    if (mounted && showMobileWallets) {
      setSlushDeepLink(buildMobileWalletLink(SUI_MOBILE_WALLETS[0]) || '#');
    }
  }, [mounted, showMobileWallets]);

  // Sui wallet hooks
  const {
    wallets,
    suiAccount,
    currentWallet,
    connectionStatus,
    connectSui,
    disconnectSui,
    isConnectingSui,
  } = useSuiWalletSafe();

  // SUI network status
  const suiContext = useSuiSafe();
  const suiIsWrongNetwork = suiContext?.isWrongNetwork ?? false;
  const suiWalletNetwork = suiContext?.walletNetwork ?? null;
  const suiExpectedNetwork = suiContext?.network ?? 'mainnet';

  const suiAddress = suiAccount?.address ?? null;
  const isSuiConnected = connectionStatus === 'connected' && !!suiAddress;
  const walletName = currentWallet?.name ?? 'SUI';

  const suiWallets = wallets.filter((w) => w.chains?.some?.((c: string) => c.includes('sui')));

  const copyAddress = useCallback((addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, []);

  const truncate = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  // Desktop: if exactly one wallet detected, connect directly; if multiple,
  // show a picker; if none, offer the install-flow. Mobile: always show the
  // mobile-wallet sheet so the user picks which app to deeplink into.
  const handleConnectSui = useCallback(() => {
    if (isMobile) {
      setShowSelector(false);
      setShowMobileWallets(true);
      return;
    }
    if (suiWallets.length === 1) {
      connectSui({ wallet: suiWallets[0] });
      setShowSelector(false);
      return;
    }
    if (suiWallets.length > 1) {
      // Toggle the wallet picker so the user chooses which detected wallet.
      setShowSelector((v) => !v);
      return;
    }
    // No wallets detected. Prefer opening the install page over a
    // confirm() dialog which many browsers now suppress silently.
    window.open('https://slush.app/', '_blank', 'noopener,noreferrer');
  }, [isMobile, suiWallets, connectSui]);

  const pickSuiWallet = useCallback((wallet: WalletWithRequiredFeatures) => {
    connectSui({ wallet });
    setShowSelector(false);
  }, [connectSui]);

  // Called from the anchor's onClick. We don't preventDefault, we
  // just track pending state so the sheet can show "Opening Slush…".
  // The <a> element's `href` does the actual navigation, which is the
  // path iOS honors for universal-link → installed-app deep linking.
  const pickMobileWallet = useCallback((wallet: MobileWalletOption) => {
    setPendingMobileWallet(wallet.name);
  }, []);

  // Wait for client mount to avoid hydration mismatch
  const showSui = mounted && isSuiConnected;
  const showConnect = !showSui;

  // WagmiProvider only mounts inside /dashboard (per app/wallet-providers.tsx
  // — marketing routes don't pay the wallet SDK bundle cost). EvmConnectSection
  // reads wagmi hooks and would throw a WagmiProviderNotFoundError outside
  // that subtree, so gate it by pathname.
  const pathname = usePathname() ?? '';
  const canShowEvm = mounted && pathname.includes('/dashboard');
  // Privy layer (hackathon Priority 3). When configured, show the email/social
  // "Sign in" CTA as the primary path. That's the whole point of the
  // Privy Financial Flow track (hide onchain complexity from users).
  const privyOn = canShowEvm && isPrivyEnabled();

  return (
    <div className="relative">
      {/* SUI wallet connect sheet — bottom-sheet on mobile, centered
          card on desktop. Same layout scales 320px → 4K. */}
      {showMobileWallets && (
        <div
          className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center animate-fade-in"
          onClick={() => setShowMobileWallets(false)}
        >
          {/* Backdrop with soft SUI-blue tint so the sheet feels
              integrated with the brand rather than floating above a
              generic black scrim. */}
          <div className="absolute inset-0 bg-gradient-to-b from-[#4DA2FF]/10 via-black/50 to-black/60 backdrop-blur-md" />

          <div
            className="relative w-full sm:max-w-[420px] mx-auto sm:mx-4 bg-white dark:bg-[#1c1c1e] rounded-t-[28px] sm:rounded-[24px] shadow-2xl shadow-[#4DA2FF]/10 pb-safe sm:pb-0 min-w-0 overflow-hidden animate-slide-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Sheet-handle indicator on mobile */}
            <div className="sm:hidden flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-black/15 dark:bg-white/20" />
            </div>

            {/* Hero header — SUI gradient panel with wave motif */}
            <div className="relative overflow-hidden px-5 sm:px-6 pt-5 sm:pt-7 pb-5 bg-gradient-to-br from-[#4DA2FF] via-[#79C2FF] to-[#B0DDFF]">
              {/* Decorative drop background */}
              <div
                aria-hidden
                className="absolute -top-8 -right-8 w-40 h-40 rounded-full bg-white/10 blur-2xl"
              />
              <div
                aria-hidden
                className="absolute -bottom-16 -left-4 w-48 h-24 rounded-full bg-white/10 blur-3xl"
              />

              <div className="relative flex items-center gap-3">
                {/* SUI drop-shape mark */}
                <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-white/95 flex items-center justify-center shadow-lg shadow-[#4DA2FF]/30 flex-shrink-0">
                  <span className="text-[#4DA2FF] font-black text-lg sm:text-xl tracking-tight">
                    SUI
                  </span>
                </div>
                <div className="min-w-0">
                  <h3 className="text-white font-bold text-lg sm:text-xl tracking-tight truncate">
                    Connect to Vault
                  </h3>
                  <p className="text-white/85 text-xs sm:text-sm">SUI mainnet · Slush wallet</p>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="p-5 sm:p-6">
              <p className="text-[13px] sm:text-sm text-label-secondary dark:text-[#EBEBF0] leading-relaxed mb-5">
                Slush opens this page in its in-app browser where the vault can request signatures.
                Your route, network and deposit form all stay put.
              </p>

              {/*
                Primary action — MUST be an <a> not a <button>. iOS Safari
                only reliably triggers Slush's universal-link association
                when navigation originates from a real anchor click.
                window.location.assign() from a button onClick just opens
                my.slush.app in Safari and never launches the installed
                app. That was the "even with Slush installed nothing
                opens" report from 2026-07-12.
              */}
              <a
                href={slushDeepLink}
                onClick={() => pickMobileWallet(SUI_MOBILE_WALLETS[0])}
                aria-disabled={pendingMobileWallet !== null || slushDeepLink === '#'}
                className={`group w-full h-12 sm:h-14 rounded-2xl
                           bg-gradient-to-r from-[#4DA2FF] to-[#3F91E8]
                           hover:from-[#3F91E8] hover:to-[#2F80D7]
                           active:scale-[0.985]
                           text-white text-[15px] sm:text-base font-semibold
                           shadow-lg shadow-[#4DA2FF]/25
                           transition-all duration-200
                           flex items-center justify-center gap-2 min-w-0
                           ${pendingMobileWallet ? 'opacity-70 cursor-wait pointer-events-none' : ''}
                           ${slushDeepLink === '#' ? 'opacity-60 cursor-wait pointer-events-none' : ''}`}
              >
                {pendingMobileWallet ? (
                  <>
                    <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin flex-shrink-0" />
                    <span className="truncate">Opening {pendingMobileWallet}…</span>
                  </>
                ) : (
                  <>
                    <span className="truncate">Open in Slush</span>
                    <svg
                      viewBox="0 0 24 24"
                      className="w-4 h-4 flex-shrink-0 transition-transform group-hover:translate-x-0.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M5 12h14M13 5l7 7-7 7" />
                    </svg>
                  </>
                )}
              </a>

              {pendingMobileWallet && (
                <p className="text-[11px] sm:text-xs text-label-tertiary mt-3 text-center leading-relaxed">
                  If Slush didn&apos;t open, install it and try again.
                </p>
              )}

              {/* Small trust row. Three cues that this is safe */}
              <div className="mt-5 grid grid-cols-3 gap-1.5 sm:gap-3 text-[10px] sm:text-[11px] text-label-tertiary">
                <div className="flex flex-col items-center gap-1 text-center">
                  <span className="w-7 h-7 rounded-full bg-[#4DA2FF]/10 text-[#4DA2FF] flex items-center justify-center font-bold text-xs">
                    1
                  </span>
                  <span className="leading-tight">Opens Slush</span>
                </div>
                <div className="flex flex-col items-center gap-1 text-center">
                  <span className="w-7 h-7 rounded-full bg-[#4DA2FF]/10 text-[#4DA2FF] flex items-center justify-center font-bold text-xs">
                    2
                  </span>
                  <span className="leading-tight">Same page reloads</span>
                </div>
                <div className="flex flex-col items-center gap-1 text-center">
                  <span className="w-7 h-7 rounded-full bg-[#4DA2FF]/10 text-[#4DA2FF] flex items-center justify-center font-bold text-xs">
                    3
                  </span>
                  <span className="leading-tight">Tap Connect</span>
                </div>
              </div>

              {/* Footer actions */}
              <div className="mt-5 pt-5 border-t border-[#E5E5EA] dark:border-[#38383a] flex flex-col-reverse sm:flex-row gap-2">
                <button
                  onClick={() => {
                    setShowMobileWallets(false);
                    setPendingMobileWallet(null);
                  }}
                  className="h-11 sm:h-auto px-4 py-2 text-sm font-medium text-label-primary dark:text-white bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] active:scale-[0.98] rounded-xl transition-all"
                >
                  Cancel
                </button>
                <a
                  href={SUI_MOBILE_WALLETS[0].installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 h-11 sm:h-auto px-4 py-2 text-sm font-medium text-center text-[#4DA2FF] bg-[#4DA2FF]/10 hover:bg-[#4DA2FF]/15 active:scale-[0.98] rounded-xl transition-all inline-flex items-center justify-center gap-1"
                >
                  Don&apos;t have Slush?
                  <span className="opacity-80">Install →</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Not connected. Hedera-primary pivot (2026-09-04). On /dashboard
          the EVM section (Hedera default) is the primary CTA; SUI is
          available as a smaller secondary link. When Privy is configured
          (Priority 3), the "Sign in with email" flow leads and the wallet
          connector becomes the advanced option. On marketing routes we
          fall back to the SUI-only connect since WagmiProvider isn't
          mounted there. */}
      {showConnect && canShowEvm && (
        <div className="relative flex items-center gap-2">
          {/* Privy is the ONLY EVM path — no wagmi injected fallback, no
              MetaMask picker. Every user signs in with email/Google and
              gets an embedded self-custodial wallet. The old
              EvmConnectSection is intentionally not rendered anywhere. */}
          <PrivyConnectSection />
          <button
            onClick={handleConnectSui}
            disabled={isConnectingSui}
            className="h-11 px-3 border border-black/10 dark:border-white/15 hover:bg-system-bg-secondary dark:hover:bg-[#2c2c2e] rounded-[12px] text-[13px] font-medium text-label-secondary dark:text-[#EBEBF0] active:scale-[0.98] disabled:opacity-70 flex items-center gap-1.5"
            title="Connect Sui wallet (secondary chain)"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[#4DA2FF]" />
            {isConnectingSui ? '…' : 'Sui'}
          </button>
          {showSelector && (
            <SuiWalletPicker
              wallets={suiWallets}
              onPick={pickSuiWallet}
              onClose={() => setShowSelector(false)}
            />
          )}
        </div>
      )}
      {showConnect && !canShowEvm && (
        <div className="relative">
          <button
            data-connect-cta="true"
            onClick={handleConnectSui}
            disabled={isConnectingSui}
            className="px-5 h-11 bg-ios-blue hover:bg-[#0062CC] active:scale-[0.98] disabled:opacity-70 text-white rounded-[12px] font-semibold text-[15px] transition-all flex items-center gap-2"
          >
            <Wallet className="w-4 h-4" />
            <span>{isConnectingSui ? 'Connecting…' : 'Connect'}</span>
          </button>
          {showSelector && (
            <SuiWalletPicker
              wallets={suiWallets}
              onPick={pickSuiWallet}
              onClose={() => setShowSelector(false)}
            />
          )}
        </div>
      )}

      {/* SUI Connected */}
      {showSui && suiAddress && (
        <>
          {suiIsWrongNetwork ? (
            <div className="relative">
              <button
                onClick={() => setShowNetworkHelp(!showNetworkHelp)}
                className="px-4 h-11 bg-[#FF3B30]/10 border border-[#FF3B30]/30 rounded-[12px] text-[#FF3B30] text-sm font-medium flex items-center gap-2"
              >
                <AlertTriangle className="w-4 h-4" />
                Wrong Network
              </button>

              {showNetworkHelp && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowNetworkHelp(false)} />
                  <div className="absolute top-full mt-2 right-0 w-72 bg-white dark:bg-[#1c1c1e] border border-[#E5E5EA] dark:border-[#38383a] rounded-xl shadow-lg overflow-hidden z-50 p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <AlertTriangle className="w-5 h-5 text-[#FF9500]" />
                      <h4 className="font-semibold text-label-primary dark:text-white">
                        Switch to {suiExpectedNetwork}
                      </h4>
                    </div>

                    <p className="text-[13px] text-label-tertiary mb-3">
                      Your wallet is on{' '}
                      <span className="font-medium text-label-primary dark:text-white">
                        {suiWalletNetwork || 'unknown'}
                      </span>
                      , but this app requires{' '}
                      <span className="font-medium text-[#4DA2FF]">{suiExpectedNetwork}</span>.
                    </p>

                    <div className="flex gap-2">
                      <button
                        onClick={() => {
                          disconnectSui();
                          setShowNetworkHelp(false);
                        }}
                        className="flex-1 py-2 bg-system-bg-secondary dark:bg-[#2c2c2e] rounded-lg text-[12px] font-medium"
                      >
                        Disconnect
                      </button>
                      <button
                        onClick={() => window.location.reload()}
                        className="flex-1 py-2 bg-[#4DA2FF] text-white rounded-lg text-[12px] font-medium"
                      >
                        Refresh
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="relative">
              <button
                onClick={() => setShowSelector(!showSelector)}
                className="h-11 bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] border border-black/5 dark:border-white/10 rounded-[12px] transition-colors flex items-center gap-2 px-3"
              >
                <div className="w-6 h-6 rounded-full bg-[#4DA2FF] flex items-center justify-center">
                  <span className="text-white font-bold text-[8px]">SUI</span>
                </div>
                <span className="text-label-primary dark:text-white font-medium text-[14px]">
                  {truncate(suiAddress)}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-label-tertiary" />
              </button>

              {showSelector && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSelector(false)} />
                  <div className="absolute top-full mt-2 right-0 w-56 bg-white dark:bg-[#1c1c1e] border border-[#E5E5EA] dark:border-[#38383a] rounded-xl shadow-lg overflow-hidden z-50">
                    <div className="p-3">
                      <div className="flex items-center gap-2.5 mb-3">
                        <div className="w-9 h-9 rounded-full bg-[#4DA2FF] flex items-center justify-center">
                          <span className="text-white font-bold text-[10px]">SUI</span>
                        </div>
                        <div>
                          <div className="font-medium text-label-primary dark:text-white text-[14px]">
                            {walletName}
                          </div>
                          <div className="text-[12px] text-label-tertiary font-mono">
                            {truncate(suiAddress)}
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-2 mb-2">
                        <button
                          onClick={() => copyAddress(suiAddress)}
                          className="flex-1 py-1.5 bg-system-bg-secondary dark:bg-[#2c2c2e] rounded-lg text-[12px] font-medium flex items-center justify-center gap-1"
                        >
                          {copied ? (
                            <Check className="w-3.5 h-3.5 text-[#34C759]" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          {copied ? 'Copied' : 'Copy'}
                        </button>
                        <a
                          href={`https://suiscan.xyz/${process.env.NEXT_PUBLIC_SUI_NETWORK || 'mainnet'}/address/${suiAddress}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1 py-1.5 bg-system-bg-secondary dark:bg-[#2c2c2e] rounded-lg text-[12px] font-medium flex items-center justify-center gap-1"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                          Explorer
                        </a>
                      </div>

                      <button
                        onClick={() => {
                          disconnectSui();
                          setShowSelector(false);
                        }}
                        className="w-full py-2 text-[#FF3B30] hover:bg-[#FF3B30]/5 rounded-lg text-[13px] font-medium flex items-center justify-center gap-1.5"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Disconnect
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
