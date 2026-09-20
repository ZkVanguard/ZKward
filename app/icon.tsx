import { ImageResponse } from 'next/og';

// File-based icon convention. Next serves this at `/icon` with
// Content-Type: image/png and auto-injects <link rel="icon" ...> into
// every <head>. 512×512 satisfies Google Search Console's Organization
// schema `logo` guidance (≥112×112, ideally 512×512) and the PWA
// manifest's "any" icon slot.
export const runtime = 'nodejs';
export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#5372FF',
          borderRadius: 88,
        }}
      >
        <div
          style={{
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            fontWeight: 900,
            fontSize: 260,
            color: '#FFFFFF',
            letterSpacing: '-0.06em',
            lineHeight: 1,
          }}
        >
          ZK
        </div>
      </div>
    ),
    { ...size },
  );
}
