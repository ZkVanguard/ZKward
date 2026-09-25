# ZKward Design System Analysis

## Executive Summary

ZKward's design language is calibrated to serve two audiences at once — institutional evaluators (SUI Foundation grant reviewers, LPs, security researchers) and retail depositors — through a single **truth-forward** posture: every marketing surface shows real product state instead of aspirational copy. The system centers on a single accent color (iOS Blue `#007AFF`) deployed exclusively for CTAs, focus rings, and brand links, paired with one distinctive display face (Space Grotesk) reserved for hero and section headlines. Layout rhythm alternates between white canvas sections and soft-gray elevation bands, with one signature visual moment — the **Vault Meter** hero card — carrying live NAV, composition, and capacity data that verifies the product's claims in-page. Density belongs behind /dashboard; marketing surfaces stay editorial-airy.

Format follows the [voltagent/awesome-design-md](https://github.com/voltagent/awesome-design-md) DESIGN.md spec. This document governs the marketing surface only (`/`, `/agents`, `/zk`, `/rwa`, `/whitepaper`, `Navbar`, `Footer`). Dashboard, admin, and simulator are out of scope.

## Core Brand Principles

**Visual Identity:**
No decorative embellishment. Every accent-blue surface earns its saturation — primary CTAs, brand wordmark, inline links, live-status pills. Semantic colors (green / orange / red) are text-only signals for status, never actionable fills. Asset color chips (BTC / ETH / SUI / USDC) are the only gradients on the site.

**Typography Philosophy:**
Space Grotesk (semibold, tight tracking) carries hero and section headlines, signaling engineering credibility rather than fintech urgency. Body copy runs SF system stack — familiar, zero web-font cost, matches the iOS-adjacent product feel. All numeric data uses `tabular-nums` for aligned column rendering, reinforcing the quantitative nature of the product.

**Content Philosophy:**
Show real state. NAV, share price, member count, capacity, cron heartbeats: all pulled live from `/api/sui/community-pool` and companion endpoints. Every technical claim links to source (e.g., `agents/specialized/HedgingAgent.ts` on `/agents` is a live GitHub link). Marketing verbs like "elevate", "seamless", "unleash" are banned.

**Spacing & Rhythm:**
Section vertical padding scales `py-12 sm:py-20 md:py-24` (medium) — closer to Linear than to a dashboard. Max content width `1100px`. Hero content caps at `900px`. Alternating `bg-system-bg-primary` / `bg-system-bg-secondary` creates scroll rhythm without card-heavy overwhelm.

## Key Design Tokens

| Category | Primary Token | Hex Value | Application |
|---|---|---|---|
| Brand Accent | `ios-blue` | `#007AFF` | Every CTA, focus ring, brand link, live pill |
| Success State | `ios-green` | `#34C759` | Live indicators, prover healthy, positive delta |
| Warning State | `ios-orange` | `#FF9500` | Degraded status, pool paused, phantom-rate alert |
| Error State | `ios-red` | `#FF3B30` | Prover offline, verification failed |
| Text Primary | `label-primary` | `#1D1D1F` | Headlines, primary body, emphasized labels |
| Text Secondary | `label-secondary` | `#424245` | Body prose, subtitles, section ledes |
| Text Tertiary | `label-tertiary` | `#6E6E73` | Eyebrows, captions, hint text, meta rows |
| Canvas Primary | `system-bg-primary` | `#FFFFFF` | Default section background, body canvas |
| Canvas Elevated | `system-bg-secondary` | `#F5F5F7` | Alternating section band, footer, code panels |
| Canvas Grouped | `system-bg-grouped` | `#F2F2F7` | Status pill fill, inline code chip |
| Separator | `separator-opaque` | `#C6C6C8` | Card border at /30 opacity, hairlines at /40 |
| Asset · BTC | `#F7931A → #FBB040` | gradient | Composition strip, asset chips |
| Asset · ETH | `#627EEA → #8FA5F2` | gradient | Composition strip, asset chips |
| Asset · SUI | `#4DA2FF → #79C2FF` | gradient | Composition strip, asset chips |
| Asset · USDC | `#2775CA → #4A9CE8` | gradient | Composition strip, asset chips |

## Component Patterns

**Button Architecture:**
Primary CTAs use `rounded-ios-xl` (16px radius), height `52 sm:56` px, `bg-ios-blue text-white`, `hover:bg-[#0062CC]`, `active:scale-[0.97]`, `shadow-ios-2`. Secondary CTAs share dimensions but drop to `bg-system-bg-primary border-separator-opaque text-label-primary`. Tertiary/inline CTAs are text-only with `text-label-secondary hover:text-ios-blue`. Every button gets `text-headline font-semibold` — no size drift.

**The Signature Card — Vault Meter:**
The hero of `/` is a single dashboard-quality card (`rounded-[24px]`, `border border-separator-opaque/40`, `shadow-ios-2`) with three rows: (1) big NAV number in `font-bold tabular-nums` at `text-[60px]` desktop, paired with the share price; (2) segmented composition strip using asset-color gradients; (3) capacity bar (`bg-ios-blue` fill at `h-1`). A `3px` brand-gradient bar sits absolute-positioned at the top edge. This is the site's one moment of visual boldness. Every other surface stays quiet in service to it.

**Status Pills:**
`rounded-full bg-system-bg-grouped border border-separator-opaque/40 px-3.5 py-1.5`. Two-slot content: left slot holds `<LiveIndicator>` (pulsing green dot + label at `text-footnote`), right slot optionally holds a metric divided by a `w-px h-3 bg-separator-opaque/40` rule. Used above every hero.

**Timeline Steps (`<TimelineStep>`):**
Vertical connected sequence with numbered gradient nodes (`w-10 h-10 rounded-full bg-gradient-to-br`) linked by a `1px w-px bg-gradient-to-b` connector. Replaces the banned "three equal feature cards" pattern for sequential content. Number badge sits `-top-1.5 -right-1.5` on each node.

**Trust Badges (`<TrustBadge>`):**
`rounded-ios-xl` (16px) card, icon in `text-ios-blue`, tiny uppercase label, then `text-title-3 sm:text-title-2` value in tabular-nums, then hint at `text-caption-1 text-label-tertiary`. Used for engineering-detail grids (security parameters on `/zk`, on-chain guards on `/`, custody API on `/rwa`).

**Code Blocks (truth-forward):**
Displayed in `bg-label-primary` (near-black), title bar with three mac-window dots (`bg-ios-red/70`, `bg-ios-orange/70`, `bg-ios-green/70`), filename in `text-caption-1 text-white/60 font-mono`. Code body at `text-subheadline text-white font-mono` with `p-5 sm:p-6 overflow-x-auto`. Every code block is followed by GitHub source links (`text-ios-blue hover:underline font-mono`).

## Responsive Strategy

**Breakpoints (Tailwind defaults):**
- `xs` (475px) — custom, used sparingly for label swaps between iPhone SE (320-374px) and 375-475px range
- `sm` (640px) — most component scale-ups
- `md` (768px) — layout column changes
- `lg` (1024px) — desktop grid switches (sidebars, 3-column layouts)
- `xl` (1280px), `2xl` (1536px) — content caps

**Hero Scaling:**
Hero h1 uses a five-stop stepped scale: `text-[36px] xs:text-[42px] sm:text-[56px] md:text-[68px] lg:text-[80px] font-display font-semibold tracking-[-0.04em] leading-[0.96]`. Content container caps at `max-w-[900px]` for hero, `max-w-[1100px]` for standard sections, `max-w-[720px]` for focused CTA blocks.

**Grid Behavior:**
- Feature grids: `grid-cols-1 sm:grid-cols-2 md:grid-cols-3` (or `md:grid-cols-4` for compact trust rows). NEVER `grid-cols-3` without a smaller-viewport fallback.
- Sidebar-detail layouts (e.g., `/agents`): `grid-cols-1 lg:grid-cols-12` with `lg:col-span-4` sidebar + `lg:col-span-8` detail.
- Timeline: single column always — no responsive shuffle.

**Touch Targets:**
Every interactive element ≥ 44px tall on mobile (WCAG AAA). Primary CTAs are 52px on mobile, 56px on desktop. Nav links use `h-11` (44px). Mobile menu button is `w-11 h-11`.

**Safe Area:**
`pt-safe`, `pb-safe`, `pl-safe`, `pr-safe` utilities defined in `globals.css` consume `env(safe-area-inset-*)` for iPhone notch + home indicator clearance. Footer uses `pb-safe`. Navbar uses `pt-safe pl-safe pr-safe`.

## Typographic Hierarchy

**Faces (2, locked):**
- **Space Grotesk** — self-hosted via `next/font/google`, exposed as `--font-display` CSS var, consumed via `font-display` Tailwind utility. Weights: 500, 600, 700. Used on `h1` and `h2` only.
- **SF system stack** — `-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'system-ui', sans-serif`. Used everywhere else.

**Display Layers (Space Grotesk):**
- **hero-h1** — `text-[38px] xs:text-[44px] sm:text-[60px] md:text-[72px] lg:text-[84px] font-semibold tracking-[-0.04em] leading-[0.96]`
- **section-h2** — `text-[26px] sm:text-[34px] md:text-[42px] lg:text-[50px] font-semibold tracking-[-0.03em] leading-[1.05]`

**Body Layers (SF, defined in `globals.css`):**
- `.text-title-1` — 34px / 600 weight — dashboard section titles
- `.text-title-2` — 28px / 600 — card titles
- `.text-title-3` — 22px / 600 — sub-headers
- `.text-headline` — 17px / 600 — button labels, card headings
- `.text-body` — 17px / 400 — running prose
- `.text-callout` — 16px / 400 — supporting copy
- `.text-subheadline` — 15px / 400 — secondary body
- `.text-footnote` — 13px / 400 — meta rows, status pills
- `.text-caption-1` — 12px / 400 — eyebrows, hints
- `.text-caption-2` — 11px / 400 — smallest labels

**Numerical Data:**
Every price, percentage, timestamp, and address renders with `tabular-nums font-feature-settings: "tnum" on`. No exceptions. Applied via the `.tabular-nums` utility (defined in globals.css) or the Tailwind `tabular-nums` class.

**Letter Spacing:**
Negative tracking (`-0.03em` to `-0.04em`) applies to display only. Body copy stays at natural spacing. Eyebrows use `tracking-wide` (0.025em) with `uppercase` to compensate.

## Do's & Don'ts Framework

**Enforce:**
- One accent color (`ios-blue`) across the entire marketing surface.
- Space Grotesk on `h1`/`h2` via `font-display`. SF stack for everything else.
- `tabular-nums` on every numeric value (NAV, %, prices, timestamps, addresses).
- Live product data on every landing page (no fake screenshots).
- Every code snippet followed by a GitHub source link.
- One signature element per page — the Vault Meter on `/`, the Verify code block on `/zk`, the interactive selector on `/agents`.
- Section rhythm via `<Section tone="primary|secondary">` alternation.
- Motion via `<Reveal>` primitive (framer-motion `whileInView`, respects `useReducedMotion`).
- iOS radius scale (`rounded-ios`, `rounded-ios-lg`, `rounded-ios-xl`).
- Subtle shadows only (`shadow-ios-1/2/3`).

**Avoid:**
- Secondary brand colors (no purple, no green, no orange as decorative fills).
- Gradient text on hero headlines (the Coinbase-style AI tell).
- Three equal feature cards in a row (banned — use timeline, asymmetric, or bento).
- Duplicate CTA intent (two buttons both linking `/dashboard` with different labels).
- Section-numbered eyebrows (`01 / INDEX`, `02 · Capabilities`).
- Em-dashes anywhere user-visible (`—` and `–` both banned). Use periods, commas, colons, or plain hyphens.
- Raw hex in JSX (`text-[#007AFF]`) — use the token (`text-ios-blue`).
- Marketing verbs (elevate, seamless, unleash, next-gen, revolutionize, quietly).
- `window.addEventListener('scroll', ...)` — use IntersectionObserver.
- Inline `<Navbar />` inside a page — the layout renders it (adding a second stacks navbars).
- Serif faces (banned unless brief pivots to editorial — currently no).
- Fraunces, Instrument Serif (specifically banned per taste-skill §4.1).
- Auto-play video, decorative status dots, locale/time strips, scroll cue arrows.

## Substitution Notes

**If Space Grotesk is unavailable** (offline dev, corporate proxy): the `font-display` utility falls back gracefully to `-apple-system, BlinkMacSystemFont, sans-serif` via the tailwind config chain. No FOUT visible — content stays readable.

**If a code editor / dashboard surface needs a mono face:** use JetBrains Mono or Geist Mono at 500 weight. Currently the site does not depend on a bundled mono face; it uses `font-mono` (Tailwind's `ui-monospace` stack) which resolves to SF Mono / Menlo on Apple, Consolas on Windows.

**System font stack (body):** `-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif`.

## Scope Boundaries

This document governs the **marketing surface only**: `/`, `/agents`, `/zk`, `/rwa`, `/whitepaper`, the shared `<Navbar>` and `<Footer>`, and the primitives in `components/ui/landing.tsx`.

Out of scope:
- `/dashboard/*` (portfolio, risk, custody sub-routes) — different audience, different density
- `/simulator`, `/docs` — separate design surfaces with their own rhythm
- Admin routes (`/api/admin/*`), agent internals
- Move contract source (different repo surface)
- Wallet-connect modals, transaction toasts — governed by the connected-state UX in `ConnectButton.tsx`

Animation timing beyond `<Reveal>` (dial MOTION=4), advanced form validation states, and accessibility beyond touch-target guidance are addressed as-needed per component but are not centrally specified here. The dashboard uses its own token layer via CSS variables in `globals.css` (`--label-primary`, `--card-bg`, `--shadow-md`) that intentionally reuses the same hex values so a future migration to shared tokens is trivial.
