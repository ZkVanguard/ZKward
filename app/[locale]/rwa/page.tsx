'use client';

import { Link } from '@/i18n/routing';
import {
  ShieldCheck, FileText, Lock, ArrowRight, Download,
  Building2, KeyRound, GitBranch, CheckCircle2,
} from 'lucide-react';
import { Section, SectionHeader, StatusPill, TrustBadge, Reveal } from '@/components/ui/landing';

// Standalone /rwa page — for RWA issuers, custodians, and institutional
// counterparties. Explains the custody-attestation product without requiring
// the reader to already understand the pool.

const STEPS = [
  {
    icon: FileText,
    title: 'Agree on the asset list off-chain',
    body: "You and your custodian settle the exact list of assets that back the portfolio outside the blockchain, in whatever format your compliance regime requires.",
  },
  {
    icon: KeyRound,
    title: 'Compute the canonical hash',
    body: 'Both sides independently hash the list via POST /api/custody · action:hash-assets. If your hashes match, you have a shared reference the chain can commit to.',
  },
  {
    icon: Lock,
    title: 'Custodian signs, you submit',
    body: 'Custodian signs a build-message payload with their enrolled ed25519 key. You submit the signature via rwa_custody_attestor::submit_attestation.',
  },
  {
    icon: ShieldCheck,
    title: 'Anyone verifies, no asset list required',
    body: 'Any counterparty calls POST /api/custody · action:verify with the attestation object id. They learn "yes, this portfolio is backed by an asset list this custodian signed". Nothing about which assets, nothing about the value.',
  },
] as const;

const AUDIENCES = [
  ['Tokenized-treasury issuers', 'Bind on-chain treasury bill wrappers to the actual custody holdings without revealing the position list.'],
  ['Real estate / receivables platforms', 'Prove that a portfolio is backed by an underlying loan or property pool without disclosing borrower identities.'],
  ['Fund managers issuing on-chain shares', 'Give LPs cryptographic proof of NAV backing at any point in time. Auditor-ready artifacts, no share leakage.'],
  ['Custodians serving crypto-native clients', 'Sign attestations once. Every counterparty verification is a stateless off-chain call, no ongoing operational burden.'],
] as const;

