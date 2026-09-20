'use client';

import { ReactNode, createContext, useContext, useMemo, useState, useEffect, useCallback } from 'react';
import { logger } from '@/lib/utils/logger';
import { 
  createNetworkConfig, 
  SuiClientProvider, 
  WalletProvider,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSignTransaction,
  useSuiClient,
  useCurrentWallet,
  useConnectWallet,
  useDisconnectWallet,
  useWallets,
} from '@mysten/dapp-kit';
import { getFullnodeUrl } from '@mysten/sui/client';
import { getSuiContractAddresses, type NetworkType } from '../lib/contracts/addresses';
import '@mysten/dapp-kit/dist/index.css';

// ============================================
// SUI NETWORK CONFIGURATION
// ============================================

// Route browser SUI RPC through our same-origin proxy — fullnode.mainnet.sui.io
// killed JSON-RPC 2026-07 AND never sent CORS headers. Proxy applies the same
// BlockVision → publicnode → nodeinfra failover the server uses.
const { networkConfig } = createNetworkConfig({
  localnet: { url: getFullnodeUrl('localnet') },
  devnet: { url: getFullnodeUrl('devnet') },
  testnet: { url: '/api/rpc/sui-testnet' },
  mainnet: { url: '/api/rpc/sui' },
});


// ============================================
// SUI CONTEXT TYPES
// ============================================

interface SuiContextType {
  // Network
  network: NetworkType;
  setNetwork: (network: NetworkType) => void;
  isWrongNetwork: boolean;
  walletNetwork: string | null;
  
  // Wallet
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  
  // Balances
  balance: string;
  balanceRaw: bigint;
  
  // Contract addresses
  contractAddresses: ReturnType<typeof getSuiContractAddresses>;
  
  // Actions
  connectWallet: () => void;
  disconnectWallet: () => void;
  
  // Transactions
  executeTransaction: (tx: unknown) => Promise<{ digest: string; success: boolean; error?: string }>;
  signTransaction: (txBytes: Uint8Array) => Promise<{ signature: string }>;
  sponsoredExecute: (tx: unknown) => Promise<{ digest: string; success: boolean; error?: string }>;
  
  // Utilities
  getExplorerUrl: (type: 'tx' | 'address' | 'object', value: string) => string;
  requestFaucetTokens: () => Promise<{ success: boolean; message: string }>;
}

const SuiContext = createContext<SuiContextType | null>(null);

// ============================================
// SUI HOOKS
// ============================================

/**
 * Hook to use Sui context
 * @throws Error if used outside SuiWalletProviders
 */
export function useSui(): SuiContextType {
  const context = useContext(SuiContext);
  if (!context) {
    throw new Error('useSui must be used within SuiWalletProviders');
  }
  return context;
}

/**
 * Safe hook to use Sui context - returns null if not in provider
 * Use this for components that may be rendered outside SuiWalletProviders
 */
export function useSuiSafe(): SuiContextType | null {
  return useContext(SuiContext);
}

// ============================================
// INTERNAL CONTEXT PROVIDER
// ============================================

