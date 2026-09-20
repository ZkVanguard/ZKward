'use client';

/**
 * Live STARK proof demo — click a scenario, we hit /api/zk-proof/generate
 * and show the real proof artifact with timing, size, field, and
 * soundness. If the backend is offline, we return the graceful fallback
 * shape (deterministic hash + explicit "fallback_mode" badge) so the
 * demo doesn't dead-end.
 *
 * Three preset scenarios line up with the vault's real attestation
 * pipeline (hedge / allocation / risk-score) so what you see here is
 * shape-identical to what the pool posts on-chain for real decisions.
 */

import { useState } from 'react';
import { Loader2, Copy, Check, ExternalLink, Zap, ShieldCheck, AlertTriangle } from 'lucide-react';

const ACCENT = '#0069D9';

interface Scenario {
  id: string;
  label: string;
  description: string;
  scenario: string;
  statement: Record<string, unknown>;
  witness: Record<string, unknown>;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'hedge',
    label: 'Hedge attestation',
    description: 'Prove a hedge fired at a specific price, size, and confidence. Without revealing the private strategy inputs.',
    scenario: 'hedge-attest',
    statement: {
      asset: 'BTC',
      action: 'HEDGE_LONG',
      notionalUsd: 5000,
      leverage: 2,
      markPrice: 80000,
    },
    witness: {
      agentId: 'hedging-agent-v2',
      confidence: 82,
      signalSources: ['polymarket-5m', 'delphi', 'cryptocom'],
    },
  },
  {
    id: 'allocation',
    label: 'Allocation rebalance',
    description: 'Prove the AI rebalanced allocations following the platform\'s rules (max ±20% drift, no single asset >50%).',
    scenario: 'allocation-rebalance',
    statement: {
      pool: '0x18a8d89E3674EBCeC678f97A8a8b1D144b330b88',
      newTargets: { BTC: 30, ETH: 30, SUI: 30, USDC: 10 },
      driftBps: 450,
    },
    witness: {
      agentId: 'lead-agent',
      quorumApprovers: 3,
      riskScore: 4,
    },
  },
  {
    id: 'risk',
    label: 'Risk score attestation',
    description: 'Prove the composite risk score was computed correctly from live venue + market inputs. Without exposing the exact weights.',
    scenario: 'risk-score',
    statement: {
      portfolioId: -2,
      timestamp: Math.floor(Date.now() / 1000),
      riskScore: 4,
      threshold: 6,
    },
    witness: {
      inputs: ['bluefin-funding', 'sui-rpc-lag', 'polymarket-flip-rate'],
      formulaVersion: 'risk-v0.4.0',
    },
  },
];

interface ProofResult {
  proof_hash?: string;
  merkle_root?: string;
  protocol?: string;
  security_level?: number;
  field_bits?: number;
  cuda_accelerated?: boolean;
  fallback_mode?: boolean;
  timestamp?: number;
}

interface GenerateResponse {
  success: boolean;
  proof?: ProofResult;
  duration_ms?: number;
  fallback?: boolean;
  error?: string;
  code?: string;
  message?: string;
}

