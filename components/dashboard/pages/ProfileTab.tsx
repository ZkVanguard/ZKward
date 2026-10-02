'use client';

/**
 * ProfileTab — user identity + account controls.
 *
 * Reads EVERYTHING through the shared useUserSession() hook — one hook,
 * one object, coherent with every other surface. Editing the display
 * name here invalidates the shared cache so the Pool tab's wallet card
 * refetches automatically.
 */

import { useEffect, useState } from 'react';
import { Copy, Check, ExternalLink, Pencil, LogOut, Mail, Chrome, Wallet as WalletIcon, User } from 'lucide-react';
import { WalletAvatar } from '@/components/ui/WalletAvatar';
import { useUserSession } from '@/lib/hooks/useUserSession';
import { useSetWalletProfile } from '@/lib/hooks/useWalletProfile';
import { ConnectPromptButton } from '@/components/ui/ConnectPromptButton';

const HEDERA_ACCENT = '#00A79F';

function formatJoinedDate(d: Date | null): string | null {
  if (!d) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
}

export function ProfileTab() {
  const session = useUserSession();

  if (!session.ready) {
    return <div className="p-8 text-center text-label-tertiary text-sm">Loading account…</div>;
  }

  if (!session.authenticated || !session.address) {
    return (
      <div className="p-8 sm:p-12 text-center">
        <User className="w-10 h-10 text-label-tertiary mx-auto mb-3" />
        <h3 className="text-lg font-semibold text-label-primary mb-1">Not signed in</h3>
        <p className="text-sm text-label-tertiary mb-4 max-w-sm mx-auto">
          Sign in with email, Google, or a wallet to see your account details, edit your display
          name, and manage your session.
        </p>
        <div className="inline-block">
          <ConnectPromptButton chain="hedera" reason="Your account is your Hedera sign-in (email or Google). We create the wallet for you." />
        </div>
      </div>
    );
  }

  return <ProfileTabAuthed session={session} />;
}

