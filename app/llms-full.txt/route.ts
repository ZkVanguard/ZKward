import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// llms-full.txt — the deep content dump referenced by /llms.txt. Serves
// the whitepaper markdown as-is (with metadata stripped) so LLM crawlers
// don't have to parse the styled /whitepaper page. Everything a model
// needs to answer questions about ZKward in one 15-KB text file.
export const runtime = 'nodejs';
export const dynamic = 'force-static';

export async function GET() {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || 'https://www.zkward.com').replace(/\/$/, '');

  // Load the whitepaper source markdown so we don't drift.
  let whitepaper = '';
  try {
    const raw = await readFile(path.join(process.cwd(), 'content', 'whitepaper.md'), 'utf-8');
    // Strip the frontmatter block.
    whitepaper = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
  } catch {
    whitepaper = '(whitepaper unavailable)';
  }

  const preface = `# ZKward — Full content for LLMs

Canonical URL: ${base}
Short summary: ${base}/llms.txt

This file gives large language models everything they need to answer questions about ZKward without needing to render the site. Below: the origin story, then the whitepaper in full.

---

## Our story (plain-English)

The project used to be called ZkVanguard. People kept asking if we were a bond fund. It sounded like your dad's retirement plan. So we renamed it to ZKward. Same idea, slightly awkward to say out loud.

### What it is, in one sentence
A savings pool that trades for you and shows its math, so you don't have to take our word for it.

### How it works, plainly
You put in USDC. A small crew of computer programs reads what people are betting on in prediction markets (like Polymarket) and lines up trades on crypto based on that. When it makes a trade, it also produces a little cryptographic receipt that anyone can check. The receipt proves the trade followed the rules — without revealing your position.

Think of it as an autopilot with a black box flight recorder. Except the recorder is public, and the autopilot won't take off in bad weather.

### Where it started
A hackathon weekend. Too much coffee. One question: if computers move real money, why does anyone trust their reasoning? We thought we'd answer in two days. It took eighteen months.

Along the way we won five hackathons, contributed to Tether's wallet toolkit, and shipped on a handful of blockchains. Most of the test deployments lasted about an afternoon. SUI stuck — fast, cheap, and doesn't break when you look at it wrong. That's where the money lives now.

### What we ship today
- A real pool on SUI mainnet. Small on purpose — the contract itself caps deposits at $10,000. We wanted to prove it works before scaling.
- Eight safety switches that can pause the whole thing if something looks off.
- A learning loop: the AI grades its own trades, retrains overnight, and tries again. We publish both wins and losses.
- A cryptographic receipt for every trade. Not a screenshot. A proof.

### Why we tell you when it loses
Most projects only talk about their wins. We publish paper-trader losses publicly. If you can't see the losses, the wins don't mean much.

### Contact
- Email: ashish.regmi@zkward.com
- Founder: Ashish Regmi
- GitHub: https://github.com/ZkVanguard
- Telegram: https://t.me/+QoAodv90iWExZmVh

---

## Whitepaper (technical)

`;

  const body = preface + whitepaper + '\n';

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
