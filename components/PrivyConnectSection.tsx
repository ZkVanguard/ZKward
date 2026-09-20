'use client';

/**
 * Privy connect section — email / social / embedded-wallet flow.
 *
 * Shown by ConnectButton when Privy is enabled (NEXT_PUBLIC_PRIVY_APP_ID
 * set). Renders BEFORE EvmConnectSection so the "log in with email" CTA
 * is the primary path — matches the "hide unnecessary onchain complexity"
 * criterion of the Privy Financial Flow prize track.
 *
 * When the user isn't logged in, we show "Sign in" that pops the Privy
 * modal with all configured login methods (email, Google, wallet).
 * When logged in, we show a compact account chip with logout + copy.
 */

import { useCallback, useState } from 'react';
import { usePrivy, useLogin, useLogout, useWallets, useLoginWithOAuth } from '@privy-io/react-auth';
import { Copy, Check, LogOut, Mail } from 'lucide-react';

// Match the site's primary CTA (Deposit USDC, Enter app, main nav links)
// so the Sign-in button reads as native chrome, not a Hedera-only feature.
// Kept as a hex constant instead of a Tailwind class so it can be passed to
// inline `style` alongside the shared button shape.
const PRIVY_ACCENT = '#0069D9'; // ios-blueHover — one shade darker for AA contrast on white
const PRIVY_ACCENT_HOVER = '#0055B3';

function truncate(addr: string | undefined): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export function PrivyConnectSection() {
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();
  const { logout } = useLogout();
  const { wallets } = useWallets();
  // Privy's built-in Google flow — driven by our OWN Google Cloud OAuth
  // client (Client ID + Secret pasted under Login methods → Google in
  // the Privy dashboard). Skipping Privy's shared credentials (which
  // fail on custom domains with redirect_uri_mismatch).
  const { initOAuth, loading: oauthLoading } = useLoginWithOAuth();
  const [showMenu, setShowMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  // Prefer the embedded wallet address when present; fall back to first
  // connected external wallet. This matches how Privy's own Universal
  // Wallet API resolves the "user's primary address."
  const primary = wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0];
  const address = primary?.address;

  const copyAddress = useCallback(() => {
    if (!address) return;
    navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  // Not yet initialized. Render an inert placeholder same size as the
  // final button so the navbar layout doesn't jump on hydration.
  if (!ready) {
    return (
      <div className="h-11 px-4 rounded-[12px] bg-system-bg-secondary dark:bg-[#2c2c2e] opacity-60 flex items-center gap-2">
        <div className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
        <span className="text-[13px] text-label-tertiary">Loading…</span>
      </div>
    );
  }

  if (!authenticated) {
    const onGoogle = async () => {
      setOauthError(null);
      try {
        // 'google' = Privy's built-in Google provider, wired against our
        // own Google Cloud OAuth client (dashboard → Login methods →
        // Google). Redirects to Google, then back to
        // https://auth.privy.io/api/v1/oauth/callback which finalises
        // the session on Privy's side, then to our origin.
        await initOAuth({ provider: 'google' });
      } catch (e) {
        setOauthError(e instanceof Error ? e.message : String(e));
      }
    };
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={onGoogle}
          disabled={oauthLoading}
          title="Continue with Google (Custom OAuth via Privy)"
          className="h-11 px-3 rounded-[12px] font-semibold text-[13px] active:scale-[0.98] flex items-center gap-2 bg-white border border-black/10 text-label-primary hover:bg-system-bg-secondary disabled:opacity-60"
        >
          {/* Google 'G' mark */}
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden>
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.8 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
            <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.2 34.7 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z"/>
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4 5.4l6.3 5.3c-.4.4 7.4-5.4 7.4-14.7 0-1.3-.1-2.4-.4-3.5z"/>
          </svg>
          {oauthLoading ? 'Redirecting…' : 'Google'}
        </button>
        <button
          onClick={() => login()}
          data-connect-cta="true"
          title="Sign in with email. Privy creates a self-custodial wallet in the background"
          className="h-11 px-4 rounded-[12px] font-semibold text-[15px] text-white active:scale-[0.98] flex items-center gap-2"
          style={{ background: PRIVY_ACCENT }}
        >
          <Mail className="w-4 h-4" />
          Sign in
        </button>
        {oauthError && (
          <span className="text-[10px] text-[#FF3B30] max-w-[200px] truncate" title={oauthError}>
            {oauthError.slice(0, 40)}
          </span>
        )}
      </div>
    );
  }

  const label = user?.email?.address ?? user?.google?.email ?? truncate(address);

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu((v) => !v)}
        className="h-11 bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] border border-black/5 dark:border-white/10 rounded-[12px] flex items-center gap-2 px-3"
      >
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
          style={{ background: PRIVY_ACCENT }}
        >
          {(label ?? '?').charAt(0).toUpperCase()}
        </div>
        <span className="text-label-primary dark:text-white font-medium text-[13px] max-w-[140px] truncate">
          {label ?? 'account'}
        </span>
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute top-full mt-2 right-0 w-64 bg-white dark:bg-[#1c1c1e] border border-[#E5E5EA] dark:border-[#38383a] rounded-xl shadow-lg overflow-hidden z-50">
            <div className="p-3">
              <div className="flex items-center gap-2 mb-3">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold"
                  style={{ background: PRIVY_ACCENT }}
                >
                  {(label ?? '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-label-primary dark:text-white truncate">
                    {label ?? 'account'}
                  </div>
                  <div className="text-[11px] text-label-tertiary font-mono truncate">
                    {truncate(address) || 'no wallet address'}
                  </div>
                </div>
              </div>

              {address && (
                <div className="flex gap-1.5 mb-2">
                  <button
                    onClick={copyAddress}
                    className="flex-1 py-1.5 bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] rounded-lg text-[12px] font-medium flex items-center justify-center gap-1"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-[#34C759]" /> : <Copy className="w-3.5 h-3.5" />}
                    {copied ? 'Copied' : 'Copy address'}
                  </button>
                </div>
              )}

              <button
                onClick={() => {
                  logout();
                  setShowMenu(false);
                }}
                className="w-full py-2 text-[#FF3B30] hover:bg-[#FF3B30]/5 rounded-lg text-[13px] font-medium flex items-center justify-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
