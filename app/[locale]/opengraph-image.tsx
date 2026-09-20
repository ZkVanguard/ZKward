import { ImageResponse } from 'next/og';

// Route segment config. next/og defaults to Edge Runtime, but the 1 MB
// Edge Function size cap is exceeded (1.08 MB) once Privy + wagmi ship
// in the client bundle that route tracing tries to pull. Force Node.js
// runtime — no size cap, and OG images cache aggressively so first-hit
// latency is amortised.
export const runtime = 'nodejs';
export const alt = 'ZKward — Autonomous SUI vault, ZK-STARK attested';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

// Root-level OG image, applies to every marketing route via metadata
// cascade unless a specific route provides its own opengraph-image.tsx.
// Deliberately minimal to match the awesomedesign.md rules: one accent
// blue, no gradient headline, quiet typographic layout.
export default async function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          backgroundColor: '#FFFFFF',
          backgroundImage:
            'radial-gradient(ellipse at 80% 20%, rgba(0,105,217,0.14) 0%, rgba(0,105,217,0) 45%),' +
            'radial-gradient(ellipse at 15% 90%, rgba(0,105,217,0.09) 0%, rgba(0,105,217,0) 40%)',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        {/* Top: brand-accent bar + live pill */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div style={{ width: 14, height: 14, borderRadius: 999, background: '#34C759' }} />
            <div style={{ fontSize: 24, fontWeight: 600, color: '#424245', letterSpacing: '-0.01em' }}>
              Live on SUI Mainnet
            </div>
          </div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#1D1D1F', letterSpacing: '-0.02em' }}>
            ZKward
          </div>
        </div>

        {/* Middle: headline */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              letterSpacing: '-0.04em',
              lineHeight: 0.98,
              color: '#1D1D1F',
              maxWidth: 980,
            }}
          >
            Autonomous SUI vault.
          </div>
          <div
            style={{
              fontSize: 84,
              fontWeight: 700,
              letterSpacing: '-0.04em',
              lineHeight: 0.98,
              color: '#0069D9',
              maxWidth: 980,
            }}
          >
            ZK-STARK attested.
          </div>
          <div
            style={{
              fontSize: 32,
              fontWeight: 400,
              color: '#424245',
              maxWidth: 900,
              marginTop: 8,
              letterSpacing: '-0.01em',
            }}
          >
            Seven AI agents. BTC, ETH, SUI. Auto-hedged perps on BlueFin. Verified end-to-end.
          </div>
        </div>

        {/* Bottom: url */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 24, color: '#6E6E73', fontWeight: 500 }}>zkward.com</div>
          <div style={{ display: 'flex', gap: 12 }}>
            {/* Asset chips: BTC / ETH / SUI / USDC */}
            {[
              { l: 'BTC', c: '#F7931A' },
              { l: 'ETH', c: '#627EEA' },
              { l: 'SUI', c: '#4DA2FF' },
              { l: 'USDC', c: '#2775CA' },
            ].map((a) => (
              <div
                key={a.l}
                style={{
                  padding: '8px 16px',
                  borderRadius: 999,
                  background: a.c,
                  color: '#fff',
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: '-0.01em',
                }}
              >
                {a.l}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
