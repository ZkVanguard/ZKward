import { ImageResponse } from 'next/og';
import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Real brand logo served at /api/icon at 512x512 PNG. Google Search
// Console reads this from the Organization JSON-LD, so it must match
// the logo people see in the Navbar. Prior version rendered plain "ZK"
// text and confused the knowledge-panel indexer.
//
// Loads public/logo-official.svg at request time, base64-encodes it,
// and embeds as an <img> inside the ImageResponse tree. Next-og
// rasterizes the whole thing to PNG on the fly. Cached for a year
// downstream because the content is a build-time constant.
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
          borderRadius: 96,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoDataUri}
          alt="ZKward"
          width={420}
          height={420}
          style={{ objectFit: 'contain' }}
        />
      </div>
    ),
    { width: 512, height: 512 },
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
