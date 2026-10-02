'use client';

/**
 * Returning user whose network is remembered but whose wallet did not come
 * back on its own (locked extension, expired sign-in): one line at the top
 * of the dashboard with the two actions that matter.
 */

import { CHAIN_INFO, useWalletHub } from '@/contexts/WalletHubContext';

export function ReconnectBanner() {
  const hub = useWalletHub();
  const chain = hub.activeChain;
  if (!chain || hub.isConnected || hub[chain].busy) return null;
  const info = CHAIN_INFO[chain];
  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-black/5 bg-white px-4 py-3 shadow-sm">
      <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: info.color }} />
      <p className="flex-1 min-w-[200px] text-[13px] text-[#1d1d1f]">
        You last used <strong>{info.name}</strong>. {chain === 'hedera' ? 'Sign in again' : 'Reconnect'} to pick up where you left off.
      </p>
      <button
        type="button"
        onClick={() => void hub.connect(chain)}
        className="h-9 px-4 rounded-xl bg-ios-blue hover:bg-ios-blueHover text-white text-[13px] font-semibold active:scale-[0.98]"
      >
        {chain === 'hedera' ? 'Sign in' : 'Reconnect'}
      </button>
      <button
        type="button"
        onClick={() => hub.openChooser()}
        className="h-9 px-3 rounded-xl text-[13px] font-medium text-[#6e6e73] hover:bg-[#f5f5f7]"
      >
        Switch network
      </button>
    </div>
  );
}