function ProfileTabAuthed({ session }: { session: ReturnType<typeof useUserSession> }) {
  const setProfileMut = useSetWalletProfile();
  const name = session.displayName;
  const address = session.address as `0x${string}`;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const saving = setProfileMut.isPending;

  useEffect(() => { if (!editing) setDraft(name ?? ''); }, [name, editing]);

  const onSaveName = async () => {
    const trimmed = draft.trim();
    if (trimmed.length < 1 || trimmed.length > 32) {
      setNameErr('1-32 characters');
      return;
    }
    setNameErr(null);
    const res = await setProfileMut.mutateAsync({ address, displayName: trimmed });
    if (!res.ok) setNameErr(res.error ?? 'save failed');
    else setEditing(false);
  };

  const onCopy = () => {
    navigator.clipboard.writeText(address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const joinedLabel = formatJoinedDate(session.joinedAt);

  return (
    <div className="p-4 sm:p-6 space-y-5 min-w-0">
      {/* Identity card */}
      <div className="rounded-2xl border p-5 space-y-4 min-w-0" style={{ borderColor: `${HEDERA_ACCENT}30`, background: `${HEDERA_ACCENT}08` }}>
        <div className="flex items-center gap-4 min-w-0">
          <WalletAvatar address={address} name={name} size={64} />
          <div className="flex-1 min-w-0">
            {editing ? (
              <div className="flex flex-col gap-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSaveName();
                    if (e.key === 'Escape') { setEditing(false); setDraft(name ?? ''); setNameErr(null); }
                  }}
                  maxLength={32}
                  placeholder="Display name (max 32)"
                  disabled={saving}
                  className="w-full h-10 px-3 rounded-lg border border-black/10 bg-white text-[15px] focus:outline-none focus:ring-2 focus:ring-black/10"
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={onSaveName}
                    disabled={saving || draft.trim().length < 1}
                    className="h-9 px-4 rounded-lg text-[13px] font-semibold text-white active:scale-[0.97] disabled:opacity-60"
                    style={{ background: HEDERA_ACCENT }}
                  >
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setEditing(false); setDraft(name ?? ''); setNameErr(null); }}
                    className="h-9 px-3 rounded-lg text-[13px] font-medium text-label-secondary hover:bg-black/5 active:scale-[0.97]"
                  >
                    Cancel
                  </button>
                  {nameErr && <span className="text-[12px] text-[#FF3B30]">{nameErr}</span>}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <div className="flex-1 min-w-0">
                  <div className="text-[20px] sm:text-[22px] font-bold text-label-primary truncate leading-tight">
                    {name ?? <span className="text-label-tertiary font-normal">No display name set</span>}
                  </div>
                  <div className="text-[12px] text-label-tertiary mt-0.5 truncate">
                    {name ? 'Your name shows on the community leaderboard.' : 'Set a name to personalise your leaderboard tile.'}
                  </div>
                </div>
                <button
                  onClick={() => { setEditing(true); setDraft(name ?? ''); setNameErr(null); }}
                  className="flex-shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium text-label-primary bg-white hover:bg-black/5 active:scale-[0.97] border border-black/10"
                  title={name ? 'Change your name' : 'Set your display name'}
                >
                  <Pencil className="w-3.5 h-3.5" />
                  {name ? 'Edit' : 'Set name'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Wallet address row */}
        <div className="flex items-center gap-2 min-w-0 pt-3 border-t" style={{ borderColor: `${HEDERA_ACCENT}20` }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide flex-shrink-0" style={{ color: HEDERA_ACCENT }}>
            Wallet
          </div>
          <code className="flex-1 min-w-0 truncate font-mono text-[13px] text-label-primary tabular-nums">{address}</code>
          <button
            onClick={onCopy}
            className="flex-shrink-0 p-1.5 rounded-lg hover:bg-white/60 active:scale-[0.96]"
            title="Copy address"
            aria-label="Copy wallet address"
          >
            {copied ? <Check className="w-4 h-4 text-[#34C759]" /> : <Copy className="w-4 h-4 text-label-secondary" />}
          </button>
          <a
            href={`https://hashscan.io/testnet/account/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-shrink-0 p-1.5 rounded-lg hover:bg-white/60 active:scale-[0.96]"
            title="View on HashScan"
          >
            <ExternalLink className="w-4 h-4 text-label-secondary" />
          </a>
        </div>
      </div>

      {/* Balances card */}
      <div className="rounded-2xl border border-black/5 bg-white p-5">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-label-tertiary mb-3">
          Balances
        </h3>
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <BalanceTile label="HBAR" value={session.balances.hbarHuman.toLocaleString(undefined, { maximumFractionDigits: 4 })} />
          <BalanceTile label="USDC" value={session.balances.usdcHuman.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
          <BalanceTile label="Shares" value={session.balances.sharesHuman.toLocaleString(undefined, { maximumFractionDigits: 2 })} />
        </div>
        <div className="text-[11px] text-label-tertiary mt-3">
          Refreshes every 15s. Shares = your slice of the AI-managed vault.
        </div>
      </div>

      {/* Account card */}
      <div className="rounded-2xl border border-black/5 bg-white p-5">
        <h3 className="text-[13px] font-semibold uppercase tracking-wide text-label-tertiary mb-3">
          Account
        </h3>
        <div className="space-y-3 text-[14px]">
          <div className="flex items-center gap-3">
            {session.authMethod === 'google' && <Chrome className="w-4 h-4 text-label-tertiary flex-shrink-0" />}
            {session.authMethod === 'email' && <Mail className="w-4 h-4 text-label-tertiary flex-shrink-0" />}
            {session.authMethod === 'wallet' && <WalletIcon className="w-4 h-4 text-label-tertiary flex-shrink-0" />}
            <div className="flex-1 min-w-0">
              <div className="text-label-primary">
                {session.authMethod === 'google' && 'Signed in with Google'}
                {session.authMethod === 'email' && 'Signed in with email'}
                {session.authMethod === 'wallet' && 'Signed in with wallet'}
              </div>
              {session.emailAddress && (
                <div className="text-[12px] text-label-tertiary truncate">{session.emailAddress}</div>
              )}
            </div>
          </div>
          {joinedLabel && (
            <div className="flex items-center gap-3">
              <User className="w-4 h-4 text-label-tertiary flex-shrink-0" />
              <div className="text-label-primary">Joined {joinedLabel}</div>
            </div>
          )}
          {session.needsChainSwitch && (
            <div className="text-[12px] text-[#FF9500]">
              Wallet is on chain {session.chainId}. Deposit/withdraw actions on the Pool tab will switch to Hedera Testnet (296).
            </div>
          )}
          <div className="text-[12px] text-label-tertiary pt-1">
            Embedded wallet provisioned by Privy. Your funds live on Hedera Testnet at the address above.
          </div>
        </div>
      </div>

      {/* Sign-out */}
      <div className="flex justify-end">
        <button
          onClick={() => void session.logout()}
          className="inline-flex items-center gap-2 h-10 px-4 rounded-lg text-[14px] font-medium text-[#FF3B30] bg-[#FF3B30]/8 hover:bg-[#FF3B30]/12 active:scale-[0.98]"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </div>
    </div>
  );
}

function BalanceTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-system-bg-secondary p-3 min-w-0">
      <div className="text-[10px] text-label-tertiary uppercase tracking-wide">{label}</div>
      <div className="text-[16px] sm:text-[18px] font-semibold tabular-nums text-label-primary break-all">{value}</div>
    </div>
  );
}
