/**
 * What the platform says about each network everywhere it names one: name,
 * tier, official mark, whether its money is real, accent colour. Plain data
 * with no wallet SDK behind it, so marketing pages (footer, homepage) can
 * draw the marks without loading the dashboard's wallet code.
 */
export type WalletChain = 'hedera' | 'sui' | 'solana';
export const WALLET_CHAINS: readonly WalletChain[] = ['hedera', 'sui', 'solana'];

export interface ChainMeta {
  name: string;
  /** Tier key: translated under `wallet.net.*`. */
  net: 'mainnet' | 'testnet' | 'devnet';
  /** The network's own published mark (public/logos/chains/). */
  logo: string;
  realFunds: boolean;
  color: string;
  installUrl: string;
}

// Build-time: NEXT_PUBLIC_SOLANA_CLUSTER=mainnet-beta turns the Solana badge to "mainnet · real funds".
const SOLANA_MAINNET = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER || '').trim().startsWith('mainnet');

export const CHAIN_META: Record<WalletChain, ChainMeta> = {
  hedera: { name: 'Hedera', net: 'testnet', logo: '/logos/chains/hedera.svg', realFunds: false, color: '#1d1d1f', installUrl: '' },
  sui: { name: 'SUI', net: 'mainnet', logo: '/logos/chains/sui.svg', realFunds: true, color: '#4DA2FF', installUrl: 'https://slush.app/' },
  solana: { name: 'Solana', net: SOLANA_MAINNET ? 'mainnet' : 'devnet', logo: '/logos/chains/solana.svg', realFunds: SOLANA_MAINNET, color: '#9945FF', installUrl: 'https://phantom.app/download' },
};
