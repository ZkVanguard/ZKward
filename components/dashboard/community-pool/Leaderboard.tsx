'use client';

import { memo } from 'react';
import { Award, Shield, ExternalLink, CheckCircle2, Database } from 'lucide-react';
import type { LeaderboardEntry } from './types';
import { formatPercent } from './utils';
import { WalletAvatar } from '@/components/ui/WalletAvatar';
import { useWalletProfile } from '@/lib/hooks/useWalletProfile';

const RANK_STYLES = [
  'bg-yellow-500 text-white',
  'bg-gray-400 text-white',
  'bg-orange-600 text-white',
];

/**
 * Single leaderboard row. Reads its own profile via React Query so
 * when useSetWalletProfile mutates + invalidates walletProfileKey(addr),
 * the row rerenders with the fresh display name — no need to refetch
 * the whole leaderboard endpoint. The entry.displayName from the parent
 * (baked at fetch time) is the fallback for the first paint.
 */
const LeaderboardRow = memo(function LeaderboardRow({
  entry,
  rank,
}: {
  entry: LeaderboardEntry;
  rank: number;
}) {
  const { data: fresh } = useWalletProfile(entry.walletAddress);
  const truncated = `${entry.walletAddress.slice(0, 6)}…${entry.walletAddress.slice(-4)}`;
  const displayName = (fresh?.displayName ?? entry.displayName)?.trim() || null;
  return (
    <div className="flex items-center justify-between gap-3 p-2 sm:p-3 rounded-lg bg-gray-50 dark:bg-gray-700/50 min-w-0">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
        <span
          className={`w-6 h-6 flex items-center justify-center rounded-full text-xs font-bold flex-shrink-0 ${
            RANK_STYLES[rank] || 'bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300'
          }`}
        >
          {rank + 1}
        </span>
        <WalletAvatar address={entry.walletAddress} name={displayName} size={32} />
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-[13px] sm:text-sm font-semibold text-label-primary truncate">
            {displayName ?? truncated}
          </span>
          {displayName ? (
            <span className="text-[10px] sm:text-[11px] text-label-tertiary font-mono truncate">
              {truncated}
            </span>
          ) : (
            <span className="text-[9px] sm:text-[10px] text-label-tertiary">no name set</span>
          )}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <p className="text-xs sm:text-sm font-semibold text-gray-900 dark:text-white tabular-nums">
          {entry.shares.toFixed(2)} shares
        </p>
        <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 tabular-nums">
          {formatPercent(entry.percentage)}
        </p>
      </div>
    </div>
  );
});
interface LeaderboardProps {
  entries: LeaderboardEntry[];
  /** Total member count (may exceed `entries.length` if the leaderboard is
   *  truncated to top N). Falls back to `entries.length` when omitted. */
  totalMembers?: number;
  proxyWallet?: string;
  poolTVL?: number;
  chainId?: number;
  selectedChain?: string;
  chainConfig?: {
    chainType?: string;
    name?: string;
    contracts?: {
      testnet?: { communityPool?: string; usdt?: string };
      mainnet?: { communityPool?: string; usdt?: string };
    };
    blockExplorer?: { testnet?: string; mainnet?: string };
    assets?: string[];
  };
}

// Treasury addresses for EVM chains
const POOL_PROXY_WALLETS: Record<string, { address: string; name: string }> = {
  sepolia: {
    address: '0x07d68C2828F35327d12a7Ba796cCF3f12F8A1086',
    name: 'Pool Contract (USDT)',
  },
  cronos: {
    address: '0x7F75Ca65D32752607fF481F453E4fbD45E61FdFd',
    name: 'Pool Contract',
  },
  hedera: {
    address: '0x18a8d89E3674EBCeC678f97A8a8b1D144b330b88',
    name: 'SimpleUsdcVaultV2 (Hedera Testnet)',
  },
};

const EXPLORER_URLS: Record<number, string> = {
  11155111: 'https://sepolia.etherscan.io',
  338: 'https://explorer.cronos.org/testnet',
  296: 'https://hashscan.io/testnet',
};

// Deterministic treasury proxy — kept as an exported utility but no
// longer used to display the "vault address" on the leaderboard card.
// Would confuse users into thinking the vault lived at a hashed 0x...
// address (0x18fbc0…ad99ec) that isn't actually on-chain anywhere.

