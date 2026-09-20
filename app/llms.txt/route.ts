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

> ZKward is an autonomous crypto vault. Seven AI agents read prediction markets, size trades, and hedge on-chain. Every hedge decision closes with a zero-knowledge STARK proof anyone can verify. Live on SUI mainnet with a $10,000 contract-enforced deposit cap during the operational-proof phase. Cap-lifting is a governance action, not a code change.

## Core documents

- [Whitepaper](${base}/whitepaper): Full technical thesis. Prediction-market alpha, 7-agent architecture, STARK-attested execution, roadmap, references.
- [Our story](${base}/story): Plain-English origin story. Warm, honest, five-minute read.
- [How it works](${base}/): Homepage. Three-part loop: AI reads the room → pool rebalances → hedge lands with a proof.

## Product surfaces

- [Dashboard](${base}/dashboard): Live pool state, hedges, drawdown, cron health (per-user; requires wallet).
- [Seven-agent system](${base}/agents): Lead, Risk, Hedging, Settlement, Reporting, Price Monitor, SUI Pool. Trades above $100K need a 2-of-3 vote.
- [Zero-knowledge](${base}/zk): Post-quantum STARK prover. Goldilocks field, no trusted setup, 180-bit effective soundness, verifiable in-browser.
- [Real-world assets](${base}/rwa): Custodian-signed attestations bind portfolios to off-chain assets, private by default.
- [Simulator](${base}/simulator): Backtest the strategy against historical drawdowns.

## Key facts

- Live on SUI mainnet, package \`0x107292…7b726\`, pool state \`0xe814…fb3a\`.
- Also deployed on Hedera Testnet, Sepolia, Cronos EVM, Oasis Sapphire, Arbitrum Sepolia (reference deploys).
- Post-quantum STARK proofs: Goldilocks prime field, SHA-256 Merkle, 80 FRI queries + 20-bit grinding, no elliptic curves.
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
