import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'faq.meta' });
  const route = '/faq';
  const canonical = locale === defaultLocale ? route : `/${locale}${route}`;
  return {
    title: t('title'),
    description: t('description'),
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? route : `/${l}${route}`]),
      ),
    },
  };
}

// Ordered list of question keys — translations live under `faq.q1..q12` in
// each locale file, with the same q/a shape. Order matters for the JSON-LD
// FAQPage schema below (LLMs quote from this exact shape; Google shows the
// first 3–4 as rich results in SERP).
const QUESTION_KEYS = [
  'q1', 'q2', 'q3', 'q4', 'q5', 'q6',
  'q7', 'q8', 'q9', 'q10', 'q11', 'q12',
] as const;

export default async function FaqPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'faq' });
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://www.zkward.com';
  const faqs = QUESTION_KEYS.map((k) => ({ q: t(`${k}.q`), a: t(`${k}.a`) }));
  const faqLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
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
          composed of translated strings + baseUrl (env-derived) — no
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
            {t('header.eyebrow')}
          </p>
          <h1 className="text-title-1 sm:text-large-title font-bold text-label-primary tracking-tight">
            {t('header.title')}
          </h1>
          <p className="mt-4 text-body text-label-secondary">
            {t.rich('header.subtitle', {
              email: () => (
                <a href="mailto:ashish.regmi@zkward.com" className="text-ios-blue hover:underline">
                  ashish.regmi@zkward.com
                </a>
              ),
            })}
          </p>
        </header>

        <section className="space-y-8">
          {faqs.map((f, i) => (
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
            {t.rich('footer.technical', {
              link: () => (
                <Link href="/whitepaper" className="text-ios-blue hover:underline font-medium">
                  {t('footer.readWhitepaper')}
                </Link>
              ),
            })}
          </div>
          <div>
            {t.rich('footer.orRead', {
              link: () => (
                <Link href="/story" className="text-ios-blue hover:underline font-medium">
                  {t('footer.ourStory')}
                </Link>
              ),
            })}
          </div>
        </footer>
      </article>
    </main>
  );
}
