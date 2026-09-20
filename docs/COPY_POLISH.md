# Copy polish — brand-voice pass

**Goal.** Every user-facing string reads like Stripe / Linear / Vercel / Apple: confident, tight, distinctively ZKward. No filler. No hype. Nothing that could belong to a hundred other DeFi projects.

**Why now.** The i18n refactor put every string in one place for the first time — 406 leaves in `messages/en.json`, translated across 13 locales. That's the leverage point: fix EN once, propagate.

**Scope.** English source only in phase 1. Localization polish comes after EN is signed off (see §Localization).

---

## Voice spec (read before every edit)

- **Grounded, not hyped.** We say the honest thing before the flashy thing. When the paper trader is down $68K we say so. That IS the brand.
- **Receipts, not promises.** Prefer verifiable specifics ("10 signals", "2-of-3 vote", "$10K cap") to adjectives ("robust", "world-class").
- **Second person for the reader, first-person plural for us.** "You deposit, we publish the math." Never "users" — always "you".
- **Verb-first sentences.** "The pool rebalances." not "Rebalancing of the pool occurs."
- **Punctuation as pause, not decoration.** Periods over commas. Fragments allowed when they hit.
- **No sentence longer than 20 words** unless it's the whitepaper.
- **No emoji.** Live-status green dot excepted.

### Anti-words (never ship)
`revolutionary`, `cutting-edge`, `next-generation`, `world-class`, `robust`, `seamless`, `unleash`, `empower`, `democratize`, `leverage` (as a verb), `synergy`, `game-changing`, `innovative`, `state-of-the-art`, `paradigm`.

### Hedging words (delete on sight)
`just`, `simply`, `basically`, `essentially`, `actually`, `really`, `very`, `pretty`, `quite`, `kind of`, `sort of`, `we hope`, `we think`, `should be able to`.

---

## Priority order (top → bottom = highest visitor impact first)

1. Landing hero (headline + subtitle + primary CTA) — first 5 seconds decide
2. Landing vault meter + live status pill
3. Landing trust badges (5 badges × 3 fields)
4. Landing surfaces cards (6 cards × 3 fields)
5. Landing "how it works" 3-step
6. Landing composition + final CTA
7. Nav + `Enter app` button
8. Page `<title>` + meta description (SEO + share previews)
9. `/agents` page (chat header + 7 agent personas)
10. `/story` page (7 sections)
11. `/faq` page (12 Q&A)
12. Footer
13. Cookie banner
14. Legacy domain banner
15. Install-app strings
16. Dashboard settings (deep) — deferred, low visitor volume

---

## Landing hero — `messages/en.json:landing.hero.*`

- [ ] `hero.headline1` + `hero.headline2` — current "A vault that / shows its work." **Keep** (already ships-worthy). Stress-test against three alternatives before locking:
  - "Your vault. In the open."
  - "A vault that proves itself."
  - "Non-custodial. Non-fictional."
- [ ] `hero.subtitle` — current 32 words / 4 sentences. Cut to **≤20 words / 2 sentences**. Target:
  > "An autonomous USDC vault. Seven AI agents trade, every hedge closes with a cryptographic receipt you can verify."
- [ ] `landing.status.liveOn` — "Live on" is 2 words. Consider `Trading` (one word, verb).
- [ ] `landing.cta.depositUsdc` — "Deposit USDC" is generic. Try `Fund the vault` (specific, action-oriented). Test both.
- [ ] `landing.cta.howItWorks` — "How it works" is universal. Alternatives: `See the loop`, `Walk the loop`. Only replace if it beats the default in a click test.
- **Done when**: reads aloud without stumbling, no hedging word, every sentence has a verb in the first four words.

## Vault meter — `landing.vault.*`

- [ ] `vault.poolNav` — "Pool NAV" is finance jargon. Consider `Pool value` for the marketing hero (keep "NAV" on dashboard).
- [ ] `vault.sharePrice` — same tension. `Per share` fits better in a hero context.
- [ ] `vault.capacity` — OK.
- [ ] `vault.capacityOf` — "`{current} of {cap}`" — OK, tabular. No change.
- **Done when**: a first-time crypto visitor understands the meter without hovering anything.

## Trust badges — `landing.trust.*` (5 badges)

