/**
 * Privy client config — browser-only surface with wagmi chain list.
 *
 * Split from privy-config.ts (server-safe) because this file imports
 * wagmi chains, which pulls in ESM that Node-based unit tests can't
 * parse without a transformer. Consumers under app/wallet-providers.tsx
 * import from here; server routes import from privy-config.ts only.
 */

import { hederaTestnet, hederaMainnet, sepolia, cronosMainnet } from './wagmi-config';

/**
 * Privy client config for the browser <PrivyProvider>.
 *
 * Shape mirrors PrivyClientConfig — kept as Record<string, unknown> so
 * we don't force downstream to depend on Privy's exported types.
 */
export function buildPrivyClientConfig(): Record<string, unknown> {
  return {
    appearance: {
      // ios-blueHover — matches site primary CTA (Deposit USDC, Sign in
      // buttons). Was Hedera teal which read as a chain-specific feature
      // rather than the app's native sign-in.
      accentColor: '#0069D9',
      theme: 'light',
      // Email primary; wallet-connect list appears in the same modal as
      // a secondary section. Keeps new users on the "hide onchain
      // complexity" path while power users can still bring MetaMask.
      showWalletLoginFirst: false,
      walletChainType: 'ethereum-only',
      logo: 'https://www.zkward.com/logo-official.svg',
      // Wallets Privy's modal will surface. Excluding coinbase_wallet
      // and base_account so their smart-wallet init doesn't throw on
      // Hedera/Cronos chain IDs. detected_ethereum_wallets uses EIP-6963
      // so MetaMask, Rabby, Trust, Brave etc. all appear.
      walletList: [
        'detected_ethereum_wallets',
        'metamask',
        'wallet_connect',
        'phantom',
        'okx_wallet',
      ],
    },
    // Email + Google + wallet. All three inside the Privy modal — no
    // separate wagmi-injected UI outside. External wallets are proxied
    // through Privy's WagmiProvider so hooks (useAccount, useSendTx)
    // see them transparently.
    loginMethods: ['email', 'google', 'wallet'],
    embeddedWallets: {
      // 'users-without-wallets' — if the user signs in with MetaMask,
      // don't force an extra embedded wallet on them. Email/Google users
      // still get one automatically.
      createOnLogin: 'users-without-wallets',
      requireUserPasswordOnCreate: false,
      // No prompt on every signature for embedded wallets — cleaner UX
      // for the financial-flow demo (one-click fund + one-click send).
      // External wallets (MetaMask) always show their own confirmation
      // popup regardless of this flag. Quorum-gated admin actions have
      // their own explicit-approval story in the quorum route.
      noPromptOnSignature: true,
    },
    supportedChains: [hederaTestnet, hederaMainnet, sepolia, cronosMainnet],
    defaultChain: hederaTestnet, // Hedera-primary pivot
    fundingMethodConfig: {
      moonpay: {
        useSandbox: process.env.HEDERA_NETWORK !== 'mainnet',
      },
    },
  };
}
