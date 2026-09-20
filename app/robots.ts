import type { MetadataRoute } from 'next';

// Next 13+ file-based convention. Emitted at /robots.txt at build time.
// Most of /api is per-user or non-indexable; disallow the tree but ALLOW
// the two icon routes because Google Search Console's knowledge-panel
// grader crawls them for the Organization schema logo.
// /dashboard and /paper are per-user surfaces. /simulator is a public
// demo and is indexable.
export default function robots(): MetadataRoute.Robots {
  const baseUrl = (process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com').replace(/\/$/, '');
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/', '/api/icon', '/api/apple-icon', '/llms.txt', '/llms-full.txt', '/rss.xml', '/.well-known/'],
        disallow: ['/api/', '/dashboard', '/paper', '/_next/'],
      },
    ],
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
