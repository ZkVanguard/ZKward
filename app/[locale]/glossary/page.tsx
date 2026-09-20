import type { Metadata } from 'next';
import Link from 'next/link';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const route = '/glossary';
  const canonical = locale === defaultLocale ? route : `/${locale}${route}`;
  return {
    title: 'Glossary — ZKward',
    description:
      'Plain-English definitions of every term ZKward uses: STARK, Goldilocks field, FRI, hedge ratio, prediction market, and more.',
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? route : `/${l}${route}`]),
      ),
    },
  };
}

// Every term is a definition query someone types into Google. Own the
// definition and you own the traffic — Google ranks single-page
// glossaries with clear H2 heads + short paragraphs above Wikipedia
// for niche technical terms.
const TERMS: Array<{ term: string; slug: string; definition: string }> = [
  {
    term: 'ZK-STARK',
    slug: 'zk-stark',
    definition:
      'A zero-knowledge proof system that lets one party prove a computation was performed correctly without revealing the private inputs. "Scalable Transparent ARgument of Knowledge." ZKward uses STARKs to attest every hedge decision on-chain — the proof is public, the position details are private.',
  },
  {
    term: 'Goldilocks field',
    slug: 'goldilocks-field',
    definition:
      'The prime field with modulus p = 2⁶⁴ − 2³² + 1 = 18,446,744,069,414,584,321. Used by ZKward, Polygon zkEVM, and Plonky2 because 64-bit arithmetic is native on modern CPUs. Native-width fields give fast Number Theoretic Transforms (NTTs), which is how STARK provers stay practical.',
  },
  {
    term: 'FRI (Fast Reed-Solomon IOP of Proximity)',
    slug: 'fri',
    definition:
      "The polynomial commitment scheme inside a STARK. Given a claim that a polynomial has low degree, FRI produces a short proof that anyone can verify in O(log n) time. ZKward uses 80 FRI queries plus 20 bits of proof-of-work grinding, giving 180-bit soundness. Cited: Ben-Sasson–Bentov–Horesh–Riabzev, ePrint 2018/828.",
  },
  {
    term: 'Prediction market',
    slug: 'prediction-market',
    definition:
      'A market where people bet on the outcome of a future event. The market price reflects the crowd\'s probability estimate. Polymarket, Kalshi, and Manifold are the main crypto-adjacent venues. Polymarket processed $20B/month in early 2026 — the signal is finally liquid enough to trade at retail size.',
  },
  {
    term: 'Hedge',
    slug: 'hedge',
    definition:
      'A trade designed to offset the risk of another position. If ZKward holds $10K of BTC spot and a signal says "BTC drops soon," the hedge opens a SHORT BTC perpetual — losses on spot are cancelled by gains on the short. ZKward\'s hedge ratio is 50% base, scaled up to 100% for very small pools where the perp minimums matter more.',
  },
  {
    term: 'Perpetual (perp)',
    slug: 'perpetual',
    definition:
      'A futures contract with no expiry date. Traders pay/receive "funding" every 8 hours to keep the perp price close to the spot price. ZKward executes hedges on BlueFin perpetuals on SUI. Funding sign is one of the signals fed to the aggregator.',
  },
  {
    term: 'Autonomous vault',
    slug: 'autonomous-vault',
    definition:
      'A smart contract holding user deposits where allocation decisions are made by code (or AI), not by a human manager. ZKward is autonomous: seven agents read signals every 5 minutes, decide, execute, and write a proof. No human clicks a button before capital moves.',
  },
  {
    term: 'Zero-knowledge proof',
    slug: 'zero-knowledge-proof',
    definition:
      'A cryptographic proof that a statement is true without revealing why. Example: proving "I know a password that unlocks this file" without showing the password. In ZKward, the statement is "this hedge follows all vault rules" and the private inputs are the exact size, entry price, and side.',
  },
  {
    term: 'Post-quantum',
    slug: 'post-quantum',
    definition:
      'A cryptographic system that a large quantum computer cannot break. RSA and ECDSA are NOT post-quantum — Shor\'s algorithm breaks both in polynomial time on a sufficiently large quantum machine. STARKs are post-quantum because they use only hash functions (SHA-256) and prime-field arithmetic, both quantum-resistant.',
  },
  {
    term: 'Non-custodial',
    slug: 'non-custodial',
    definition:
      'A design where the user, not the protocol operator, controls the private keys that authorize withdrawals. In ZKward, the pool is a Move object owned by the contract; withdrawal is permissionless — you sign a transaction and the funds return to your wallet without operator approval.',
  },
  {
    term: 'AdminCap / FeeManagerCap / OracleCap',
    slug: 'sui-capabilities',
    definition:
      'SUI Move objects that grant specific permissions. AdminCap can pause the contract; FeeManagerCap collects fees; OracleCap attests NAV. ZKward splits these so the fee path cannot be seized by an admin-key compromise. AdminCap is migrating to a multisig (MSafe) in v0.4.0.',
  },
  {
    term: 'TVL (Total Value Locked)',
    slug: 'tvl',
    definition:
      'The total value of assets deposited in a DeFi protocol. ZKward\'s TVL is capped at $10,000 by the Move contract during the operational-proof phase. Cap-lifting requires a governance action — code cannot bypass the on-chain limit.',
  },
  {
    term: 'Drawdown',
    slug: 'drawdown',
    definition:
      "The peak-to-trough decline of a portfolio's value. If the pool hit $9,000 and fell to $7,650, drawdown is 15%. ZKward's autonomy defense system triggers at specific drawdown thresholds — profit-lock clamping starts at 5%, zero-risk mode at 20%.",
  },
  {
    term: 'MSafe multisig',
    slug: 'msafe',
    definition:
      'A multi-signature wallet on the SUI network. Requires N of M signatures to authorize a transaction. ZKward\'s FeeManagerCap is held in MSafe today; AdminCap moves there in v0.4.0 after the OracleCap split.',
  },
  {
    term: 'Cron (scheduled job)',
    slug: 'cron',
    definition:
      'A scheduled task that runs at fixed intervals. ZKward runs 14 crons — most every 5 minutes — for signal aggregation, hedge execution, reconciliation, and health checks. Every cron uses claim-based idempotency: two invocations at the same time cannot double-execute.',
  },
  {
    term: 'Signal fusion',
    slug: 'signal-fusion',
    definition:
      "Combining multiple data sources into one directional estimate. ZKward's aggregator blends ten sources: Polymarket, Delphi, Crypto.com price, BlueFin funding, Binance funding + long/short, Bybit funding + OI, Kalshi ATM strike, Deribit vol, and multi-asset alignment. Each source has a per-asset weight; the fused output feeds hedge sizing.",
  },
];