function SuiContextProvider({ 
  children, 
  network, 
  setNetwork 
}: { 
  children: ReactNode; 
  network: NetworkType;
  setNetwork: (n: NetworkType) => void;
}) {
  const [balance, setBalance] = useState('0');
  const [balanceRaw, setBalanceRaw] = useState<bigint>(BigInt(0));
  const [walletNetwork, setWalletNetwork] = useState<string | null>(null);
  const [isWrongNetwork, setIsWrongNetwork] = useState(false);

  // Mounted guard: @mysten/dapp-kit uses Zustand persist middleware that
  // synchronously restores wallet state from localStorage during store init.
  // Server has empty in-memory store → disconnected; client has persisted
  // state → possibly connected.  Without this guard the initial client render
  // differs from the server-rendered HTML → React #301.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  
  // Always call hooks (rules of hooks), but gate their return values
  const rawAccount = useCurrentAccount();
  const rawWalletState = useCurrentWallet();
  const { mutate: connect, isPending: isConnecting } = useConnectWallet();
  const { mutate: disconnect } = useDisconnectWallet();
  const wallets = useWallets();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const { mutateAsync: walletSignTx } = useSignTransaction();

  // Until mounted, present the same "disconnected" state the server rendered
  const account = mounted ? rawAccount : null;
  const connectionStatus = mounted ? rawWalletState.connectionStatus : 'disconnected';
  const _currentWallet = mounted ? rawWalletState.currentWallet : null;

  const address = account?.address ?? null;
  const isConnected = connectionStatus === 'connected' && !!address;

  // Detect wallet network and check for mismatches
  useEffect(() => {
    async function detectWalletNetwork() {
      if (!account || !isConnected) {
        setWalletNetwork(null);
        setIsWrongNetwork(false);
        return;
      }

      try {
        // Check the account's chains to detect wallet network
        // SUI wallet accounts report their chain as 'sui:mainnet', 'sui:testnet', etc.
        const accountChains = account.chains || [];
        let detectedNetwork: string | null = null;

        logger.debug('SUI account chains detected', { component: 'SuiProvider', data: { accountChains, expected: network } });

        for (const chain of accountChains) {
          if (chain.includes('mainnet')) {
            detectedNetwork = 'mainnet';
            break;
          } else if (chain.includes('testnet')) {
            detectedNetwork = 'testnet';
            break;
          } else if (chain.includes('devnet')) {
            detectedNetwork = 'devnet';
            break;
          }
        }

        // If no chains reported, try to detect via RPC by checking chain identifier
        if (!detectedNetwork && address) {
          try {
            const chainId = await suiClient.getChainIdentifier();
            logger.debug('SUI chainId from RPC', { component: 'SuiProvider', data: { chainId } });
            // Chain identifiers: mainnet = specific hash, testnet & devnet have their own
            // Use a simple heuristic based on common patterns
            if (chainId) {
              // Known chain identifiers (these may change, but pattern remains)
              // mainnet: "35834a8a", testnet: "4c78adac", devnet changes frequently
              const mainnetId = '35834a8a';
              const testnetId = '4c78adac';
              
              if (chainId === mainnetId) {
                detectedNetwork = 'mainnet';
              } else if (chainId === testnetId) {
                detectedNetwork = 'testnet';
              } else {
                detectedNetwork = 'devnet'; // Assume devnet for unknown
              }
            }
          } catch {
            // RPC detection failed, fallback to assuming correct network
            logger.debug('Could not detect SUI chain via RPC', { component: 'SuiProvider' });
          }
        }

        logger.debug('SUI detected wallet network', { component: 'SuiProvider', data: { detectedNetwork } });
        setWalletNetwork(detectedNetwork);

        // If we can't detect wallet network, assume it's correct (don't block user)
        if (detectedNetwork && detectedNetwork !== network) {
          logger.warn('SUI wallet network mismatch', {
            component: 'SuiProvider',
            data: { walletNetwork: detectedNetwork, appNetwork: network },
          });
          setIsWrongNetwork(true);
        } else {
          setIsWrongNetwork(false);
        }
      } catch (error) {
        logger.error('Failed to detect wallet network', error instanceof Error ? error : undefined, { component: 'SuiProvider' });
        // On error, don't block - assume correct network
        setIsWrongNetwork(false);
      }
    }

    detectWalletNetwork();
  }, [account, isConnected, network, address, suiClient]);

  // Fetch balance when address changes
  useEffect(() => {
    async function fetchBalance() {
      if (!address) {
        setBalance('0');
        setBalanceRaw(BigInt(0));
        return;
      }

      try {
        const balanceResult = await suiClient.getBalance({
          owner: address,
          coinType: '0x2::sui::SUI',
        });
        
        const rawBalance = BigInt(balanceResult.totalBalance);
        setBalanceRaw(rawBalance);
        // SUI has 9 decimals
        setBalance((Number(rawBalance) / 1e9).toFixed(4));
      } catch (error) {
        logger.error('Failed to fetch balance', error instanceof Error ? error : undefined, { component: 'SuiProvider' });
        setBalance('0');
        setBalanceRaw(BigInt(0));
      }
    }

    fetchBalance();
    
    // Refresh balance every 30 seconds — only when tab is visible
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!interval) interval = setInterval(fetchBalance, 30000); };
    const stop = () => { if (interval) { clearInterval(interval); interval = null; } };
    const onVis = () => document.hidden ? stop() : start();
    document.addEventListener('visibilitychange', onVis);
    if (!document.hidden) start();
    return () => { stop(); document.removeEventListener('visibilitychange', onVis); };
  }, [address, suiClient]);

  const connectWallet = useCallback(() => {
    // Try to connect to the first available wallet
    const availableWallet = wallets[0];
    if (availableWallet) {
      connect({ wallet: availableWallet });
    } else {
      logger.error('No wallets available', undefined, { component: 'SuiProvider' });
    }
  }, [connect, wallets]);

  const disconnectWallet = useCallback(() => {
    // Clear stale balance/state before disconnect
    setBalance('0');
    setBalanceRaw(BigInt(0));
    disconnect();
  }, [disconnect]);

  const executeTransaction = useCallback(async (tx: unknown): Promise<{ digest: string; success: boolean; error?: string }> => {
    if (!isConnected) {
      throw new Error('Wallet not connected');
    }

    // SECURITY: Block transactions when wallet is on wrong network
    if (isWrongNetwork) {
      const msg = `Transaction blocked: wallet is on ${walletNetwork || 'unknown'} but app expects ${network}. Please switch your wallet network.`;
      logger.error(msg, undefined, { component: 'SuiProvider' });
      throw new Error(msg);
    }

    try {
      const result = await signAndExecute({
        transaction: tx as Parameters<typeof signAndExecute>[0]['transaction'],
      });

      return {
        digest: result.digest,
        success: true,
      };
    } catch (error: unknown) {
      logger.error('Transaction failed', error instanceof Error ? error : undefined, { component: 'SuiProvider' });
      // Distinguish user rejection from other errors
      const message = error instanceof Error ? error.message : String(error);
      const isUserRejection = message.includes('Rejected') || message.includes('User rejected') || message.includes('cancelled');
      return {
        digest: '',
        success: false,
        error: isUserRejection ? 'User rejected the transaction' : message,
      };
    }
  }, [isConnected, isWrongNetwork, walletNetwork, network, signAndExecute]);

  // Sign-only: user signs pre-built transaction bytes (for sponsored txs)
  const signTransaction = useCallback(async (txBytes: Uint8Array): Promise<{ signature: string }> => {
    if (!isConnected) throw new Error('Wallet not connected');
    if (isWrongNetwork) throw new Error(`Wrong network: wallet is on ${walletNetwork || 'unknown'}, app expects ${network}`);

    // Pass as base64 string — dapp-kit accepts Transaction | string
    const b64 = Buffer.from(txBytes).toString('base64');
    const result = await walletSignTx({ transaction: b64 });
    return { signature: result.signature };
  }, [isConnected, isWrongNetwork, walletNetwork, network, walletSignTx]);

  // Sponsored execute: 2-step flow
  // Step 1: Server sets gas fields on unbuilt tx → returns modified tx
  // Step 2: Wallet builds + signs → server admin co-signs the same bytes + executes
  const sponsoredExecute = useCallback(async (tx: unknown): Promise<{ digest: string; success: boolean; error?: string }> => {
    if (!isConnected || !address) throw new Error('Wallet not connected');
    if (isWrongNetwork) throw new Error(`Wrong network: wallet is on ${walletNetwork || 'unknown'}, app expects ${network}`);

    try {
      const { Transaction } = await import('@mysten/sui/transactions');
      const txObj = tx as InstanceType<typeof Transaction>;

      // Step 1: Send unbuilt tx to server — server sets gasOwner, gasBudget, gasPayment
      const serialized = txObj.serialize();
      const txBase64 = Buffer.from(serialized).toString('base64');

      const sponsorRes = await fetch('/api/sui/sponsor-gas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txBytes: txBase64, sender: address }),
      });
      const sponsorData = await sponsorRes.json();
      if (!sponsorRes.ok || !sponsorData.success) {
        throw new Error(sponsorData.error || 'Gas sponsoring failed');
      }

      // Reconstruct Transaction object from the server's modified JSON
      const modifiedTxJson = Buffer.from(sponsorData.txBytes, 'base64').toString('utf-8');
      const modifiedTx = Transaction.from(modifiedTxJson);

      // Wallet builds (resolves objects via RPC) and signs the BCS bytes
      // Cast needed: dynamic import Transaction vs dapp-kit's Transaction type are structurally same
      const userSig = await walletSignTx({ transaction: modifiedTx as unknown as string });

      // Step 2: Server admin co-signs the wallet's bytes and executes
      const executeRes = await fetch('/api/sui/sponsor-execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          txBytes: userSig.bytes,       // base64 BCS bytes the wallet built and signed
          userSignature: userSig.signature,
          sender: address,
        }),
      });
      const execData = await executeRes.json();

      if (!executeRes.ok || !execData.success) {
        throw new Error(execData.error || 'Sponsored execution failed');
      }

      return { digest: execData.digest || '', success: true };
    } catch (error: unknown) {
      logger.error('Sponsored transaction failed', error instanceof Error ? error : undefined, { component: 'SuiProvider' });
      const message = error instanceof Error ? error.message : String(error);
      const isUserRejection = message.includes('Rejected') || message.includes('User rejected') || message.includes('cancelled');
      return {
        digest: '',
        success: false,
        error: isUserRejection ? 'User rejected the transaction' : message,
      };
    }
  }, [isConnected, isWrongNetwork, walletNetwork, network, address, walletSignTx]);

  const getExplorerUrl = useCallback((type: 'tx' | 'address' | 'object', value: string): string => {
    const baseUrl = network === 'mainnet' 
      ? 'https://suiexplorer.com'
      : `https://suiexplorer.com/?network=${network}`;
    
    switch (type) {
      case 'tx':
        return `${baseUrl}/txblock/${value}`;
      case 'address':
        return `${baseUrl}/address/${value}`;
      case 'object':
        return `${baseUrl}/object/${value}`;
      default:
        return baseUrl;
    }
  }, [network]);

  const requestFaucetTokens = useCallback(async (): Promise<{ success: boolean; message: string }> => {
    if (!address) {
      return { success: false, message: 'Wallet not connected' };
    }

    if (network === 'mainnet') {
      return { success: false, message: 'Faucet not available on mainnet' };
    }

    try {
      const faucetUrl = network === 'devnet' 
        ? 'https://faucet.devnet.sui.io/v1/gas'
        : 'https://faucet.testnet.sui.io/v1/gas';

      const response = await fetch(faucetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          FixedAmountRequest: {
            recipient: address,
          },
        }),
      });

      if (response.ok) {
        return { success: true, message: 'Tokens requested successfully! Check your balance in a moment.' };
      } else {
        const error = await response.text();
        return { success: false, message: `Faucet request failed: ${error}` };
      }
    } catch (error: unknown) {
      return { success: false, message: `Faucet request failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }, [address, network]);

  const contractAddresses = useMemo(() => getSuiContractAddresses(network), [network]);

  const contextValue: SuiContextType = useMemo(() => ({
    network,
    setNetwork,
    isWrongNetwork,
    walletNetwork,
    address,
    isConnected,
    isConnecting,
    balance,
    balanceRaw,
    contractAddresses,
    connectWallet,
    disconnectWallet,
    executeTransaction,
    signTransaction,
    sponsoredExecute,
    getExplorerUrl,
    requestFaucetTokens,
  }), [
    network,
    setNetwork,
    isWrongNetwork,
    walletNetwork,
    address,
    isConnected,
    isConnecting,
    balance,
    balanceRaw,
    contractAddresses,
    connectWallet,
    disconnectWallet,
    executeTransaction,
    signTransaction,
    sponsoredExecute,
    getExplorerUrl,
    requestFaucetTokens,
  ]);

  return (
    <SuiContext.Provider value={contextValue}>
      {children}
    </SuiContext.Provider>
  );
}

// ============================================
// MAIN PROVIDER
// ============================================

interface SuiWalletProvidersProps {
  children: ReactNode;
  defaultNetwork?: NetworkType;
}

// Get default network from environment variable
const getDefaultSuiNetwork = (): NetworkType => {
  const envNetwork = process.env.NEXT_PUBLIC_SUI_NETWORK || process.env.SUI_NETWORK || 'mainnet';
  if (envNetwork === 'mainnet' || envNetwork === 'testnet' || envNetwork === 'devnet') {
    return envNetwork as NetworkType;
  }
  return 'mainnet';
};

export function SuiWalletProviders({
  children,
  defaultNetwork = getDefaultSuiNetwork(),
}: SuiWalletProvidersProps) {
  const [network, setNetwork] = useState<NetworkType>(defaultNetwork);

  const suiNetwork = network === 'mainnet' ? 'mainnet' : network === 'devnet' ? 'devnet' : 'testnet';

  // The parent <Providers> already supplies the QueryClientProvider that
  // @mysten/dapp-kit needs. Rendering our own here would nest a second
  // client + break useQuery cache sharing across the app.
  // Slush web flow — auto-registers a wallet-standard-compatible signer
  // for users who don't have the Slush extension installed. "Stashed" is
  // Slush's pre-rebrand internal name in @mysten/dapp-kit. When the
  // extension IS installed, dapp-kit prefers it over the web flow.
  const stashedWallet = useMemo(
    () => ({
      name: 'ZKward',
      network: (suiNetwork === 'testnet' ? 'testnet' : 'mainnet') as 'mainnet' | 'testnet',
    }),
    [suiNetwork],
  );

  return (
    <SuiClientProvider networks={networkConfig} defaultNetwork={suiNetwork}>
      <WalletProvider
        autoConnect
        stashedWallet={stashedWallet}
        // Boost commonly-installed wallets to the top of the modal so
        // detection order doesn't hide the wallet the user just installed.
        // Names come from each wallet's `name` field in the wallet-standard
        // registration — spelling matters exactly.
        preferredWallets={[
          'Slush',
          'Slush — A Sui wallet',
          'Sui Wallet',
          'Suiet',
          'Ethos Wallet',
          'Nightly',
          'OKX Wallet',
          'Phantom',
          'Backpack',
        ]}
      >
        <SuiContextProvider network={network} setNetwork={setNetwork}>
          {children}
        </SuiContextProvider>
      </WalletProvider>
    </SuiClientProvider>
  );
}

// ============================================
// EXPORTS
// ============================================

export { 
  useCurrentAccount as useSuiAccount,
  useSuiClient,
  useSignAndExecuteTransaction as useSuiTransaction,
};
