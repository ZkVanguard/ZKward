import { NextResponse, type NextRequest } from 'next/server';

// IndexNow endpoint — ping Bing, Yandex, Seznam, Naver et al. to instantly
// re-index a URL. Free, open protocol (indexnow.org). Bing + Yandex share
// submissions so one call reaches all participating engines.
//
// Auth model: the URL is bearer-authorized by an on-site key file we host
// at /$INDEXNOW_KEY.txt. If the search engine can fetch that file and
// see the same key in the POST body, we own the domain.
//
// Usage:
//   POST /api/indexnow?url=https://www.zkward.com/story
//   Requires header  X-Refresh-Secret: $CRON_SECRET
export const runtime = 'nodejs';

const INDEXNOW_KEY = process.env.INDEXNOW_KEY?.trim() || '1e2ad26466c624c38bd211d1f2cb8314';
const BASE = (process.env.NEXT_PUBLIC_BASE_URL || 'https://www.zkward.com').replace(/\/$/, '');
const HOST = new URL(BASE).host;

export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  const provided = request.headers.get('x-refresh-secret')?.trim();
  if (!secret || provided !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = request.nextUrl.searchParams.get('url');
  if (!url) {
    return NextResponse.json({ error: 'missing url query param' }, { status: 400 });
  }
  const target = new URL(url);
  if (target.host !== HOST) {
    return NextResponse.json({ error: `url must be on ${HOST}` }, { status: 400 });
  }

  const body = {
    host: HOST,
    key: INDEXNOW_KEY,
    keyLocation: `${BASE}/${INDEXNOW_KEY}.txt`,
    urlList: [target.toString()],
  };

  const results: Record<string, number> = {};
  for (const endpoint of [
    'https://api.indexnow.org/indexnow',
    'https://www.bing.com/indexnow',
    'https://yandex.com/indexnow',
  ]) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      results[endpoint] = res.status;
    } catch {
      results[endpoint] = 599;
    }
  }

  return NextResponse.json({ submitted: url, endpoints: results });
}
