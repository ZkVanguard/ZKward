'use client';

/**
 * The network selector — the only connect UI on the dashboard. One network
 * is active at a time: picking another one switches to it (and disconnects
 * the current one). Opened by the navbar (no preference) or by a surface
 * that needs a specific chain (pre-selected, with a reason).
 *
 * Each card shows the network's official mark, whether its money is real,
 * and whether this browser already has the wallet it needs. The card the
 * visitor most likely wants leads and says why (lib/wallet/suggest-chain).
 */

import { Check, ExternalLink, Loader2, LogOut, Smartphone, Sparkles, Wallet, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { CHAIN_INFO, WALLET_CHAINS, useWalletHub, type WalletChain } from '@/contexts/WalletHubContext';
import { ChainLogo, FundsTag } from '@/components/wallet/ChainLogo';
import { installedSuiWallets } from '@/lib/wallet/suggest-chain';
import { SOLANA_MOBILE_WALLETS, SUI_MOBILE_WALLETS, isMobileBrowser, walletHandoffLink } from '@/lib/utils/mobile-wallet';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ChainChooser() {
  const hub = useWalletHub();
  const t = useTranslations('wallet');
  const { chooser } = hub;
  if (!chooser.open) return null;

  // The chain this page needs goes first, then the active one, then the suggestion.
  const order: WalletChain[] = [...WALLET_CHAINS].sort((a, b) => rank(a) - rank(b));
  function rank(c: WalletChain) {
    if (c === chooser.chain) return 0;
    if (c === hub.activeChain) return 1;
    if (c === hub.suggestion.chain) return 2;
    return 3;
  }
  // Suggest only when nothing more specific is in play.
  const suggested = !chooser.chain && !hub.isConnected ? hub.suggestion.chain : null;

  const title = chooser.welcome
    ? t('chooser.welcomeTitle')
    : chooser.chain
      ? t('chooser.useTitle', { chain: CHAIN_INFO[chooser.chain].name })
      : hub.isConnected
        ? t('chooser.switchTitle')
        : t('chooser.chooseTitle');

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
        className="relative w-full sm:max-w-[480px] mx-auto bg-white rounded-t-[28px] sm:rounded-[24px] shadow-2xl p-5 sm:p-6 max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sm:hidden flex justify-center -mt-1 mb-3">
          <div className="w-10 h-1 rounded-full bg-black/15" />
        </div>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 id="chain-chooser-title" className="text-[20px] font-semibold text-[#1d1d1f] tracking-[-0.01em]">
              {title}
            </h2>
            <p className="text-[13px] text-[#6e6e73] mt-1 leading-snug">
              {chooser.reason ?? (chooser.welcome ? t('chooser.welcomeBody') : t('chooser.body'))}
            </p>
          </div>
          <button
            onClick={hub.closeChooser}
            aria-label={t('chooser.close')}
            className="p-2 -mr-2 -mt-1 rounded-full hover:bg-[#f5f5f7] text-[#6e6e73]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-3">
          {order.map((chain) => (
            <ChainCard key={chain} chain={chain} highlighted={chooser.chain === chain} suggested={suggested === chain} />
          ))}
        </div>
        {chooser.welcome && (
          <button
            type="button"
            onClick={hub.closeChooser}
            className="mt-4 w-full h-10 rounded-xl text-[13px] font-medium text-[#6e6e73] hover:bg-[#f5f5f7]"
          >
            {t('chooser.browseFirst')}
          </button>
        )}
      </div>
    </div>
  );
}

