import type { Metadata } from 'next';
import { locales, defaultLocale } from '@/i18n/routing';

export async function generateMetadata(
  { params }: { params: Promise<{ locale: string }> },
): Promise<Metadata> {
  const { locale } = await params;
  const path = '/agents';
  const canonical = locale === defaultLocale ? path : `/${locale}${path}`;
  return {
    title: 'AI agents',
    description: 'Seven specialised AI agents run the ZKward vault: Lead, Risk, Hedging, Settlement, Reporting, PriceMonitor, SuiPool. 2-of-3 consensus on trades over $100k.',
    alternates: {
      canonical,
      languages: Object.fromEntries(
        locales.map((l) => [l, l === defaultLocale ? path : `/${l}${path}`]),
      ),
    },
    // openGraph + twitter intentionally omitted. Next metadata REPLACES
    // (not merges) these objects when a child sets them, which would
    // wipe the parent's auto-generated OG image from
    // [locale]/opengraph-image.tsx. Composed page title falls out of
    // title.template in the parent layout: 'AI agents · ZKward'.
  };
}

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
