/**
 * Mobile wallet-connect helpers for every network that needs a wallet app
 * (SUI and Solana; Hedera signs in with email, which works on any device).
 *
 * Problem: our previous mobile flow used
 *   window.location.href = `https://my.slush.app/browse/${encodeURIComponent(window.location.origin)}`
 * That drops the current path (`.origin` not `.href`), only offers Slush,
 * misses iPad Safari (modern iPads report macOS UA), and gives no signal
 * to the user that the redirect is even happening.
 *
 * This module centralises:
 *   - Accurate mobile detection (handles iPad Safari via touch points)
 *   - The list of supported SUI wallets with their universal links
 *   - Consistent URL encoding (uses full href so returning to the page
 *     preserves route context)
 *
 * Wallet universal-link formats verified against each wallet's docs 2026-07.
 * Each opens the app if installed, otherwise the browser stays on a page
 * that prompts to install — never a silent no-op.
 */

export interface MobileWalletOption {
  id: 'slush' | 'sui-wallet' | 'suiet' | 'ethos' | 'phantom' | 'solflare';
  name: string;
  /** SVG icon URL served from the wallet's own CDN. */
  iconUrl?: string;
  /** Universal link that opens the dApp inside the wallet's in-app browser.
   *  Both arguments arrive URL-encoded: the page, and its origin (some wallets
   *  want it as `ref`). */
  buildUniversalLink: (encodedHref: string, encodedOrigin: string) => string;
  /** Fallback install page when the wallet isn't installed. */
  installUrl: string;
}

/**
 * Detect whether the current browser is a mobile device.
 *
 * Uses UA regex for iOS/Android/etc., PLUS a touch-point check to catch
 * iPad Safari 13+ which reports a Mac UA. Runs on client only; returns
 * `false` on the server so SSR renders the desktop path (avoids hydration
 * mismatch — the client mount will correct it).
 */
export function isMobileBrowser(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  // iPad Safari 13+ reports macOS UA but has touch. maxTouchPoints > 1
  // ignores stylus-only devices (which report 1).
  return (
    /Macintosh/i.test(ua) &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1
  );
}

/**
 * Returns the URL the wallet should navigate its in-app browser to,
 * URL-encoded once. Uses full href (not origin) so the user returns
 * to the same page they clicked Connect on.
 */
function dappHrefEncoded(): string {
  if (typeof window === 'undefined') return '';
  return encodeURIComponent(window.location.href);
}

// Solana wallet apps with an in-app browser. Phantom first (the pool's
// instructions name it), Solflare as the other widely used one. Formats
// from each wallet's deeplink docs (`/ul/browse/<url>?ref=<origin>`).
export const SOLANA_MOBILE_WALLETS: MobileWalletOption[] = [
  {
    id: 'phantom',
    name: 'Phantom',
    buildUniversalLink: (encodedHref, encodedOrigin) => `https://phantom.app/ul/browse/${encodedHref}?ref=${encodedOrigin}`,
    installUrl: 'https://phantom.app/download',
  },
  {
    id: 'solflare',
    name: 'Solflare',
    buildUniversalLink: (encodedHref, encodedOrigin) => `https://solflare.com/ul/v1/browse/${encodedHref}?ref=${encodedOrigin}`,
    installUrl: 'https://solflare.com/download',
  },
];

/**
 * The page a wallet app should open: this page, with the network selected
 * and an instruction to connect on arrival, so the visitor does not have to
 * find the button again inside the wallet's browser. Pure: takes the href.
 */
export function handoffTarget(href: string, chain: 'sui' | 'solana'): string {
  const u = new URL(href);
  u.searchParams.set('chain', chain);
  u.searchParams.set('connect', chain);
  return u.toString();
}

/** Universal link that opens this page, set up for `chain`, inside `wallet`. */
export function walletHandoffLink(wallet: MobileWalletOption, chain: 'sui' | 'solana', href: string): string {
  const target = handoffTarget(href, chain);
  return wallet.buildUniversalLink(encodeURIComponent(target), encodeURIComponent(new URL(target).origin));
}

// SUI-first mobile flow: just Slush. It's the officially rebranded Sui
// Wallet Mobile and is what the SUI Foundation currently ships as the
// canonical mobile wallet. Multiple options was over-engineering — the
// user reports Slush is what they want to see. If we ever add another
// mobile wallet, this array is where it goes.
export const SUI_MOBILE_WALLETS: MobileWalletOption[] = [
  {
    id: 'slush',
    name: 'Slush',
    buildUniversalLink: (encodedHref: string) => `https://my.slush.app/browse/${encodedHref}`,
    installUrl: 'https://slush.app/download',
  },
];

/**
 * Compute the ready-to-navigate universal link for a wallet. Prefer
 * putting this on an `<a href={...}>` element rather than assigning
 * `window.location`.
 *
 * Why anchors matter: iOS universal links only reliably trigger the
 * installed app when navigation comes from a user-initiated
 * `<a>` click. `window.location.assign()` from JS is often treated as
 * an in-page navigation and just opens the URL in Safari, leaving the
 * installed Slush app untouched. Observed live 2026-07-12: users with
 * Slush installed reported "connect wallet doesn't open Slush" —
 * exactly this iOS behavior.
 *
 * Returns empty string on the server so SSR can safely render the
 * anchor with a placeholder href; a client-side effect fills in the
 * real href once `window.location.href` is available.
 */
export function buildMobileWalletLink(wallet: MobileWalletOption): string {
  const encoded = dappHrefEncoded();
  if (!encoded) return '';
  return wallet.buildUniversalLink(encoded, encodeURIComponent(window.location.origin));
}
