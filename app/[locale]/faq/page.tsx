import type { Metadata } from 'next';
import Link from 'next/link';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const route = '/faq';
  const canonical = locale === defaultLocale ? route : `/${locale}${route}`;
  return {
    title: 'Frequently asked questions — ZKward',
    description:
      'What ZKward is, how it works, what happens with your money, and why the paper trader is currently in the red.',
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? route : `/${l}${route}`]),
      ),
    },
  };
}

// FAQ pairs — order matters for the JSON-LD FAQPage schema below.
// LLMs (ChatGPT, Perplexity, Claude) quote from this exact shape.
// Google shows the first 3–4 as rich results in SERP.
const FAQS: Array<{ q: string; a: string }> = [
  {
    q: 'What is ZKward?',
    a: 'ZKward is an autonomous crypto vault. You deposit USDC. Seven AI agents read prediction markets, funding rates, and price momentum, then trade across BTC, ETH, and SUI. Every hedge decision closes with a cryptographic proof anyone can verify on-chain.',
  },
  {
    q: 'Is ZKward a hedge fund?',
    a: 'No. A hedge fund is a specific regulated legal structure. ZKward is an on-chain vault — non-custodial, permissionless, no accreditation required, on-chain fee accounting, open-source strategy. It runs similar directional strategies but with public proofs instead of quarterly letters.',
  },
  {
    q: 'How much can I deposit?',
    a: 'The pool is capped at $10,000 total by the Move contract during the operational-proof phase. This is enforced on-chain — nobody, including us, can raise it without a governance action. Cap-lifting happens step by step after each stage survives a real drawdown test.',
  },
  {
    q: 'Where are my funds held?',
    a: 'In a SUI Move object controlled by the pool contract. Your keys stay with you — this is non-custodial. Withdrawals are permissionless and available anytime, with a 25% per-day account throttle enforced on-chain to prevent draining attacks.',
  },
  {
    q: 'What is a STARK proof and why do I care?',
    a: 'A STARK proof is a mathematical receipt that lets anyone verify a computation happened correctly, without seeing the private inputs. When ZKward opens or closes a hedge, it writes a STARK proof to the chain proving the trade followed the vault rules (asset caps, leverage caps, size limits). No black box. No "trust us."',
  },
  {
    q: 'What chains does ZKward run on?',
    a: 'SUI mainnet is the lead chain (live pool at package 0x107292…7b726). Reference deployments exist on Hedera Testnet, Sepolia, Cronos EVM, Oasis Sapphire, and Arbitrum Sepolia. Portability is proven; production expands where demand justifies it.',
  },
  {
    q: 'What are the fees?',
    a: '50 basis points annual management and 10% performance on realised profits. Fees are routed through a MSafe multisig-held FeeManagerCap, distinct from the operational AdminCap. The fee path cannot be seized by an admin key compromise.',
  },
  {
    q: 'Why is the paper trader losing money right now?',
    a: 'Public transparency. We run a paper trader against real signals and publish every trade — wins and losses. Current cumulative paper PnL is around -$68,000 while we tune the new gate system (volatility filter, streak guard, trend alignment, signal-quality). If we hid the losses, the wins would not mean anything.',
  },
  {
    q: 'How do I know the AI is not just making it up?',
    a: 'Every decision that moves capital emits a STARK proof committed to the SUI chain. The proof binds the decision to on-chain invariants (asset caps, leverage caps, size). Anyone can verify with the on-chain verifier. Trades under $100K also pass a 5-second cooldown, a 30-bps slippage ceiling, and a max-3-concurrent breaker. Trades over $100K need a 2-of-3 vote from the agent quorum.',
  },
  {
    q: 'Is ZKward safe against quantum computers?',
    a: 'The STARK proof system is transparent (no trusted setup) and uses only SHA-256 Merkle trees and the Goldilocks prime field. No elliptic curves, no discrete-log, no pairings. Shor\'s algorithm — the quantum attack that breaks RSA and ECDSA — is a non-threat here. Effective soundness is 180 bits, 52 bits above NIST post-quantum Level 1.',
  },
  {
    q: 'Can I withdraw at any time?',
    a: 'Yes. Withdrawal is permissionless — you sign a transaction, the contract calculates your share of the pool NAV, funds return to your wallet. A 25% per-day throttle per account is enforced by the contract to prevent draining under stress. There is no lockup, no notice period, no manager approval.',
  },
  {
    q: 'How do I contact the team?',
    a: 'Email ashish.regmi@zkward.com or join our Telegram (link in the footer). GitHub issues also work for technical questions.',
  },
];

export default function FaqPage() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.zkward.com';
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQS.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: f.a,
      },
    })),
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
      { '@type': 'ListItem', position: 2, name: 'FAQ', item: `${baseUrl}/faq` },
    ],
  };

  return (
    <main className="min-h-screen bg-system-bg-primary pt-24 pb-24">
      {/* JSON-LD structured data. `faqLd` and `breadcrumbLd` are
          composed of hardcoded constants + baseUrl (env-derived). No
          user input. JSON.stringify escapes HTML-significant chars.
          Canonical Next.js pattern; matches app/[locale]/layout.tsx. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />

      <article className="max-w-[720px] mx-auto px-4 sm:px-6">
        <header className="mb-12">
          <p className="text-caption-1 uppercase tracking-widest text-ios-blue font-semibold mb-3">
            FAQ
          </p>
          <h1 className="text-title-1 sm:text-large-title font-bold text-label-primary tracking-tight">
            Common questions
          </h1>
          <p className="mt-4 text-body text-label-secondary">
            Short answers. If yours is missing, email{' '}
            <a href="mailto:ashish.regmi@zkward.com" className="text-ios-blue hover:underline">
              ashish.regmi@zkward.com
            </a>{' '}
            and we&rsquo;ll add it.
          </p>
        </header>

        <section className="space-y-8">
          {FAQS.map((f, i) => (
            <div key={i} className="pb-6 border-b border-separator-opaque/40 last:border-b-0">
              <h2 className="text-title-3 font-semibold text-label-primary mb-2 leading-tight">
                {f.q}
              </h2>
              <p className="text-body text-label-secondary leading-relaxed">{f.a}</p>
            </div>
          ))}
        </section>

        <footer className="mt-12 pt-8 border-t border-separator-opaque/40 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between text-subheadline text-label-secondary">
          <div>
            Want the full technical version?{' '}
            <Link href="/whitepaper" className="text-ios-blue hover:underline font-medium">
              Read the whitepaper
            </Link>
          </div>
          <div>
            Or read{' '}
            <Link href="/story" className="text-ios-blue hover:underline font-medium">
              our story
            </Link>
            .
          </div>
        </footer>
      </article>
    </main>
  );
}
