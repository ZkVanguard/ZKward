import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import createIntlMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/**
 * Combined Middleware: i18n + Geo-Blocking + Security Headers + CORS
 *
 * Optimized for multi-user throughput:
 * - Set-based O(1) lookups instead of Array.some() for path matching
 * - Pre-compiled blocked country set
 * - Minimal work on hot path (public/API routes skip early)
 */

// Create i18n middleware handler once (module-level singleton)
const intlMiddleware = createIntlMiddleware(routing);

// Multi-origin CORS for the rebrand transition. Both old and new domains
// accepted; drop zkvanguard.xyz entries once the domain is fully retired
// (planned ≥12 months after zkward.com cutover so external Suiscan proofs,
// grant reports, and Discord alert links keep resolving).
const ALLOWED_ORIGINS = new Set([
  'https://zkward.com',
  'https://www.zkward.com',
  'https://zkvanguard.xyz',
  'https://www.zkvanguard.xyz',
]);
const CORS_ALLOW_HEADERS = 'Content-Type, Authorization, X-Wallet-Address, X-Wallet-Signature, X-Wallet-Message';
const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

function applyCors(response: NextResponse, allow: string | null): NextResponse {
  if (allow) {
    response.headers.set('Access-Control-Allow-Origin', allow);
    // Credentials CANNOT be combined with wildcard origin per CORS spec.
    // Public read surfaces don't need credentials anyway.
    if (allow !== '*') {
      response.headers.set('Access-Control-Allow-Credentials', 'true');
    }
    response.headers.set('Vary', 'Origin');
  }
  return response;
}

/** Add security headers to all responses */
function addSecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return response;
}

// O(1) lookup for blocked countries
const BLOCKED_COUNTRIES = new Set([
  'KP', // North Korea
  'IR', // Iran
  'SY', // Syria
  'CU', // Cuba
  'RU', // Russia (due to 2022 sanctions)
  'BY', // Belarus
]);

// Paths that require geo-blocking (sensitive operations)
// Use prefix array for startsWith matching (still fast at this size)
const PROTECTED_PREFIXES = [
  '/api/swap',
  '/api/hedge',
  '/api/portfolio',
  '/api/agents/hedging/execute',
  '/api/agents/command',
  '/api/zk-proof/generate',
  '/api/settlement',
  '/dashboard',
  '/swap',
];

// Fast prefix set for public paths
const PUBLIC_PREFIXES = [
  '/api/health',
  '/api/prices',
  '/api/chat',
  '/api/agents/status',
  '/api/zk-proof/health',
  '/_next',
  '/favicon.ico',
  '/terms',
  '/privacy',
];

function isProtected(pathname: string): boolean {
  for (let i = 0; i < PROTECTED_PREFIXES.length; i++) {
    if (pathname.startsWith(PROTECTED_PREFIXES[i])) return true;
  }
  return false;
}

function isPublic(pathname: string): boolean {
  for (let i = 0; i < PUBLIC_PREFIXES.length; i++) {
    if (pathname.startsWith(PUBLIC_PREFIXES[i])) return true;
  }
  return false;
}

/**
 * Cache-Control policies for GET API routes.
 * Matched in order; first prefix match wins.
 * POST/PUT/DELETE requests never get cache headers.
 */
const API_CACHE_POLICIES: Array<{ prefix: string; value: string }> = [
  // Private / no-store (user-specific or mutation-adjacent)
  { prefix: '/api/gasless/', value: 'private, no-store' },
  { prefix: '/api/x402/', value: 'private, no-store' },
  { prefix: '/api/debug/', value: 'no-store' },
  { prefix: '/api/chat/health', value: 'public, s-maxage=10, stale-while-revalidate=20' },
  // Fast-changing operational data (15s)
  { prefix: '/api/agents/hedging/list', value: 'public, s-maxage=15, stale-while-revalidate=30' },
  { prefix: '/api/agents/hedging/onchain', value: 'public, s-maxage=15, stale-while-revalidate=30' },
  { prefix: '/api/agents/hedging/tracker', value: 'public, s-maxage=15, stale-while-revalidate=30' },
  { prefix: '/api/agents/hedging/bluefin', value: 'public, s-maxage=15, stale-while-revalidate=30' },
  { prefix: '/api/agents/hedging/pnl', value: 'public, s-maxage=30, stale-while-revalidate=60' },
  { prefix: '/api/agents/activity', value: 'public, s-maxage=15, stale-while-revalidate=30' },
  { prefix: '/api/agents/monitor', value: 'public, s-maxage=15, stale-while-revalidate=30' },
  { prefix: '/api/agents/auto-hedge', value: 'public, s-maxage=30, stale-while-revalidate=60' },
  { prefix: '/api/agents/auto-rebalance', value: 'public, s-maxage=30, stale-while-revalidate=60' },
  { prefix: '/api/portfolio/[', value: 'public, s-maxage=15, stale-while-revalidate=30' },
  { prefix: '/api/portfolio/', value: 'public, s-maxage=30, stale-while-revalidate=60' },
  { prefix: '/api/price-alerts', value: 'public, s-maxage=15, stale-while-revalidate=30' },
  // Medium-lived data (30s)
  { prefix: '/api/community-pool/', value: 'public, s-maxage=30, stale-while-revalidate=60' },
  { prefix: '/api/community-pool', value: 'public, s-maxage=30, stale-while-revalidate=60' },
  { prefix: '/api/oasis/', value: 'public, s-maxage=30, stale-while-revalidate=60' },
];

