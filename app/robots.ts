import type { MetadataRoute } from 'next';

// Next 13+ file-based convention. Emitted at /robots.txt at build time.
// /api, /dashboard, and /paper are per-user or non-indexable; disallowing
// them keeps crawl budget on the marketing surface. /simulator is a
// public demo and is indexable.
export default function robots(): MetadataRoute.Robots {
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com').replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/dashboard', '/paper', '/_next/'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
