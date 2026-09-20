'use client';

/**
 * B2B admin panel — Privy Best B2B Financial Product prize track.
 *
 * Renders three things:
 *   1. A "Propose action" form (raise TVL cap by default; the only action
 *      wired to real execution).
 *   2. Live quorum status for the current actionId — polls the GET
 *      endpoint, shows N-of-M approvers, and the "Approve" button when
 *      the signed-in Privy user is on the allowlist.
 *   3. A "Policies" card summarising the org's quorum settings — the
 *      "policies visible" part of the prize criteria.
 *
 * Runs entirely inside WalletProviders (mounted by dashboard/layout.tsx),
 * so Privy hooks resolve. Gated by isPrivyEnabled() — invisible until
 * NEXT_PUBLIC_PRIVY_APP_ID is set.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePrivy, useLogin, getAccessToken } from '@privy-io/react-auth';
import { ShieldCheck, Users, CheckCircle2, XCircle, Loader2, LogIn, Send } from 'lucide-react';
import { isPrivyEnabled } from '@/lib/evm-wallet/privy-config';

// Match site primary (ios-blueHover) for CTAs. Chain-specific chips
// (Hedera-flavoured badges) live in the header via <Badge color="teal">.
const ACCENT = '#0069D9';

interface QuorumSnapshot {
  actionId: string;
  approverCount: number;
  required: number;
  reached: boolean;
  approvers: string[];
  createdAt: number;
  policy: { allowlistSize: number; quorum: number };
}

async function fetchQuorum(actionId: string): Promise<QuorumSnapshot | null> {
  const r = await fetch(`/api/admin/hedera-pool/quorum-action?actionId=${encodeURIComponent(actionId)}`, {
    cache: 'no-store',
  });
  if (!r.ok) return null;
  return (await r.json()) as QuorumSnapshot;
}

async function fetchPolicy(): Promise<{ allowlistSize: number; quorum: number } | null> {
  const r = await fetch('/api/admin/hedera-pool/quorum-action', { cache: 'no-store' });
  if (!r.ok) return null;
  const d = (await r.json()) as { policy?: { allowlistSize: number; quorum: number } };
  return d.policy ?? null;
}

export function B2bAdminPanel() {
  const enabled = isPrivyEnabled();
  const { ready, authenticated, user } = usePrivy();
  const { login } = useLogin();

  // Form state
  const [newCap, setNewCap] = useState<string>('50000');
  const [actionId, setActionId] = useState<string>('');
  const [posting, setPosting] = useState(false);
  const [lastResponse, setLastResponse] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  // Snapshot state
  const [snap, setSnap] = useState<QuorumSnapshot | null>(null);
  const [policy, setPolicy] = useState<{ allowlistSize: number; quorum: number } | null>(null);

  // Load policy once on mount so the "Policies" card renders even when no
  // action is proposed yet.
  useEffect(() => {
    fetchPolicy().then(setPolicy).catch(() => {});
  }, []);

  // Poll snapshot every 3s while an actionId is active. Shows the
  // second-approver click in near-realtime.
  useEffect(() => {
    if (!actionId) return;
    let cancelled = false;
    const tick = async () => {
      const s = await fetchQuorum(actionId);
      if (!cancelled && s) setSnap(s);
    };
    tick();
    const iv = window.setInterval(tick, 3000);
    return () => { cancelled = true; window.clearInterval(iv); };
  }, [actionId]);

  const propose = useCallback(async () => {
    setError(null);
    setLastResponse(null);
    const capUsdc = Number(newCap);
    if (!Number.isFinite(capUsdc) || capUsdc <= 0) {
      setError('Enter a positive USDC amount.');
      return;
    }
    // Same actionId for both approvers — the idempotency key that lets
    // Alice's approval + Bob's approval combine into a single quorum.
    const id = `raise-tvl-${capUsdc}-${new Date().toISOString().slice(0, 13)}`;
    setActionId(id);
    setPosting(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError('Sign in first.');
        setPosting(false);
        return;
      }
      const r = await fetch('/api/admin/hedera-pool/quorum-action', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'raise-tvl-cap',
          actionId: id,
          params: { newCapUsdc: capUsdc },
        }),
      });
      const j = await r.json();
      setLastResponse(j);
      if (!r.ok) setError(j?.error ?? `HTTP ${r.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPosting(false);
    }
  }, [newCap]);

  const currentUserEmail = useMemo(
    () => user?.email?.address ?? user?.google?.email ?? null,
    [user],
  );

  if (!enabled) {
    return (
      <div className="p-6 text-center text-label-tertiary text-sm">
        Privy is not configured. Set <code className="px-1.5 py-0.5 bg-system-bg-secondary rounded">NEXT_PUBLIC_PRIVY_APP_ID</code> to enable the B2B admin panel.
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="p-6 flex items-center justify-center gap-2 text-label-tertiary">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading Privy…
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="p-6 sm:p-8 text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4" style={{ background: `${ACCENT}15` }}>
          <ShieldCheck className="w-7 h-7" style={{ color: ACCENT }} />
        </div>
        <h3 className="text-title-3 font-semibold text-label-primary mb-2">B2B admin controls</h3>
        <p className="text-callout text-label-secondary max-w-md mx-auto mb-5">
          Sign in with your team email to propose or approve treasury actions.
          Each destructive action requires a quorum of allowlisted admins.
        </p>
        <button
          onClick={() => login()}
          className="inline-flex items-center gap-2 px-5 h-11 rounded-[12px] text-white font-semibold text-[15px] active:scale-[0.98]"
          style={{ background: ACCENT }}
        >
          <LogIn className="w-4 h-4" />
          Sign in with email
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* Policies card */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-label-tertiary" />
          <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary">Policy</div>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-label-tertiary text-caption-1 mb-1">Admin allowlist</div>
            <div className="text-title-3 font-semibold text-label-primary tabular-nums">{policy?.allowlistSize ?? '—'}</div>
          </div>
          <div>
            <div className="text-label-tertiary text-caption-1 mb-1">Quorum required</div>
            <div className="text-title-3 font-semibold text-label-primary tabular-nums">{policy?.quorum ?? '—'}-of-{policy?.allowlistSize ?? '—'}</div>
          </div>
        </div>
        <div className="mt-3 text-[11px] text-label-tertiary leading-relaxed">
          Signed in as <span className="font-medium text-label-secondary">{currentUserEmail ?? user?.id.slice(0, 24)}</span>.
          Only allowlisted addresses can approve. Non-admins get 403 from the API.
        </div>
      </div>

      {/* Propose action */}
      <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
        <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary mb-3">Propose action</div>
        <label className="block text-sm text-label-secondary mb-1">Raise TVL cap to (USDC)</label>
        <div className="flex gap-2">
          <input
            type="number"
            min="1"
            step="1"
            value={newCap}
            onChange={(e) => setNewCap(e.target.value)}
            className="flex-1 px-3 h-11 rounded-[12px] border border-separator-opaque/60 bg-system-bg-secondary text-label-primary tabular-nums focus:outline-none focus:border-[color:var(--accent)]"
            style={{ ['--accent' as string]: ACCENT }}
          />
          <button
            onClick={propose}
            disabled={posting}
            className="inline-flex items-center gap-2 px-4 h-11 rounded-[12px] text-white font-semibold text-[13px] active:scale-[0.98] disabled:opacity-60"
            style={{ background: ACCENT }}
          >
            {posting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {snap && !snap.reached ? 'Approve' : 'Propose'}
          </button>
        </div>
        {error && (
          <div className="mt-2 text-[11px] text-[#FF3B30]">{error}</div>
        )}
      </div>

      {/* Live quorum */}
      {snap && (
        <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-primary p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary">Quorum</div>
            {snap.reached ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#34C759]">
                <CheckCircle2 className="w-3.5 h-3.5" /> Reached
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#FF9500]">
                <XCircle className="w-3.5 h-3.5" /> Pending
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 mb-3">
            <div className="text-title-2 font-semibold text-label-primary tabular-nums">
              {snap.approverCount} <span className="text-label-tertiary text-title-3">/ {snap.required}</span>
            </div>
            <div className="flex-1 h-2 rounded-full bg-system-bg-grouped overflow-hidden">
              <div
                className="h-full transition-all"
                style={{
                  width: `${Math.min(100, (snap.approverCount / snap.required) * 100)}%`,
                  background: snap.reached ? '#34C759' : ACCENT,
                }}
              />
            </div>
          </div>
          <div className="text-[11px] text-label-tertiary mb-2">Action id: <code className="font-mono">{snap.actionId}</code></div>
          {snap.approvers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {snap.approvers.map((a) => (
                <span key={a} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-system-bg-grouped text-label-secondary font-mono">
                  {a}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Last API response (debug + demoable receipt) */}
      {lastResponse ? (
        <div className="rounded-2xl border border-separator-opaque/40 bg-system-bg-grouped p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-label-tertiary mb-2">Last response</div>
          <pre className="text-[10px] text-label-secondary overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(lastResponse, null, 2)}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
