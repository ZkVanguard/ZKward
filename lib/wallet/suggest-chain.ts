/**
 * Which network a visitor most likely wants, from what the browser already
 * tells us. No prompt and no request: the chooser leads with this card and
 * says why, and the visitor can still pick any other.
 */
export type SuggestChain = 'hedera' | 'sui' | 'solana';
export type SuggestReason = 'link' | 'last' | 'wallet' | 'no-install';

export interface SuggestInput {
  /** `?chain=` on arrival, when it names a network. */
  linkChain: SuggestChain | null;
  /** The network this device used last. */
  lastChain: SuggestChain | null;
  /** Names of the SUI wallets the browser exposes. */
  suiWallets: readonly string[];
  /** An injected Solana wallet (Phantom or compatible) is present. */
  solanaWallet: boolean;
}

/**
 * SUI wallets the visitor actually installed. The SDK registers its web
 * wallet ("Stashed") for everyone, and Phantom registers for SUI as well as
 * Solana, so neither says the visitor came for SUI.
 */
export function installedSuiWallets(names: readonly string[]): string[] {
  return names.filter((n) => !/stashed|phantom/i.test(n));
}

export function suggestChain(i: SuggestInput): { chain: SuggestChain; reason: SuggestReason } {
  if (i.linkChain) return { chain: i.linkChain, reason: 'link' };
  if (i.lastChain) return { chain: i.lastChain, reason: 'last' };
  if (installedSuiWallets(i.suiWallets).length > 0) return { chain: 'sui', reason: 'wallet' };
  if (i.solanaWallet) return { chain: 'solana', reason: 'wallet' };
  // Nothing installed: Hedera signs in with email, so it is the one that works as is.
  return { chain: 'hedera', reason: 'no-install' };
}
