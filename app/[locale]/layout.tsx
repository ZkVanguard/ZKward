import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata, Viewport } from 'next';
import '../../styles/globals.css';
import { Providers } from '../providers';
import { NavbarSwitch } from '../../components/NavbarSwitch';
import { Footer } from '../../components/Footer';
import { CookieConsent } from '../../components/CookieConsent';
import { PwaProvider } from '../../components/PwaProvider';
import { LegacyDomainBanner } from '../../components/LegacyDomainBanner';
import { locales } from '../../i18n/request';
import { localeDir } from '../../i18n/routing';
import { IntlProvider } from '../../components/IntlProvider';

// System-font stack for display face. Google Fonts (Space Grotesk) was
// dropped 2026-09-20 — it added a render-blocking CSS request and a
// 15-KB WOFF2 payload for one heading weight. System fonts render
// instantly, have zero network cost, and look near-identical at the
// weights we use. Kill the bytes, get the LCP back.
const displayFontClass = 'font-display';

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

// Mobile-first viewport: viewportFit 'cover' enables env(safe-area-inset-*)
// so we can pad around the iPhone home indicator and notch. themeColor
// matches the app background so the iOS status bar blends in.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
  themeColor: '#ffffff',
};

export async function generateMetadata(
  props: {
    params: Promise<{ locale: string }>;
  }
): Promise<Metadata> {
  const params = await props.params;

  const {
    locale
  } = params;

  const t = await getTranslations({ locale, namespace: 'hero' });

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com';
  // Tab title is brand-only per 2026-09-25 direction. Description meta
  // still carries the positioning copy for SERP snippets + social cards.
  const title = 'ZKward';
  const description = t('subtitle');

  return {
    metadataBase: new URL(baseUrl),
    title: {
      default: title,
      // Per-page `title.template` — child pages can set `title: 'Vault'`
      // and this composes it as "Vault · ZKward" for SERP snippets.
      template: '%s · ZKward',
    },
    description,
    // Keep the keyword list short and brand-forward. Google ignores the
    // `keywords` meta for ranking, but Bing and DuckDuckGo still weight
    // it lightly, and it costs nothing.
    keywords: [
      'ZKward', 'zkward', 'zkward.com',
      'signal intelligence', 'signal fusion', 'signal aggregator',
      'per-source calibration', 'Bayesian hit rate', 'source scoring',
      'prediction market execution', 'algorithmic trading',
      'Polymarket', 'Kalshi', 'Delphi', 'Manifold',
      'autonomous execution', 'ZK-STARK', 'SUI',
    ],
    authors: [{ name: 'ZKward', url: baseUrl }],
    creator: 'ZKward',
    publisher: 'ZKward',
    applicationName: 'ZKward',
    // Icons served by API routes (/api/icon at 512×512, /api/apple-icon
    // at 180×180). File-based app/icon.tsx collided with the [locale]
    // catch-all — every request fell through to /404. API routes bypass
    // that entirely. SVG kept as the shortcut for crisp desktop favicons.
    icons: {
      icon: [
        { url: '/api/icon', type: 'image/png', sizes: '512x512' },
        { url: '/favicon.svg', type: 'image/svg+xml' },
      ],
      shortcut: '/favicon.svg',
      apple: [{ url: '/api/apple-icon', sizes: '180x180', type: 'image/png' }],
    },
    manifest: '/manifest.json',
    appleWebApp: {
      capable: true,
      statusBarStyle: 'default',
      title: 'ZKward',
    },
    // Google Search Console + Bing Webmaster verification. Values are
    // set at deploy time via env — no secret, but they only work when
    // the domain is claimed. See docs/SEO_RUNBOOK.md.
    verification: {
      google: process.env.GOOGLE_SITE_VERIFICATION,
      other: process.env.BING_SITE_VERIFICATION
        ? { 'msvalidate.01': process.env.BING_SITE_VERIFICATION }
        : undefined,
    },
    // OG + Twitter images intentionally omitted — Next's file convention
    // at app/opengraph-image.tsx auto-populates a proper 1200x630 card.
    openGraph: {
      title,
      description,
      type: 'website',
      url: baseUrl,
      siteName: 'ZKward',
      locale,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      creator: '@HarveReg',
      site: '@HarveReg',
    },
    alternates: {
      canonical: '/',
      languages: Object.fromEntries(
        // localePrefix: 'as-needed' — default locale renders at root, others prefixed.
        (['en','es','fr','de','zh','ja','ko','pt','ru','ar','hi','it'] as const).map(
          (l) => [l, l === 'en' ? '/' : `/${l}`],
        ),
      ),
    },
  };
}