/** Get Cache-Control value for a GET API route, or null if none applies */
function getApiCachePolicy(pathname: string): string | null {
  for (let i = 0; i < API_CACHE_POLICIES.length; i++) {
    if (pathname.startsWith(API_CACHE_POLICIES[i].prefix)) {
      return API_CACHE_POLICIES[i].value;
    }
  }
  return null;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // FAST PATH: Skip i18n middleware entirely for API routes
  if (pathname.startsWith('/api')) {
    const origin = request.headers.get('origin');
    // Public GraphQL surfaces (subgraph adapter) are read-only, no session
    // cookies, no wallet-scoped writes → safe to allow any origin. Lets
    // Apollo Sandbox, GraphQL Playground, Studio, and third-party agents
    // hit them without an allowlist entry. Everything else stays strict.
    const isPublicReadSurface = pathname.startsWith('/api/subgraph/');
    const allow = isPublicReadSurface
      ? (origin || '*')
      : (origin && ALLOWED_ORIGINS.has(origin) ? origin : null);

    // CORS preflight — respond before any other work
    if (request.method === 'OPTIONS') {
      const preflightHeaders = new Headers();
      if (allow) {
        preflightHeaders.set('Access-Control-Allow-Origin', allow);
        if (allow !== '*') {
          preflightHeaders.set('Access-Control-Allow-Credentials', 'true');
        }
      }
      preflightHeaders.set('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
      // Echo requested headers for public read surfaces so Apollo Sandbox's
      // apollo-require-preflight (or any other non-standard header) is honored
      // without needing to hardcode every possible tool's header name.
      const requestedHeaders = request.headers.get('access-control-request-headers');
      preflightHeaders.set(
        'Access-Control-Allow-Headers',
        isPublicReadSurface && requestedHeaders ? requestedHeaders : CORS_ALLOW_HEADERS,
      );
      preflightHeaders.set('Vary', 'Origin');
      return new NextResponse(null, { status: 204, headers: preflightHeaders });
    }

    if (isProtected(pathname)) {
      const country = getCountryFromRequest(request);
      if (country && BLOCKED_COUNTRIES.has(country)) {
        logGeoBlock(request, country, pathname);
        // CORS applied to the 451 so the browser can actually read the error body
        return applyCors(createBlockedResponse(country, pathname), allow);
      }
    }
    const response = addSecurityHeaders(NextResponse.next());

    // Add Cache-Control headers for GET requests only
    if (request.method === 'GET') {
      const cachePolicy = getApiCachePolicy(pathname);
      if (cachePolicy) {
        response.headers.set('Cache-Control', cachePolicy);
      }
    }

    return applyCors(response, allow);
  }
  
  // Apply i18n for non-API routes
  const intlResponse = intlMiddleware(request);

  // Add security headers to all i18n responses
  if (intlResponse instanceof NextResponse) {
    addSecurityHeaders(intlResponse);
  }
  // Note: marketing-page Cache-Control was attempted here but Next 16's
  // page renderer overrides middleware headers for dynamic responses.
  // Proper fix is `export const revalidate = X` per page, which needs
  // deeper look at how generateMetadata + client 'use client' interact.
  // Deferred — origin TTFB is 27-33ms so CDN offload is low priority.
  
  // Skip geo-blocking for public paths
  if (isPublic(pathname)) {
    return intlResponse;
  }
  
  // Check if path requires protection (strip locale from pathname)
  const pathnameWithoutLocale = pathname.replace(/^\/[a-z]{2}(\/|$)/, '/');
  if (!isProtected(pathnameWithoutLocale)) {
    return intlResponse;
  }
  
  // Get country from various geo headers
  const country = getCountryFromRequest(request);
  
  // Development override for testing
  if (process.env.NODE_ENV === 'development' && process.env.GEO_OVERRIDE) {
    const testCountry = process.env.GEO_OVERRIDE;
    if (BLOCKED_COUNTRIES.has(testCountry)) {
      return createBlockedResponse(testCountry, pathname);
    }
    return intlResponse;
  }
  
  // Check if country is blocked
  if (country && BLOCKED_COUNTRIES.has(country)) {
    // Log for compliance (async, don't await)
    logGeoBlock(request, country, pathname);
    return createBlockedResponse(country, pathname);
  }
  
  // Add geo info to headers for downstream use and return intl response
  if (country && intlResponse) {
    intlResponse.headers.set('x-user-country', country);
  }
  
  return intlResponse;
}

/**
 * Extract country code from request headers
 * Supports multiple CDN providers
 */
function getCountryFromRequest(request: NextRequest): string | null {
  // Vercel Edge Network (request.geo was removed in Next 15;
  // the x-vercel-ip-country header remains the authoritative source)
  const vercelCountry = request.headers.get('x-vercel-ip-country');
  if (vercelCountry) {
    return vercelCountry;
  }
  
  // Cloudflare
  const cfCountry = request.headers.get('cf-ipcountry');
  if (cfCountry) {
    return cfCountry;
  }
  
  // AWS CloudFront
  const awsCountry = request.headers.get('cloudfront-viewer-country');
  if (awsCountry) {
    return awsCountry;
  }
  
  return null;
}

/**
 * Create standardized blocked response
 * Uses HTTP 451 (Unavailable For Legal Reasons)
 */
function createBlockedResponse(country: string, pathname: string): NextResponse {
  const isApiRoute = pathname.startsWith('/api');
  
  if (isApiRoute) {
    // JSON response for API routes
    return new NextResponse(
      JSON.stringify({
        error: 'Service unavailable in your region',
        code: 'GEO_RESTRICTED',
        message: 'This service is not available in your jurisdiction due to regulatory requirements.',
        support: 'For questions, contact compliance@zkward.com'
      }),
      {
        status: 451,
        headers: {
          'Content-Type': 'application/json',
          'X-Blocked-Reason': 'geo-restriction',
          'X-Blocked-Country': country,
        }
      }
    );
  }
  
  // HTML response for page routes
  return new NextResponse(
    `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Service Unavailable - ZK Vanguard</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #0a0a0a 0%, #1a1a2e 100%);
          color: #fff;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          padding: 20px;
        }
        .container {
          max-width: 500px;
          text-align: center;
          background: rgba(255,255,255,0.05);
          padding: 40px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.1);
        }
        h1 { color: #ef4444; margin-bottom: 16px; }
        p { color: #9ca3af; line-height: 1.6; }
        a { color: #3b82f6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .code { 
          font-family: monospace; 
          background: rgba(0,0,0,0.3);
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚫 Service Unavailable</h1>
        <p>
          We're sorry, but ZK Vanguard is not available in your region 
          due to regulatory requirements.
        </p>
        <p>
          If you believe this is an error, please contact us at 
          <a href="mailto:compliance@zkward.com">compliance@zkward.com</a>
        </p>
        <p class="code">Error Code: GEO_RESTRICTED</p>
      </div>
    </body>
    </html>
    `,
    {
      status: 451,
      headers: {
        'Content-Type': 'text/html',
        'X-Blocked-Reason': 'geo-restriction',
      }
    }
  );
}

/**
 * Log geo-blocks for compliance auditing
 * Non-blocking async operation
 */
async function logGeoBlock(
  request: NextRequest, 
  country: string, 
  pathname: string
): Promise<void> {
  try {
    // Hash IP for privacy compliance
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown';
    const hashedIP = await hashString(ip);
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      hashedIP,
      country,
      pathname,
      userAgent: request.headers.get('user-agent') || 'unknown',
    };
    
    // In production, send to compliance logging service
    if (process.env.NODE_ENV === 'production') {
      // Could send to:
      // - Analytics database
      // - Compliance audit log
      // - SIEM system
      console.info('[GEO-BLOCK]', JSON.stringify(logEntry));
    }
  } catch (error) {
    // Don't let logging errors affect the request
    console.error('[GEO-BLOCK LOG ERROR]', error);
  }
}

/**
 * Hash string for privacy-preserving logging
 */
async function hashString(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
}

// Configure which paths the middleware runs on
export const config = {
  matcher: [
    // Match all paths except static files, images, and PWA assets.
    // manifest.json and sw.js MUST pass through unchanged — the i18n middleware
    // otherwise rewrites them to /en/manifest.json / /en/sw.js and Chrome
    // fails PWA install eligibility.
    '/((?!_next/static|_next/image|favicon.ico|manifest\\.json|sw\\.js|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|json|js|woff|woff2|ttf|txt|xml)$).*)',
  ],
};
