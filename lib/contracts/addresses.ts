/**
 * Smart Contract Addresses
 * Multi-chain deployment addresses for Cronos (EVM), Oasis ParaTimes (Emerald/Sapphire), and SUI (Move)
 * 
 * OASIS PARATIMES:
 *   - Consensus: Base layer (staking/governance, not smart-contract capable)
 *   - Emerald: Public EVM ParaTime
 *   - Sapphire: Confidential EVM ParaTime
 *   - Cipher: Confidential WASM ParaTime (non-EVM)
 * 
 * MAINNET READY: Set NEXT_PUBLIC_CHAIN_ID and configure mainnet addresses via env vars
 */


// ============================================
// CRONOS (EVM) CONTRACT ADDRESSES
// ============================================

export const CRONOS_CONTRACT_ADDRESSES = {
  testnet: {
    zkVerifier: ((process.env.NEXT_PUBLIC_ZKVERIFIER_ADDRESS || '0x46A497cDa0e2eB61455B7cAD60940a563f3b7FD8').trim()) as `0x${string}`,
    rwaManager: ((process.env.NEXT_PUBLIC_RWAMANAGER_ADDRESS || '0x1Fe3105E6F3878752F5383db87Ea9A7247Db9189').trim()) as `0x${string}`,
    paymentRouter: ((process.env.NEXT_PUBLIC_PAYMENT_ROUTER_ADDRESS || '0xe40AbC51A100Fa19B5CddEea637647008Eb0eA0b').trim()) as `0x${string}`,
    // Legacy gasless contracts (archived)
    universalRelayer: ((process.env.NEXT_PUBLIC_RELAYER_CONTRACT || '0x9E5512b683d92290ccD20F483D20699658bcb9f3').trim()) as `0x${string}`,
    gaslessZKVerifier: ((process.env.NEXT_PUBLIC_GASLESS_ZK_VERIFIER || '0x7747e2D3e8fc092A0bd0d6060Ec8d56294A5b73F').trim()) as `0x${string}`,
    // Production gasless contract (gas refund model)
    gaslessZKCommitmentVerifier: ((process.env.NEXT_PUBLIC_GASLESS_COMMITMENT_VERIFIER || '0x52903d1FA10F90e9ec88DD7c3b1F0F73A0f811f9').trim()) as `0x${string}`,
    // TRUE gasless contract (x402 + USDC)
    x402GaslessZKCommitmentVerifier: ((process.env.NEXT_PUBLIC_X402_GASLESS_VERIFIER || '0x44098d0dE36e157b4C1700B48d615285C76fdE47').trim()) as `0x${string}`,
    // USDT token on Cronos Testnet
    usdtToken: '0xc01efAaF7C5C61bEbFAeb358E1161b537b8bC0e0' as `0x${string}`,
    // HedgeExecutor on testnet
    hedgeExecutor: ((process.env.NEXT_PUBLIC_HEDGE_EXECUTOR_ADDRESS || '0x090b6221137690EbB37667E4644287487CE462B9').trim()) as `0x${string}`,
    // Moonlander Diamond (same address works on both testnet/mainnet)
    moonlanderRouter: '0xE6F6351fb66f3a35313fEEFF9116698665FBEeC9' as `0x${string}`,
  },
  mainnet: {
    // All mainnet addresses use env vars - set these after deploying to mainnet
    // Empty address (0x0...0) indicates "not yet deployed" - check at runtime
    zkVerifier: ((process.env.NEXT_PUBLIC_MAINNET_ZKVERIFIER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    rwaManager: ((process.env.NEXT_PUBLIC_MAINNET_RWAMANAGER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    paymentRouter: ((process.env.NEXT_PUBLIC_MAINNET_PAYMENT_ROUTER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    universalRelayer: ((process.env.NEXT_PUBLIC_MAINNET_RELAYER_CONTRACT || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    gaslessZKVerifier: ((process.env.NEXT_PUBLIC_MAINNET_GASLESS_ZK_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    gaslessZKCommitmentVerifier: ((process.env.NEXT_PUBLIC_MAINNET_GASLESS_COMMITMENT_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    x402GaslessZKCommitmentVerifier: ((process.env.NEXT_PUBLIC_MAINNET_X402_GASLESS_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    hedgeExecutor: ((process.env.NEXT_PUBLIC_MAINNET_HEDGE_EXECUTOR_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    // USDT on Cronos Mainnet
    usdtToken: '0xc21223249CA28397B4B6541dfFaEcC539BfF0c59' as `0x${string}`,
    // Real Moonlander Diamond on Cronos Mainnet (verified)
    moonlanderRouter: '0xE6F6351fb66f3a35313fEEFF9116698665FBEeC9' as `0x${string}`,
  },
} as const;

// ============================================
// SUI (MOVE) CONTRACT ADDRESSES
// ============================================

export const SUI_CONTRACT_ADDRESSES = {
  testnet: {
    // ZKward Package ID (includes all modules: community_pool, zk_proxy_vault, etc.)
    packageId: ((process.env.NEXT_PUBLIC_SUI_PACKAGE_ID || '0xcb37e4ea0109e5c91096c0733821e4b603a5ef8faa995cfcf6c47aa2e325b70c').trim()) as string,
    // Shared object IDs
    rwaManagerState: ((process.env.NEXT_PUBLIC_SUI_RWA_MANAGER_STATE || '0x84925d623a658bc40a5821ef74458e7f8e8f5a2971c58ec9df6fb59277a8951d').trim()) as string,
    zkVerifierState: ((process.env.NEXT_PUBLIC_SUI_ZK_VERIFIER_STATE || '0x19f9c7a1ca761442180928f0efe982d414fd324948a1a092a258e8116c56213e').trim()) as string,
    paymentRouterState: ((process.env.NEXT_PUBLIC_SUI_PAYMENT_ROUTER_STATE || '0x08c0f37564f618162edc982d714b79dd946fbf7d387731f6c5ca3946d6cbe507').trim()) as string,
    zkProxyVaultState: ((process.env.NEXT_PUBLIC_SUI_ZK_PROXY_VAULT_STATE || '0x0738bb829009c6b2fd930e5e9adb1a7fdbf3f5180d41ad0bf091bebc611add35').trim()) as string,
    // Community Pool - requires create_pool call to create shared state
    communityPoolPackage: '0xcb37e4ea0109e5c91096c0733821e4b603a5ef8faa995cfcf6c47aa2e325b70c' as string,
    // Capability object IDs (owned by admin)
    adminCap: ((process.env.NEXT_PUBLIC_SUI_ADMIN_CAP || '0x088fef47064d46e298b57214eb68d9c245f420989249978625b5fdd0f1afb28f').trim()) as string,
    feeManagerCap: '0x13731b6f7852b9bfa5072ff4901abe11124b956cac62a9fea3e7568808931e70' as string,
  },
  mainnet: {
    // SUI Mainnet addresses - populate after deployment via env vars or direct values
    packageId: ((process.env.NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID || process.env.NEXT_PUBLIC_SUI_PACKAGE_ID || '').trim()) as string,
    rwaManagerState: ((process.env.NEXT_PUBLIC_SUI_MAINNET_RWA_MANAGER_STATE || process.env.NEXT_PUBLIC_SUI_RWA_MANAGER_STATE || '').trim()) as string,
    zkVerifierState: ((process.env.NEXT_PUBLIC_SUI_MAINNET_ZK_VERIFIER_STATE || process.env.NEXT_PUBLIC_SUI_ZK_VERIFIER_STATE || '').trim()) as string,
    paymentRouterState: ((process.env.NEXT_PUBLIC_SUI_MAINNET_PAYMENT_ROUTER_STATE || process.env.NEXT_PUBLIC_SUI_PAYMENT_ROUTER_STATE || '').trim()) as string,
    zkProxyVaultState: ((process.env.NEXT_PUBLIC_SUI_MAINNET_ZK_PROXY_VAULT_STATE || process.env.NEXT_PUBLIC_SUI_ZK_PROXY_VAULT_STATE || '').trim()) as string,
    communityPoolPackage: ((process.env.NEXT_PUBLIC_SUI_MAINNET_PACKAGE_ID || process.env.NEXT_PUBLIC_SUI_PACKAGE_ID || '').trim()) as string,
    adminCap: ((process.env.NEXT_PUBLIC_SUI_MAINNET_ADMIN_CAP || process.env.NEXT_PUBLIC_SUI_ADMIN_CAP || '').trim()) as string,
    feeManagerCap: ((process.env.NEXT_PUBLIC_SUI_MAINNET_FEE_MANAGER_CAP || '').trim()) as string,
    // MSafe multisig treasury — fee collection and admin operations
    msafeTreasury: ((process.env.SUI_MSAFE_ADDRESS || '').trim()) as string,
  },
  devnet: {
    packageId: ((process.env.NEXT_PUBLIC_SUI_DEVNET_PACKAGE_ID || '').trim()) as string,
    rwaManagerState: ((process.env.NEXT_PUBLIC_SUI_DEVNET_RWA_MANAGER_STATE || '').trim()) as string,
    zkVerifierState: ((process.env.NEXT_PUBLIC_SUI_DEVNET_ZK_VERIFIER_STATE || '').trim()) as string,
    paymentRouterState: ((process.env.NEXT_PUBLIC_SUI_DEVNET_PAYMENT_ROUTER_STATE || '').trim()) as string,
    zkProxyVaultState: ((process.env.NEXT_PUBLIC_SUI_DEVNET_ZK_PROXY_VAULT_STATE || '').trim()) as string,
    communityPoolPackage: ((process.env.NEXT_PUBLIC_SUI_DEVNET_PACKAGE_ID || '').trim()) as string,
    adminCap: ((process.env.NEXT_PUBLIC_SUI_DEVNET_ADMIN_CAP || '').trim()) as string,
    feeManagerCap: ((process.env.NEXT_PUBLIC_SUI_DEVNET_FEE_MANAGER_CAP || '').trim()) as string,
  },
} as const;

// ============================================
// OASIS EMERALD (PUBLIC EVM) CONTRACT ADDRESSES
// ============================================

export const OASIS_EMERALD_CONTRACT_ADDRESSES = {
  testnet: {
    zkVerifier: ((process.env.NEXT_PUBLIC_EMERALD_ZKVERIFIER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    rwaManager: ((process.env.NEXT_PUBLIC_EMERALD_RWAMANAGER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    paymentRouter: ((process.env.NEXT_PUBLIC_EMERALD_PAYMENT_ROUTER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    gaslessZKCommitmentVerifier: ((process.env.NEXT_PUBLIC_EMERALD_GASLESS_COMMITMENT_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    hedgeExecutor: ((process.env.NEXT_PUBLIC_EMERALD_HEDGE_EXECUTOR_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    usdtToken: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  },
  mainnet: {
    zkVerifier: ((process.env.NEXT_PUBLIC_EMERALD_MAINNET_ZKVERIFIER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    rwaManager: ((process.env.NEXT_PUBLIC_EMERALD_MAINNET_RWAMANAGER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    paymentRouter: ((process.env.NEXT_PUBLIC_EMERALD_MAINNET_PAYMENT_ROUTER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    gaslessZKCommitmentVerifier: ((process.env.NEXT_PUBLIC_EMERALD_MAINNET_GASLESS_COMMITMENT_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    hedgeExecutor: ((process.env.NEXT_PUBLIC_EMERALD_MAINNET_HEDGE_EXECUTOR_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    usdtToken: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  },
} as const;

// ============================================
// OASIS SAPPHIRE (CONFIDENTIAL EVM) CONTRACT ADDRESSES
// ============================================

export const OASIS_CONTRACT_ADDRESSES = {
  testnet: {
    // All Oasis Sapphire testnet addresses - deploy and update these
    zkVerifier: ((process.env.NEXT_PUBLIC_OASIS_ZKVERIFIER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    rwaManager: ((process.env.NEXT_PUBLIC_OASIS_RWAMANAGER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    paymentRouter: ((process.env.NEXT_PUBLIC_OASIS_PAYMENT_ROUTER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    // Confidential ZK contracts (leveraging Sapphire's native confidentiality)
    confidentialZKVerifier: ((process.env.NEXT_PUBLIC_OASIS_CONFIDENTIAL_ZK_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    // Gasless commitment verifier
    gaslessZKCommitmentVerifier: ((process.env.NEXT_PUBLIC_OASIS_GASLESS_COMMITMENT_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    // Hedge executor
    hedgeExecutor: ((process.env.NEXT_PUBLIC_OASIS_HEDGE_EXECUTOR_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    // USDT/stablecoin token on Oasis Sapphire Testnet
    usdtToken: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  },
  mainnet: {
    zkVerifier: ((process.env.NEXT_PUBLIC_OASIS_MAINNET_ZKVERIFIER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    rwaManager: ((process.env.NEXT_PUBLIC_OASIS_MAINNET_RWAMANAGER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    paymentRouter: ((process.env.NEXT_PUBLIC_OASIS_MAINNET_PAYMENT_ROUTER_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    confidentialZKVerifier: ((process.env.NEXT_PUBLIC_OASIS_MAINNET_CONFIDENTIAL_ZK_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    gaslessZKCommitmentVerifier: ((process.env.NEXT_PUBLIC_OASIS_MAINNET_GASLESS_COMMITMENT_VERIFIER || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    hedgeExecutor: ((process.env.NEXT_PUBLIC_OASIS_MAINNET_HEDGE_EXECUTOR_ADDRESS || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    usdtToken: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  },
} as const;

// ============================================
// SEPOLIA (ETH TESTNET) CONTRACT ADDRESSES
// ============================================

export const SEPOLIA_CONTRACT_ADDRESSES = {
  testnet: {
    // Sepolia (Chain ID: 11155111)
    communityPool: '0x07d68C2828F35327d12a7Ba796cCF3f12F8A1086' as `0x${string}`,
    usdtToken: '0xd077a400968890eacc75cdc901f0356c943e4fdb' as `0x${string}`,
    zkVerifier: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    rwaManager: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    paymentRouter: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    hedgeExecutor: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    gaslessZKCommitmentVerifier: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  },
} as const;

// ============================================
// HEDERA CONTRACT ADDRESSES
// ============================================

export const HEDERA_CONTRACT_ADDRESSES = {
  testnet: {
    // Hedera Testnet (Chain ID: 296) — SimpleUsdcVaultV2 (permit-enabled)
    // deployed 2026-09-08. V2 supports depositWithPermit for single-popup
    // deposits via Privy embedded wallets. Old V1 pool at 0xe7E6…9A9 is
    // dormant but on-chain. Old USDC at 0x7043…ae1 has no permit — do not
    // reuse; the new USDC's mint() still funds the faucet the same way.
    communityPool: '0x18a8d89E3674EBCeC678f97A8a8b1D144b330b88' as `0x${string}`,
    usdtToken: '0xe40AbC51A100Fa19B5CddEea637647008Eb0eA0b' as `0x${string}`, // MockERC20Permit (6 dec, mintable, EIP-2612)
    pythOracle: '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729' as `0x${string}`,
    zkVerifier: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    rwaManager: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    paymentRouter: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    hedgeExecutor: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    gaslessZKCommitmentVerifier: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  },
  mainnet: {
    // Hedera Mainnet (Chain ID: 295)
    communityPool: ((process.env.NEXT_PUBLIC_HEDERA_COMMUNITY_POOL || '0x0000000000000000000000000000000000000000').trim()) as `0x${string}`,
    usdtToken: '0x0000000000000000000000000000000000000000' as `0x${string}`, // USDT on Hedera mainnet
    pythOracle: '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729' as `0x${string}`,
    zkVerifier: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    rwaManager: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    paymentRouter: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    hedgeExecutor: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    gaslessZKCommitmentVerifier: '0x0000000000000000000000000000000000000000' as `0x${string}`,
  },
} as const;

// ============================================
// CHAIN TYPE DETECTION
// ============================================

export type ChainType = 'evm' | 'sui' | 'hedera' | 'oasis-emerald' | 'oasis-sapphire' | 'oasis-consensus' | 'oasis-cipher';
export type NetworkType = 'mainnet' | 'testnet' | 'devnet';

export interface ChainInfo {
  type: ChainType;
  network: NetworkType;
  chainId: number | string;
}

/**
 * Get chain info from chainId
 */
export function getChainInfo(chainId: number | string): ChainInfo {
  if (typeof chainId === 'string' && chainId.startsWith('sui:')) {
    const network = chainId.split(':')[1] as NetworkType;
    return { type: 'sui', network, chainId };
  }
  if (typeof chainId === 'string' && chainId.startsWith('oasis:consensus')) {
    const network = chainId.split(':')[2] as NetworkType;
    return { type: 'oasis-consensus', network: network || 'mainnet', chainId };
  }
  if (typeof chainId === 'string' && chainId.startsWith('oasis:cipher')) {
    const network = chainId.split(':')[2] as NetworkType;
    return { type: 'oasis-cipher', network: network || 'mainnet', chainId };
  }
  
  switch (chainId) {
    case 338:
      return { type: 'evm', network: 'testnet', chainId };
    case 25:
      return { type: 'evm', network: 'mainnet', chainId };
    case 296:
      return { type: 'hedera', network: 'testnet', chainId };
    case 295:
      return { type: 'hedera', network: 'mainnet', chainId };
    case 42261:
      return { type: 'oasis-emerald', network: 'testnet', chainId };
    case 42262:
      return { type: 'oasis-emerald', network: 'mainnet', chainId };
    case 23295:
      return { type: 'oasis-sapphire', network: 'testnet', chainId };
    case 23294:
      return { type: 'oasis-sapphire', network: 'mainnet', chainId };
    default:
      return { type: 'evm', network: 'testnet', chainId };
  }
}

/**
 * Get EVM contract addresses for the current chain
 */
export function getContractAddresses(chainId: number) {
  switch (chainId) {
    case 338: // Cronos Testnet
      return CRONOS_CONTRACT_ADDRESSES.testnet;
    case 25: // Cronos Mainnet
      return CRONOS_CONTRACT_ADDRESSES.mainnet;
    case 11155111: // Sepolia
      return SEPOLIA_CONTRACT_ADDRESSES.testnet;
    case 296: // Hedera Testnet
      return HEDERA_CONTRACT_ADDRESSES.testnet;
    case 295: // Hedera Mainnet
      return HEDERA_CONTRACT_ADDRESSES.mainnet;
    case 42261: // Oasis Emerald Testnet
      return OASIS_EMERALD_CONTRACT_ADDRESSES.testnet;
    case 42262: // Oasis Emerald Mainnet
      return OASIS_EMERALD_CONTRACT_ADDRESSES.mainnet;
    case 23295: // Oasis Sapphire Testnet
      return OASIS_CONTRACT_ADDRESSES.testnet;
    case 23294: // Oasis Sapphire Mainnet
      return OASIS_CONTRACT_ADDRESSES.mainnet;
    default:
      return CRONOS_CONTRACT_ADDRESSES.testnet; // Default to testnet
  }
}

/**
 * Get SUI contract addresses for the current network
 */
export function getSuiContractAddresses(network: 'mainnet' | 'testnet' | 'devnet' = 'testnet') {
  return SUI_CONTRACT_ADDRESSES[network];
}

/**
 * Get contract addresses based on chain type and network
 */
export function getMultiChainAddresses(chainType: ChainType, network: NetworkType) {
  if (chainType === 'sui') {
    return SUI_CONTRACT_ADDRESSES[network === 'mainnet' ? 'mainnet' : network === 'devnet' ? 'devnet' : 'testnet'];
  }
  if (chainType === 'hedera') {
    return HEDERA_CONTRACT_ADDRESSES[network === 'mainnet' ? 'mainnet' : 'testnet'];
  }
  if (chainType === 'oasis-sapphire') {
    return OASIS_CONTRACT_ADDRESSES[network === 'mainnet' ? 'mainnet' : 'testnet'];
  }
  if (chainType === 'oasis-emerald') {
    return OASIS_EMERALD_CONTRACT_ADDRESSES[network === 'mainnet' ? 'mainnet' : 'testnet'];
  }
  return CRONOS_CONTRACT_ADDRESSES[network === 'mainnet' ? 'mainnet' : 'testnet'];
}

/**
 * Get Oasis Emerald contract addresses for the current network
 */
export function getOasisEmeraldContractAddresses(network: 'mainnet' | 'testnet' = 'testnet') {
  return OASIS_EMERALD_CONTRACT_ADDRESSES[network];
}

/**
 * Get Oasis Sapphire contract addresses for the current network
 */
export function getOasisContractAddresses(network: 'mainnet' | 'testnet' = 'testnet') {
  return OASIS_CONTRACT_ADDRESSES[network];
}

/**
 * Zero address constant for checking if contract is deployed
 */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Check if a contract address is configured (not zero address)
 */
export function isAddressConfigured(address: string): boolean {
  return address !== ZERO_ADDRESS && address !== '' && address !== undefined;
}

/**
 * Check if mainnet contracts are properly configured
 * Returns list of missing contract names
 */
export function checkMainnetConfiguration(): { configured: boolean; missing: string[] } {
  const addresses = CRONOS_CONTRACT_ADDRESSES.mainnet;
  const missing: string[] = [];
  
  if (!isAddressConfigured(addresses.zkVerifier)) missing.push('cronos:zkVerifier');
  if (!isAddressConfigured(addresses.rwaManager)) missing.push('cronos:rwaManager');
  if (!isAddressConfigured(addresses.hedgeExecutor)) missing.push('cronos:hedgeExecutor');
  if (!isAddressConfigured(addresses.paymentRouter)) missing.push('cronos:paymentRouter');
  
  return {
    configured: missing.length === 0,
    missing,
  };
}

/**
 * Check if Oasis Sapphire mainnet contracts are properly configured
 */
export function checkOasisMainnetConfiguration(): { configured: boolean; missing: string[] } {
  const addresses = OASIS_CONTRACT_ADDRESSES.mainnet;
  const missing: string[] = [];
  
  if (!isAddressConfigured(addresses.zkVerifier)) missing.push('oasis:zkVerifier');
  if (!isAddressConfigured(addresses.rwaManager)) missing.push('oasis:rwaManager');
  if (!isAddressConfigured(addresses.hedgeExecutor)) missing.push('oasis:hedgeExecutor');
  if (!isAddressConfigured(addresses.paymentRouter)) missing.push('oasis:paymentRouter');
  if (!isAddressConfigured(addresses.confidentialZKVerifier)) missing.push('oasis:confidentialZKVerifier');
  
  return {
    configured: missing.length === 0,
    missing,
  };
}

/**
 * Check if SUI mainnet contracts are properly configured
 */
export function checkSuiMainnetConfiguration(): { configured: boolean; missing: string[] } {
  const addresses = SUI_CONTRACT_ADDRESSES.mainnet;
  const missing: string[] = [];
  
  if (!addresses.packageId) missing.push('sui:packageId');
  if (!addresses.rwaManagerState) missing.push('sui:rwaManagerState');
  if (!addresses.zkVerifierState) missing.push('sui:zkVerifierState');
  if (!addresses.paymentRouterState) missing.push('sui:paymentRouterState');
  if (!addresses.adminCap) missing.push('sui:adminCap');
  
  return {
    configured: missing.length === 0,
    missing,
  };
}
