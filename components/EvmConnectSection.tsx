'use client';

/**
 * EVM connect section — Hedera-primary flow.
 *
 * Rendered inside ConnectButton when no wallet is connected. Presents
 * Hedera Testnet as the default target, offers Hedera Mainnet + legacy
 * Sepolia/Cronos as advanced options, and uses wagmi's injected +
 * Coinbase connectors so users' existing wallets (MetaMask, Rabby,
 * Coinbase, Brave, Trust) all work.
 *
 * When connected, shows an EVM-flavored dropdown with chain switcher +
 * copy address + explorer link + disconnect. Reads chain metadata from
 * lib/evm-wallet/wagmi-config.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSwitchChain,
  type Connector,
} from 'wagmi';
import { ChevronDown, Copy, Check, ExternalLink, LogOut, Wallet } from 'lucide-react';
import { CHAIN_PICKER_ORDER, isHederaChain, hederaTestnet } from '@/lib/evm-wallet/wagmi-config';

// Hedera brand-ish teal for the primary CTA + badges.
const HEDERA_ACCENT = '#00A79F';

// Manual add-network fallback. Wagmi's switchChain normally calls
// wallet_addEthereumChain under the hood, but Coinbase Smart Wallet,
// Phantom's EVM shim, and some in-app browser wallets swallow that
// automatic path. Calling the EIP-1193 method directly always works if
// the wallet supports arbitrary chains at all — MetaMask, Rabby, Trust,
// Brave, Coinbase Extension.
async function addHederaTestnetToWallet(): Promise<{ ok: boolean; error?: string }> {
  const eth = (typeof window !== 'undefined' ? (window as unknown as { ethereum?: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } }).ethereum : undefined);
  if (!eth?.request) return { ok: false, error: 'No injected EVM wallet detected' };
  try {
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: `0x${hederaTestnet.id.toString(16)}`,
        chainName: hederaTestnet.name,
        nativeCurrency: hederaTestnet.nativeCurrency,
        rpcUrls: [...hederaTestnet.rpcUrls.default.http],
        blockExplorerUrls: [hederaTestnet.blockExplorers!.default.url],
      }],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function connectorIcon(connector: Connector): string {
  const name = connector.name.toLowerCase();
  if (name.includes('metamask')) return '🦊';
  if (name.includes('coinbase')) return '🟦';
  if (name.includes('rabby')) return '🐰';
  if (name.includes('trust')) return '🛡️';
  if (name.includes('brave')) return '🦁';
  if (name.includes('walletconnect')) return '🔗';
  return '💼';
}

function connectorHint(connector: Connector): string | null {
  const name = connector.name.toLowerCase();
  const id = connector.id?.toLowerCase() ?? '';
  if (id === 'walletconnect' || name.includes('walletconnect')) return 'QR · mobile wallets';
  if (name.includes('coinbase')) return 'No extension needed';
  if (id === 'injected' && name === 'injected') return 'Detected browser wallet';
  return null;
}

export function EvmConnectSection() {
  const { address, chainId, isConnected, isConnecting } = useAccount();
  const { connectors, connect, isPending: isConnectPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const [showConnectors, setShowConnectors] = useState(false);
  const [showAccountMenu, setShowAccountMenu] = useState(false);
  const [copied, setCopied] = useState(false);

  const onHedera = isHederaChain(chainId);
  const activeChain = useMemo(
    () => CHAIN_PICKER_ORDER.find((c) => c.id === chainId),
    [chainId],
  );

  const copyAddress = useCallback(() => {
    if (!address) return;
    navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [address]);

  // Filter connectors. Dedupe by name; wagmi surfaces multiple entries
  // when the browser has both MetaMask + a wagmi-defined injected.
  const usableConnectors = useMemo(() => {
    const seen = new Set<string>();
    return connectors.filter((c) => {
      const key = c.name.toLowerCase().replace(/\s+/g, '-');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [connectors]);

  // ─── Not connected. Show Hedera-first connect CTA ─────────────────────
  if (!isConnected) {
    return (
      <div className="relative">
        <button
          data-connect-cta="true"
          onClick={() => setShowConnectors((v) => !v)}
          disabled={isConnectPending || isConnecting}
          className="px-4 h-11 rounded-[12px] font-semibold text-[15px] transition-all flex items-center gap-2 text-white active:scale-[0.98] disabled:opacity-70"
          style={{ background: HEDERA_ACCENT }}
        >
          <Wallet className="w-4 h-4" />
          <span>{isConnectPending ? 'Connecting…' : 'Connect Hedera'}</span>
          <ChevronDown className="w-3.5 h-3.5 opacity-80" />
        </button>

        {showConnectors && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowConnectors(false)} />
            <div className="absolute top-full mt-2 right-0 w-72 bg-white dark:bg-[#1c1c1e] border border-[#E5E5EA] dark:border-[#38383a] rounded-xl shadow-lg overflow-hidden z-50">
              <div className="p-3">
                <div className="flex items-center gap-2 mb-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                    style={{ background: HEDERA_ACCENT }}
                  >
                    ℏ
                  </div>
                  <div>
                    <div className="text-[14px] font-semibold text-label-primary dark:text-white">
                      Connect to Hedera
                    </div>
                    <div className="text-[11px] text-label-tertiary">
                      Pick a wallet. Testnet by default
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5">
                  {usableConnectors.length === 0 && (
                    <div className="text-[12px] text-label-tertiary p-2 leading-relaxed">
                      No wallet detected.{' '}
                      <a
                        href="https://metamask.io/download/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#00A79F] font-medium hover:underline"
                      >
                        Install MetaMask →
                      </a>
                    </div>
                  )}
                  {usableConnectors.map((c) => {
                    const hint = connectorHint(c);
                    return (
                      <button
                        key={c.uid}
                        onClick={() => {
                          // chainId hint asks the wallet to open on Hedera
                          // Testnet instead of whatever chain it was last on.
                          // MetaMask / Rabby honour this; wallets that don't
                          // fall back to their current chain — the
                          // "Add Hedera Testnet" button below handles them.
                          connect({ connector: c, chainId: hederaTestnet.id });
                          setShowConnectors(false);
                        }}
                        disabled={isConnectPending}
                        className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] active:scale-[0.98] transition-all disabled:opacity-60"
                      >
                        <span className="text-lg flex-shrink-0">{connectorIcon(c)}</span>
                        <div className="flex-1 text-left min-w-0">
                          <div className="text-[13px] font-medium text-label-primary dark:text-white truncate">
                            {c.name}
                          </div>
                          {hint && (
                            <div className="text-[10px] text-label-tertiary truncate">{hint}</div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* Escape hatch: some wallets (Coinbase Smart, Phantom EVM
                    shim, some in-app browsers) don't auto-add Hedera when
                    wagmi asks. This button calls wallet_addEthereumChain
                    directly. Idempotent — safe to click twice. */}
                <button
                  onClick={async () => {
                    const res = await addHederaTestnetToWallet();
                    if (!res.ok) {
                      // eslint-disable-next-line no-alert
                      alert(`Couldn't add Hedera Testnet: ${res.error ?? 'unknown error'}`);
                    }
                  }}
                  className="mt-2 w-full text-[11px] py-1.5 rounded-lg border border-[#00A79F]/30 text-[#00A79F] hover:bg-[#00A79F]/5 active:scale-[0.98] transition-all"
                >
                  Add Hedera Testnet to wallet
                </button>

                <div className="mt-2 text-[10px] leading-relaxed text-label-tertiary">
                  Works with MetaMask, Rabby, Trust, Brave, Coinbase Extension.
                  Phantom&apos;s EVM mode does not support Hedera.
                </div>

                {connectError && (
                  <div className="mt-2 text-[11px] text-[#FF3B30]">
                    {connectError.message.slice(0, 100)}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  // ─── Connected but wrong chain. Nudge to Hedera ────────────────────────
  if (!onHedera) {
    return (
      <div className="relative">
        <button
          onClick={async () => {
            try {
              await switchChain({ chainId: hederaTestnet.id });
            } catch {
              // Wallet doesn't have Hedera configured and wagmi's built-in
              // add-then-switch failed. Add manually via EIP-1193; on
              // success most wallets auto-switch.
              await addHederaTestnetToWallet();
            }
          }}
          disabled={isSwitching}
          className="h-11 px-3 border border-[#FF9500]/40 bg-[#FF9500]/10 rounded-[12px] flex items-center gap-2 text-[13px] font-medium text-[#B26400] disabled:opacity-70"
        >
          <span className="w-2 h-2 rounded-full bg-[#FF9500]" />
          {isSwitching ? 'Switching…' : `Switch to Hedera (${activeChain?.name ?? chainId})`}
        </button>
      </div>
    );
  }

  // ─── Connected on Hedera ────────────────────────────────────────────────
  return (
    <div className="relative">
      <button
        onClick={() => setShowAccountMenu((v) => !v)}
        className="h-11 bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] border border-black/5 dark:border-white/10 rounded-[12px] transition-colors flex items-center gap-2 px-3"
      >
        <div
          className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
          style={{ background: HEDERA_ACCENT }}
        >
          ℏ
        </div>
        <span className="text-label-primary dark:text-white font-medium text-[14px]">
          {truncate(address!)}
        </span>
        <ChevronDown className="w-3.5 h-3.5 text-label-tertiary" />
      </button>

      {showAccountMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowAccountMenu(false)} />
          <div className="absolute top-full mt-2 right-0 w-64 bg-white dark:bg-[#1c1c1e] border border-[#E5E5EA] dark:border-[#38383a] rounded-xl shadow-lg overflow-hidden z-50">
            <div className="p-3">
              <div className="flex items-center gap-2 mb-3">
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center text-white text-[12px] font-bold"
                  style={{ background: HEDERA_ACCENT }}
                >
                  ℏ
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-label-primary dark:text-white truncate">
                    {activeChain?.name ?? `Chain ${chainId}`}
                  </div>
                  <div className="text-[11px] text-label-tertiary font-mono">
                    {truncate(address!)}
                  </div>
                </div>
              </div>

              <div className="flex gap-1.5 mb-2">
                <button
                  onClick={copyAddress}
                  className="flex-1 py-1.5 bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] rounded-lg text-[12px] font-medium flex items-center justify-center gap-1"
                >
                  {copied ? <Check className="w-3.5 h-3.5 text-[#34C759]" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <a
                  href={`https://hashscan.io/${chainId === 296 ? 'testnet' : 'mainnet'}/address/${address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 py-1.5 bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e] rounded-lg text-[12px] font-medium flex items-center justify-center gap-1"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  HashScan
                </a>
              </div>

              {/* Chain switcher — testnet ↔ mainnet within Hedera */}
              <div className="flex gap-1.5 mb-2">
                {CHAIN_PICKER_ORDER.filter((c) => c.id === 296 || c.id === 295).map((c) => (
                  <button
                    key={c.id}
                    onClick={() => switchChain({ chainId: c.id })}
                    disabled={c.id === chainId || isSwitching}
                    className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-colors ${
                      c.id === chainId
                        ? 'bg-[#00A79F]/20 text-[#00A79F] cursor-default'
                        : 'bg-system-bg-secondary dark:bg-[#2c2c2e] hover:bg-[#E5E5EA] dark:hover:bg-[#3c3c3e]'
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>

              <button
                onClick={() => {
                  disconnect();
                  setShowAccountMenu(false);
                }}
                className="w-full py-2 text-[#FF3B30] hover:bg-[#FF3B30]/5 rounded-lg text-[13px] font-medium flex items-center justify-center gap-1.5"
              >
                <LogOut className="w-3.5 h-3.5" />
                Disconnect
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
