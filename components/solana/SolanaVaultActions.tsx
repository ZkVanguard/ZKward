'use client';

/**
 * Solana pool deposit / withdraw — same layout as the Hedera vault card so
 * every chain in the Pool tab works the same way: wallet card → balance
 * chips (+ test faucet) → Deposit | Withdraw → amount → action.
 *
 * Talks to the injected wallet (Phantom) via ./wallet, which pulls in
 * @solana/web3.js — callers must load this component lazily.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Droplets, ExternalLink, Loader2, Minus, Plus, Wallet } from 'lucide-react';
import { depositTokens, signWithdrawMessage } from './wallet';
import { CHAIN_INFO, useWalletHub } from '@/contexts/WalletHubContext';
import { explorerAddress, explorerTx, shortAddr, useSolanaPoolStatus } from './status';
import { ChainLogo } from '@/components/wallet/ChainLogo';

const SOLANA_ACCENT = '#9945FF';
const ACCENT = '#0069D9';

interface MyBalance {
  sharesUi: number;
  tokenValueUi: number;
  poolSharePct: number;
  /** JIMP in the wallet, not deposited. null = chain read failed. */
  walletTokenUi: number | null;
}

type Busy = null | 'connect' | 'faucet' | 'deposit' | 'withdraw';
type Notice = { kind: 'ok' | 'err'; text: string; tx?: string };

