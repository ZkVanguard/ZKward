import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'story.meta' });
  const route = '/story';
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

export default async function StoryPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'story' });
  const tMeta = await getTranslations({ locale, namespace: 'story.meta' });
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com';
  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'AboutPage',
    // JSON-LD name stays in the request locale so search engines index the
    // localised page correctly.
    name: tMeta('title'),
    url: `${baseUrl}/story`,
    inLanguage: locale,
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
            {t('header.eyebrow')}
          </p>
          <h1 className="text-title-1 sm:text-large-title font-bold text-label-primary tracking-tight">
            {t('header.title')}
          </h1>
          <p className="mt-4 text-body text-label-secondary">
            {t('header.subtitle')}
          </p>
        </header>

        <section className="space-y-6 text-body text-label-primary leading-relaxed">
          <p>
            {t.rich('intro', {
              em: (chunks) => <em>{chunks}</em>,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>

          <h2 className="text-title-2 font-semibold pt-3">{t('whatItIs.heading')}</h2>
          <p>{t('whatItIs.body')}</p>

          <h2 className="text-title-2 font-semibold pt-3">{t('howItWorks.heading')}</h2>
          <p>{t('howItWorks.body1')}</p>
          <p>{t('howItWorks.body2')}</p>

          <h2 className="text-title-2 font-semibold pt-3">{t('whereStarted.heading')}</h2>
          <p>
            {t.rich('whereStarted.body1', {
              em: (chunks) => <em>{chunks}</em>,
            })}
          </p>
          <p>
            {t.rich('whereStarted.body2', {
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </p>

          <h2 className="text-title-2 font-semibold pt-3">{t('shipToday.heading')}</h2>
          <ul className="list-disc list-outside pl-5 space-y-2">
            <li>{t('shipToday.item1')}</li>
            <li>{t('shipToday.item2')}</li>
            <li>{t('shipToday.item3')}</li>
            <li>{t('shipToday.item4')}</li>
          </ul>

          <h2 className="text-title-2 font-semibold pt-3">{t('whyWeTell.heading')}</h2>
          <p>{t('whyWeTell.body1')}</p>
          <p>{t('whyWeTell.body2')}</p>

          <h2 className="text-title-2 font-semibold pt-3">{t('whoBuilds.heading')}</h2>
          <p>{t('whoBuilds.body1')}</p>
          <p>{t('whoBuilds.body2')}</p>

          <h2 className="text-title-2 font-semibold pt-3">{t('next.heading')}</h2>
          <p>
            {t.rich('next.body', {
              telegram: (chunks) => (
                <a
                  href="https://t.me/+QoAodv90iWExZmVh"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-ios-blue hover:underline"
                >
                  {chunks}
                </a>
              ),
            })}
          </p>
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
            {t.rich('footer.orJust', {
              link: () => (
                <Link href="/dashboard" className="text-ios-blue hover:underline font-medium">
                  {t('footer.openApp')}
                </Link>
              ),
            })}
          </div>
        </footer>
      </article>
    </main>
  );
}
