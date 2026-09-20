'use client';

import { useEffect, useState } from 'react';
import { Shield, Cpu, Lock, CheckCircle2, ExternalLink, X } from 'lucide-react';
import { Section, SectionHeader, StatusPill, TrustBadge, Reveal } from '@/components/ui/landing';
import { ZkLiveProofDemo } from '@/components/zk/ZkLiveProofDemo';

// Single focused ZK page. Replaces the three separate /zk-authenticity, /zk-proof,
// and /zk-verification pages that grew independently and drifted apart. Structure:
//   1. Hero — what STARK-attested vault means.
//   2. Live prover health — is the Python STARK backend up right now.
//   3. Explainer — how the STARK works.
//   4. Security parameters — honest about field choice and soundness.
//   5. Verify widget — paste a proof hash, we tell you if it's on-chain.
//   6. Deep-dive links — old pages moved to sub-routes.

interface ProverHealth {
  status: 'healthy' | 'unhealthy' | 'unavailable';
  cuda_available?: boolean;
  cuda_enabled?: boolean;
  backend?: string;
  error?: string;
}

const HOW_STEPS = [
  {
    icon: Lock,
    title: 'Trace the computation',
    body: 'Each agent decision (allocation percentages, hedge sizing, risk score) compiles into an execution trace: a matrix of intermediate states the prover walks through.',
  },
  {
    icon: Shield,
    title: 'Commit and prove',
    body: 'AIR constraints on the trace are extended and folded through FRI (Fast Reed-Solomon IOP). Merkle-committed with SHA-256. Fiat-Shamir non-interactivity.',
  },
  {
    icon: CheckCircle2,
    title: 'Verify anywhere',
    body: 'Proofs are 10 to 50 KB. Verification is 50 to 200 ms off-chain and constant-time. No interaction with the prover, no trust in the AI, no revealing the underlying data.',
  },
] as const;

