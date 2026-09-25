/**
 * Chain parameters for wallet_switchEthereumChain / wallet_addEthereumChain
 * Shared by handleDeposit and handleWithdraw in useCommunityPool
 */

export interface ChainParam {
  chainId: string;
  chainName: string;
  rpcUrls: string[];
  blockExplorerUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export const EVM_CHAIN_PARAMS: Record<number, ChainParam> = {
  296: { // Hedera Testnet
    chainId: '0x128',
    chainName: 'Hedera Testnet',
    rpcUrls: ['https://testnet.hashio.io/api'],
    blockExplorerUrls: ['https://hashscan.io/testnet'],
    nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  },
  295: { // Hedera Mainnet
    chainId: '0x127',
    chainName: 'Hedera',
    rpcUrls: ['https://mainnet.hashio.io/api'],
    blockExplorerUrls: ['https://hashscan.io/mainnet'],
    nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  },
};

/**
 * Switch wallet to target chain using native wallet API.
 * Tries wallet_switchEthereumChain first, falls back to wallet_addEthereumChain.
 */
export async function switchChainNative(targetChainId: number): Promise<void> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) throw new Error('No wallet detected');

  const params = EVM_CHAIN_PARAMS[targetChainId];
  if (!params) throw new Error(`Chain ${targetChainId} not configured`);

  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: params.chainId }],
    });
  } catch (switchError: any) {
    if (switchError.code === 4902) {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [params],
      });
    } else {
      throw switchError;
    }
  }
}
