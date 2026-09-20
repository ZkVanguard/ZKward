import type { Metadata } from 'next';
import Link from 'next/link';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const route = '/story';
  const canonical = locale === defaultLocale ? route : `/${locale}${route}`;
  return {
    title: 'Our story — ZKward',
    description:
      "How ZKward started, what it does, and why we tell you when it loses money.",
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? route : `/${l}${route}`]),
      ),
    },
  };
}

export default function StoryPage() {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com';
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    name: 'How we got here — ZKward',
    url: `${baseUrl}/story`,
    inLanguage: 'en',
    isPartOf: { '@id': `${baseUrl}/#website` },
    about: { '@id': `${baseUrl}/#org` },
    mainEntity: {
      '@type': 'Organization',
      '@id': `${baseUrl}/#org`,
    },
  };
  return (
    <main className="min-h-screen bg-system-bg-primary pt-24 pb-24">
      {/* JSON-LD structured data. `articleLd` is a hardcoded object
          composed of build-time constants; JSON.stringify escapes
          HTML-significant chars in any string values. No user-controlled
          input reaches this string. Canonical Next.js JSON-LD pattern —
          matches the one in app/[locale]/layout.tsx. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <article className="max-w-[680px] mx-auto px-4 sm:px-6">
        <header className="mb-10">
          <p className="text-caption-1 uppercase tracking-widest text-ios-blue font-semibold mb-3">
            Our story
          </p>
          <h1 className="text-title-1 sm:text-large-title font-bold text-label-primary tracking-tight">
            How we got here
          </h1>
          <p className="mt-4 text-body text-label-secondary">
            Five minutes. No jargon. Grab a coffee.
          </p>
        </header>

        <section className="space-y-6 text-body text-label-primary leading-relaxed">
          <p>
            The project used to be called <em>ZkVanguard</em>. People kept asking if we
            were a bond fund. It sounded like your dad&rsquo;s retirement plan. So we
            renamed it to <strong>ZKward</strong>. Same idea, slightly awkward to say
            out loud. You&rsquo;ll get used to it.
          </p>

          <h2 className="text-title-2 font-semibold pt-3">What it is, in one sentence</h2>
          <p>
            A savings pool that trades for you and shows its math, so you don&rsquo;t
            have to take our word for it.
          </p>

          <h2 className="text-title-2 font-semibold pt-3">How it works, plainly</h2>
          <p>
            You put in USDC. A small crew of computer programs reads what people are
            betting on in prediction markets (like Polymarket) and lines up trades on
            crypto based on that. When it makes a trade, it also produces a little
            cryptographic receipt that anyone can check. The receipt proves the trade
            followed the rules. Without revealing your position.
          </p>
          <p>
            Think of it as an autopilot with a black box flight recorder. Except the
            recorder is public, and the autopilot won&rsquo;t take off in bad weather.
          </p>

          <h2 className="text-title-2 font-semibold pt-3">Where it started</h2>
          <p>
            A hackathon weekend. Too much coffee. One question:{' '}
            <em>if computers move real money, why does anyone trust their reasoning?</em>{' '}
            We thought we&rsquo;d answer in two days. It took eighteen months.
          </p>
          <p>
            Along the way we won five hackathons, contributed to Tether&rsquo;s wallet
            toolkit, and shipped on a handful of blockchains. Most of the test
            deployments lasted about an afternoon. <strong>SUI</strong> stuck. It&rsquo;s
            fast, cheap, and doesn&rsquo;t break when you look at it wrong. That&rsquo;s
            where the money lives now.
          </p>

          <h2 className="text-title-2 font-semibold pt-3">What we ship today</h2>
          <ul className="list-disc list-outside pl-5 space-y-2">
            <li>
              A real pool on SUI mainnet. Small on purpose. The contract itself caps
              deposits at $10,000. We wanted to prove it works before scaling. Slow is
              the point.
            </li>
            <li>
              Eight safety switches that can pause the whole thing if something looks
              off. One tripped yesterday, after a rough day of testing (more on that
              below).
            </li>
            <li>
              A learning loop: the AI grades its own trades, retrains overnight, and
              tries again. Sometimes it gets better. Sometimes it finds new ways to
              fail. We publish both.
            </li>
            <li>
              A cryptographic receipt for every trade. Not a screenshot. A proof.
            </li>
          </ul>

          <h2 className="text-title-2 font-semibold pt-3">Why we tell you when it loses</h2>
          <p>
            Most projects only talk about their wins. Right now, our test trader is
            down about $68,000 on paper. We&rsquo;re telling you because that&rsquo;s
            the whole point. If you can&rsquo;t see the losses, the wins don&rsquo;t
            mean much.
          </p>
          <p>
            Also, hiding a loss is how a small loss turns into a much larger one three
            months later. We tried that once. Do not recommend.
          </p>

          <h2 className="text-title-2 font-semibold pt-3">Who&rsquo;s making it</h2>
          <p>
            Mostly one person, working from nine time zones away from most of you.
            Computer science degree, some years at big companies, an unreasonable
            number of side quests. Funded by savings and small grants that pay out
            roughly around the time the founder starts skipping lunch.
          </p>
          <p>
            The paper trader has occasionally cost more per month than the founder
            eats. We consider this on-brand.
          </p>

          <h2 className="text-title-2 font-semibold pt-3">Where this goes next</h2>
          <p>
            Two things need to happen. First, prove the trader stops losing money in
            the test pool. Then raise the deposit cap, one careful step at a time,
            with a real drawdown test at each step. If we skip a step, please yell at
            us on{' '}
            <a
              href="https://t.me/+QoAodv90iWExZmVh"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ios-blue hover:underline"
            >
              Telegram
            </a>
            .
          </p>
        </section>

        <footer className="mt-12 pt-8 border-t border-separator-opaque/40 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between text-subheadline text-label-secondary">
          <div>
            Want the technical version?{' '}
            <Link href="/whitepaper" className="text-ios-blue hover:underline font-medium">
              Read the whitepaper
            </Link>
          </div>
          <div>
            Or just{' '}
            <Link href="/dashboard" className="text-ios-blue hover:underline font-medium">
              open the app
            </Link>
            .
          </div>
        </footer>
      </article>
    </main>
  );
}
