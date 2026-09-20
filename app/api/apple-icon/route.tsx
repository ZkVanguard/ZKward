import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';

// 180×180 apple-touch-icon at /api/apple-icon. iOS home-screen icon.
// Solid background (no radius) — iOS applies its own rounded-square
// mask.
export const runtime = 'nodejs';

export async function GET() {
  const image = new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#5372FF',
        }}
      >
        <div
          style={{
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
            fontWeight: 900,
            fontSize: 92,
            color: '#FFFFFF',
            letterSpacing: '-0.06em',
            lineHeight: 1,
          }}
        >
          ZK
        </div>
      </div>
    ),
    { width: 180, height: 180 },
  );

  const buf = await image.arrayBuffer();
  return new NextResponse(buf, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(buf.byteLength),
    },
  });
}
