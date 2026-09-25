const createNextIntlPlugin = require('next-intl/plugin');

const withNextIntl = createNextIntlPlugin();

// --- Build-time env sanitization ---------------------------------------------
// Strip trailing CRLF, stray whitespace, and matched surrounding quotes from
// every env var. This protects build-time-inlined `NEXT_PUBLIC_*` constants
// from upstream upload corruption (e.g. PowerShell pipe CRLF). The
// `instrumentation.ts` hook handles runtime; this handles build.
{
  let sanitized = 0;
  for (const k of Object.keys(process.env)) {
    const raw = process.env[k];
    if (raw === undefined) continue;
    let v = raw.replace(/[\r\n\t\u00A0]+/g, '');
    if (v.length >= 2) {
      const f = v.charCodeAt(0);
      const l = v.charCodeAt(v.length - 1);
      if ((f === 34 || f === 39) && f === l) v = v.slice(1, -1);
    }
    v = v.replace(/^[\x20]+|[\x20]+$/g, '');
    if (v !== raw) {
      process.env[k] = v;
      sanitized++;
    }
  }
  if (sanitized > 0) {
    // eslint-disable-next-line no-console
    console.log(`[next.config] Sanitized ${sanitized} env var(s) at build start`);
  }
}
// -----------------------------------------------------------------------------

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Standalone output — smaller deployment, faster cold starts
  output: 'standalone',

  // Performance optimizations
  experimental: {
    optimizePackageImports: [
      'viem', 'lucide-react', '@heroicons/react', 'framer-motion',
      'chart.js', 'react-chartjs-2', '@mysten/dapp-kit', '@mysten/sui',
      'ethers', 'eventemitter3', 'uuid',
      '@tanstack/react-query', 'react-markdown', 'remark-gfm',
    ],
    // optimizeCss removed: it's webpack-only + requires the `critters`
    // dependency (not installed). Next 16 defaults to Turbopack for
    // `next build`, so the flag was a no-op. Turbopack uses lightningcss.
  },

  // Reduce serverless function size (moved from experimental in Next 15)
  outputFileTracingExcludes: {
    '*': [
      'node_modules/@swc/core-linux-x64-gnu',
      'node_modules/@swc/core-linux-x64-musl',
      'node_modules/@esbuild',
      'node_modules/sharp',
    ],
  },

  // Compiler optimizations
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },

  // Turbopack config (v16 default). Only silences Node-native modules that
  // sneak into client bundles via transitive web3 deps; refactor imports if
  // you can, this is a fallback per Next 16 upgrade guide.
  // ponytail: minimal turbopack config, add resolveAlias entries only when
  //   a runtime "Can't resolve X for browser" surfaces.
  turbopack: {},

  // Webpack: stub connectors we don't use whose transitive deps fail to
  // resolve. `wagmi/connectors` barrel pulls in `baseAccount` →
  // `@base-org/account` → `@coinbase/cdp-sdk` → `@x402/*` (unshipped
  // sub-paths). We only use `injected`, so false-alias the whole subtree
  // and let webpack treat them as empty modules.
  webpack: (config, { webpack }) => {
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@base-org/account': false,
      '@coinbase/cdp-sdk': false,
    };

    // Optional peer deps we don't need — MetaMask SDK's React Native
    // storage adapter, Privy's Farcaster mini-app-solana bridge. Actively
    // ignore instead of just warning so build output is clean.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^@react-native-async-storage\/async-storage$/,
      }),
      new webpack.IgnorePlugin({
        resourceRegExp: /^@farcaster\/mini-app-solana$/,
      }),
    );

    // Silence noisy "Critical dependency: request of a dependency is an
    // expression" from viem's ox/tempo dynamic import — the dynamic import
    // is intentional (viem loads chain configs on demand) and works fine.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      { module: /node_modules[\\/].*ox[\\/]_esm[\\/]tempo/, message: /Critical dependency/ },
    ];

    return config;
  },

  // env: {} block removed — all vars listed were NEXT_PUBLIC_*, which
  // Next.js auto-inlines at build time. The block was doubling that work.
  // API keys stay server-only via process.env on server routes; never
  // expose CRYPTOCOM_DEVELOPER_API_KEY or any secret to the browser.

  // Production optimizations
  compress: true,
  poweredByHeader: false,

  // Image optimization
  images: {
    // Next 16: images.domains deprecated in favor of remotePatterns
    remotePatterns: [
      { protocol: 'http', hostname: 'localhost' },
    ],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 86400, // 24h image caching
    deviceSizes: [640, 750, 828, 1080, 1200], // Fewer sizes = fewer variants to cache
  },
  
  // Security + caching headers
  async headers() {
    return [
      // _next/static Cache-Control removed 2026-09-25 — Vercel + Next.js
      // set 'public, max-age=31536000, immutable' by default for hashed
      // build assets. Overriding it triggered the "Custom Cache-Control
      // headers detected" warning without changing behavior.
      {
        // Generated icons served from ImageResponse — content is a
        // build-time constant, safe to cache aggressively at the edge.
        source: '/api/(icon|apple-icon)',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
      {
        // Public static images + PDF. Individual rules — Next's route
        // matcher uses path-to-regexp v6 which doesn't accept multi-
        // extension groups like /:path(.*\.(svg|png|...)). One header
        // block per extension keeps the config valid and readable.
        source: '/:path*.svg',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000, s-maxage=31536000' }],
      },
      {
        source: '/:path*.png',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000, s-maxage=31536000' }],
      },
      {
        source: '/:path*.jpg',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000, s-maxage=31536000' }],
      },
      {
        source: '/:path*.webp',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000, s-maxage=31536000' }],
      },
      {
        source: '/:path*.pdf',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=2592000, s-maxage=31536000' }],
      },
      {
        source: '/:path*.woff2',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        // llms.txt / rss.xml / sitemap regenerate cheaply — 1h browser,
        // 1d CDN.
        source: '/llms.txt',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, s-maxage=86400' }],
      },
      {
        source: '/llms-full.txt',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, s-maxage=86400' }],
      },
      {
        source: '/rss.xml',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, s-maxage=86400' }],
      },
      {
        source: '/sitemap.xml',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, s-maxage=86400' }],
      },
      {
        source: '/robots.txt',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=3600, s-maxage=86400' }],
      },
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-DNS-Prefetch-Control',
            value: 'on',
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'X-Frame-Options',
            value: 'SAMEORIGIN',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-XSS-Protection',
            value: '1; mode=block',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Privy's iframe SDK + WalletConnect + MoonPay all inject
              // scripts from their own CDNs.
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://auth.privy.io https://*.privy.io https://*.walletconnect.com https://*.walletconnect.org https://*.moonpay.com https://buy-sandbox.moonpay.com https://buy.moonpay.com",
              "style-src 'self' 'unsafe-inline' https://*.privy.io https://*.moonpay.com",
              "img-src 'self' data: blob: https:",
              "font-src 'self' data: https://*.privy.io",
              "connect-src 'self' https: wss:",
              // frame-src explicit: Privy Auth iframe, MoonPay checkout,
              // WalletConnect verify. Without this, Privy sign-in blows up
              // with "Framing violates default-src".
              "frame-src 'self' https://auth.privy.io https://*.privy.io https://*.walletconnect.com https://*.walletconnect.org https://*.moonpay.com https://buy-sandbox.moonpay.com https://buy.moonpay.com https://verify.walletconnect.com https://verify.walletconnect.org",
              "worker-src 'self' blob:",
              "frame-ancestors 'self'",
              "base-uri 'self'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

module.exports = withNextIntl(nextConfig);
