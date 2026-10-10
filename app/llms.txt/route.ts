import { NextResponse } from 'next/server';

// llms.txt — emerging standard (Answer.AI, September 2024) for LLM
// crawlers to find the canonical, high-signal content of a site. Format
// mirrors CommonMark. ChatGPT, Perplexity, and Claude web-browse tools
// all check this file when they visit a domain.
//
// Kept short. The full dump lives at /llms-full.txt.
export const runtime = 'nodejs';
export const dynamic = 'force-static';

export async function GET() {
  const base = (process.env.NEXT_PUBLIC_BASE_URL || 'https://www.zkward.com').replace(/\/$/, '');
  const body = `# ZKward

> ZKward is an autonomous crypto vault. Six AI agents read prediction markets, size trades, and hedge on-chain. Signal quality is measured in public and the vault accounting is on-chain. Live on SUI mainnet with a $10,000 contract-enforced deposit cap during the operational-proof phase. Cap-lifting is a governance action, not a code change.

## Core documents

- [Whitepaper](${base}/whitepaper): Full technical thesis. Signals measured in public, 6-agent architecture, what the proof system is and is not, roadmap, references.
- [Our story](${base}/story): Plain-English origin story. Warm, honest, five-minute read.
- [How it works](${base}/): Homepage. Three-part loop: AI reads the room → pool rebalances → hedge lands on-chain.

## Product surfaces

- [Dashboard](${base}/dashboard): Live pool state, hedges, drawdown, cron health (per-user; requires wallet).
- [Six-agent system](${base}/agents): Lead, Risk, Hedging, Reporting, Price Monitor, SUI Pool. Trades above $100K need a 2-of-3 vote.
- [Zero-knowledge](${base}/zk): What the proof system is and is not today (forwards to the whitepaper's "Proofs" section).
- [Real-world assets](${base}/rwa): Custodian-signed attestations bind portfolios to off-chain assets, private by default.
- [Simulator](${base}/simulator): Backtest the strategy against historical drawdowns.

## Key facts

- Live on SUI mainnet, package \`0x107292…7b726\`, pool state \`0xe814…fb3a\`.
- Also deployed on Hedera Testnet (vault) and Solana devnet (token pool).
- Proofs: a transparent ZK-STARK (Goldilocks field, SHA-256 Merkle commitments, FRI, no trusted setup) exists off chain. It has no outside review, no hedge carries a proof, and nothing is verified on-chain.
- Eight-gate autonomy defense system with contract-enforced kill switches.
- Fees: 50 bps annual management + 10% performance, routed through MSafe-held FeeManagerCap.
- Non-custodial: user keys, on-chain custody, permissionless withdraw anytime.

## Contact

- Email: ashish.regmi@zkward.com
- Founder: Ashish Regmi
- GitHub: https://github.com/ZkVanguard
- Telegram: https://t.me/+QoAodv90iWExZmVh
- Twitter: https://twitter.com/HarveReg
`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=86400',
    },
  });
}
