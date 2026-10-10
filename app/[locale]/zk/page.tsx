import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { locales, defaultLocale } from '@/i18n/routing';
import { ProofDemo } from '@/components/zk/ProofDemo';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'zkDemo' });
  const route = '/zk';
  const canonical = locale === defaultLocale ? route : `/${locale}${route}`;
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: {
      canonical,
      languages: Object.fromEntries(locales.map((l) => [l, l === defaultLocale ? route : `/${l}${route}`])),
    },
  };
}

/**
 * The proof system, live: make a hedge policy proof and check it. The limits
 * of what exists are stated on the page itself, and the whitepaper's "Proofs"
 * section stays the full account.
 */
export default async function ZkPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'zkDemo' });
  return (
    <main className="min-h-screen bg-system-bg-primary pt-24 pb-24">
      <article className="max-w-[680px] mx-auto px-4 sm:px-6">
        <header className="mb-8">
          <h1 className="text-title-1 sm:text-large-title font-bold text-label-primary tracking-tight">{t('title')}</h1>
          <p className="mt-4 text-body text-label-secondary">{t('lead')}</p>
        </header>

        <ProofDemo />

        <section className="mt-10 space-y-3 text-body text-label-primary leading-relaxed">
          <h2 className="text-title-2 font-semibold">{t('statusHeading')}</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>{t('statusDesign')}</li>
            <li>{t('statusReview')}</li>
            <li>{t('statusHedges')}</li>
            <li>{t('statusChain')}</li>
          </ul>
          <p>
            <Link href="/whitepaper" className="text-ios-blue hover:underline font-medium">{t('readMore')}</Link>
          </p>
        </section>
      </article>
    </main>
  );
}