export default function GlossaryPage() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.zkward.com';

  // DefinedTermSet — Schema.org's structured type for glossaries. Google
  // uses this to eligible the page for the "definition" rich result and
  // to bind each term to a concept it can surface elsewhere.
  const glossaryLd = {
    '@context': 'https://schema.org',
    '@type': 'DefinedTermSet',
    name: 'ZKward Glossary',
    url: `${baseUrl}/glossary`,
    hasDefinedTerm: TERMS.map((t) => ({
      '@type': 'DefinedTerm',
      name: t.term,
      description: t.definition,
      url: `${baseUrl}/glossary#${t.slug}`,
      inDefinedTermSet: `${baseUrl}/glossary`,
    })),
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
      { '@type': 'ListItem', position: 2, name: 'Glossary', item: `${baseUrl}/glossary` },
    ],
  };

  return (
    <main className="min-h-screen bg-system-bg-primary pt-24 pb-24">
      {/* JSON-LD structured data — build-time constants + baseUrl only.
          No user input. JSON.stringify escapes HTML-significant chars.
          Canonical Next.js pattern. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(glossaryLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />

      <article className="max-w-[760px] mx-auto px-4 sm:px-6">
        <header className="mb-12">
          <p className="text-caption-1 uppercase tracking-widest text-ios-blue font-semibold mb-3">
            Glossary
          </p>
          <h1 className="text-title-1 sm:text-large-title font-bold text-label-primary tracking-tight">
            Every term, plainly.
          </h1>
          <p className="mt-4 text-body text-label-secondary">
            Terms you&rsquo;ll see across the site, defined without jargon. If one is missing,
            email{' '}
            <a href="mailto:ashish.regmi@zkward.com" className="text-ios-blue hover:underline">
              ashish.regmi@zkward.com
            </a>
            .
          </p>
        </header>

        <nav className="mb-10 p-4 bg-system-bg-secondary rounded-xl">
          <p className="text-caption-1 uppercase tracking-widest text-label-tertiary mb-2 font-semibold">
            Jump to
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-subheadline">
            {TERMS.map((t) => (
              <a
                key={t.slug}
                href={`#${t.slug}`}
                className="text-ios-blue hover:underline"
              >
                {t.term}
              </a>
            ))}
          </div>
        </nav>

        <section className="space-y-10">
          {TERMS.map((t) => (
            <div key={t.slug} id={t.slug} className="scroll-mt-24">
              <h2 className="text-title-3 font-semibold text-label-primary mb-2 leading-tight">
                {t.term}
              </h2>
              <p className="text-body text-label-secondary leading-relaxed">
                {t.definition}
              </p>
            </div>
          ))}
        </section>

        <footer className="mt-16 pt-8 border-t border-separator-opaque/40 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between text-subheadline text-label-secondary">
          <div>
            Read the full technical version in the{' '}
            <Link href="/whitepaper" className="text-ios-blue hover:underline font-medium">
              whitepaper
            </Link>
            .
          </div>
          <div>
            New here?{' '}
            <Link href="/story" className="text-ios-blue hover:underline font-medium">
              Start with our story
            </Link>
            .
          </div>
        </footer>
      </article>
    </main>
  );
}
