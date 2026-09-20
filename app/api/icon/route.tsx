import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';

// Static PNG icon served at /api/icon. Next 16's file-based icon
// convention (app/icon.tsx) collides with the [locale] catch-all in
// this project — every request to /icon fell through to /404. An API
// route sidesteps the file convention entirely and is guaranteed to
// resolve independently of the routing tree.
//
// 512×512 satisfies Google Search Console's Organization-schema logo
// guidance (>=112x112, ideally >=512x512).
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
    { width: 512, height: 512 },
  );

  // Long cache — content is a build-time constant.
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
