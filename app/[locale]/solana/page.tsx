'use client';

/**
 * /solana — public Solana token-pool page (testnet phase).
 *
 * Answers: is the pool real? Shows the devnet vault, live-from-chain
 * balance, shares, share price, USD NAV (mirror priced at the real
 * token's mainnet Jupiter quote), and the on-chain deposit trail.
 *
 * Data source: /api/solana-pool/status (public, no auth).
 * Follows the /paper page conventions (self-contained client page,
 * direct URL; i18n follow-up tracked for both pages together).
 */
import { useEffect, useState } from 'react';

interface DepositRow {
  signature: string;
  sender: string;
  amount: number;
  shares: number;
  slot: number;
  blockTime: string | null;
}

interface Status {
  enabled: boolean;
  testnet?: boolean;
  cluster?: string;
  vaultAta?: string | null;
  vaultTokens?: number | null;
  totalShares?: number;
  sharePrice?: number;
  tokenUsd?: number | null;
  navUsd?: number | null;
  priceNote?: string;
  recentDeposits?: DepositRow[];
  error?: string;
}

const fmtTok = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const fmtUsd = (n: number | null | undefined) =>
  n === null || n === undefined
    ? '—'
    : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const short = (s: string, head = 6, tail = 6) =>
  s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;

export default function SolanaPoolPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/solana-pool/status', { cache: 'no-store' });
        const j = (await r.json()) as Status;
        if (alive) {
          setStatus(j);
          setFetchedAt(new Date());
        }
      } catch {
        /* keep last state; next poll retries */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const copyVault = async () => {
    if (!status?.vaultAta) return;
    try {
      await navigator.clipboard.writeText(status.vaultAta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — address is still selectable */
    }
  };

  return (
    <main className="min-h-screen bg-system-bg-primary text-label-primary px-4 py-8 sm:px-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-2xl font-bold">Solana Token Pool</h1>
          {status?.testnet !== false && (
            <span className="text-xs font-bold uppercase tracking-wide text-orange-700 bg-ios-orange/10 rounded-ios px-2 py-1">
              Testnet · {status?.cluster ?? 'devnet'}
            </span>
          )}
        </div>

        {!status && (
          <div className="bg-system-bg-secondary rounded-ios-xl p-5 border border-separator-opaque/30 text-label-secondary">
            Loading pool state…
          </div>
        )}

        {status && !status.enabled && (
          <div className="bg-system-bg-secondary rounded-ios-xl p-5 border border-separator-opaque/30 text-label-secondary">
            The Solana pool is not enabled in this environment.
          </div>
        )}

        {status?.enabled && (
          <>
            <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
              <div className="text-xs text-label-secondary uppercase mb-3">Pool state (live from chain)</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-label-tertiary text-xs">Vault balance</div>
                  <div className="font-bold">{fmtTok(status.vaultTokens)} tokens</div>
                </div>
                <div>
                  <div className="text-label-tertiary text-xs">Total shares</div>
                  <div>{fmtTok(status.totalShares)}</div>
                </div>
                <div>
                  <div className="text-label-tertiary text-xs">Share price</div>
                  <div>{status.sharePrice?.toFixed(4) ?? '—'} tok/share</div>
                </div>
                <div>
                  <div className="text-label-tertiary text-xs">NAV (USD)</div>
                  <div>{fmtUsd(status.navUsd)}</div>
                </div>
              </div>
              {status.tokenUsd != null && (
                <div className="text-xs text-label-tertiary mt-3">
                  Token price {`$${status.tokenUsd.toFixed(8)}`} — {status.priceNote}
                </div>
              )}
            </div>

            <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
              <div className="text-xs text-label-secondary uppercase mb-2">Deposit address (vault token account)</div>
              {status.vaultAta ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <code className="text-sm break-all bg-system-bg-primary rounded-ios px-2 py-1 border border-separator-opaque/30">
                    {status.vaultAta}
                  </code>
                  <button
                    onClick={copyVault}
                    className="text-xs px-2 py-1 rounded-ios bg-system-bg-primary border border-separator-opaque/30 hover:bg-system-bg-tertiary"
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ) : (
                <div className="text-label-secondary text-sm">Vault not configured.</div>
              )}
              <div className="text-xs text-label-tertiary mt-2">
                Devnet phase: send the mirror SPL token to this account (e.g. Phantom set to devnet).
                Deposits are indexed on-chain and credited 1:1 as shares within ~1 minute.
              </div>
            </div>

            <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
              <div className="text-xs text-label-secondary uppercase mb-2">Recent deposits (on-chain trail)</div>
              {status.recentDeposits && status.recentDeposits.length > 0 ? (
                <div className="space-y-2 text-sm">
                  {status.recentDeposits.map((d) => (
                    <div
                      key={d.signature}
                      className="grid grid-cols-2 md:grid-cols-4 gap-2 bg-system-bg-primary rounded-ios p-2 border border-separator-opaque/30"
                    >
                      <div>
                        <div className="text-label-tertiary text-xs">Sender</div>
                        <div>{short(d.sender)}</div>
                      </div>
                      <div>
                        <div className="text-label-tertiary text-xs">Amount</div>
                        <div className="text-green-700">+{fmtTok(d.amount)}</div>
                      </div>
                      <div>
                        <div className="text-label-tertiary text-xs">Shares</div>
                        <div>{fmtTok(d.shares)}</div>
                      </div>
                      <div>
                        <div className="text-label-tertiary text-xs">Tx</div>
                        <a
                          className="underline decoration-dotted"
                          href={`https://explorer.solana.com/tx/${d.signature}?cluster=devnet`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {short(d.signature, 8, 8)}
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-label-secondary text-sm">No deposits indexed yet.</div>
              )}
            </div>

            {status.error && (
              <div className="text-sm text-red-700 bg-ios-red/10 rounded-ios p-3">{status.error}</div>
            )}
          </>
        )}

        <div className="text-xs text-label-tertiary">
          {fetchedAt ? `Updated ${fetchedAt.toLocaleTimeString()}` : ''} · refreshes every 30s ·{' '}
          <a className="underline decoration-dotted" href="/api/solana-pool/status" target="_blank" rel="noopener noreferrer">
            raw status JSON
          </a>
        </div>
      </div>
    </main>
  );
}