function ChainCard({ chain, highlighted, suggested }: { chain: WalletChain; highlighted: boolean; suggested: boolean }) {
  const hub = useWalletHub();
  const t = useTranslations('wallet');
  const info = CHAIN_INFO[chain];
  const w = hub[chain];
  const isActive = hub.activeChain === chain && w.connected;
  const pending = hub.activeChain === chain && !w.connected && w.busy;
  const error = hub.errors[chain];
  const pickers = chain === 'sui' && !isActive ? hub.suiWallets : [];
  const switchLabel = hub.isConnected && hub.activeChain !== chain ? t('chooser.switchTo', { chain: info.name }) : t(`chains.${chain}.cta`);

  // What this browser already has for this network.
  const suiNames = installedSuiWallets(hub.suiWallets.map((x) => x.name));
  const detected =
    chain === 'hedera'
      ? { ok: true, text: t('detect.hedera') }
      : chain === 'sui'
        ? suiNames.length > 0
          ? { ok: true, text: t('detect.suiFound', { wallet: suiNames.join(', ') }) }
          : { ok: false, text: t('detect.suiMissing') }
        : hub.solanaWalletFound
          ? { ok: true, text: t('detect.solanaFound') }
          : { ok: false, text: t('detect.solanaMissing') };

  // A phone's browser has no wallet extension: SUI and Solana wallets live in
  // their own apps. Offer to open this page inside one (an <a>: iOS only hands
  // universal links to the app from a real tap). Hedera needs no wallet app.
  const needsApp = chain !== 'hedera' && !isActive && isMobileBrowser() && (chain === 'solana' ? !hub.solanaWalletFound : suiNames.length === 0);
  const apps = needsApp ? (chain === 'solana' ? SOLANA_MOBILE_WALLETS : SUI_MOBILE_WALLETS) : [];

  return (
    <div
      className={`rounded-2xl border p-4 transition-colors ${
        highlighted
          ? 'border-[#007AFF] bg-[#007AFF]/[0.04]'
          : isActive
            ? 'border-[#34C759]/40 bg-[#34C759]/[0.04]'
            : suggested
              ? 'border-[#007AFF]/40 bg-[#007AFF]/[0.03]'
              : 'border-black/10 bg-white'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-2xl bg-[#f5f5f7] flex items-center justify-center flex-shrink-0">
          <ChainLogo chain={chain} size={26} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[15px] font-semibold text-[#1d1d1f]">{info.name}</span>
            <span className="text-[11px] text-[#86868b]">{t(`net.${info.net}`)}</span>
            <FundsTag chain={chain} />
            {isActive && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-800 bg-[#34C759]/10 rounded-full px-2 py-0.5">
                <Check className="w-3 h-3" /> {t('chooser.active')}
              </span>
            )}
            {highlighted && !isActive && (
              <span className="text-[11px] font-semibold text-[#007AFF] bg-[#007AFF]/10 rounded-full px-2 py-0.5">
                {t('chooser.neededHere')}
              </span>
            )}
          </div>
          {suggested && !isActive && (
            <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-[#007AFF]">
              <Sparkles className="w-3 h-3" />
              {t('chooser.suggested')} · {t(`why.${hub.suggestion.reason === 'no-install' ? 'noInstall' : hub.suggestion.reason}`)}
            </div>
          )}
          <div className="text-[13px] text-[#1d1d1f] mt-0.5">{t(`chains.${chain}.pool`)}</div>
          <div className="text-[12px] text-[#6e6e73] mt-0.5 leading-snug">{t(`chains.${chain}.how`)}</div>
          {!isActive && (
            <div className={`mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] ${detected.ok ? 'text-green-800' : 'text-[#86868b]'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${detected.ok ? 'bg-[#34C759]' : 'bg-[#c7c7cc]'}`} />
              {apps.length > 0 ? t('detect.mobileHandoff') : detected.text}
              {!detected.ok && apps.length === 0 && info.installUrl && (
                <a href={info.installUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-semibold text-[#007AFF] hover:underline">
                  {t(`install.${chain}`)} <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}

          {isActive && w.address && (
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <code className="font-mono text-[12px] text-[#1d1d1f] bg-[#f5f5f7] rounded-lg px-2 py-1">{short(w.address)}</code>
              <button
                onClick={() => void hub.disconnect(chain)}
                className="inline-flex items-center gap-1 text-[12px] font-medium text-[#FF3B30] hover:underline"
              >
                <LogOut className="w-3.5 h-3.5" /> {t('chooser.disconnect')}
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
                  {wallet.icon && (
                    <img src={wallet.icon} alt="" className="w-5 h-5 rounded" />
                  )}
                  {wallet.name}
                </button>
              ))}
            </div>
          )}

          {apps.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {apps.map((app, i) => (
                <a
                  key={app.id}
                  href={walletHandoffLink(app, chain as 'sui' | 'solana', window.location.href)}
                  className={`inline-flex items-center gap-2 h-10 px-4 rounded-xl text-[13px] font-semibold active:scale-[0.98] ${i === 0 ? 'text-white' : 'bg-[#f5f5f7] text-[#1d1d1f]'}`}
                  style={i === 0 ? { background: highlighted || suggested ? '#007AFF' : info.color } : undefined}
                >
                  <Smartphone className="w-4 h-4" />
                  {t('mobile.openIn', { wallet: app.name })}
                </a>
              ))}
            </div>
          )}

          {/* Solana has no browser wallet on a phone, so its button would only
              fail; SUI keeps it (Slush also signs in the browser). */}
          {!isActive && pickers.length <= 1 && !(apps.length > 0 && chain === 'solana') && (
            <button
              onClick={() => void hub.connect(chain)}
              disabled={w.busy}
              // With wallet-app links above, this is the secondary way in.
              className={`mt-3 inline-flex items-center gap-2 h-10 px-4 rounded-xl text-[13px] font-semibold active:scale-[0.98] disabled:opacity-60 ${apps.length > 0 ? 'bg-[#f5f5f7] text-[#1d1d1f]' : 'text-white'}`}
              style={apps.length > 0 ? undefined : { background: highlighted || suggested ? '#007AFF' : info.color }}
            >
              {pending || w.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
              {pending || w.busy ? t('chooser.connecting') : switchLabel}
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
                  {t(`install.${chain}`)} <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