export function ZkLiveProofDemo() {
  const [selected, setSelected] = useState<Scenario>(SCENARIOS[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  const generate = async () => {
    setLoading(true);
    setResult(null);
    setElapsedMs(null);
    const t0 = performance.now();
    try {
      const r = await fetch('/api/zk-proof/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenario: selected.scenario,
          statement: selected.statement,
          witness: selected.witness,
        }),
      });
      const data = (await r.json()) as GenerateResponse;
      setResult(data);
      setElapsedMs(performance.now() - t0);
    } catch (e) {
      setResult({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  };

  const copyHash = async () => {
    if (!result?.proof?.proof_hash) return;
    try {
      await navigator.clipboard.writeText(result.proof.proof_hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  };

  const proof = result?.proof;
  const isReal = result?.success && !proof?.fallback_mode && !result.fallback;
  const isFallback = result?.success && (proof?.fallback_mode || result.fallback);
  const isError = result && !result.success;

  return (
    <div className="rounded-[24px] border border-separator-opaque/40 bg-system-bg-primary p-5 sm:p-7 shadow-ios-2">
      <div className="flex items-start gap-3 mb-4">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: `${ACCENT}15`, color: ACCENT }}
        >
          <Zap className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-headline font-semibold text-label-primary">Generate a live proof</div>
          <div className="text-caption-1 text-label-secondary mt-1 leading-relaxed">
            Pick a real vault decision shape, click generate. The prover runs the same code path
            it uses on-chain. Output is a full STARK artifact you can verify below.
          </div>
        </div>
      </div>

      {/* Scenario picker */}
      <div className="flex flex-wrap gap-2 mb-3">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => { setSelected(s); setResult(null); }}
            className={`px-3 h-9 rounded-[10px] text-[13px] font-semibold transition-all ${
              selected.id === s.id
                ? 'bg-white shadow-ios-1 text-label-primary border border-separator-opaque/60'
                : 'bg-system-bg-secondary text-label-tertiary hover:bg-[#E5E5EA]'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="text-[11px] text-label-tertiary mb-3 leading-relaxed">
        {selected.description}
      </div>

      {/* Statement + witness preview */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        <div className="rounded-lg bg-system-bg-secondary p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-label-tertiary mb-1.5">
            Statement (public)
          </div>
          <pre className="text-[10px] font-mono text-label-secondary overflow-x-auto whitespace-pre-wrap break-all">
{JSON.stringify(selected.statement, null, 2)}
          </pre>
        </div>
        <div className="rounded-lg bg-system-bg-secondary p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-label-tertiary mb-1.5">
            Witness (private. Not revealed)
          </div>
          <pre className="text-[10px] font-mono text-label-secondary overflow-x-auto whitespace-pre-wrap break-all">
{JSON.stringify(selected.witness, null, 2)}
          </pre>
        </div>
      </div>

      <button
        onClick={generate}
        disabled={loading}
        className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-5 h-12 rounded-xl text-white font-semibold text-[15px] active:scale-[0.98] disabled:opacity-60"
        style={{ background: ACCENT }}
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Generating STARK proof…
          </>
        ) : (
          <>
            <Zap className="w-4 h-4" />
            Generate proof
          </>
        )}
      </button>

      {/* Result panel */}
      {result && (
        <div className={`mt-4 rounded-xl p-4 border ${
          isReal ? 'bg-ios-green/10 border-ios-green/30' :
          isFallback ? 'bg-ios-orange/10 border-ios-orange/30' :
          'bg-ios-red/10 border-ios-red/30'
        }`}>
          <div className="flex items-center gap-2 mb-3">
            {isReal && <ShieldCheck className="w-5 h-5 text-ios-green" />}
            {isFallback && <AlertTriangle className="w-5 h-5 text-ios-orange" />}
            {isError && <AlertTriangle className="w-5 h-5 text-ios-red" />}
            <div className="text-[13px] font-semibold text-label-primary">
              {isReal && 'Proof generated on the live prover'}
              {isFallback && 'Deterministic fallback (prover offline)'}
              {isError && (result.error || 'Prover unreachable')}
            </div>
            {elapsedMs !== null && (
              <span className="ml-auto text-[10px] font-mono text-label-tertiary tabular-nums">
                {elapsedMs.toFixed(0)}ms round-trip
              </span>
            )}
          </div>

          {proof?.proof_hash && (
            <div className="space-y-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-label-tertiary mb-1">
                  Proof hash
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate font-mono text-[11px] text-label-primary bg-white/60 rounded px-2 py-1.5">
                    {proof.proof_hash}
                  </code>
                  <button
                    onClick={copyHash}
                    className="p-1.5 rounded-lg hover:bg-white/60 active:scale-[0.96] transition-all"
                    title="Copy hash"
                  >
                    {copied ? (
                      <Check className="w-3.5 h-3.5 text-ios-green" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-label-secondary" />
                    )}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                <ProofStat label="Protocol" value={proof.protocol || 'STARK'} />
                <ProofStat label="Field bits" value={proof.field_bits?.toString() || '—'} />
                <ProofStat label="Soundness" value={proof.security_level ? `${proof.security_level} bits` : '—'} />
                <ProofStat label="CUDA" value={proof.cuda_accelerated ? 'On' : 'Off'} />
              </div>
              {result.duration_ms !== undefined && (
                <div className="text-[10px] text-label-tertiary">
                  Server-side proof time: <span className="font-mono tabular-nums">{result.duration_ms}ms</span>
                </div>
              )}
            </div>
          )}

          {!proof?.proof_hash && result.message && (
            <div className="text-[11px] text-label-secondary leading-relaxed">
              {result.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProofStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/50 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wide text-label-tertiary">{label}</div>
      <div className="text-[11px] font-mono font-semibold text-label-primary tabular-nums truncate">{value}</div>
    </div>
  );
}
