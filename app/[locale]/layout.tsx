import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import type { Metadata, Viewport } from 'next';
import { Space_Grotesk } from 'next/font/google';
import '../../styles/globals.css';
import { Providers } from '../providers';
import { NavbarSwitch } from '../../components/NavbarSwitch';
import { Footer } from '../../components/Footer';
import { CookieConsent } from '../../components/CookieConsent';
import { PwaProvider } from '../../components/PwaProvider';
import { LegacyDomainBanner } from '../../components/LegacyDomainBanner';
import { locales } from '../../i18n/request';
import { IntlProvider } from '../../components/IntlProvider';

// Display face — self-hosted (no <link> to fonts.googleapis.com), variable
// CSS var consumed by `font-display` utility in tailwind config. Applied to
// hero headlines only; body stays on SF for zero-cost native feel.
// Only weight 600 is ever paired with .font-display in the marketing
// surface (h1/h2). Dropping 500 + 700 shaves ~2/3 of the font payload on
// cold visits without any visual change. If a future headline needs bold,
// add '700' back here explicitly.
const displayFont = Space_Grotesk({
  subsets: ['latin'],
  weight: ['600'],
  variable: '--font-display',
  display: 'swap',
});

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
  const title = 'ZKward — Multi-chain autonomous vault, ZK-STARK attested';
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
    keywords: ['Hedera', 'SUI', 'DeFi', 'ZK-STARK', 'AI agents', 'autonomous vault', 'The Graph', 'x402', 'prediction markets', 'RWA', 'BlueFin'],
    authors: [{ name: 'ZKward Team' }],
    icons: {
      icon: '/logo-official.svg',
      shortcut: '/logo-official.svg',
      apple: '/logo-official.svg',
    },
    manifest: '/manifest.json',
    appleWebApp: {
      capable: true,
      statusBarStyle: 'default',
      title: 'ZKward',
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

  // JSON-LD structured data — Organization + WebSite. Emitted on every
  // page so Google can build a knowledge-panel + sitelinks searchbox.
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://zkward.com';
  const ldJson = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${baseUrl}/#org`,
        name: 'ZKward',
        url: baseUrl,
        logo: `${baseUrl}/logo-official.svg`,
        sameAs: [
          'https://github.com/ZkVanguard/zkward-ethglobal',
          'https://twitter.com/HarveReg',
        ],
      },
      {
        '@type': 'WebSite',
        '@id': `${baseUrl}/#website`,
        url: baseUrl,
        name: 'ZKward',
        publisher: { '@id': `${baseUrl}/#org` },
        inLanguage: locale,
      },
    ],
  };

  return (
    <html lang={locale} className={displayFont.variable} suppressHydrationWarning>
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
