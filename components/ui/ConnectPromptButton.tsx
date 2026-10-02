'use client';

/**
 * Empty-state Connect CTA. On the dashboard it opens the wallet hub's
 * chain chooser, pre-selected on the chain the calling surface needs and
 * carrying a one-line reason, so every prompt leads to the same flow the
 * navbar uses. Outside the dashboard (no hub) it falls back to clicking the
 * navbar's connect button, which keeps marketing pages working without
 * importing the wallet SDKs.
 */

import { memo } from 'react';
import { Wallet } from 'lucide-react';
import { CHAIN_INFO, useWalletHubSafe, type WalletChain } from '@/contexts/WalletHubContext';

interface Props {
  /** Chain this surface needs; omit when any wallet will do. */
  chain?: WalletChain;
  /** One line shown under the chooser title: why this page asks. */
  reason?: string;
  label?: string;
  size?: 'md' | 'sm';
  className?: string;
}

export const ConnectPromptButton = memo(function ConnectPromptButton({
  chain,
  reason,
  label,
  size = 'md',
  className = '',
}: Props) {
  const hub = useWalletHubSafe();
  const onAnother = !!hub?.isConnected && !!chain && hub.activeChain !== chain;
  const text = label ?? (chain ? (onAnother ? `Switch to ${CHAIN_INFO[chain].name}` : CHAIN_INFO[chain].cta) : hub?.isConnected ? 'Switch network' : 'Connect wallet');
  const onClick = () => {
    if (hub) {
      hub.openChooser({ chain, reason });
      return;
    }
    const btn = document.querySelector<HTMLButtonElement>('[data-connect-cta="true"]');
    if (btn) {
      btn.click();
      btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  };
  const sizing = size === 'sm' ? 'px-3 h-8 text-[12px] rounded-[10px]' : 'px-5 h-11 text-[15px] rounded-[12px]';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 bg-ios-blue hover:bg-ios-blueHover active:scale-[0.98] text-white font-semibold transition-all shadow-ios-1 ${sizing} ${className}`}
    >
      <Wallet className={size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} strokeWidth={2.5} />
      {text}
    </button>
  );
});
