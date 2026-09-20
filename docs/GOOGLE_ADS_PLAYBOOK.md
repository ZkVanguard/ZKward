# Google Ads playbook — ZKward

Copy-paste this into a fresh Google Ads campaign to defend the brand while organic ranking catches up.

## Setup

1. https://ads.google.com/ → sign in with the same Google account that owns Search Console.
2. **New Campaign** → **Search** → **Website traffic**.
3. Budget: **$3/day** to start. Roughly $90/month. Brand searches are cheap — most clicks will be $0.10–$0.50.
4. Bidding: **Maximize clicks** (auto-bid, easiest). Switch to **Manual CPC** with $0.50 max later if traffic surges.
5. Networks: **Search Network only**. Turn OFF Display and Search Partners for brand campaigns.
6. Location: **All countries and territories**. Brand queries have global intent.
7. Language: **All languages** (the site is 12-locale).

## Ad group 1 — Brand defence (exact match)

**Keywords** (one per line, wrap in brackets for exact match):

```
[zkward]
[zk ward]
[zkward vault]
[zkward crypto]
[zkward ai]
[zkward.com]
[ZKward whitepaper]
[ZKward story]
[ZKward FAQ]
```

**Ad — Headline set** (Google rotates the best combination):

- Headline 1: `ZKward — Autonomous crypto vault`
- Headline 2: `Verifiable AI. Real proofs.`
- Headline 3: `Live on SUI mainnet`
- Headline 4: `Deposit USDC. Watch the AI trade.`
- Headline 5: `Zero-knowledge attested`

**Descriptions:**

- Description 1: `An autonomous crypto vault. Seven AI agents trade on your behalf. Every hedge closes with a STARK proof anyone can verify. Small pool on purpose.`
- Description 2: `Non-custodial. On-chain. Withdraw anytime. Post-quantum STARK proofs bind every trade to on-chain invariants. See it running at zkward.com.`

**Final URL:** `https://www.zkward.com/`

**Display path:** `zkward.com` / `story`

**Sitelinks:**

- `Read our story` → `https://www.zkward.com/story` — Description 1: `Warm, five-minute origin story.` Description 2: `How we started and why we publish losses.`
- `Whitepaper` → `https://www.zkward.com/whitepaper` — `Full technical thesis` / `Prediction alpha, agents, STARK proofs`
- `FAQ` → `https://www.zkward.com/faq` — `Common questions` / `What ZKward is, how it works, what happens with your money`
- `The seven agents` → `https://www.zkward.com/agents` — `Meet the specialists` / `2-of-3 consensus on trades over $100K`

**Callouts:** `Live on SUI Mainnet` · `Non-custodial` · `Verifiable AI` · `Post-quantum` · `$10K contract-enforced cap` · `Zero-knowledge STARK proofs`

## Ad group 2 — Category (broad match with negative words)

Only enable this after ad group 1 has been running clean for a week — broad match burns money if the negatives aren't right.

**Keywords** (no brackets, broad match):

```
autonomous crypto vault
verifiable AI trading
zero knowledge crypto vault
zk-stark defi
AI managed crypto portfolio
prediction market alpha trading
polymarket alpha strategy
sui defi vault
```

**Negative keywords** (add to the campaign, not the ad group — prevents wasted spend):

```
free
job
salary
career
resume
tutorial
course
udemy
scholarship
wallpaper
```

**Same ads** as ad group 1.

## What to expect

- **First 24 hours:** clicks arrive, cost per click stabilizes. Brand terms usually $0.05–$0.30. Category terms $1–$3.
- **First week:** you learn which keywords produce actual pool deposits. Prune the losers.
- **Two weeks:** organic ranking catches up. You can lower the ad budget or turn off ad group 1 (brand defence) because you'll rank #1 organically anyway.
- **Two months:** ad group 2 (category) is worth its cost only if the CAC (customer acquisition cost) is below your fee revenue per user. Math this out in month 2.

## Conversion tracking

Once the account is live, share the **Google Ads conversion ID** here and I'll wire the tag into the site so you can see which ad clicks turn into wallet connects and deposits. Format looks like `AW-1234567890`.

## Common mistakes to avoid

- **Do not** enable "Search Partners" or "Display Network" on brand campaigns. Bad traffic, wasted budget.
- **Do not** set the daily budget higher than $5 without a conversion action wired — Google will spend it, but you can't tell if it's working.
- **Do not** target keywords you don't own (competitor names). This gets ugly fast and rarely converts.
- **Do** add exact-match variants of misspellings once you see search-terms data (e.g. `[zkwrd]`, `[zkard]`, `[z k ward]`).

## When to shut it all off

If any of these happen, pause the campaign:

- Clicks are >$5 for brand terms (means someone else is bidding aggressively — investigate)
- Zero conversions after 500 clicks (something is off with the landing page or the account tracking)
- Discord/Telegram/email traffic drops on the same day (ad clicks are cannibalising organic — usually means the ad is working)
