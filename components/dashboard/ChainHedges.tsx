'use client';

/**
 * Hedges for the user's ACTIVE network.
 *
 * SUI / Hedera: the wallet's hedge exposure from /api/portfolio/unified —
 * its share of the pool's live hedges plus hedges bound to the wallet.
 * Solana: the pool trades through its paper sleeve, which lives on the Pool
 * page, so the view points there. The view this replaces read a retired
 * testnet contract and told every user, on every network, "no hedges".
 */

import { useQuery } from '@tanstack/react-query';
import { Shield, TrendingDown, TrendingUp } from 'lucide-react';
import { useWallet } from '@/lib/hooks/useWallet';
import { CHAIN_INFO, useWalletHub, type WalletChain } from '@/contexts/WalletHubContext';
import { ConnectPromptButton } from '@/components/ui/ConnectPromptButton';
import { ChainBadge } from '@/components/wallet/ChainBadge';

interface HedgeExposure {
  market: string;
  side: 'LONG' | 'SHORT';
  attributedNotionalUsd: number;
  attributedUnrealizedPnlUsd: number;
  source: 'pool-share' | 'zk-ownership' | 'wallet-attributed';
}

const SOURCE_LABEL: Record<HedgeExposure['source'], string> = {
  'pool-share': 'Your share of the pool hedge',
  'zk-ownership': 'Your private hedge',
  'wallet-attributed': 'Your hedge',
};

/** Where hedges come from on each network, for the empty state. */
const EMPTY_NOTE: Record<WalletChain, string> = {
  sui: 'The SUI pool opens hedges on BlueFin when its signals call for protection. Your share of them appears here.',
  hedera: 'The Hedera pool holds USDC today. Its projected hedges are on the Pool page.',
  solana: 'The Solana pool trades through its paper sleeve, shown on the Pool page.',
};

const usd = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ChainHedges({ compact = false, onGoToPool }: { compact?: boolean; onGoToPool?: () => void }) {
  const hub = useWalletHub();
  const { portfolioAddress } = useWallet();
  const chain = hub.isConnected ? hub.activeChain : null;

  const { data, isLoading, error } = useQuery({
    queryKey: ['unified-portfolio', portfolioAddress],
    queryFn: async () => {
      const r = await fetch(`/api/portfolio/unified?wallet=${encodeURIComponent(portfolioAddress ?? '')}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { hedgeExposure?: HedgeExposure[] };
    },
    enabled: !!portfolioAddress,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const pad = compact ? 'px-4 sm:px-6 pb-5' : 'px-4 sm:px-6 pb-6';

  if (!chain) {
    return (
      <div className={`${pad} flex flex-col items-center text-center gap-3 py-6`}>
        <Shield className="w-8 h-8 text-[#86868b]" />
        <p className="text-[14px] text-[#1d1d1f] font-medium">Connect a wallet to see your hedges</p>
        <p className="text-[13px] text-[#6e6e73] max-w-[320px]">Hedges follow your active network.</p>
        <ConnectPromptButton reason="Hedges follow your active network. Pick the one you want to use." />
      </div>
    );
  }

  if (chain === 'solana') {
    return (
      <div className={`${pad} flex flex-col items-center text-center gap-3 py-6`}>
        <ChainBadge chain="solana" />
        <p className="text-[13px] text-[#6e6e73] max-w-[340px]">{EMPTY_NOTE.solana}</p>
        {onGoToPool && (
          <button
            type="button"
            onClick={onGoToPool}
            className="h-9 px-4 rounded-xl bg-ios-blue hover:bg-ios-blueHover text-white text-[13px] font-semibold active:scale-[0.98]"
          >
            Open the Solana pool
          </button>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={`${pad} space-y-2`}>
        {[0, 1].map((i) => (
          <div key={i} className="h-14 rounded-xl bg-[#f5f5f7] animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className={`${pad} text-[13px] text-red-700`}>Could not load your hedges. Try again in a moment.</p>;
  }

  const rows = data?.hedgeExposure ?? [];
  if (rows.length === 0) {
    return (
      <div className={`${pad} flex flex-col items-center text-center gap-3 py-6`}>
        <ChainBadge chain={chain} />
        <p className="text-[14px] text-[#1d1d1f] font-medium">No hedges on {CHAIN_INFO[chain].name} right now</p>
        <p className="text-[13px] text-[#6e6e73] max-w-[340px]">{EMPTY_NOTE[chain]}</p>
        {onGoToPool && (
          <button type="button" onClick={onGoToPool} className="text-[13px] font-medium text-ios-blue hover:underline">
            Open the {CHAIN_INFO[chain].name} pool
          </button>
        )}
      </div>
    );
  }

  const shown = compact ? rows.slice(0, 3) : rows;
  const totalNotional = rows.reduce((s, r) => s + r.attributedNotionalUsd, 0);
  const totalPnl = rows.reduce((s, r) => s + r.attributedUnrealizedPnlUsd, 0);

  return (
    <div className={`${pad} space-y-3`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <ChainBadge chain={chain} />
        <span className="text-[12px] text-[#6e6e73] tabular-nums">
          {rows.length} hedge{rows.length === 1 ? '' : 's'} · {usd(totalNotional)} notional ·{' '}
          <span className={totalPnl >= 0 ? 'text-green-700' : 'text-red-700'}>{totalPnl >= 0 ? '+' : ''}{usd(totalPnl)}</span>
        </span>
      </div>
      <div className="space-y-2">
        {shown.map((h, i) => (
          <div key={`${h.market}-${h.side}-${i}`} className="flex items-center justify-between gap-3 rounded-xl bg-[#f5f5f7] px-3 py-2.5">
            <div className="flex items-center gap-2.5 min-w-0">
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                  h.side === 'LONG' ? 'bg-[#34C759]/10 text-green-800' : 'bg-[#FF3B30]/10 text-red-700'
                }`}
              >
                {h.side === 'LONG' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {h.side}
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-[#1d1d1f] truncate">{h.market}</div>
                <div className="text-[11px] text-[#6e6e73] truncate">{SOURCE_LABEL[h.source]}</div>
              </div>
            </div>
            <div className="text-right tabular-nums flex-shrink-0">
              <div className="text-[13px] font-semibold text-[#1d1d1f]">{usd(h.attributedNotionalUsd)}</div>
              <div className={`text-[11px] font-medium ${h.attributedUnrealizedPnlUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                {h.attributedUnrealizedPnlUsd >= 0 ? '+' : ''}{usd(h.attributedUnrealizedPnlUsd)}
              </div>
            </div>
          </div>
        ))}
      </div>
      {compact && rows.length > shown.length && (
        <p className="text-[12px] text-[#6e6e73]">+{rows.length - shown.length} more in the Hedges view</p>
      )}
    </div>
  );
}