export const Leaderboard = memo(function Leaderboard({
  entries,
  totalMembers,
  proxyWallet,
  poolTVL,
  chainId = 11155111,
  selectedChain,
  chainConfig,
}: LeaderboardProps) {
  // Effective total — prop wins, but fall back to entries.length so the
  // "top N of M" chip is always sane even if the caller didn't wire it.
  const memberTotal = Math.max(totalMembers ?? 0, entries.length);
  const showingCount = entries.length;
  const isTruncated = memberTotal > showingCount;
  const isSui = selectedChain === 'sui' || chainConfig?.chainType === 'sui';

  // Get explorer URL based on chain
  const suiNetwork = (process.env.NEXT_PUBLIC_SUI_NETWORK || 'mainnet') as 'mainnet' | 'testnet';
  const explorerUrl = isSui
    ? chainConfig?.blockExplorer?.[suiNetwork] || `https://suiscan.xyz/${suiNetwork}`
    : EXPLORER_URLS[chainId] || EXPLORER_URLS[11155111];

  // Treasury info varies by chain. For EVM chains we show the ACTUAL
  // vault contract address from POOL_PROXY_WALLETS (canonical config),
  // NOT the derived-PDA hash (which is a legacy relic that confused
  // users into thinking the vault lived at a random 0x... address).
  const treasury = isSui
    ? {
        address: chainConfig?.contracts?.[suiNetwork]?.communityPool || '',
        name: 'Pool Contract (USDC)',
      }
    : proxyWallet
      ? { address: proxyWallet, name: POOL_PROXY_WALLETS[selectedChain || 'sepolia']?.name || 'Pool Treasury' }
      : POOL_PROXY_WALLETS[selectedChain || 'sepolia'] || POOL_PROXY_WALLETS.sepolia;

  // Build explorer link based on chain type
  const contractUrl = isSui
    ? `${explorerUrl}/object/${treasury.address}`
    : `${explorerUrl}/address/${treasury.address}`;

  return (
    <div className="p-4 sm:p-5">
      {/* Pool Contract Info */}
      <div className="mb-4 p-3 sm:p-4 rounded-lg bg-ios-blue/5 border border-ios-blue/15">
        <div className="flex items-center gap-2 mb-2">
          {isSui ? (
            <Database className="w-4 h-4 text-blue-500 flex-shrink-0" />
          ) : (
            <Shield className="w-4 h-4 text-purple-500 flex-shrink-0" />
          )}
          <span className="font-semibold text-xs sm:text-sm text-purple-600 dark:text-purple-400 truncate">
            {treasury.name}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] sm:text-xs text-gray-600 dark:text-gray-400 font-mono truncate min-w-0">
            {treasury.address
              ? `${treasury.address.slice(0, 8)}...${treasury.address.slice(-6)}`
              : 'N/A'}
          </span>
          {poolTVL !== undefined && (
            <span className="text-xs sm:text-sm font-bold text-purple-600 dark:text-purple-400 tabular-nums flex-shrink-0">
              ${poolTVL.toLocaleString()} TVL
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-2">
          {treasury.address && (
            <a
              href={contractUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" />
              {isSui ? 'View on SuiScan' : 'View Contract'}
            </a>
          )}
          {isSui && chainConfig?.contracts?.[suiNetwork]?.usdt && (
            <a
              href={`${explorerUrl}/object/${chainConfig.contracts[suiNetwork].usdt}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" />
              USDC Token
            </a>
          )}
          {!isSui && treasury.address && (
            <a
              href={`${explorerUrl}/address/${treasury.address}#tokentxns`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink className="w-3 h-3" />
              Token Transfers
            </a>
          )}
        </div>
      </div>

      {/* SUI Pool Info */}
      {isSui && (
        <div className="mb-4 p-3 sm:p-4 rounded-lg bg-blue-500/10 border border-blue-500/20">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-4 h-4 text-blue-500 flex-shrink-0" />
            <span className="font-semibold text-xs sm:text-sm text-blue-600 dark:text-blue-400">
              Database-Backed USDC Pool
            </span>
          </div>
          <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 leading-relaxed">
            Deposits are recorded in the pool database. AI manages a 3-asset allocation across{' '}
            {chainConfig?.assets?.join(', ') || 'BTC, ETH, SUI'}. Share price starts at $1 at
            inception and tracks the pool&apos;s on-chain NAV oracle as the AI grows capital.
          </p>
        </div>
      )}

      {/* Shareholders Leaderboard */}
      {entries.length > 0 && (
        <>
          <h3 className="pool-inner-heading font-semibold text-gray-900 dark:text-white flex items-center gap-2 flex-wrap mb-2 text-sm sm:text-base">
            <Award className="w-4 h-4 text-yellow-500 flex-shrink-0" />
            <span>Top Shareholders</span>
            {isTruncated && (
              <span className="text-[10px] sm:text-[11px] font-normal text-gray-500 dark:text-gray-400 tabular-nums">
                showing {showingCount} of {memberTotal.toLocaleString()}
              </span>
            )}
          </h3>
          <p className="pool-inner-subheading text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mb-3 leading-relaxed">
            Direct on-chain shareholders, ranked by share balance. Set a display name in your
            wallet profile to appear as a label instead of an address.
          </p>
          <div className="space-y-2">
            {entries
              .filter((user) => user?.walletAddress)
              .map((user, index) => (
                <LeaderboardRow key={user.walletAddress} entry={user} rank={index} />
              ))}
          </div>
        </>
      )}
    </div>
  );
});