export default async function LocaleLayout(
  props: {
    children: React.ReactNode;
    params: Promise<{ locale: string }>;
  }
) {
  const params = await props.params;

  const {
    locale
  } = params;

  const {
    children
  } = props;

  // Validate locale
  if (!locales.includes(locale as typeof locales[number])) {
    notFound();
  }

  // JSON-LD structured data. Organization + WebSite. Emitted on every
  // page so Google can build a knowledge-panel + sitelinks searchbox.
  //
  // Logo is a 512×512 PNG served by app/api/icon.tsx. Google Search Console
  // requires raster (PNG/JPG/WebP) for the Organization logo. SVG is
  // accepted by some crawlers but not shown in the knowledge panel.
  //
  // `alternateName` covers legacy casings the domain has been mentioned
  // under (ZkVanguard, ZkWard). Brand-query searches for any variant
  // should route back to this Organization entity.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com';
  const ldJson = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${baseUrl}/#org`,
        name: 'ZKward',
        alternateName: ['ZkWard', 'zkward', 'ZkVanguard'],
        url: baseUrl,
        logo: {
          '@type': 'ImageObject',
          url: `${baseUrl}/api/icon`,
          contentUrl: `${baseUrl}/api/icon`,
          width: 512,
          height: 512,
          caption: 'ZKward',
        },
        sameAs: [
          'https://github.com/ZkVanguard/zkward-ethglobal',
          'https://twitter.com/HarveReg',
          'https://t.me/+QoAodv90iWExZmVh',
        ],
        founder: {
          '@type': 'Person',
          name: 'Ashish Regmi',
          email: 'ashish.regmi@zkward.com',
        },
        contactPoint: {
          '@type': 'ContactPoint',
          contactType: 'customer support',
          email: 'ashish.regmi@zkward.com',
          availableLanguage: ['en'],
        },
        email: 'ashish.regmi@zkward.com',
      },
      {
        '@type': 'WebSite',
        '@id': `${baseUrl}/#website`,
        url: baseUrl,
        name: 'ZKward',
        alternateName: 'zkward.com',
        publisher: { '@id': `${baseUrl}/#org` },
        inLanguage: locale,
        potentialAction: {
          '@type': 'SearchAction',
          target: {
            '@type': 'EntryPoint',
            urlTemplate: `${baseUrl}/?q={search_term_string}`,
          },
          'query-input': 'required name=search_term_string',
        },
      },
      {
        // Tell Google we are a software product, not a blog. Enables
        // the software knowledge-panel treatment and the "install" /
        // "open" call-to-action in some SERP layouts.
        '@type': 'SoftwareApplication',
        '@id': `${baseUrl}/#software`,
        name: 'ZKward',
        applicationCategory: 'FinanceApplication',
        applicationSubCategory: 'Cryptocurrency Vault',
        operatingSystem: 'Web, iOS, Android (PWA)',
        url: baseUrl,
        author: { '@id': `${baseUrl}/#org` },
        publisher: { '@id': `${baseUrl}/#org` },
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          description: 'Free to use. Protocol fees: 50 bps annual management + 10% performance on realised profits.',
        },
        featureList: [
          'Autonomous AI trading',
          'Zero-knowledge STARK proofs',
          'Non-custodial vault',
          'Multi-chain (SUI, Hedera)',
          'On-chain hedge attestations',
          'Post-quantum cryptography',
        ],
      },
    ],
  };

  return (
    <html lang={locale} dir={localeDir(locale)} suppressHydrationWarning>
      <head>
        {/* Resource hints for third-parties the marketing pages actually hit.
            Cronos preconnect removed — project runs on SUI mainnet, not Cronos. */}
        <link rel="preconnect" href="https://api.crypto.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://api.crypto.com" />
        
        {/* Preload critical fonts (system fonts, no external fonts needed) */}
        <style dangerouslySetInnerHTML={{ __html: `
          /* Critical inline CSS for instant render */
          * { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
          body { margin: 0; background: #fff; }
          @keyframes shimmer { 0% { background-position: -1000px 0; } 100% { background-position: 1000px 0; } }
        `}} />
        
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // Critical theme initialization (no FOUC - Flash Of Unstyled Content)
              (function() {
                const theme = localStorage.getItem('theme') || 'light';
                if (theme === 'dark') {
                  document.documentElement.classList.add('dark');
                }
              })();
            `,
          }}
        />

        {/* JSON-LD structured data for search engines.
            dangerouslySetInnerHTML is safe here: `ldJson` is a hardcoded
            object literal composed of build-time constants + `locale`,
            which is validated against the `locales` allowlist above.
            No user-controlled input reaches this string, and
            JSON.stringify escapes HTML-significant chars in string
            values. Canonical Next.js pattern for JSON-LD. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(ldJson) }}
        />
      </head>
      <body className="antialiased bg-system-bg-primary min-h-screen" suppressHydrationWarning>
        <IntlProvider locale={locale}>
          <Providers>
            <div className="flex flex-col min-h-screen">
              <LegacyDomainBanner />
              <NavbarSwitch />
              <main className="flex-1">
                {children}
              </main>
              <Footer />
              <CookieConsent />
              <PwaProvider />
            </div>
          </Providers>
        </IntlProvider>
      </body>
    </html>
  );
}
