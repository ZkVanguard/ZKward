/**
 * Slush's web wallet: the same wallet at my.slush.app, signing in a browser
 * tab instead of an extension or the phone app. It is what lets a phone
 * browser (no extensions, no injected wallet) use SUI without leaving the
 * page. The SDK steps aside by itself when the real Slush is present.
 *
 * We register it here, not through the wallet provider's own option, to keep
 * the handle: it carries the same name as the installed wallet ("Slush"), so
 * identity is the only reliable way to tell "available to everyone" from
 * "this visitor installed a wallet".
 */
import { registerSlushWallet } from '@mysten/slush-wallet';

let webWallet: object | null = null;

/** Registers the web wallet under `appName` (shown on Slush's approval screen). Returns the undo. */
export function registerSlushWeb(appName: string): () => void {
  const registered = registerSlushWallet(appName);
  webWallet = registered?.wallet ?? null;
  return () => {
    registered?.unregister();
    webWallet = null;
  };
}

export function isSlushWeb(wallet: object): boolean {
  return webWallet !== null && wallet === webWallet;
}
