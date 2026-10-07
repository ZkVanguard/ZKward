/**
 * wagmi config — Hedera-primary EVM wallet setup.
 *
 * ETHGlobal pivot (2026-09-04): Hedera is the primary EVM chain for
 * the hackathon submission. Chain ordering here drives the connect
 * flow — Hedera Testnet is the default, then Hedera Mainnet.
 *
 * Connectors
 *   - injected() — MetaMask, Rabby, Brave, Trust, any browser wallet
 *
 * Coinbase + WalletConnect intentionally NOT added at the wagmi layer —
 * Privy's login modal already exposes both (plus email/social/embedded
 * wallets). Keeping wagmi lean means one less place to break when a
 * connector's peer deps churn.
 */

import { createConfig, http } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { defineChain } from 'viem';

// ─── Hedera EVM chain definitions ──────────────────────────────────────────
// viem/chains does not ship Hedera; define here with Hashio RPCs. HBAR is
// 8-decimal natively but the EVM wrapper (Hashio) surfaces 18 decimals for
// Ethereum tooling compatibility. Explorer is HashScan.

export const hederaTestnet = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://testnet.hashio.io/api'] },
  },
  blockExplorers: {
    default: { name: 'HashScan', url: 'https://hashscan.io/testnet' },
  },
  testnet: true,
});

export const hederaMainnet = defineChain({
  id: 295,
  name: 'Hedera',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://mainnet.hashio.io/api'] },
  },
  blockExplorers: {
    default: { name: 'HashScan', url: 'https://hashscan.io/mainnet' },
  },
});

// Chain order matters — first entry is the default chain wagmi tries
// to switch to. Hedera Testnet first (cheap + fast), Hedera Mainnet second.
export const SUPPORTED_CHAINS = [hederaTestnet, hederaMainnet] as const;

// ─── wagmi config ─────────────────────────────────────────────────────────
// Lazy-instantiated so SSR doesn't try to spin up storage before window
// exists. Called from app/wallet-providers.tsx.

let _config: ReturnType<typeof buildConfig> | null = null;

function buildConfig() {
  return createConfig({
    chains: SUPPORTED_CHAINS,
    connectors: [
      injected({ shimDisconnect: true }),
    ],
    transports: {
      [hederaTestnet.id]: http(),
      [hederaMainnet.id]: http(),
    },
    ssr: true, // Next.js App Router — cookie-based reconnect
  });
}

export function getWagmiConfig(): ReturnType<typeof buildConfig> {
  if (!_config) _config = buildConfig();
  return _config;
}

/** True if the wallet's current chain is Hedera (primary chain). */
export function isHederaChain(chainId: number | undefined): boolean {
  return chainId === hederaTestnet.id || chainId === hederaMainnet.id;
}
