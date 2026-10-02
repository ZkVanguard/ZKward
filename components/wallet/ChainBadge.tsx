'use client';

/**
 * Chain context, said out loud. `ChainBadge` names a network (and its
 * mainnet/testnet/devnet tier) next to an address; `WalletContextBadge`
 * tells a portfolio surface which wallet it is showing — these views pick
 * one wallet (SUI first, then the Hedera sign-in), and without the badge
 * the user cannot tell which one they are looking at.
 */

import { useWallet } from '@/lib/hooks/useWallet';
import { CHAIN_INFO, useWalletHubSafe, type WalletChain } from '@/contexts/WalletHubContext';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ChainBadge({
  chain,
  address,
  size = 'sm',
  className = '',
}: {
  chain: WalletChain;
  address?: string | null;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const info = CHAIN_INFO[chain];
  const text = size === 'sm' ? 'text-[11px]' : 'text-[12px]';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 bg-[#f5f5f7] text-[#1d1d1f] font-medium ${text} ${className}`}
      title={`${info.name} ${info.net}`}
    >
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: info.color }} />
      {info.name}
      <span className="text-[#86868b] font-normal">{info.net}</span>
      {address && <span className="font-mono text-[#6e6e73]">{short(address)}</span>}
    </span>
  );
}

/** "Showing SUI mainnet 0x12…ab · Manage wallets" for the portfolio surfaces. */
export function WalletContextBadge({ className = '' }: { className?: string }) {
  const w = useWallet();
  const hub = useWalletHubSafe();
  if (!w.address) return null;
  const chain: WalletChain = w.isSUI ? 'sui' : 'hedera';
  // An injected EVM wallet that is not the Privy sign-in is still an EVM wallet; say so.
  const isPrivy = !!hub?.hedera.address && hub.hedera.address.toLowerCase() === (w.evmAddress ?? '').toLowerCase();
  const others = hub
    ? [hub.hedera.connected && chain !== 'hedera', hub.sui.connected && chain !== 'sui', hub.solana.connected].filter(Boolean).length
    : 0;
  return (
    <span className={`inline-flex items-center gap-2 flex-wrap ${className}`}>
      <span className="text-[11px] text-[#86868b]">Showing</span>
      {chain === 'hedera' && !isPrivy ? (
        <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 bg-[#f5f5f7] text-[11px] font-medium text-[#1d1d1f]">
          <span className="w-2 h-2 rounded-full bg-[#86868b]" />
          EVM wallet <span className="font-mono text-[#6e6e73]">{short(w.address)}</span>
        </span>
      ) : (
        <ChainBadge chain={chain} address={w.address} />
      )}
      {hub && others > 0 && (
        <button
          type="button"
          onClick={() => hub.openChooser({ reason: 'These pages show one wallet at a time: your SUI wallet first, otherwise your Hedera sign-in. Disconnect one to see the other.' })}
          className="text-[11px] font-medium text-ios-blue hover:underline"
        >
          Manage wallets
        </button>
      )}
    </span>
  );
}
