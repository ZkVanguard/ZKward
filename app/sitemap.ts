import type { MetadataRoute } from 'next';
import { locales, defaultLocale } from '@/i18n/routing';

// Marketing routes emitted to /sitemap.xml. Per-user surfaces (/dashboard,
// /paper) and API routes are excluded — they're per-session or dynamic
// and adding them dilutes the crawl budget.
//
// Each entry declares its 12 language alternates so Google reads them as
// hreflang siblings, not duplicate content.
const MARKETING_ROUTES: Array<{ path: string; priority: number; changeFrequency: 'daily' | 'weekly' | 'monthly' }> = [
  { path: '', priority: 1.0, changeFrequency: 'daily' },
  { path: '/agents', priority: 0.9, changeFrequency: 'weekly' },
  { path: '/zk', priority: 0.9, changeFrequency: 'weekly' },
  { path: '/rwa', priority: 0.8, changeFrequency: 'weekly' },
  { path: '/whitepaper', priority: 0.9, changeFrequency: 'monthly' },
  { path: '/story', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/faq', priority: 0.8, changeFrequency: 'monthly' },
  { path: '/simulator', priority: 0.7, changeFrequency: 'monthly' },
  { path: '/privacy', priority: 0.3, changeFrequency: 'monthly' },
  { path: '/terms', priority: 0.3, changeFrequency: 'monthly' },
];

function urlFor(base: string, locale: string, route: string): string {
  const prefix = locale === defaultLocale ? '' : `/${locale}`;
  return `${base}${prefix}${route}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com').replace(/\/$/, '');
  const now = new Date();

  return MARKETING_ROUTES.map(({ path, priority, changeFrequency }) => ({
    url: urlFor(base, defaultLocale, path),
    lastModified: now,
    changeFrequency,
    priority,
    alternates: {
      languages: Object.fromEntries(
        locales.map((l) => [l, urlFor(base, l, path)]),
      ),
    },
  }));
}