export default function RwaPage() {
  return (
    <div className="bg-system-bg-primary text-label-primary min-h-screen">
      {/* HERO */}
      <section className="pt-20 pb-8 sm:pt-32 sm:pb-16 px-4 sm:px-5 lg:px-8 min-w-0">
        <div className="max-w-[900px] mx-auto text-center">
          <div className="flex justify-center mb-8">
            <StatusPill
              left={
                <>
                  <Building2 className="w-3.5 h-3.5 text-ios-blue" />
                  <span className="text-footnote font-medium text-label-secondary">
                    For issuers, custodians & institutional counterparties
                  </span>
                </>
              }
            />
          </div>
          <h1 className="font-display font-semibold text-[36px] sm:text-[56px] md:text-[68px] lg:text-[80px] tracking-[-0.04em] leading-[0.96] text-label-primary mb-5 sm:mb-6 break-words">
            Real-world assets.
            <br />
            Provably backed on-chain.
          </h1>
          <p className="text-base sm:text-[19px] text-label-secondary max-w-[620px] mx-auto leading-relaxed mb-8 sm:mb-10">
            Bind an off-chain asset list to an on-chain portfolio with a custodian-signed attestation.
            Counterparties verify cryptographically, without ever seeing the assets themselves.
          </p>
          <div className="flex flex-col sm:flex-row justify-center items-stretch sm:items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center justify-center gap-2 px-8 h-[52px] sm:h-[56px] bg-ios-blue text-white text-headline font-semibold rounded-ios-xl hover:bg-[#0062CC] active:scale-[0.97] transition-all shadow-ios-2"
            >
              View attestations
              <ArrowRight className="w-4 h-4" strokeWidth={2.5} />
            </Link>
            <a
              href="mailto:ashishregmi2017@gmail.com?subject=ZKward%20RWA%20custody%20onboarding"
              className="inline-flex items-center justify-center gap-2 px-8 h-[52px] sm:h-[56px] bg-system-bg-primary border border-separator-opaque text-label-primary text-headline font-medium rounded-ios-xl hover:bg-system-bg-secondary active:scale-[0.97] transition-all"
            >
              Request custodian onboarding
            </a>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <Section tone="secondary" size="md">
        <Reveal>
          <SectionHeader
            eyebrow="How it works"
            title="Four steps, one signature."
            lede="The attestation binds a portfolio to an asset-list hash. Everything except the hash + the signature stays off-chain."
          />
          <ol className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4">
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <li key={title} className="bg-system-bg-primary rounded-ios-xl border border-separator-opaque/30 p-5 sm:p-6 shadow-ios-1">
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-ios bg-ios-blue/10 flex items-center justify-center flex-shrink-0">
                    <Icon className="w-5 h-5 text-ios-blue" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="font-semibold text-label-primary mb-1.5 text-headline">
                      <span className="text-label-tertiary tabular-nums mr-2">0{i + 1}</span>
                      {title}
                    </h3>
                    <p className="text-label-secondary text-callout leading-relaxed">{body}</p>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </Section>

      {/* AUDIENCE */}
      <Section size="md">
        <Reveal>
          <SectionHeader
            title="Who this is for."
            align="left"
          />
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
            {AUDIENCES.map(([title, body]) => (
              <div key={title}>
                <dt className="font-semibold text-label-primary text-headline mb-1">{title}</dt>
                <dd className="text-label-secondary text-callout leading-relaxed">{body}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </Section>

      {/* UNDER THE HOOD */}
      <Section tone="secondary" size="md">
        <Reveal>
          <SectionHeader
            eyebrow="Engineering"
            title="Under the hood."
            align="left"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <TrustBadge
              icon={<GitBranch className="w-5 h-5" />}
              title="Move contract"
              value="340 LOC"
              hint="rwa_custody_attestor.move · 11/11 tests · ed25519 + SHA-256"
            />
            <TrustBadge
              icon={<Download className="w-5 h-5" />}
              title="Artifacts"
              value="Portable JSON"
              hint="Canonical download per attestation, off-chain verifiable"
            />
            <TrustBadge
              icon={<CheckCircle2 className="w-5 h-5" />}
              title="API"
              value="/api/custody"
              hint="hash-assets · build-message · verify · list-attestations"
            />
            <TrustBadge
              icon={<ShieldCheck className="w-5 h-5" />}
              title="Privacy"
              value="By construction"
              hint="Hash + pubkey on-chain. List + sizes + identities stay off-chain."
            />
          </div>
        </Reveal>
      </Section>

      {/* CTA */}
      <Section size="lg">
        <div className="max-w-[720px] mx-auto text-center">
          <h2 className="font-display font-semibold text-[28px] sm:text-[42px] md:text-[52px] tracking-[-0.03em] leading-[1.05] text-label-primary mb-4 sm:mb-5 break-words">
            Onboard as a custodian.
          </h2>
          <p className="text-base sm:text-[19px] text-label-secondary max-w-[560px] mx-auto leading-relaxed mb-8">
            Enrol your ed25519 signing key, run through hash-assets with a test payload, then start issuing attestations. 30-minute onboarding call.
          </p>
          <a
            href="mailto:ashishregmi2017@gmail.com?subject=ZKward%20RWA%20custody%20onboarding"
            className="inline-flex items-center justify-center gap-2 px-8 h-[52px] sm:h-[56px] bg-label-primary text-white text-headline font-semibold rounded-ios-xl hover:bg-black active:scale-[0.97] transition-all shadow-ios-2"
          >
            Book onboarding call
            <ArrowRight className="w-5 h-5" strokeWidth={2.5} />
          </a>
        </div>
      </Section>
    </div>
  );
}