Each badge is `{ title, value, hint }`. Hints currently 11–14 words each. **Cut to ≤10 words each**. Titles must be a claim, not a category.

- [ ] `trust.poolCap` — title "Pool cap" OK. Hint "Enforced by the Move contract. Not a marketing number." — keep last sentence, delete first.
- [ ] `trust.freshOracle` — "Fresh oracle / Strict mode" is insider jargon. Try `Fresh price / 2-hour max`.
- [ ] `trust.withdrawThrottle` — title OK. Hint could drop "on-chain" (implied everywhere on this page).
- [ ] `trust.proofs` — great already ("Proofs, not promises"). Keep.
- [ ] `trust.twoChains` — hint "Live on both. SUI is the flagship. Hedera is the fallback." — three sentences for a badge is too many. Cut to one.
- **Done when**: all 15 strings scan in one glance; no hint requires a second read.

## Surfaces cards — `landing.surfaces.*` (6 cards)

Each card `{ eyebrow, title, body }`. Bodies currently 15–25 words. **Cut to ≤15 words**. Titles must be a mini-thesis.

- [ ] `dashboard` — title "Your pool, in one screen." — OK.
- [ ] `rwa` — body reads like a spec sheet. Rewrite as one sentence.
- [ ] `agents` — title "Meet the specialists." — flat. Try `Seven specialists. One loop.` (echoes hero).
- [ ] `zk` — "Not screenshots. Math." — **keep as is, one of the strongest lines on the site**.
- [ ] `story` — bodies feels apologetic ("Warm, honest, and yes"). Delete the yes.
- [ ] `whitepaper` — "For the engineers in the room." — good.
- **Done when**: the 6 cards read as one voice; no card sounds like it was written by a different person.

## How it works — `landing.howItWorks.*`

- [ ] `title` "Three moving parts. One loop." — **keep**, one of the strongest lines.
- [ ] `step1.title` "The AI reads the room" — **keep**.
- [ ] `step2.title` "The pool rebalances" — verb-only. Good.
- [ ] `step3.title` "A hedge lands with a proof" — great.
- [ ] Each step body — cut ~30% length without losing the specific numbers (10 signals, 4 venues, 2-of-3, etc.).
- **Done when**: no step body is longer than 2 short sentences.

## Composition — `landing.composition.*`

- [ ] `title` "Where your USDC is right now." — OK.
- [ ] `body` — mentions "30 minutes" AND "30s" in the same paragraph. Confusing. Pick one cadence to lead with.

## Final CTA — `landing.finalCta.*`

- [ ] `title` "Come see it running." — **keep**.
- [ ] `body` "Connect a wallet, deposit USDC, close the tab. The AI takes it from there." — **keep**.
- [ ] `alreadyIn` "`{count} already in.`" — good.
- [ ] `paused` — one word could go ("currently").

## Nav — `messages/en.json:nav.*`

- [ ] Single-word labels — no polish needed.
- [ ] `enterApp` "Enter app" — consider `Open vault` (specific to the product). Test both.

## Page metadata (per route)

**Each page needs a hook first, keyword second.** Current metadata is SEO-flat.

- [ ] `<title>` root layout — currently "ZKward — AI-managed USDC vault on SUI, ZK-STARK attested". Fine. Consider `ZKward — an AI vault that shows its work.` (mirrors the hero, aids brand recall).
- [ ] `whitepaperMeta.title` / `.description`
- [ ] `story.meta.*`
- [ ] `faq.meta.*`
- [ ] `agentsPage.meta.*`
- **Done when**: each meta description is a self-contained one-sentence pitch that could stand alone in a search result.

## Agents page — `agentsPage.*`

- [ ] `header.title` "Ask ZKward." — **keep**.
- [ ] `header.subtitle` — 2 sentences, one has "Nothing rehearsed" (great). Try to keep in one sentence.
- [ ] 7 agent personas — the "The dispatcher / worrier / broker" format is strong. Some need sharpening:
  - `settlement.role` "The signer" — functional. Consider `The notary` or `The clerk`.
  - `reporting.role` "The bookkeeper" — flat. Consider `The scribe` or `The bookkeeper` (keep if scribe reads as archaic).
- [ ] Each `description` — currently 25–40 words. Target ≤25.
- [ ] Each `capabilities.c1…c4` — 4-5 words each. Consistent length.
- **Done when**: reading all 7 agents feels like meeting a crew, not reading a spec sheet.

