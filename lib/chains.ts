import { defineChain } from 'viem';
import { getRpcUrl } from './rpc-urls';

// ============================================
// ETHEREUM MAINNET (Production with USDT)
// ============================================

export const EthereumMainnet = defineChain({
  id: 1,
  name: 'Ethereum',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [getRpcUrl('ethereum'), 'https://cloudflare-eth.com'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Etherscan',
      url: 'https://etherscan.io',
    },
  },
  testnet: false,
});

// ============================================
// CRONOS CHAINS (EVM-Compatible)
// ============================================

// Cronos EVM Mainnet
export const CronosMainnet = defineChain({
  id: 25,
  name: 'Cronos',
  nativeCurrency: {
    decimals: 18,
    name: 'Cronos',
    symbol: 'CRO',
  },
  rpcUrls: {
    default: {
      http: ['https://evm.cronos.org'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Cronoscan',
      url: 'https://explorer.cronos.org',
    },
  },
  testnet: false,
});

// Cronos EVM Testnet (For Development & Testing)
export const CronosTestnet = defineChain({
  id: 338,
  name: 'Cronos Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Test Cronos',
    symbol: 'tCRO',
  },
  rpcUrls: {
    default: {
      http: ['https://evm-t3.cronos.org'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Cronos Testnet Explorer',
      url: 'https://explorer.cronos.org/testnet',
    },
  },
  testnet: true,
});

// ============================================
// HEDERA CHAINS
// ============================================

// Hedera Mainnet
export const HederaMainnet = defineChain({
  id: 295,
  name: 'Hedera',
  nativeCurrency: {
    decimals: 18,
    name: 'HBAR',
    symbol: 'HBAR',
  },
  rpcUrls: {
    default: {
      http: ['https://mainnet.hashio.io/api'],
    },
  },
  blockExplorers: {
    default: {
      name: 'HashScan',
      url: 'https://hashscan.io/mainnet',
    },
  },
  testnet: false,
});

// Hedera Testnet
export const HederaTestnet = defineChain({
  id: 296,
  name: 'Hedera Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'HBAR',
    symbol: 'HBAR',
  },
  rpcUrls: {
    default: {
      http: ['https://testnet.hashio.io/api'],
    },
  },
  blockExplorers: {
    default: {
      name: 'HashScan Testnet',
      url: 'https://hashscan.io/testnet',
    },
  },
  testnet: true,
});

