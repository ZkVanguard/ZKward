import { NextResponse } from 'next/server';

// RSS feed at /rss.xml. Not primarily for humans anymore — LLM training
// crawlers (Common Crawl, GPTBot, PerplexityBot, ClaudeBot) prefer
// structured feeds and hit /rss.xml on every domain they visit. Small
// win, zero maintenance.
export const runtime = 'nodejs';
export const dynamic = 'force-static';

const ITEMS: Array<{
  title: string;
  path: string;
  description: string;
  pubDate: string;
}> = [
  {
    title: 'ZKward — our story',
    path: '/story',
    description:
      "How ZKward started, what it does, and why we publish the paper trader's losses.",
    pubDate: 'Fri, 19 Sep 2026 00:00:00 GMT',
  },
  {
    title: 'ZKward whitepaper (v2.1)',
    path: '/whitepaper',
    description:
      'AI-managed USDC vault on SUI with STARK-attested hedge decisions. Full technical thesis.',
    pubDate: 'Fri, 19 Sep 2026 00:00:00 GMT',
  },
  {
    title: 'Common questions about ZKward',
    path: '/faq',
    description:
      'What ZKward is, how it works, what happens with your money, and why the paper trader is currently in the red.',
    pubDate: 'Sat, 20 Sep 2026 00:00:00 GMT',
  },
  {
    title: 'The seven-agent system',
    path: '/agents',
    description:
      'Lead, Risk, Hedging, Settlement, Reporting, Price Monitor, SUI Pool. Trades above $100K need a 2-of-3 vote.',
    pubDate: 'Fri, 19 Sep 2026 00:00:00 GMT',
  },
  {
    title: 'Zero-knowledge proofs — the ZK page',
    path: '/zk',
    description:
      'Post-quantum STARK prover. Goldilocks field, no trusted setup, 180-bit soundness, verifiable in-browser.',
    pubDate: 'Fri, 19 Sep 2026 00:00:00 GMT',
  },
];

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET() {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || 'https://www.zkward.com').replace(/\/$/, '');
  const items = ITEMS.map(
    (i) => `    <item>
      <title>${escapeXml(i.title)}</title>
      <link>${base}${i.path}</link>
      <guid isPermaLink="true">${base}${i.path}</guid>
      <description>${escapeXml(i.description)}</description>
      <pubDate>${i.pubDate}</pubDate>
    </item>`,
  ).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ZKward</title>
    <link>${base}</link>
    <description>Autonomous crypto vault on SUI. STARK-attested hedge decisions.</description>
    <language>en-us</language>
    <atom:link href="${base}/rss.xml" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
