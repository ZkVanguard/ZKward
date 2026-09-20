import type { Metadata } from 'next';
import Link from 'next/link';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const route = '/team';
  const canonical = locale === defaultLocale ? route : `/${locale}${route}`;
  return {
    title: 'The team behind ZKward',
    description:
      'ZKward is built primarily by Ashish Regmi (Mrare Jimmy) — CS + cryptography + AI, prior senior engineer at Fortune 500 companies, Tether WDK contributor, five hackathon wins.',
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? route : `/${l}${route}`]),
      ),
    },
  };
}

// E-E-A-T signal (Experience, Expertise, Authoritativeness, Trust).
// Google specifically looks for author bios on YMYL (Your Money or
// Your Life) topics — finance qualifies. Detailed founder credentials
// on this page feed Google's confidence that we're a real project.
export default function TeamPage() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.zkward.com';

  const personLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    '@id': `${baseUrl}/team#ashish`,
    name: 'Ashish Regmi',
    alternateName: 'Mrare Jimmy',
    jobTitle: 'Founder & Lead Engineer',
    email: 'ashish.regmi@zkward.com',
    url: `${baseUrl}/team`,
    worksFor: { '@id': `${baseUrl}/#org` },
    knowsAbout: [
      'Zero-knowledge proofs',
      'STARK proof systems',
      'Autonomous trading systems',
      'DeFi protocol design',
      'SUI Move smart contracts',
      'Solidity',
      'Post-quantum cryptography',
      'Prediction markets',
      'Artificial intelligence',
    ],
    sameAs: [
      'https://github.com/ZkVanguard',
      'https://twitter.com/HarveReg',
    ],
    alumniOf: {
      '@type': 'EducationalOrganization',
      name: "Bachelor's in Computer Science (Cryptography + AI)",
    },
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: baseUrl },
      { '@type': 'ListItem', position: 2, name: 'Team', item: `${baseUrl}/team` },
    ],
  };

  return (
    <main className="min-h-screen bg-system-bg-primary pt-24 pb-24">
      {/* JSON-LD structured data — build-time literals, no user input. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbLd) }}
      />

      <article className="max-w-[720px] mx-auto px-4 sm:px-6">
        <header className="mb-12">
          <p className="text-caption-1 uppercase tracking-widest text-ios-blue font-semibold mb-3">
            Team
          </p>
          <h1 className="text-title-1 sm:text-large-title font-bold text-label-primary tracking-tight">
            Who&rsquo;s behind ZKward.
          </h1>
          <p className="mt-4 text-body text-label-secondary">
            One founder, one operator, a lot of open-source contributions along the way.
          </p>
        </header>

        <section className="space-y-6 text-body text-label-primary leading-relaxed">
          <h2 className="text-title-2 font-semibold pt-3">Ashish Regmi</h2>
          <p className="text-callout text-label-secondary -mt-4">
            Founder &amp; Lead Engineer · Also known as Mrare Jimmy
          </p>

          <p>
            I built ZKward. I write the contracts, the agents, the ZK backend, the
            frontend, the deploy scripts, and the security scans. Also the 3 AM
            debugging when the paper trader does something stupid. That is on-brand.
          </p>

          <h3 className="text-title-3 font-semibold pt-4">Background</h3>
          <ul className="list-disc list-outside pl-5 space-y-2">
            <li>
              <strong>Bachelor&rsquo;s in Computer Science</strong>, with majors in{' '}
              <strong>Cryptography</strong> and <strong>Artificial Intelligence</strong>.
              The two fields ZKward literally sits on top of.
            </li>
            <li>
              <strong>Prior senior engineer</strong> at multiple Fortune 500 companies —
              production systems that moved real money at scale, so the "not lunatics"
              rule about the $10K cap comes from experience.
            </li>
            <li>
              <strong>Upstream contributor to Tether&rsquo;s Wallet Dev Kit</strong>{' '}
              (WDK) — the SDK Tether uses for its embedded wallet flows. Merged PRs
              live in the public repo.
            </li>
            <li>
              <strong>Five hackathon wins</strong> across the EVM, Aptos, and ICP
              ecosystems. Each win taught something that ended up in ZKward.
            </li>
          </ul>

          <h3 className="text-title-3 font-semibold pt-4">Reachable at</h3>
          <ul className="list-disc list-outside pl-5 space-y-2">
            <li>
              Email:{' '}
              <a href="mailto:ashish.regmi@zkward.com" className="text-ios-blue hover:underline">
                ashish.regmi@zkward.com
              </a>
            </li>
            <li>
              Telegram:{' '}
              <a
                href="https://t.me/+QoAodv90iWExZmVh"
                target="_blank"
                rel="noopener noreferrer"
                className="text-ios-blue hover:underline"
              >
                zkward group
              </a>
            </li>
            <li>
              X / Twitter:{' '}
              <a
                href="https://twitter.com/HarveReg"
                target="_blank"
                rel="noopener noreferrer"
                className="text-ios-blue hover:underline"
              >
                @HarveReg
              </a>
            </li>
            <li>
              GitHub:{' '}
              <a
                href="https://github.com/ZkVanguard"
                target="_blank"
                rel="noopener noreferrer"
                className="text-ios-blue hover:underline"
              >
                ZkVanguard org
              </a>
            </li>
          </ul>

          <h3 className="text-title-3 font-semibold pt-4">The rest of the crew</h3>
          <p>
            Contributors come and go — most are open-source PRs from people who tried
            the pool, spotted a bug, and sent a fix. Every merged PR is credited in
            the commit history. If you want to help, the codebase is public and the
            issues list is honest.
          </p>
        </section>

        <footer className="mt-14 pt-8 border-t border-separator-opaque/40 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between text-subheadline text-label-secondary">
          <div>
            Prefer the technical picture?{' '}
            <Link href="/whitepaper" className="text-ios-blue hover:underline font-medium">
              Read the whitepaper
            </Link>
          </div>
          <div>
            Or start with{' '}
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