## Story page — `story.*`

- [ ] Voice is already strong (warm, honest, self-deprecating). **Light polish only.**
- [ ] `intro` — the ZkVanguard → ZKward paragraph is great. Keep.
- [ ] `whoBuilds.body2` "We consider this on-brand." — **one of the strongest lines on the site**, keep.
- [ ] `next.body` — "please yell at us on Telegram" — great voice, keep.
- [ ] Cut any remaining hedging words.

## FAQ — `faq.*`

- [ ] 12 Q&A pairs. Questions are already question-form.
- [ ] Answers 30-80 words each. **Depth is fine** for SEO + LLM extraction.
- [ ] `q1.a` — first sentence should hook. Currently "ZKward is an autonomous crypto vault." (5 words). Good.
- [ ] `q8` (paper-trader-losing) — currently 4 sentences. Tighten the middle.
- [ ] Every A should end with a sentence that lands. Audit last-sentence energy.

## Footer — `footer.*`

- [ ] Column headers ALL CAPS — OK.
- [ ] Link labels are single words — OK.
- [ ] `rights` "All rights reserved." — boilerplate. Fine.
- [ ] `migrationNotice` "Formerly zkvanguard.xyz. Zkward.com is our new home." — one sentence would be better than two.

## Cookie banner — `cookies.*`

- [ ] Currently long. Consumer cookie banners should be 1 sentence + 3 buttons.
- [ ] `description` — cut to under 20 words.

## Legacy banner — `legacyBanner.*`

- [ ] `message` "zkvanguard.xyz will retire soon. We've moved to zkward.com. Please update your bookmarks." — three sentences. Try one:
  > "zkvanguard.xyz is retiring — we're now at zkward.com."
- [ ] `dismiss` "Dismiss" — OK.

## Install-app — `landing.cta.installApp` / `installIosHint`

- [ ] `installIosHint` — currently 15 words. Keep — it's an instruction, clarity beats brevity.

---

## Localization strategy (after EN is signed off)

Do **not** re-translate every locale from scratch. Instead:

1. **Freeze EN.** Once above checklist is done, tag the commit as `i18n:en-frozen-v1`.
2. **Diff each locale against the frozen EN.** For every key whose EN string changed, mark the locale value as `stale`.
3. **Re-translate only stale keys, per locale, in priority order.**

### Priority for locale re-translation
| Locale | Rationale | Path |
|---|---|---|
| es | Latam crypto volume | Native reviewer (Upwork / community) |
| pt | Brazil crypto | Native reviewer |
| zh | Asia crypto volume | Native reviewer |
| ja | Japan matures | Native reviewer |
| ko | Active KR market | Native reviewer |
| de | EU + regulated market | Native reviewer |
| fr | EU | Native reviewer |
| it | EU | Native reviewer |
| ar | MENA growth + RTL sanity check | Native reviewer |
| hi | India interest | Native reviewer |
| ru | Content indexed (geo-blocked from write) | LLM-polish acceptable |
| ne | Founder can self-polish | Founder |

Budget estimate: $200–500 per locale for tech-savvy native review on Upwork. Total ≤$4K for all 11 non-founder locales. Payable as we scale, not before.

---

## Definition of done (whole polish)

- [ ] Every EN key passes: reads aloud without stumbling, no filler / hedging / anti-word.
- [ ] Every EN key has a stated reason for its current length (why not shorter?).
- [ ] Hero, trust badges, surfaces cards, agents personas all pass the **Linear test**: "Would Linear's marketing team ship this?"
- [ ] Hemingway app reading grade ≤ 9 for landing / agents / story / faq. Whitepaper exempt.
- [ ] Every locale re-translated for changed keys OR marked "en-fallback acceptable" per key.
- [ ] `bun /c/tmp/i18n-deep-audit.mjs` — every column zero across every locale.

## Working the list

Edit `messages/en.json` for EN keys. Run `bun tsc --noEmit` after each save (catches nothing but keeps muscle memory). When shipping, batch by section — one PR per surface (hero, trust, surfaces, agents, story, faq). Avoid a single 400-key PR — nobody reviews that well.

When a section is done, tick its box and move to the next. Delete this file when everything ticks.