// Ethereum Sepolia (Testnet) - WDK USDT Primary Test Network
export const Sepolia = defineChain({
  id: 11155111,
  name: 'Sepolia',
  nativeCurrency: {
    decimals: 18,
    name: 'Sepolia Ether',
    symbol: 'ETH',
  },
  rpcUrls: {
    default: {
      http: [getRpcUrl('sepolia'), 'https://rpc.sepolia.org'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Etherscan Sepolia',
      url: 'https://sepolia.etherscan.io',
    },
  },
  testnet: true,
});

// ============================================
// OASIS NETWORK PARATIMES
// ============================================
// Oasis has 4 ParaTimes: Consensus (base layer), Emerald (public EVM),
// Sapphire (confidential EVM), and Cipher (confidential WASM)

// --- OASIS EMERALD (Public EVM ParaTime) ---

// Oasis Emerald Mainnet
export const OasisEmeraldMainnet = defineChain({
  id: 42262,
  name: 'Oasis Emerald',
  nativeCurrency: {
    decimals: 18,
    name: 'ROSE',
    symbol: 'ROSE',
  },
  rpcUrls: {
    default: {
      http: ['https://emerald.oasis.io'],
      webSocket: ['wss://emerald.oasis.io/ws'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Oasis Explorer',
      url: 'https://explorer.oasis.io/mainnet/emerald',
    },
  },
  testnet: false,
});

// Oasis Emerald Testnet
export const OasisEmeraldTestnet = defineChain({
  id: 42261,
  name: 'Oasis Emerald Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Test ROSE',
    symbol: 'TEST',
  },
  rpcUrls: {
    default: {
      http: ['https://testnet.emerald.oasis.io'],
      webSocket: ['wss://testnet.emerald.oasis.io/ws'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Oasis Testnet Explorer',
      url: 'https://explorer.oasis.io/testnet/emerald',
    },
  },
  testnet: true,
});

// --- OASIS SAPPHIRE (Confidential EVM ParaTime) ---

// Oasis Sapphire Mainnet (Confidential EVM ParaTime)
export const OasisSapphireMainnet = defineChain({
  id: 23294,
  name: 'Oasis Sapphire',
  nativeCurrency: {
    decimals: 18,
    name: 'ROSE',
    symbol: 'ROSE',
  },
  rpcUrls: {
    default: {
      http: ['https://sapphire.oasis.io'],
      webSocket: ['wss://sapphire.oasis.io/ws'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Oasis Explorer',
      url: 'https://explorer.oasis.io/mainnet/sapphire',
    },
  },
  testnet: false,
});

// Oasis Sapphire Testnet (For Development & Testing)
export const OasisSapphireTestnet = defineChain({
  id: 23295,
  name: 'Oasis Sapphire Testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'Test ROSE',
    symbol: 'TEST',
  },
  rpcUrls: {
    default: {
      http: ['https://testnet.sapphire.oasis.io'],
      webSocket: ['wss://testnet.sapphire.oasis.io/ws'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Oasis Testnet Explorer',
      url: 'https://explorer.oasis.io/testnet/sapphire',
    },
  },
  testnet: true,
});

// --- OASIS CONSENSUS (Base Layer) ---
// Not an EVM chain — used for staking, governance, and cross-ParaTime transfers

export const OasisConsensusMainnet = {
  id: 'oasis:consensus:mainnet',
  name: 'Oasis Consensus',
  nativeCurrency: {
    decimals: 9,
    name: 'ROSE',
    symbol: 'ROSE',
  },
  rpcUrls: {
    default: {
      http: ['https://grpc.oasis.io'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Oasis Explorer',
      url: 'https://explorer.oasis.io/mainnet/consensus',
    },
  },
  testnet: false,
};

export const OasisConsensusTestnet = {
  id: 'oasis:consensus:testnet',
  name: 'Oasis Consensus Testnet',
  nativeCurrency: {
    decimals: 9,
    name: 'Test ROSE',
    symbol: 'TEST',
  },
  rpcUrls: {
    default: {
      http: ['https://testnet.grpc.oasis.io'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Oasis Testnet Explorer',
      url: 'https://explorer.oasis.io/testnet/consensus',
    },
  },
  testnet: true,
};

// --- OASIS CIPHER (Confidential WASM ParaTime) ---
// Not EVM — uses Oasis SDK with WebAssembly smart contracts

export const OasisCipherMainnet = {
  id: 'oasis:cipher:mainnet',
  name: 'Oasis Cipher',
  nativeCurrency: {
    decimals: 9,
    name: 'ROSE',
    symbol: 'ROSE',
  },
  rpcUrls: {
    default: {
      http: ['https://cipher.oasis.io'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Oasis Explorer',
      url: 'https://explorer.oasis.io/mainnet/cipher',
    },
  },
  testnet: false,
};

export const OasisCipherTestnet = {
  id: 'oasis:cipher:testnet',
  name: 'Oasis Cipher Testnet',
  nativeCurrency: {
    decimals: 9,
    name: 'Test ROSE',
    symbol: 'TEST',
  },
  rpcUrls: {
    default: {
      http: ['https://testnet.cipher.oasis.io'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Oasis Testnet Explorer',
      url: 'https://explorer.oasis.io/testnet/cipher',
    },
  },
  testnet: true,
};

// ============================================
// SUI CHAINS (Move-based, Non-EVM)
// ============================================

// SUI Mainnet Configuration (for wallet display & reference)
export const SuiMainnet = {
  id: 'sui:mainnet',
  name: 'SUI',
  nativeCurrency: {
    decimals: 9,
    name: 'SUI',
    symbol: 'SUI',
  },
  rpcUrls: {
    default: {
      http: ['https://fullnode.mainnet.sui.io:443'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Sui Explorer',
      url: 'https://suiexplorer.com',
    },
  },
  testnet: false,
};

// SUI Testnet Configuration (For Development & Testing)
export const SuiTestnet = {
  id: 'sui:testnet',
  name: 'SUI Testnet',
  nativeCurrency: {
    decimals: 9,
    name: 'SUI',
    symbol: 'SUI',
  },
  rpcUrls: {
    default: {
      http: ['https://fullnode.testnet.sui.io:443'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Sui Testnet Explorer',
      url: 'https://suiexplorer.com/?network=testnet',
    },
  },
  testnet: true,
};

// SUI Devnet Configuration (For early development)
export const SuiDevnet = {
  id: 'sui:devnet',
  name: 'SUI Devnet',
  nativeCurrency: {
    decimals: 9,
    name: 'SUI',
    symbol: 'SUI',
  },
  rpcUrls: {
    default: {
      http: ['https://fullnode.devnet.sui.io:443'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Sui Devnet Explorer',
      url: 'https://suiexplorer.com/?network=devnet',
    },
  },
  testnet: true,
};

// ============================================
// MULTI-CHAIN UTILITIES
// ============================================

export type ChainType = 'evm' | 'sui' | 'hedera' | 'oasis-emerald' | 'oasis-sapphire' | 'oasis-consensus' | 'oasis-cipher';

// Convenience type for any Oasis ParaTime
export type OasisParaTime = 'oasis-emerald' | 'oasis-sapphire' | 'oasis-consensus' | 'oasis-cipher';

export interface MultiChainConfig {
  type: ChainType;
  name: string;
  logo: string;
  chains: {
    mainnet: typeof CronosMainnet | typeof HederaMainnet | typeof SuiMainnet | typeof OasisSapphireMainnet | typeof OasisEmeraldMainnet | typeof OasisConsensusMainnet | typeof OasisCipherMainnet;
    testnet: typeof CronosTestnet | typeof HederaTestnet | typeof SuiTestnet | typeof OasisSapphireTestnet | typeof OasisEmeraldTestnet | typeof OasisConsensusTestnet | typeof OasisCipherTestnet;
  };
}

// Supported chains for the platform.
// NOTE: Chronos-Vanguard is currently SUI-focused — other chains
// (Cronos / Hedera / Oasis ParaTimes) are intentionally disabled in the UI
// while their backend service code is preserved for future re-enablement.
export const SUPPORTED_CHAINS: MultiChainConfig[] = [
  {
    type: 'sui',
    name: 'SUI',
    logo: '/logos/chains/sui.svg',
    chains: {
      mainnet: SuiMainnet,
      testnet: SuiTestnet,
    },
  },
];

// Helper to check if a chain is any Oasis ParaTime
export function isOasisChain(chainId: number | string): boolean {
  if (typeof chainId === 'number') {
    return chainId === 23294 || chainId === 23295 || chainId === 42262 || chainId === 42261;
  }
  if (typeof chainId === 'string') {
    return chainId.startsWith('oasis:');
  }
  return false;
}

// Helper to check if a chain is EVM-compatible (includes Cronos, Hedera, Emerald, Sapphire)
export function isEVMChain(chainId: number | string): boolean {
  if (typeof chainId === 'number') {
    // Cronos (25, 338), Hedera (295, 296), Oasis Emerald (42262, 42261), Oasis Sapphire (23294, 23295)
    return chainId === 25 || chainId === 338 || chainId === 295 || chainId === 296 || chainId === 23294 || chainId === 23295 || chainId === 42262 || chainId === 42261;
  }
  return !chainId.startsWith('sui:') && !chainId.startsWith('oasis:');
}

// Helper to check if a chain is SUI
export function isSUIChain(chainId: number | string): boolean {
  if (typeof chainId === 'string') {
    return chainId.startsWith('sui:');
  }
  return false;
}

// Get chain type from ID
export function getChainType(chainId: number | string): ChainType {
  if (isSUIChain(chainId)) return 'sui';
  if (typeof chainId === 'string') {
    if (chainId.startsWith('oasis:consensus')) return 'oasis-consensus';
    if (chainId.startsWith('oasis:cipher')) return 'oasis-cipher';
  }
  if (typeof chainId === 'number') {
    if (chainId === 295 || chainId === 296) return 'hedera';
    if (chainId === 42262 || chainId === 42261) return 'oasis-emerald';
    if (chainId === 23294 || chainId === 23295) return 'oasis-sapphire';
  }
  return 'evm';
}
