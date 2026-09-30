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
import {
  connectWallet,
  depositTokens,
  getProvider,
  signWithdrawMessage,
} from '@/components/solana/wallet';

interface DepositRow {
  signature: string;
  sender: string;
  amount: number;
  shares: number;
  slot: number;
  blockTime: string | null;
}

interface SleevePosition {
  orderId: string;
  asset: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  notionalUsd: number;
  markPrice: number | null;
  unrealizedPnlUsd: number | null;
  openedAt: number;
}

interface Sleeve {
  trades: number;
  wins: number;
  winRatePct: number | null;
  pendingBuybackUsd: number;
  position: SleevePosition | null;
}

interface Status {
  enabled: boolean;
  testnet?: boolean;
  cluster?: string;
  vaultAta?: string | null;
  tokenMint?: string | null;
  rpcUrl?: string;
  vaultTokens?: number | null;
  totalShares?: number;
  sharePrice?: number;
  tokenUsd?: number | null;
  navUsd?: number | null;
  priceNote?: string;
  sleeve?: Sleeve | null;
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

interface MyBalance {
  sharesUi: number;
  tokenValueUi: number;
  poolSharePct: number;
}

export default function SolanaPoolPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  const [myBalance, setMyBalance] = useState<MyBalance | null>(null);
  const [depositAmt, setDepositAmt] = useState('');
  const [withdrawAmt, setWithdrawAmt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const say = (kind: 'ok' | 'err', text: string) => setNotice({ kind, text });

  const refreshBalance = async (w: string) => {
    try {
      const r = await fetch(`/api/solana-pool/balance?wallet=${w}`, { cache: 'no-store' });
      const j = await r.json();
      if (r.ok) setMyBalance(j as MyBalance);
    } catch { /* next poll */ }
  };

  useEffect(() => {
    // Silent reconnect for returning wallets
    const p = getProvider();
    if (p && !p.publicKey) {
      p.connect({ onlyIfTrusted: true })
        .then(({ publicKey }) => {
          const w = publicKey.toBase58();
          setWallet(w);
          void refreshBalance(w);
        })
        .catch(() => undefined);
    }
  }, []);

  const onConnect = async () => {
    setBusy('connect');
    try {
      const w = await connectWallet();
      setWallet(w);
      await refreshBalance(w);
      say('ok', `Connected ${w.slice(0, 6)}…`);
    } catch (e) {
      say('err', e instanceof Error ? e.message : 'connect failed');
    } finally {
      setBusy(null);
    }
  };

  const onFaucet = async () => {
    if (!wallet) return;
    setBusy('faucet');
    try {
      const r = await fetch('/api/solana-pool/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'faucet failed');
      say('ok', `Faucet sent ${Number(j.amountUi).toLocaleString()} test JIMP`);
    } catch (e) {
      say('err', e instanceof Error ? e.message : 'faucet failed');
    } finally {
      setBusy(null);
    }
  };

  const onDeposit = async () => {
    if (!wallet || !status?.tokenMint || !status.vaultAta || !status.rpcUrl) return;
    const amt = Number(depositAmt);
    if (!isFinite(amt) || amt <= 0) return say('err', 'enter a deposit amount');
    setBusy('deposit');
    try {
      const sig = await depositTokens({
        rpcUrl: status.rpcUrl,
        wallet,
        tokenMint: status.tokenMint,
        vaultAta: status.vaultAta,
        amountUi: amt,
      });
      say('ok', `Deposit sent (${sig.slice(0, 12)}…) — shares credit within ~1 min`);
      setDepositAmt('');
    } catch (e) {
      say('err', e instanceof Error ? e.message : 'deposit failed');
    } finally {
      setBusy(null);
    }
  };

  const onWithdraw = async () => {
    if (!wallet) return;
    const amt = Number(withdrawAmt);
    if (!isFinite(amt) || amt <= 0) return say('err', 'enter a shares amount');
    setBusy('withdraw');
    try {
      const nr = await fetch(`/api/solana-pool/withdraw?wallet=${wallet}`, { cache: 'no-store' });
      const nj = await nr.json();
      if (!nr.ok) throw new Error(nj.error || 'nonce failed');
      const signatureHex = await signWithdrawMessage(nj.nonce as string, amt);
      const r = await fetch('/api/solana-pool/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, sharesUi: amt, signatureHex }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'withdraw failed');
      say('ok', `Paid ${Number(j.amountUi).toLocaleString()} JIMP (${String(j.txSignature).slice(0, 12)}…)`);
      setWithdrawAmt('');
      await refreshBalance(wallet);
    } catch (e) {
      say('err', e instanceof Error ? e.message : 'withdraw failed');
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!wallet) return;
    const id = setInterval(() => void refreshBalance(wallet), 30_000);
    void refreshBalance(wallet);
    return () => clearInterval(id);
  }, [wallet]);

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
              <div className="text-xs text-label-secondary uppercase mb-3">
                Trading sleeve — signal-driven, honest friction (paper on testnet)
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-label-tertiary text-xs">Win rate</div>
                  <div className="font-bold">
                    {status.sleeve?.winRatePct != null
                      ? `${status.sleeve.winRatePct}%`
                      : '— (no closes yet)'}
                  </div>
                </div>
                <div>
                  <div className="text-label-tertiary text-xs">Trades (W/L)</div>
                  <div>
                    {status.sleeve
                      ? `${status.sleeve.trades} (${status.sleeve.wins}/${status.sleeve.trades - status.sleeve.wins})`
                      : '—'}
                  </div>
                </div>
                <div>
                  <div className="text-label-tertiary text-xs">Pending buyback (realized PnL)</div>
                  <div
                    className={
                      (status.sleeve?.pendingBuybackUsd ?? 0) >= 0 ? 'text-green-700' : 'text-red-700'
                    }
                  >
                    {fmtUsd(status.sleeve?.pendingBuybackUsd ?? 0)}
                  </div>
                </div>
                <div>
                  <div className="text-label-tertiary text-xs">Open position</div>
                  {status.sleeve?.position ? (
                    <div>
                      {status.sleeve.position.asset}{' '}
                      <span
                        className={
                          status.sleeve.position.side === 'LONG' ? 'text-green-700' : 'text-red-700'
                        }
                      >
                        {status.sleeve.position.side}
                      </span>{' '}
                      {fmtUsd(status.sleeve.position.notionalUsd)}
                      {status.sleeve.position.unrealizedPnlUsd != null && (
                        <span
                          className={
                            status.sleeve.position.unrealizedPnlUsd >= 0
                              ? 'text-green-700'
                              : 'text-red-700'
                          }
                        >
                          {' '}
                          ({status.sleeve.position.unrealizedPnlUsd >= 0 ? '+' : ''}
                          {status.sleeve.position.unrealizedPnlUsd.toFixed(2)})
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="text-label-secondary">none (gates holding)</div>
                  )}
                </div>
              </div>
              <div className="text-xs text-label-tertiary mt-3">
                Sleeve notional sizes off live pool NAV (portfolio-margin). Realized profits become
                vault tokens only via real buybacks — on testnet they accrue here, truthfully pending.
              </div>
            </div>

            <div className="bg-system-bg-secondary rounded-ios-xl p-4 sm:p-5 border border-separator-opaque/30">
              <div className="text-xs text-label-secondary uppercase mb-3">Your wallet</div>
              {!wallet ? (
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={onConnect}
                    disabled={busy !== null}
                    className="text-sm font-bold px-4 py-2 rounded-ios bg-system-bg-primary border border-separator-opaque/30 hover:bg-system-bg-tertiary disabled:opacity-50"
                  >
                    {busy === 'connect' ? 'Connecting…' : 'Connect Solana wallet'}
                  </button>
                  <span className="text-xs text-label-tertiary">
                    Phantom recommended — set network to devnet
                  </span>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <div className="text-label-tertiary text-xs">Address</div>
                      <div>{short(wallet)}</div>
                    </div>
                    <div>
                      <div className="text-label-tertiary text-xs">Your shares</div>
                      <div className="font-bold">{fmtTok(myBalance?.sharesUi ?? 0)}</div>
                    </div>
                    <div>
                      <div className="text-label-tertiary text-xs">Value (JIMP)</div>
                      <div>{fmtTok(myBalance?.tokenValueUi ?? 0)}</div>
                    </div>
                    <div>
                      <div className="text-label-tertiary text-xs">Pool share</div>
                      <div>{(myBalance?.poolSharePct ?? 0).toFixed(2)}%</div>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-3 gap-3 text-sm">
                    <div className="bg-system-bg-primary rounded-ios p-3 border border-separator-opaque/30 space-y-2">
                      <div className="text-label-tertiary text-xs">1 · Get test JIMP (devnet faucet)</div>
                      <button
                        onClick={onFaucet}
                        disabled={busy !== null}
                        className="w-full px-3 py-2 rounded-ios bg-system-bg-secondary border border-separator-opaque/30 hover:bg-system-bg-tertiary disabled:opacity-50"
                      >
                        {busy === 'faucet' ? 'Minting…' : 'Airdrop 100,000 test JIMP'}
                      </button>
                    </div>
                    <div className="bg-system-bg-primary rounded-ios p-3 border border-separator-opaque/30 space-y-2">
                      <div className="text-label-tertiary text-xs">2 · Deposit into the pool</div>
                      <input
                        value={depositAmt}
                        onChange={(e) => setDepositAmt(e.target.value)}
                        placeholder="amount (JIMP)"
                        inputMode="decimal"
                        className="w-full px-3 py-2 rounded-ios bg-system-bg-secondary border border-separator-opaque/30"
                      />
                      <button
                        onClick={onDeposit}
                        disabled={busy !== null}
                        className="w-full px-3 py-2 rounded-ios bg-system-bg-secondary border border-separator-opaque/30 hover:bg-system-bg-tertiary disabled:opacity-50 font-bold"
                      >
                        {busy === 'deposit' ? 'Sign in wallet…' : 'Deposit'}
                      </button>
                    </div>
                    <div className="bg-system-bg-primary rounded-ios p-3 border border-separator-opaque/30 space-y-2">
                      <div className="text-label-tertiary text-xs">3 · Withdraw (burn shares)</div>
                      <input
                        value={withdrawAmt}
                        onChange={(e) => setWithdrawAmt(e.target.value)}
                        placeholder="shares"
                        inputMode="decimal"
                        className="w-full px-3 py-2 rounded-ios bg-system-bg-secondary border border-separator-opaque/30"
                      />
                      <button
                        onClick={onWithdraw}
                        disabled={busy !== null}
                        className="w-full px-3 py-2 rounded-ios bg-system-bg-secondary border border-separator-opaque/30 hover:bg-system-bg-tertiary disabled:opacity-50"
                      >
                        {busy === 'withdraw' ? 'Sign message…' : 'Withdraw'}
                      </button>
                    </div>
                  </div>
                  <div className="text-xs text-label-tertiary">
                    Deposits are on-chain transfers you sign; withdrawals burn your shares and the
                    vault pays you back at live share price after you sign an ownership proof.
                  </div>
                </div>
              )}
              {notice && (
                <div
                  className={`text-sm mt-3 rounded-ios p-2 ${
                    notice.kind === 'ok'
                      ? 'text-green-700 bg-ios-green/10'
                      : 'text-red-700 bg-ios-red/10'
                  }`}
                >
                  {notice.text}
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
