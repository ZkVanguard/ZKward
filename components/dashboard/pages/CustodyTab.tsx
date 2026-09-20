'use client';

import { useEffect, useState } from 'react';
import { ShieldCheck, Copy, AlertTriangle, FileText, ExternalLink, Mail, Download } from 'lucide-react';
import { useSui } from '@/app/sui-providers';
import { logger } from '@/lib/utils/logger';
import { ConnectPromptButton } from '@/components/ui/ConnectPromptButton';

interface AttestationView {
  objectId: string;
  portfolioId: string;
  custodianPubkey: string;
  assetListHash: string;
  nonce: string;
  attestedAt: string;
  validUntil: string;
  isValid: boolean;
}

interface ListResponse {
  wallet: string;
  attestations: AttestationView[];
  deployed: boolean;
  message?: string;
}

function fmtDate(ms: string): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n === 0) return '—';
  return new Date(n).toLocaleString();
}

function truncate(hex: string, head = 10, tail = 6): string {
  if (!hex || hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

function AttestationCard({ a }: { a: AttestationView }) {
  const expired = !a.isValid;
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const copyValue = (val: string, label: string) => {
    navigator.clipboard.writeText(val);
    setCopiedField(label);
    setTimeout(() => setCopiedField(null), 1500);
  };

  // Download a canonical JSON artifact that a counterparty can verify off-chain.
  // Includes everything an auditor needs: object id, custodian pubkey, asset-list
  // hash, timestamps, on-chain link. This is the "here's my proof of backing"
  // artifact institutions can pass around out-of-band.
  const downloadJson = () => {
    const artifact = {
      $schema: 'https://zkward.com/schemas/custody-attestation/v1',
      objectId: a.objectId,
      portfolioId: a.portfolioId,
      custodianPubkey: a.custodianPubkey,
      assetListHash: a.assetListHash,
      nonce: a.nonce,
      attestedAt: a.attestedAt,
      validUntil: a.validUntil,
      isValid: a.isValid,
      network: 'sui-mainnet',
      onChainExplorer: `https://suiscan.xyz/mainnet/object/${a.objectId}`,
      verificationEndpoint: `${typeof window !== 'undefined' ? window.location.origin : ''}/api/custody?action=verify`,
      generatedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `custody-attestation-portfolio-${a.portfolioId}-${a.objectId.slice(2, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={`border ${expired ? 'border-amber-200 bg-amber-50/30' : 'border-black/5 bg-white'} rounded-2xl p-5`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className={`w-4 h-4 ${expired ? 'text-amber-600' : 'text-green-600'}`} />
            <span className={`text-[11px] uppercase tracking-wide font-semibold ${expired ? 'text-amber-700' : 'text-green-700'}`}>
              {expired ? 'expired' : 'active attestation'}
            </span>
          </div>
          <h3 className="text-[17px] font-semibold text-[#1d1d1f]">
            Portfolio #{a.portfolioId}
          </h3>
        </div>
        <div className="text-[11px] text-[#86868b] text-right flex-shrink-0 ml-2">
          <div className="truncate max-w-[110px] sm:max-w-none">nonce {a.nonce}</div>
          <div className="truncate max-w-[110px] sm:max-w-none">attested {fmtDate(a.attestedAt)}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13px]">
        <div>
          <div className="text-[#86868b] mb-0.5">Custodian</div>
          <div className="font-mono text-[12px] text-[#1d1d1f] flex items-center gap-1">
            {truncate(a.custodianPubkey)}
            <button
              onClick={() => navigator.clipboard.writeText(a.custodianPubkey)}
              className="hover:text-[#4ca3ff]" title="Copy"
            >
              <Copy className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div>
          <div className="text-[#86868b] mb-0.5">Asset-list hash</div>
          <div className="font-mono text-[12px] text-[#1d1d1f] flex items-center gap-1">
            {truncate(a.assetListHash)}
            <button
              onClick={() => navigator.clipboard.writeText(a.assetListHash)}
              className="hover:text-[#4ca3ff]" title="Copy"
            >
              <Copy className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div>
          <div className="text-[#86868b] mb-0.5">Valid until</div>
          <div className="text-[#1d1d1f]">{fmtDate(a.validUntil)}</div>
        </div>
        <div>
          <div className="text-[#86868b] mb-0.5">On-chain object</div>
          <a
            href={`https://suiscan.xyz/mainnet/object/${a.objectId}`}
            target="_blank" rel="noreferrer"
            className="font-mono text-[12px] text-[#4ca3ff] flex items-center gap-1 hover:underline"
          >
            {truncate(a.objectId)}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-black/5 space-y-2 sm:space-y-0 sm:flex sm:items-center sm:justify-between sm:gap-3">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={downloadJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1d1d1f] text-white text-[12px] font-medium hover:bg-[#0A0E1A] active:scale-[0.98] transition-all"
          >
            <Download className="w-3.5 h-3.5" /> Download JSON
          </button>
          <button
            onClick={() => copyValue(`${window.location.origin}/custody/verify?object=${a.objectId}`, 'share')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-black/10 text-[#1d1d1f] text-[12px] font-medium hover:bg-[#f5f5f7] active:scale-[0.98] transition-all"
          >
            <Copy className="w-3.5 h-3.5" />
            {copiedField === 'share' ? 'Copied ✓' : 'Copy share link'}
          </button>
        </div>
        <span className="text-[11px] text-[#86868b] sm:text-right">
          Asset list stays off-chain; only the hash is on chain.
        </span>
      </div>
    </div>
  );
}

export function CustodyTab() {
  const sui = useSui();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wallet = sui?.address || null;

  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/custody?action=list-attestations&wallet=${wallet}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => { if (!cancelled) setData(json as ListResponse); })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        logger.error('[CustodyProofs] fetch failed', { error: msg });
        if (!cancelled) setError(msg);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [wallet]);

  if (!wallet) {
    return (
      <div className="max-w-5xl mx-auto px-3 sm:px-4 md:px-6 py-8 sm:py-12 min-w-0">
        <div className="bg-white border border-black/5 rounded-3xl p-6 sm:p-10 text-center min-w-0">
          <ShieldCheck className="w-8 h-8 sm:w-10 sm:h-10 text-[#86868b] mx-auto mb-3" />
          <h1 className="text-xl sm:text-2xl md:text-[28px] font-semibold text-[#1d1d1f] mb-2 break-words">
            Connect a SUI wallet to view your custody attestations
          </h1>
          <p className="text-[#86868b] text-sm sm:text-[15px] max-w-2xl mx-auto leading-relaxed mb-6">
            Institutional custodians sign attestations that bind your portfolio to
            off-chain assets. The asset list stays private to you + the custodian;
            only the cryptographic hash hits chain.
          </p>
          <ConnectPromptButton label="Connect SUI Wallet" />
        </div>
      </div>
    );
  }

  return (
    // Navbar clearance + horizontal tab strip live in dashboard/layout.tsx.
    <div className="max-w-5xl mx-auto px-3 sm:px-4 md:px-6 py-4 sm:py-10 space-y-3 sm:space-y-6 min-w-0">
      <header className="min-w-0">
        <div className="text-[11px] sm:text-[12px] text-[#86868b] uppercase tracking-wide font-medium mb-1">
          Custody attestations
        </div>
        <h1 className="text-2xl sm:text-3xl md:text-[32px] font-semibold text-[#1d1d1f] tracking-[-0.02em] leading-tight break-words">
          Your custody-backed portfolios
        </h1>
        <p className="text-xs sm:text-[13px] text-[#86868b] mt-1 font-mono truncate tabular-nums">
          {wallet.slice(0, 10)}…{wallet.slice(-6)}
        </p>
      </header>

      {/* Hero explainer */}
      <section className="bg-gradient-to-br from-[#f5f5f7] to-white border border-black/5 rounded-2xl p-6">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-[#4ca3ff] mt-1 flex-shrink-0" />
          <div>
            <h2 className="text-[18px] font-semibold text-[#1d1d1f] mb-2">
              How custody attestation works
            </h2>
            <ol className="text-[13px] text-[#1d1d1f] space-y-1.5 list-decimal list-inside">
              <li>
                You and your custodian agree off-chain on the asset list backing your portfolio.
              </li>
              <li>
                You both compute the canonical SHA-256 hash of that list independently
                via <code className="bg-white px-1.5 py-0.5 rounded">POST /api/custody · action: hash-assets</code>.
              </li>
              <li>
                You request the signed message bytes via
                <code className="bg-white px-1.5 py-0.5 rounded mx-1">POST /api/custody · action: build-message</code>;
                your custodian signs them with their enrolled ed25519 key.
              </li>
              <li>
                You submit the signature on-chain via the
                <code className="bg-white px-1.5 py-0.5 rounded mx-1">rwa_custody_attestor::submit_attestation</code>
                call. The resulting attestation lives in your wallet.
              </li>
              <li>
                Any counterparty can verify the attestation via
                <code className="bg-white px-1.5 py-0.5 rounded mx-1">POST /api/custody · action: verify</code> — confirming
                portfolio backing without ever seeing the asset list.
              </li>
            </ol>
          </div>
        </div>
      </section>

      {loading && <div className="text-[14px] text-[#86868b]">Loading attestations…</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-[13px]">
          Failed to load: {error}
        </div>
      )}

      {data && !data.deployed && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-[15px] font-semibold mb-1">
                Custody attestor not deployed yet
              </h3>
              <p className="text-[13px]">
                The <code className="bg-white/50 px-1.5 py-0.5 rounded">rwa_custody_attestor.move</code>
                contract has been written, audited via internal review, and is ready to deploy as a
                Tranche 2/3 grant deliverable. See
                <code className="bg-white/50 px-1.5 py-0.5 rounded mx-1">docs/CUSTODY_ATTESTATION_SPEC.md</code>
                for the deployment runbook.
              </p>
              <p className="text-[12px] text-amber-700 mt-2">
                Once deployed, this page will list active attestations for your wallet. The off-chain verification and
                message-building API endpoints are already live.
              </p>
            </div>
          </div>
        </div>
      )}

      {data && data.deployed && data.attestations.length === 0 && (
        <div className="bg-white border border-black/5 rounded-2xl p-10 text-center">
          <FileText className="w-10 h-10 text-[#86868b] mx-auto mb-3" />
          <h3 className="text-[18px] font-semibold text-[#1d1d1f] mb-2">No attestations yet</h3>
          <p className="text-[#86868b] text-[14px] max-w-xl mx-auto mb-5">
            Once a custodian signs an attestation and you submit it on-chain, it will appear here.
          </p>
          <a
            href="mailto:ashishregmi2017@gmail.com?subject=ZKward%20custody%20attestation%20request"
            className="inline-flex items-center gap-2 bg-[#1d1d1f] text-white px-5 py-2.5 rounded-xl text-[13px] font-semibold hover:bg-[#0A0E1A]"
          >
            <Mail className="w-4 h-4" /> Request custodian onboarding
          </a>
        </div>
      )}

      {data && data.attestations.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[17px] font-semibold text-[#1d1d1f]">
              {data.attestations.length} attestation{data.attestations.length === 1 ? '' : 's'}
            </h2>
          </div>
          <div className="space-y-3">
            {data.attestations.map((a) => <AttestationCard key={a.objectId} a={a} />)}
          </div>
        </section>
      )}

      <footer className="text-center text-[11px] text-[#86868b] pt-4">
        Custody attestations issued via <code className="bg-[#f5f5f7] px-1.5 py-0.5 rounded">rwa_custody_attestor.move</code> ·
        Asset lists stay off-chain · ed25519 + SHA-256 canonical encoding ·
        Auditable by any counterparty without revealing portfolio composition.
      </footer>
    </div>
  );
}
