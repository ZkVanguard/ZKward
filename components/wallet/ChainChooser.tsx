'use client';

/**
 * The network selector — the only connect UI on the dashboard. One network
 * is active at a time: picking another one switches to it (and disconnects
 * the current one). Opened by the navbar (no preference) or by a surface
 * that needs a specific chain (pre-selected, with a reason).
 */

import { Check, ExternalLink, Loader2, LogOut, Wallet, X } from 'lucide-react';
import { CHAIN_INFO, WALLET_CHAINS, useWalletHub, type WalletChain } from '@/contexts/WalletHubContext';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ChainChooser() {
  const hub = useWalletHub();
  const { chooser } = hub;
  if (!chooser.open) return null;

  // The chain this page needs goes first, then the active one.
  const order: WalletChain[] = [...WALLET_CHAINS].sort((a, b) => rank(a) - rank(b));
  function rank(c: WalletChain) {
    if (c === chooser.chain) return 0;
    if (c === hub.activeChain) return 1;
    return 2;
  }

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="chain-chooser-title"
      onClick={hub.closeChooser}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full sm:max-w-[460px] mx-auto bg-white rounded-t-[28px] sm:rounded-[24px] shadow-2xl p-5 sm:p-6 max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sm:hidden flex justify-center -mt-1 mb-3">
          <div className="w-10 h-1 rounded-full bg-black/15" />
        </div>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 id="chain-chooser-title" className="text-[20px] font-semibold text-[#1d1d1f] tracking-[-0.01em]">
              {chooser.welcome ? 'Welcome to ZKward' : chooser.chain ? `Use ${CHAIN_INFO[chooser.chain].name}` : hub.isConnected ? 'Switch network' : 'Choose your network'}
            </h2>
            <p className="text-[13px] text-[#6e6e73] mt-1 leading-snug">
              {chooser.reason ??
                (chooser.welcome
                  ? 'Choose the network you want to use. Every tab follows your choice, and you can switch any time from the top bar.'
                  : 'You use one network at a time. Switching disconnects the current one.')}
            </p>
          </div>
          <button
            onClick={hub.closeChooser}
            aria-label="Close"
            className="p-2 -mr-2 -mt-1 rounded-full hover:bg-[#f5f5f7] text-[#6e6e73]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          {order.map((chain) => (
            <ChainCard key={chain} chain={chain} highlighted={chooser.chain === chain} />
          ))}
        </div>
        {chooser.welcome && (
          <button
            type="button"
            onClick={hub.closeChooser}
            className="mt-4 w-full h-10 rounded-xl text-[13px] font-medium text-[#6e6e73] hover:bg-[#f5f5f7]"
          >
            Browse first, decide later
          </button>
        )}
      </div>
    </div>
  );
}

function ChainCard({ chain, highlighted }: { chain: WalletChain; highlighted: boolean }) {
  const hub = useWalletHub();
  const info = CHAIN_INFO[chain];
  const w = hub[chain];
  const isActive = hub.activeChain === chain && w.connected;
  const pending = hub.activeChain === chain && !w.connected && w.busy;
  const error = hub.errors[chain];
  const pickers = chain === 'sui' && !isActive ? hub.suiWallets : [];
  const switchLabel = hub.isConnected && hub.activeChain !== chain ? `Switch to ${info.name}` : info.cta;

  return (
    <div
      className={`rounded-2xl border p-4 ${
        highlighted ? 'border-[#007AFF] bg-[#007AFF]/[0.04]' : isActive ? 'border-[#34C759]/40 bg-[#34C759]/[0.04]' : 'border-black/10 bg-white'
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold text-[11px]"
          style={{ background: info.color }}
        >
          {info.name.slice(0, 3).toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold text-[#1d1d1f]">{info.name}</span>
            <span className="text-[11px] text-[#86868b]">{info.net}</span>
            {isActive && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-800 bg-[#34C759]/10 rounded-full px-2 py-0.5">
                <Check className="w-3 h-3" /> Active
              </span>
            )}
            {highlighted && !isActive && (
              <span className="text-[11px] font-semibold text-[#007AFF] bg-[#007AFF]/10 rounded-full px-2 py-0.5">
                Needed here
              </span>
            )}
          </div>
          <div className="text-[13px] text-[#1d1d1f] mt-0.5">{info.pool}</div>
          <div className="text-[12px] text-[#6e6e73] mt-0.5 leading-snug">{info.how}</div>

          {isActive && w.address && (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <code className="font-mono text-[12px] text-[#1d1d1f] bg-[#f5f5f7] rounded-lg px-2 py-1">{short(w.address)}</code>
              <button
                onClick={() => void hub.disconnect(chain)}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-[#FF3B30] hover:underline"
              >
                <LogOut className="w-3.5 h-3.5" /> Disconnect
              </button>
            </div>
          )}

          {!isActive && pickers.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {pickers.map((wallet) => (
                <button
                  key={wallet.name}
                  onClick={() => void hub.connect('sui', wallet)}
                  disabled={w.busy}
                  className="inline-flex items-center gap-2 h-10 px-3 rounded-xl bg-[#f5f5f7] hover:bg-[#e8e8ed] text-[13px] font-medium text-[#1d1d1f] disabled:opacity-60"
                >
                  {wallet.name}
                </button>
              ))}
            </div>
          )}

          {!isActive && pickers.length <= 1 && (
            <button
              onClick={() => void hub.connect(chain)}
              disabled={w.busy}
              className="mt-3 inline-flex items-center gap-2 h-10 px-4 rounded-xl text-white text-[13px] font-semibold active:scale-[0.98] disabled:opacity-60"
              style={{ background: highlighted ? '#007AFF' : info.color }}
            >
              {pending || w.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
              {pending || w.busy ? 'Connecting…' : switchLabel}
            </button>
          )}

          {error && (
            <div className="mt-2 text-[12px] text-red-700 flex items-center gap-2 flex-wrap">
              <span>{error}</span>
              {info.installUrl && (
                <a
                  href={info.installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-semibold underline decoration-dotted"
                >
                  {info.installLabel} <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
