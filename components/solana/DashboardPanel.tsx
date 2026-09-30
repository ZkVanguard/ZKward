'use client';

/**
 * Slim Solana-pool panel for the main dashboard tab — live snapshot plus
 * a link through to the full /solana page (wallet actions live there).
 * Feather-light on purpose: one status fetch, no wallet SDK in this tab.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Snap {
  enabled: boolean;
  testnet?: boolean;
  cluster?: string;
  vaultTokens?: number | null;
  totalShares?: number;
  sharePrice?: number;
  navUsd?: number | null;
  sleeve?: {
    trades: number;
    wins: number;
    winRatePct: number | null;
    pendingBuybackUsd: number;
    position: { asset: string; side: string; notionalUsd: number } | null;
  } | null;
}

const tok = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export function SolanaPoolPanel() {
  const [snap, setSnap] = useState<Snap | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/solana-pool/status', { cache: 'no-store' });
        const j = (await r.json()) as Snap;
        if (alive) setSnap(j);
      } catch { /* next poll */ }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!snap) return <div className="text-label-secondary text-sm p-4">Loading pool state…</div>;
  if (!snap.enabled) {
    return (
      <div className="text-label-secondary text-sm p-4">
        Solana pool is not enabled in this environment.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-1">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
        <div>
          <div className="text-label-tertiary text-xs">Vault (JIMP)</div>
          <div className="font-bold">{tok(snap.vaultTokens)}</div>
        </div>
        <div>
          <div className="text-label-tertiary text-xs">Share price</div>
          <div>{snap.sharePrice?.toFixed(4) ?? '—'}</div>
        </div>
        <div>
          <div className="text-label-tertiary text-xs">NAV (USD)</div>
          <div>{snap.navUsd != null ? `$${snap.navUsd.toFixed(2)}` : '—'}</div>
        </div>
        <div>
          <div className="text-label-tertiary text-xs">Sleeve win rate</div>
          <div className="font-bold">
            {snap.sleeve?.winRatePct != null ? `${snap.sleeve.winRatePct}%` : '— (no closes)'}
          </div>
        </div>
      </div>
      <div className="text-xs text-label-tertiary">
        {snap.sleeve?.position
          ? `Open: ${snap.sleeve.position.asset} ${snap.sleeve.position.side} $${snap.sleeve.position.notionalUsd.toFixed(0)}`
          : 'No open sleeve position — gates holding.'}{' '}
        · Pending buyback ${snap.sleeve?.pendingBuybackUsd?.toFixed(2) ?? '0.00'}
      </div>
      <Link
        href="/solana"
        className="inline-block text-sm font-bold px-4 py-2 rounded-ios bg-system-bg-primary border border-separator-opaque/30 hover:bg-system-bg-tertiary"
      >
        Open pool — deposit · withdraw · faucet →
      </Link>
    </div>
  );
}