export default function ZkPage() {
  const [health, setHealth] = useState<ProverHealth | null>(null);
  const [verifyInput, setVerifyInput] = useState('');
  const [verifyResult, setVerifyResult] = useState<null | { found: boolean; detail?: string }>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);

  useEffect(() => {
    fetch('/api/zk-proof/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'unavailable' }));
  }, []);

  const verify = async () => {
    const q = verifyInput.trim();
    if (!q) return;
    setVerifyLoading(true);
    setVerifyResult(null);
    try {
      const r = await fetch(`/api/zk-proof/lookup?hash=${encodeURIComponent(q)}`, { cache: 'no-store' });
      const data = await r.json();
      if (r.ok && data?.found) {
        setVerifyResult({ found: true, detail: data.detail || `Verified on-chain at ${data.timestamp ?? 'unknown time'}` });
      } else {
        setVerifyResult({ found: false, detail: data?.error || 'Proof not found on-chain. Check the hash and try again.' });
      }
    } catch (e) {
      setVerifyResult({ found: false, detail: e instanceof Error ? e.message : 'Verification failed' });
    } finally {
      setVerifyLoading(false);
    }
  };

  const proverStatusDot =
    health?.status === 'healthy' ? 'bg-ios-green' :
    health?.status === 'unhealthy' ? 'bg-ios-orange' :
    health?.status === 'unavailable' ? 'bg-ios-red' : 'bg-separator-opaque';

  const proverStatusLabel = health ? (
    health.status === 'healthy' ? 'Online' :
    health.status === 'unhealthy' ? 'Degraded' : 'Offline'
  ) : 'Checking…';

  return (
    <div className="bg-system-bg-primary text-label-primary min-h-screen">
      {/* HERO */}
      <section className="pt-20 pb-8 sm:pt-32 sm:pb-16 px-4 sm:px-5 lg:px-8 min-w-0">
        <div className="max-w-[900px] mx-auto text-center">
          <div className="flex justify-center mb-8">
            <StatusPill
              left={
                <>
                  <Shield className="w-3.5 h-3.5 text-ios-blue" />
                  <span className="text-footnote font-medium text-label-secondary">
                    ZK-STARK · Post-Quantum · No Trusted Setup
                  </span>
                </>
              }
            />
          </div>
          <h1 className="font-display font-semibold text-[36px] sm:text-[56px] md:text-[68px] lg:text-[80px] tracking-[-0.04em] leading-[0.96] text-label-primary mb-5 sm:mb-6 break-words">
            Every vault decision,
            <br />
            cryptographically attested.
          </h1>
          <p className="text-base sm:text-[19px] text-label-secondary max-w-[620px] mx-auto leading-relaxed">
            When our AI agents commit to a hedge, allocation, or rebalance, the decision is proven correct with a
            zero-knowledge STARK. No trusted setup. Post-quantum secure by construction. Verifiable by anyone.
          </p>
        </div>
      </section>

      {/* LIVE PROOF DEMO — the marquee. Click, watch a real STARK land. */}
      <Section size="sm">
        <div className="max-w-[820px] mx-auto">
          <ZkLiveProofDemo />
        </div>
      </Section>

      {/* PROVER STATUS — compact strip so the demo owns the fold */}
      <Section size="sm">
        <div className="max-w-[820px] mx-auto">
          <div className="flex items-center gap-3 sm:gap-4 bg-system-bg-secondary rounded-2xl px-4 py-3 text-[12px] sm:text-[13px]">
            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${proverStatusDot}`} />
            <span className="text-label-secondary">
              Prover backend: <span className="font-semibold text-label-primary">{proverStatusLabel}</span>
            </span>
            {health && (
              <>
                <span className="text-label-tertiary hidden sm:inline">·</span>
                <span className="text-label-secondary hidden sm:inline">
                  {health.cuda_enabled ? (
                    <span className="inline-flex items-center gap-1">
                      <Cpu className="w-3 h-3 text-ios-green" /> CUDA
                    </span>
                  ) : health.cuda_available ? 'CUDA available · CPU active' : 'CPU only'}
                </span>
                <span className="text-label-tertiary hidden md:inline">·</span>
                <span className="text-label-tertiary hidden md:inline font-mono text-[11px] truncate">
                  {health.backend || '…'}
                </span>
              </>
            )}
          </div>
        </div>
      </Section>

      {/* HOW IT WORKS */}
      <Section tone="secondary" size="md">
        <Reveal>
          <SectionHeader
            eyebrow="How it works"
            title="Trace. Commit. Verify."
            lede="Three moves. The prover produces the artifact. The verifier reads it in milliseconds. Nothing about your position leaks either way."
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
            {HOW_STEPS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="bg-system-bg-primary rounded-ios-xl border border-separator-opaque/30 p-5 sm:p-6 shadow-ios-1">
                <div className="w-10 h-10 rounded-ios bg-ios-blue/10 flex items-center justify-center mb-3">
                  <Icon className="w-5 h-5 text-ios-blue" />
                </div>
                <h3 className="font-semibold text-label-primary mb-2 text-headline">{title}</h3>
                <p className="text-label-secondary text-callout leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* SECURITY PARAMETERS */}
      <Section size="md">
        <Reveal>
          <SectionHeader
            eyebrow="Security"
            title="Parameters, no marketing."
            align="left"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            <TrustBadge
              icon={<Lock className="w-5 h-5" />}
              title="Field"
              value="Goldilocks-64"
              hint="NIST P-521 prime available as fallback"
            />
            <TrustBadge
              icon={<Shield className="w-5 h-5" />}
              title="Commitments"
              value="SHA-256"
              hint="Merkle trees · Fiat-Shamir non-interactive"
            />
            <TrustBadge
              icon={<CheckCircle2 className="w-5 h-5" />}
              title="Soundness"
              value="~180 bits"
              hint="FRI queries plus grinding, above PQ requirements"
            />
            <TrustBadge
              icon={<Shield className="w-5 h-5" />}
              title="Trusted setup"
              value="None"
              hint="Hash-based commitments only"
            />
            <TrustBadge
              icon={<CheckCircle2 className="w-5 h-5" />}
              title="Post-quantum"
              value="Yes"
              hint="No discrete-log or factoring assumption"
            />
            <TrustBadge
              icon={<Cpu className="w-5 h-5" />}
              title="Acceleration"
              value="CUDA"
              hint="CuPy / Numba with CPU fallback"
            />
          </div>
        </Reveal>
      </Section>

      {/* WHY STARK — comparison table */}
      <Section tone="secondary" size="md">
        <Reveal>
          <SectionHeader
            eyebrow="Why STARK"
            title="Three protocols. One that survives quantum."
            lede="STARK is transparent (no trusted setup), post-quantum secure, and has proof sizes that don't need a pairing curve. That's why the vault's attestation layer runs on it."
            align="left"
          />
          <div className="overflow-x-auto -mx-4 sm:mx-0">
            <table className="w-full min-w-[540px] text-left text-[12px] sm:text-[13px] border-separate border-spacing-0">
              <thead>
                <tr className="text-label-tertiary">
                  <th className="font-semibold uppercase tracking-wide text-[10px] pb-2 pl-4 sm:pl-0"></th>
                  <th className="font-semibold uppercase tracking-wide text-[10px] pb-2 px-2 sm:px-4" style={{ color: '#0069D9' }}>ZK-STARK<br /><span className="text-label-tertiary normal-case font-normal text-[10px]">(this vault)</span></th>
                  <th className="font-semibold uppercase tracking-wide text-[10px] pb-2 px-2 sm:px-4">Groth16 SNARK</th>
                  <th className="font-semibold uppercase tracking-wide text-[10px] pb-2 px-2 sm:px-4 pr-4 sm:pr-0">Bulletproofs</th>
                </tr>
              </thead>
              <tbody className="text-label-primary">
                <ComparisonRow
                  label="Trusted setup"
                  values={[
                    { text: 'None', good: true },
                    { text: 'Per-circuit ceremony', good: false },
                    { text: 'None', good: true },
                  ]}
                />
                <ComparisonRow
                  label="Post-quantum secure"
                  values={[
                    { text: 'Yes (hash-based)', good: true },
                    { text: 'No (elliptic-curve)', good: false },
                    { text: 'No (discrete-log)', good: false },
                  ]}
                />
                <ComparisonRow
                  label="Proof size"
                  values={[
                    { text: '10 to 50 KB', good: null },
                    { text: '~200 B', good: true },
                    { text: '1 to 2 KB', good: null },
                  ]}
                />
                <ComparisonRow
                  label="Verification time"
                  values={[
                    { text: '~100 ms', good: null },
                    { text: '~2 ms', good: true },
                    { text: '~100 ms', good: null },
                  ]}
                />
                <ComparisonRow
                  label="Prover time (10⁶ constraints)"
                  values={[
                    { text: '~5 s (CUDA)', good: true },
                    { text: '~30 s', good: null },
                    { text: '~500 s', good: false },
                  ]}
                />
                <ComparisonRow
                  label="Soundness"
                  values={[
                    { text: '~180 bits', good: true },
                    { text: '~128 bits', good: null },
                    { text: '~128 bits', good: null },
                  ]}
                />
                <ComparisonRow
                  label="Aggregation"
                  values={[
                    { text: 'Recursive FRI', good: true },
                    { text: 'Native pairing', good: true },
                    { text: 'Log-linear', good: null },
                  ]}
                  isLast
                />
              </tbody>
            </table>
          </div>
          <p className="text-caption-1 text-label-tertiary mt-4 leading-relaxed max-w-[720px]">
            SNARKs win on proof size but rely on a trusted ceremony and elliptic-curve assumptions Shor breaks.
            Bulletproofs are transparent but prover time doesn&apos;t scale to a 24/7 attestation stream. STARK
            is the only option that hits the three constraints we actually care about: no trusted setup,
            quantum-safe, fast enough to prove every meaningful decision.
          </p>
        </Reveal>
      </Section>

      {/* VERIFY WIDGET */}
      <Section tone="secondary" size="md">
        <Reveal>
          <div className="max-w-[720px] mx-auto">
            <SectionHeader
              title="Verify a proof."
              lede="Paste a proof hash (0x…) or transaction digest from the vault's activity log. We'll check whether it's recorded on-chain and return its details."
              align="left"
            />
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                inputMode="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={verifyInput}
                onChange={(e) => setVerifyInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && verify()}
                placeholder="0x…"
                className="flex-1 h-12 px-4 rounded-xl border border-separator-opaque bg-system-bg-primary focus:border-ios-blue focus:outline-none text-label-primary font-mono text-sm w-full min-w-0"
              />
              <button
                onClick={verify}
                disabled={verifyLoading || !verifyInput.trim()}
                className="h-12 px-6 rounded-xl bg-ios-blue text-white font-semibold hover:bg-[#0062CC] transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-full sm:w-auto flex-shrink-0 active:scale-[0.97]"
              >
                {verifyLoading ? 'Checking…' : 'Verify'}
              </button>
            </div>
            {verifyResult && (
              <div className={`mt-4 p-4 rounded-xl border ${
                verifyResult.found
                  ? 'bg-ios-green/10 border-ios-green/30 text-[#0F5132]'
                  : 'bg-ios-red/10 border-ios-red/30 text-[#842029]'
              }`}>
                <div className="flex items-start gap-3">
                  {verifyResult.found ? (
                    <CheckCircle2 className="w-5 h-5 mt-0.5 flex-shrink-0" />
                  ) : (
                    <ExternalLink className="w-5 h-5 mt-0.5 flex-shrink-0 opacity-70" />
                  )}
                  <div className="text-sm leading-relaxed break-words min-w-0">{verifyResult.detail}</div>
                </div>
              </div>
            )}
          </div>
        </Reveal>
      </Section>

      {/* VERIFY YOURSELF — real code, real API. Open source is the moat. */}
      <Section size="md">
        <Reveal>
          <SectionHeader
            eyebrow="Open source"
            title="Verify it yourself."
            lede="One HTTP call. No SDK. Every attestation the vault posts is publicly checkable."
            align="left"
          />
          <div className="bg-label-primary rounded-[20px] overflow-hidden shadow-ios-2">
            <div className="flex items-center justify-between px-5 sm:px-6 py-3 border-b border-white/10">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-ios-red/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-ios-orange/70" />
                <span className="w-2.5 h-2.5 rounded-full bg-ios-green/70" />
              </div>
              <span className="text-caption-1 text-white/60 font-mono">verify.sh</span>
            </div>
            <pre className="p-5 sm:p-6 overflow-x-auto text-subheadline text-white font-mono leading-relaxed">
{`# Look up any proof hash the vault has posted
curl "https://www.zkward.com/api/zk-proof/lookup?hash=0xa3..2f"

# Response:
# {
#   "found": true,
#   "backend": "CUDATrueSTARK",
#   "field": "Goldilocks-64",
#   "soundness_bits": 180,
#   "timestamp": "2026-08-26T14:07:12Z",
#   "on_chain_tx": "0x..."
# }`}
            </pre>
          </div>
          <div className="mt-4 flex flex-wrap gap-3 items-center text-caption-1 text-label-tertiary">
            <span>Source:</span>
            <a
              href="https://github.com/ZkVanguard/zkward-ethglobal/tree/main/zkp"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-ios-blue hover:underline font-mono"
            >
              zkp/ <ExternalLink className="w-3 h-3" />
            </a>
            <span>·</span>
            <a
              href="https://github.com/ZkVanguard/zkward-ethglobal/blob/main/zkp/api/server.py"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-ios-blue hover:underline font-mono"
            >
              api/server.py <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </Reveal>
      </Section>

    </div>
  );
}

function ComparisonRow({
  label,
  values,
  isLast,
}: {
  label: string;
  values: Array<{ text: string; good: boolean | null }>;
  isLast?: boolean;
}) {
  const borderClass = isLast ? '' : 'border-b border-separator-opaque/30';
  return (
    <tr>
      <td className={`py-2.5 pr-3 pl-4 sm:pl-0 font-medium text-label-secondary ${borderClass}`}>{label}</td>
      {values.map((v, i) => (
        <td key={i} className={`py-2.5 px-2 sm:px-4 ${borderClass} ${i === values.length - 1 ? 'pr-4 sm:pr-0' : ''}`}>
          <div className="flex items-center gap-1.5">
            {v.good === true && <CheckCircle2 className="w-3.5 h-3.5 text-ios-green flex-shrink-0" />}
            {v.good === false && <X className="w-3.5 h-3.5 text-ios-red flex-shrink-0" />}
            <span className={v.good === false ? 'text-label-tertiary' : 'text-label-primary'}>{v.text}</span>
          </div>
        </td>
      ))}
    </tr>
  );
}