export function SolanaVaultActions() {
  const { data: status } = useSolanaPoolStatus();
  const cluster = status?.cluster ?? 'devnet';
  const testnet = status?.testnet !== false;
  // The Solana wallet lives in the dashboard wallet hub, so the navbar and
  // this card always agree on what is connected.
  const hub = useWalletHub();
  const wallet = hub.solana.address;
  const [balance, setBalance] = useState<MyBalance | null>(null);
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshBalance = async (w: string) => {
    try {
      const r = await fetch(`/api/solana-pool/balance?wallet=${w}`, { cache: 'no-store' });
      if (r.ok) setBalance((await r.json()) as MyBalance);
    } catch { /* next poll */ }
  };

  useEffect(() => {
    if (!wallet) return;
    void refreshBalance(wallet);
    const id = setInterval(() => void refreshBalance(wallet), 30_000);
    return () => clearInterval(id);
  }, [wallet]);

  const run = async (kind: Exclude<Busy, null>, fn: () => Promise<Notice>) => {
    setBusy(kind);
    setNotice(null);
    try {
      setNotice(await fn());
    } catch (e) {
      setNotice({ kind: 'err', text: e instanceof Error ? e.message : `${kind} failed` });
    } finally {
      setBusy(null);
    }
  };

  const onConnect = () =>
    run('connect', async () => {
      const res = await hub.connect('solana');
      if (!res.ok) {
        // No Phantom, or the user dismissed it: the chooser explains and links the install.
        hub.openChooser({ chain: 'solana', reason: testnet ? 'This test pool runs on Solana devnet and needs Phantom.' : 'This pool runs on Solana and needs a Solana wallet.' });
        throw new Error(res.error);
      }
      return { kind: 'ok', text: 'Solana wallet connected' };
    });

  const onFaucet = () =>
    run('faucet', async () => {
      const r = await fetch('/api/solana-pool/faucet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Faucet failed — try again in a minute');
      if (wallet) await refreshBalance(wallet);
      return { kind: 'ok', text: `Added ${Number(j.amountUi).toLocaleString()} test JIMP to your wallet — deposit some below`, tx: j.txSignature };
    });

  const onDeposit = () =>
    run('deposit', async () => {
      if (!wallet || !status?.tokenMint || !status.vaultAta || !status.rpcUrl) throw new Error('Pool details still loading');
      const sig = await depositTokens({
        rpcUrl: status.rpcUrl,
        wallet,
        tokenMint: status.tokenMint,
        vaultAta: status.vaultAta,
        amountUi: Number(amount),
        testnet,
      });
      setAmount('');
      if (wallet) await refreshBalance(wallet);
      return { kind: 'ok', text: 'Deposit confirmed — your shares appear within about a minute', tx: sig };
    });

  const onWithdraw = () =>
    run('withdraw', async () => {
      if (!wallet) throw new Error('Connect your wallet first');
      const sharesUi = Number(amount);
      const nr = await fetch(`/api/solana-pool/withdraw?wallet=${wallet}`, { cache: 'no-store' });
      const nj = await nr.json();
      if (!nr.ok) throw new Error(nj.error || 'Could not start the withdrawal');
      const signatureHex = await signWithdrawMessage(nj.nonce as string, sharesUi);
      const r = await fetch('/api/solana-pool/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wallet, sharesUi, signatureHex }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Withdrawal failed');
      setAmount('');
      await refreshBalance(wallet);
      // 202: the payout was sent and the network has not confirmed it yet.
      // The shares are already set aside; the pool settles it within a minute.
      if (j.pending) return { kind: 'ok', text: 'Withdrawal sent — the network is still confirming it. It will show in your wallet shortly.', tx: String(j.txSignature) };
      return { kind: 'ok', text: `Paid ${Number(j.amountUi).toLocaleString()} JIMP to your wallet`, tx: String(j.txSignature) };
    });

  const copyAddress = async () => {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be denied */ }
  };

  const shares = balance?.sharesUi ?? 0;
  const walletTokens = balance?.walletTokenUi ?? null;
  const maxAmount = mode === 'deposit' ? (walletTokens ?? 0) : shares;
  const parsed = Number(amount);
  const entered = Number.isFinite(parsed) && parsed > 0;
  const disabledReason: string | null =
    !wallet ? 'Connect your Solana wallet first'
    : !entered ? (mode === 'deposit' ? 'Enter how much JIMP to deposit' : 'Enter how many shares to withdraw')
    : mode === 'deposit' && walletTokens !== null && parsed > walletTokens ? `Your wallet holds ${walletTokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} JIMP`
    : mode === 'withdraw' && parsed > shares ? `You have ${shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares`
    : mode === 'withdraw' && (status?.solvent === false || status?.withdrawalsPaused) ? 'Withdrawals are paused right now'
    : mode === 'deposit' && status?.depositsOpen === false ? 'The pool is at its deposit limit for now'
    : busy ? 'Working…'
    : null;

  return (
    <div className="p-4 border-b border-gray-100 dark:border-gray-700 space-y-3">
      {wallet ? (
        <div className="rounded-xl border p-3 space-y-2" style={{ borderColor: `${SOLANA_ACCENT}30`, background: `${SOLANA_ACCENT}08` }}>
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: SOLANA_ACCENT }}>
              <ChainLogo chain="solana" size={14} />
              Your Solana wallet
            </div>
            <span className="text-[10px] text-label-tertiary">Solana {testnet ? cluster : 'mainnet'}</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate font-mono text-[12px] text-label-primary">{wallet}</code>
            <button onClick={copyAddress} className="p-1.5 rounded-lg hover:bg-white/60 active:scale-[0.96]" aria-label="Copy wallet address">
              {copied ? <Check className="w-4 h-4 text-[#34C759]" /> : <Copy className="w-4 h-4 text-label-secondary" />}
            </button>
            <a
              href={explorerAddress(wallet, cluster)}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-lg hover:bg-white/60 active:scale-[0.96]"
              aria-label="View on Solana Explorer"
            >
              <ExternalLink className="w-4 h-4 text-label-secondary" />
            </a>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border p-3 flex flex-wrap items-center gap-3" style={{ borderColor: `${SOLANA_ACCENT}30`, background: `${SOLANA_ACCENT}08` }}>
          <div className="flex-1 min-w-[200px] text-[12px] text-label-secondary">
            {hub.isConnected && hub.activeChain && hub.activeChain !== 'solana'
              ? `You're using ${CHAIN_INFO[hub.activeChain].name}. This pool runs on Solana, so switch to deposit.`
              : 'Connect a Solana wallet to deposit.'}
            {testnet && ' Phantom works best — switch it to Devnet for this test pool.'}
          </div>
          <button
            onClick={onConnect}
            disabled={busy !== null}
            className="h-10 px-4 rounded-[10px] text-white font-semibold text-[13px] active:scale-[0.98] disabled:opacity-60 inline-flex items-center gap-1.5"
            style={{ background: SOLANA_ACCENT }}
          >
            {busy === 'connect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wallet className="w-4 h-4" />}
            {hub.isConnected && hub.activeChain !== 'solana' ? 'Switch to Solana' : 'Connect Solana wallet'}
          </button>
        </div>
      )}

      {wallet && (
        <div className="flex flex-wrap gap-2 text-[12px]">
          <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#34C759]/10 text-green-800 font-semibold tabular-nums">
            {shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} shares
            <span className="opacity-70 font-normal">· {(balance?.tokenValueUi ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} JIMP</span>
          </span>
          {(balance?.poolSharePct ?? 0) > 0 && (
            <span className="inline-flex items-center px-2 py-1 rounded-full bg-system-bg-secondary tabular-nums">
              {(balance?.poolSharePct ?? 0).toFixed(2)}% of the pool
            </span>
          )}
          {walletTokens !== null && (
            <span
              className="inline-flex items-center px-2 py-1 rounded-full bg-system-bg-secondary tabular-nums"
              title="JIMP in your wallet, not yet deposited"
            >
              Wallet {walletTokens.toLocaleString(undefined, { maximumFractionDigits: 2 })} JIMP
            </span>
          )}
          {testnet && (
            <button
              onClick={onFaucet}
              disabled={busy !== null}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-[#0069D9]/10 text-[#0069D9] font-semibold hover:bg-[#0069D9]/15 active:scale-[0.98] disabled:opacity-60"
              title="Mint 100,000 test JIMP to your wallet (devnet faucet)"
            >
              {busy === 'faucet' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Droplets className="w-3 h-3" />}
              Get test JIMP
            </button>
          )}
        </div>
      )}

      {notice && (
        <div
          className={`text-[12px] rounded-xl p-2.5 flex items-center gap-2 flex-wrap ${
            notice.kind === 'ok' ? 'text-green-800 bg-[#34C759]/10' : 'text-red-700 bg-[#FF3B30]/10'
          }`}
        >
          {notice.kind === 'ok' ? <Check className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
          <span>{notice.text}</span>
          {notice.tx && (
            <a
              href={explorerTx(notice.tx, cluster)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 underline decoration-dotted"
            >
              view <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}

      {status?.solvent === false && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-[#FF9500]/10 border border-[#FF9500]/30 text-[12px] text-[#B26400]">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          The vault holds less than it owes right now, so withdrawals are paused.
        </div>
      )}

      <div className="inline-flex rounded-[10px] bg-system-bg-secondary p-0.5">
        {(['deposit', 'withdraw'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-3 py-1.5 rounded-[8px] text-[12px] font-semibold transition-all ${
              mode === m ? 'bg-white shadow-ios-1 text-label-primary' : 'text-label-tertiary'
            }`}
          >
            {m === 'deposit' ? <Plus className="inline w-3 h-3 mr-1" /> : <Minus className="inline w-3 h-3 mr-1" />}
            {m === 'deposit' ? 'Deposit' : 'Withdraw'}
          </button>
        ))}
      </div>

      <div className="space-y-1.5 min-w-0">
        <div className="flex gap-2 min-w-0">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={mode === 'deposit' ? 'JIMP amount' : `Shares (max ${shares.toLocaleString(undefined, { maximumFractionDigits: 2 })})`}
            disabled={busy !== null}
            className="flex-1 min-w-0 h-11 px-3 rounded-[10px] border border-black/10 dark:border-white/15 bg-system-bg-secondary tabular-nums focus:outline-none"
          />
          {maxAmount > 0 && (
            <button
              onClick={() => setAmount(String(maxAmount))}
              className="flex-shrink-0 px-3 h-11 rounded-[10px] bg-system-bg-secondary text-[12px] font-medium text-label-secondary hover:bg-[#E5E5EA] active:scale-[0.98]"
            >
              Max
            </button>
          )}
          <button
            onClick={mode === 'deposit' ? onDeposit : onWithdraw}
            disabled={disabledReason !== null}
            className="flex-shrink-0 h-11 px-4 sm:px-5 rounded-[10px] text-white font-semibold text-[13px] sm:text-[14px] active:scale-[0.98] disabled:opacity-60 flex items-center gap-1.5 min-w-[92px] sm:min-w-[120px] justify-center"
            style={{ background: mode === 'deposit' ? ACCENT : '#FF3B30' }}
          >
            {(busy === 'deposit' || busy === 'withdraw') && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy === 'deposit' ? 'Confirm in wallet…' : busy === 'withdraw' ? 'Sign in wallet…' : mode === 'deposit' ? 'Deposit' : 'Withdraw'}
          </button>
        </div>
        {disabledReason && <div className="text-[11px] text-label-tertiary">{disabledReason}</div>}
      </div>

      {status?.vaultAta && (
        <div className="text-[11px] text-label-tertiary flex items-center gap-1.5 flex-wrap">
          <span>Or send JIMP straight to the pool vault:</span>
          <code className="font-mono text-label-secondary">{shortAddr(status.vaultAta, 6, 6)}</code>
          <button
            onClick={() => navigator.clipboard?.writeText(status.vaultAta ?? '').catch(() => undefined)}
            className="inline-flex items-center gap-0.5 text-ios-blue hover:underline"
            aria-label="Copy pool vault address"
          >
            <Copy className="w-3 h-3" /> copy
          </button>
          <span>— credited as shares within a minute.</span>
        </div>
      )}

    </div>
  );
}
