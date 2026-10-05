/**
 * wagmi config — Hedera-primary EVM wallet setup.
 *
 * ETHGlobal pivot (2026-09-04): Hedera is the primary EVM chain for
 * the hackathon submission. Chain ordering here drives the connect
 * flow — Hedera Testnet is the default, then Hedera Mainnet, then
 * Sepolia + Cronos as legacy multi-chain surface.
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
import { getRpcUrl } from '@/lib/rpc-urls';

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

// ─── Secondary EVM chains kept for the multi-chain shell ──────────────────
// Sepolia + Cronos are supported but not primary. Adding them here lets
// existing dashboard UI code (which knows these chain IDs) continue to
// work without runtime errors when a user's wallet is on the wrong chain.

export const sepolia = defineChain({
  id: 11155111,
  name: 'Sepolia',
  nativeCurrency: { name: 'Sepolia ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    // Same-origin proxy in the browser: public Sepolia endpoints send no CORS
    // headers, and the one this pointed at has been retired.
    default: { http: [getRpcUrl('sepolia')] },
  },
  blockExplorers: {
    default: { name: 'Etherscan', url: 'https://sepolia.etherscan.io' },
  },
  testnet: true,
});

export const cronosMainnet = defineChain({
  id: 25,
  name: 'Cronos',
  nativeCurrency: { name: 'Cronos', symbol: 'CRO', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evm.cronos.org'] },
  },
  blockExplorers: {
    default: { name: 'CronoScan', url: 'https://cronoscan.com' },
  },
});

// Chain order matters — first entry is the default chain wagmi tries
// to switch to. Hedera Testnet first for hackathon demo (cheap + fast),
// Hedera Mainnet second, then legacy Sepolia + Cronos.
export const SUPPORTED_CHAINS = [hederaTestnet, hederaMainnet, sepolia, cronosMainnet] as const;

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
      [sepolia.id]: http(),
      [cronosMainnet.id]: http(),
    },
    ssr: true, // Next.js App Router — cookie-based reconnect
  });
}

export function getWagmiConfig(): ReturnType<typeof buildConfig> {
  if (!_config) _config = buildConfig();
  return _config;
}

// ─── Chain metadata for the ConnectButton picker ──────────────────────────
// Ordering here IS the picker order — Hedera-first pivot.

export const CHAIN_PICKER_ORDER = [
  { id: hederaTestnet.id, name: 'Hedera Testnet', symbol: 'HBAR', color: '#00A79F', isPrimary: true },
  { id: hederaMainnet.id, name: 'Hedera', symbol: 'HBAR', color: '#00A79F', isPrimary: true },
  { id: sepolia.id, name: 'Sepolia', symbol: 'ETH', color: '#627EEA', isPrimary: false },
  { id: cronosMainnet.id, name: 'Cronos', symbol: 'CRO', color: '#002D74', isPrimary: false },
] as const;

/** True if the wallet's current chain is Hedera (primary chain). */
export function isHederaChain(chainId: number | undefined): boolean {
  return chainId === hederaTestnet.id || chainId === hederaMainnet.id;
}
