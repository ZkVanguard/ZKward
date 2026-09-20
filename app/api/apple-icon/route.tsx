import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// 180x180 apple-touch-icon at /api/apple-icon. iOS home-screen icon.
// Same brand logo as /api/icon, sized for iOS. Solid white background
// because iOS applies its own rounded-square mask on the home screen.
export const runtime = 'nodejs';

let cachedSvgDataUri: string | null = null;

async function loadLogoDataUri(): Promise<string> {
  if (cachedSvgDataUri) return cachedSvgDataUri;
  const svg = await readFile(path.join(process.cwd(), 'public', 'logo-official.svg'), 'utf-8');
  cachedSvgDataUri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  return cachedSvgDataUri;
}

export async function GET() {
  const logoDataUri = await loadLogoDataUri();

  const image = new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#FFFFFF',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoDataUri}
          alt="ZKward"
          width={150}
          height={150}
          style={{ objectFit: 'contain' }}
        />
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
