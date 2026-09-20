'use client';

import type { RefObject } from 'react';
import { memo, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@/i18n/routing';
import { useHederaPool, type HederaPoolResponse } from '@/lib/hooks/useHederaPool';
import {
  ArrowRight, ShieldCheck, Zap, BarChart3,
  Sparkles, Layers, Lock,
} from 'lucide-react';
import { InstallAppButton } from './InstallAppButton';
import { Reveal, LiveIndicator, StatusPill, TrustBadge } from './ui/landing';

// Linear's signature spring curve. Read as: quick out, slow in — feels
// like real mass behind interactive elements instead of the default
// ease-in-out "slide-and-stop" cadence.
const SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)';

// Cursor spotlight — updates --sx/--sy CSS variables on a container from
// pointermove so children can drive a 3D tilt effect. rAF-throttled to
// 60fps; disabled on touch devices + prefers-reduced-motion.
//
// Attached to the vault card container ONLY (not the whole hero) so the
// card feels physical while the hero background stays flat (no
// pointer-follow spotlight glow — user request).
import { useReducedMotion } from 'framer-motion';

function useCursorSpotlight<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) return;
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia('(min-width: 768px) and (pointer: fine)');
    if (!mq.matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        el.style.setProperty('--sx', `${x}%`);
        el.style.setProperty('--sy', `${y}%`);
      });
    };
    el.addEventListener('pointermove', onMove);
    return () => {
      el.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, [ref, reduce]);
}

// VaultTiltScene — encapsulates the perspective wrapper + the cursor-
// spotlight hook attached to the card container. Pulling this into its
// own component lets us mount useCursorSpotlight in one place, scoped
// to the card only (not the whole hero).
function VaultTiltScene({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useCursorSpotlight(ref as RefObject<HTMLElement>);
  return (
    <div ref={ref} className="vault-tilt-scene max-w-[720px] mx-auto mb-3 sm:mb-4 relative">
      <div className="vault-idle-float relative">
        <div className="vault-scroll-lift rounded-[28px]">
          <div className="vault-tilt rounded-[28px]">{children}</div>
        </div>
      </div>
    </div>
  );
}

// TVL cap enforced by the Move contract. Surfacing "room remaining" on the
// landing gives visitors a scale anchor without leading with the current
// (small) NAV. If the on-chain cap changes, bump this constant — the display
// is intentionally not fetched (it's a marketing rail, not a live gate).
// Hedera testnet vault has no on-chain TVL cap (uncapped demo vault).
// The bar just shows how full the demo is vs a soft target we've picked
// for the visual — 100k is a reasonable "next milestone" that leaves room
// to grow from the current 60k without pinning at 100%.
const TVL_CAP_USD = 100_000;

// ───────────────────────────────────────────────────────────────────────────
// Live SUI Community Pool landing page — Apple-themed, single focus.
//
// Pulls real-time numbers from /api/sui/community-pool?network=mainnet
// (cached 30s server-side), so a fresh visitor sees actual NAV / share price /
// composition / ATH instead of stale marketing.
//
// Design tokens: tailwind.config.js `ios.*`, `system-bg.*`, `label.*`,
// typography `large-title`, `title-1`, `headline`, etc., shadows `ios-1/2/3`.
// No warm `claude-*` colors anywhere.
// ───────────────────────────────────────────────────────────────────────────

interface PoolSummary {
  totalNAV: number;        // USDC
  sharePrice: number;
  allTimeHighNav: number;  // ATH share price
  totalDeposited: number;
  totalWithdrawn: number;
  memberCount: number;
  totalShares: number;
  allocation: Record<string, number>; // live composition (BTC/ETH/SUI/USDC)
  paused: boolean;
}

const ASSET_ICONS: Record<string, string> = {
  BTC: '₿', ETH: 'Ξ', SUI: '💧', USDC: '$',
};
const ASSET_GRADIENTS: Record<string, string> = {
  BTC: 'from-[#F7931A] to-[#FBB040]',
  ETH: 'from-[#627EEA] to-[#8FA5F2]',
  SUI: 'from-[#4DA2FF] to-[#79C2FF]',
  USDC: 'from-[#2775CA] to-[#4A9CE8]',
};

function formatUsd(n: number, decimals = 2): string {
  if (!Number.isFinite(n)) return '…';
  const abs = Math.abs(n);
  // Compact suffixes above 10k so the stat cards stay readable at scale.
  // ($3,214,857 in a card is a nightmare; $3.21M is fine.)
  if (abs >= 1_000_000_000) return `${n < 0 ? '-' : ''}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000)     return `${n < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000)        return `${n < 0 ? '-' : ''}$${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 1_000)         return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return '$' + n.toFixed(decimals);
}

// Compact member/share formatter that also handles pluralisation.
function formatCount(n: number, singular: string, plural: string): string {
  if (!Number.isFinite(n) || n < 0) return `… ${plural}`;
  const rounded = Math.floor(n);
  if (rounded >= 1_000_000) return `${(rounded / 1_000_000).toFixed(1)}M ${plural}`;
  if (rounded >= 10_000)    return `${(rounded / 1_000).toFixed(1)}K ${plural}`;
  if (rounded >= 1_000)     return `${rounded.toLocaleString('en-US')} ${plural}`;
  return `${rounded} ${rounded === 1 ? singular : plural}`;
}

/** Map the shared Hedera pool response into the local PoolSummary shape. */
function toPoolSummary(res: HederaPoolResponse | undefined): PoolSummary | null {
  const p = res?.pool;
  if (!p) return null;
  return {
    totalNAV: Number(p.totalValueUSD ?? 0),
    sharePrice: Number(p.sharePrice ?? 1),
    // Simple vault has no ATH concept (share price is pinned to $1.00 by
    // design). Use current NAV as ATH — no phantom peak to worry about.
    allTimeHighNav: Number(p.sharePrice ?? 1),
    totalDeposited: Number(p.totalDeposited ?? p.totalValueUSD ?? 0),
    totalWithdrawn: Number(p.totalWithdrawn ?? 0),
    memberCount: Number(p.memberCount ?? 0),
    totalShares: Number(p.totalShares ?? 0),
    // Hedera vault holds USDC only — no cross-asset allocation until
    // AI-executed swaps land on-chain (currently projected in dashboard).
    allocation: p.allocation ?? { USDC: 100 },
    paused: !!p.paused,
  };
}

// HeroGraphBg — three parallax layers behind the hero (CSS dot-grid +
// SVG chart curves + SVG node network). Reads --sx/--sy already
// published by useCursorSpotlight, translates each layer by a different
// factor (calc((--sx - 50%) * k)) so back layers drift slowly and the
// front layer tracks the cursor faster. That differential IS the 3D cue.
// All ios-blue at low opacity so the white canvas stays clean. Hidden
// below md: — mobile has no cursor and the graph would compete with
// headline text at that width.
//
// Reduced-motion + hydration: gated purely in CSS (@media prefers-
// reduced-motion). Not useReducedMotion() — that returns null on server
// and a real value on client's first render, which caused a hydration
// mismatch on the earlier revision.
// Front layer geometry — replaced the previous 7-node polygon graph
// with Vogel's phyllotaxis (sunflower seed spiral). Each dot sits at
// angle i × golden-angle from the center and radius √i × scale. The
// resulting pattern shows both clockwise and counter-clockwise
// Fibonacci-numbered spiral arms — the exact math nature uses for
// sunflower disks, pinecone scales, and galaxy arms. Universe math
// that reads as intentional rather than decorative.
const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5)); // ~137.508°
// Coordinates rounded to 2 decimals to fix an SSR/CSR hydration
// mismatch: Node's number-to-string emits 17-digit precision on the
// server (cy="337.50384165405035") while the browser's DOM attribute
// serializer trims to 16 (cy="337.5038416540504"). Same double, but
// React sees the strings as different. Rounding produces identical
// short strings on both sides. Visual impact of the round: zero
// (subpixel).
const HERO_PHYLLOTAXIS: Array<[number, number, number]> = (() => {
  const pts: Array<[number, number, number]> = [];
  const cx = 600, cy = 300;    // center of the 1200×600 viewBox
  const scale = 14;
  const N = 90;
  const round = (n: number) => Number(n.toFixed(2));
  for (let i = 1; i <= N; i++) {
    const angle = i * GOLDEN_ANGLE_RAD;
    const r = scale * Math.sqrt(i);
    if (r > 260) break;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    // Dot radius grows subtly with distance so outer arms read stronger.
    pts.push([round(x), round(y), round(1.4 + (i / N) * 2.2)]);
  }
  return pts;
})();

// Golden logarithmic spiral: r = a·e^(bθ) with b = ln(φ)/(π/2).
// One continuous smooth curve winding out from the center — the
// signature "shell/galaxy" shape. Traced as a polyline for SVG.
const HERO_GOLDEN_SPIRAL_PATH: string = (() => {
  const PHI = (1 + Math.sqrt(5)) / 2;
  const b = Math.log(PHI) / (Math.PI / 2);
  const a = 2.4;
  const cx = 600, cy = 300;
  const points: string[] = [];
  for (let theta = 0; theta < 6.4 * Math.PI; theta += 0.06) {
    const r = a * Math.exp(b * theta);
    if (r > 270) break;
    const x = cx + r * Math.cos(theta);
    const y = cy + r * Math.sin(theta);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return 'M' + points.join(' L');
})();

// Precomputed parallax styles — hoisting kills the per-render allocation
// that would happen if we built these objects inside the component.
// The factor triplet (-0.03, -0.07, -0.13) drives the differential
// translate; the Z-offset triplet (-40, 0, +30) drives real perspective
// depth (parent has perspective: 1400px). Combined, layers sit at
// physically different distances AND drift at different apparent
// speeds — the "3D" cue is both.
//
// Transition tightened 700ms → 250ms with a faster ease-out — previous
// value felt sticky on rapid cursor movement (layers lagged the cursor
// by nearly a full second). New value tracks close enough to feel
// responsive without losing the "premium smoothness" character.
const HERO_PARALLAX_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const parallaxStyle = (k: number, z: number): React.CSSProperties => ({
  transform: `translate3d(calc((var(--sx, 50%) - 50%) * ${k}), calc((var(--sy, 50%) - 50%) * ${k * 0.7}), ${z}px)`,
  transition: `transform 250ms ${HERO_PARALLAX_EASE}`,
  willChange: 'transform',
});
const PX_LAYER_1 = parallaxStyle(-0.03, -40);
const PX_LAYER_2 = parallaxStyle(-0.07, 0);
const PX_LAYER_3 = parallaxStyle(-0.13, 30);
// Responsive dot density: clamp with vw so 4K desktops don't get a
// pinprick grid and 13" laptops don't get honeycombed. ~28-40px range
// keeps the perceptual dot spacing roughly constant across the range.
const LAYER_1_STYLE: React.CSSProperties = {
  ...PX_LAYER_1,
  backgroundImage:
    'radial-gradient(circle at 1.6px 1.6px, rgba(0,105,217,0.55) 1.4px, transparent 1.8px)',
  backgroundSize: 'clamp(28px, 2.4vw, 40px) clamp(28px, 2.4vw, 40px)',
  WebkitMaskImage:
    'linear-gradient(to bottom, transparent 0%, black 18%, black 72%, transparent 100%)',
  maskImage:
    'linear-gradient(to bottom, transparent 0%, black 18%, black 72%, transparent 100%)',
};

function HeroGraphBg() {
  // `perspective` on the wrapper + `translateZ` per layer gives real
  // spatial depth (back layer literally further from the viewer, front
  // literally closer). Combined with the cursor-driven parallax, that's
  // the "3D" cue — not just 2D differential translate. transform-style:
  // preserve-3d on the wrapper is required so the child transforms
  // compose in the same 3D space instead of flattening.
  //
  // Pause-when-off-screen: IntersectionObserver flips
  // data-hero-visible="false" once the hero fully exits the viewport,
  // which CSS uses to pause the three ambient animations (chart tape,
  // node drift, node pulse). Users who scroll past the hero don't burn
  // CPU on animations they can't see. rootMargin: 100px so a brief
  // scroll-back doesn't miss a frame at re-entry.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        el.dataset.heroVisible = entry.isIntersecting ? 'true' : 'false';
      },
      { rootMargin: '100px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      aria-hidden
      data-hero-visible="true"
      // Extends 100px above section top so the graph reaches under
      // the fixed navbar (h ~52px + safe-area). Navbar has
      // `backdrop-blur-lg bg-system-bg-primary/90` → the phyllotaxis +
      // chart + dot grid all get blurred through the glass, visually
      // syncing the header with the hero backdrop instead of the
      // previous sharp cutoff at section top. Section must NOT clip
      // vertical overflow (see overflow-x-clip on the <section>).
      className="hero-graph-bg hidden md:block absolute -top-24 left-0 right-0 bottom-0 -z-10 pointer-events-none overflow-hidden"
      style={{
        perspective: '1400px',
        perspectiveOrigin: '50% 30%',
        transformStyle: 'preserve-3d',
        // `contain` isolates this subtree — the browser can skip layout
        // + paint work when nothing inside it changes, and knows the
        // effects don't leak out (accurate: all layers are z-negative
        // absolutes clipped by our own overflow-hidden).
        contain: 'layout paint style',
        // Radial vignette centered on where the vault meter sits
        // (approx 50% x, 66% y). The effect fades to transparent in
        // a wider soft ellipse around the card so the meter reads as
        // a clean "hero moment" instead of competing with dense
        // phyllotaxis/chart lines behind it. Longer fade band (35%
        // to 82%) makes the transition feel machined rather than
        // hard-cut. Corners keep the full effect — depth cue
        // preserved. Both prefixed forms so Safari + Firefox agree.
        WebkitMaskImage:
          'radial-gradient(ellipse 50% 46% at 50% 66%, transparent 0%, transparent 35%, black 82%)',
        maskImage:
          'radial-gradient(ellipse 50% 46% at 50% 66%, transparent 0%, transparent 35%, black 82%)',
      }}
    >
      {/* Layer 1 — dot grid via CSS radial-gradient (SVG pattern without a
          viewBox tiles inconsistently across browsers on this project's
          layout; CSS gradient tile is deterministic + one line). Vertical
          fade via mask-image so the grid does not clash with headline
          text or the vault meter card. */}
      <div className="hero-graph-layer absolute -left-32 -right-32 top-0 bottom-0" style={LAYER_1_STYLE} />

      {/* Layer 2 — chart polylines. Slow dashoffset sweep on the dashed line
          gives a "live tape" feel without any JS. Paths extended beyond
          viewBox 0-1200 (starting at -200, ending at 1400) so the chart
          keeps going off both sides — the visible container edges then
          show a chart in mid-flow rather than trailing off. `overflow=
          visible` allows the SVG to draw outside the viewBox. Layer
          stays extended -left-32/-right-32 for the 3D depth cue. */}
      <svg
        className="hero-graph-layer absolute -left-32 -right-32 top-0 bottom-0 h-full"
        preserveAspectRatio="none"
        viewBox="0 0 1200 600"
        overflow="visible"
        style={PX_LAYER_2}
      >
        <defs>
          <linearGradient id="hero-chart-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgba(0,105,217,0.11)" />
            <stop offset="100%" stopColor="rgba(0,105,217,0)" />
          </linearGradient>
        </defs>
        <path
          d="M-200,480 L0,430 C150,395 250,350 380,368 S620,285 780,308 S1050,225 1200,255 L1400,215 L1400,600 L-200,600 Z"
          fill="url(#hero-chart-fill)"
        />
        <path
          d="M-200,480 L0,430 C150,395 250,350 380,368 S620,285 780,308 S1050,225 1200,255 L1400,215"
          fill="none"
          stroke="rgba(0,105,217,0.42)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          className="hero-chart-tape"
          d="M-200,540 L0,490 C180,455 300,470 460,438 S720,405 900,382 S1100,362 1200,338 L1400,298"
          fill="none"
          stroke="rgba(0,105,217,0.28)"
          strokeWidth="1"
          strokeLinecap="round"
          strokeDasharray="4 7"
        />
      </svg>

      {/* Layer 3 — golden spiral + phyllotaxis dots, fastest parallax
          (feels closest to viewer). The spiral is one continuous
          logarithmic curve; the dots trace Vogel's sunflower model at
          the golden angle — same math that produces the arm patterns
          in galaxies + nautilus shells. Wrapped in a `hero-node-drift`
          group for a slow ambient float, and each dot pulses subtly
          so the disk breathes without cursor input. Additionally, the
          whole layer slowly rotates (72s per revolution) — sub-liminal
          but reinforces the "living system" read. */}
      <svg
        className="hero-graph-layer absolute -left-32 -right-32 top-0 bottom-0 h-full"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 1200 600"
        style={PX_LAYER_3}
      >
        <g className="hero-node-drift">
          <g className="hero-spiral-rotate">
            <path
              d={HERO_GOLDEN_SPIRAL_PATH}
              fill="none"
              stroke="rgba(0,105,217,0.22)"
              strokeWidth="1"
              strokeLinecap="round"
            />
            <g fill="rgba(0,105,217,0.62)">
              {HERO_PHYLLOTAXIS.map(([cx, cy, r], idx) => (
                <circle
                  key={idx}
                  cx={cx}
                  cy={cy}
                  r={r}
                  className="hero-node-pulse"
                  // toFixed(2) so 0.3×9 = 2.6999999999997 doesn't drift
                  // between SSR (17-digit) and CSR (16-digit) strings.
                  style={{ animationDelay: `${((idx % 12) * 0.3).toFixed(2)}s` }}
                />
              ))}
            </g>
          </g>
        </g>
      </svg>

      <style jsx>{`
        .hero-chart-tape { animation: hero-tape 14s linear infinite; }
        @keyframes hero-tape { to { stroke-dashoffset: -220; } }
        /* Continuous ambient float — 6px horizontal ping-pong over 11s
           so the front layer breathes visibly without needing cursor
           input (main reason the earlier revision felt like a static
           overlay to users who kept the mouse still). */
        .hero-node-drift {
          transform-origin: 50% 50%;
          animation: hero-node-drift 11s ease-in-out infinite alternate;
        }
        @keyframes hero-node-drift {
          from { transform: translate3d(-3px, -2px, 0); }
          to   { transform: translate3d(3px, 2px, 0); }
        }
        /* Nodes pulse subtly so they read as "alive" data points. */
        .hero-node-pulse { animation: hero-node-pulse 3.6s ease-in-out infinite; }
        @keyframes hero-node-pulse {
          0%, 100% { opacity: 0.65; }
          50%      { opacity: 1; }
        }
        /* Spiral disk slowly rotates — 72s per revolution is glacial
           but visible over a session. Combined with the phyllotaxis
           dot arrangement it produces the "galaxy arm" read where
           multiple spiral patterns emerge from the same points. */
        .hero-spiral-rotate {
          transform-origin: 600px 300px; /* matches phyllotaxis center */
          animation: hero-spiral-rotate 72s linear infinite;
        }
        @keyframes hero-spiral-rotate {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        /* CPU saver — pause every animation once the hero has fully
           scrolled out of view. The wrapper's data-hero-visible attr
           is flipped by an IntersectionObserver in HeroGraphBg. */
        .hero-graph-bg[data-hero-visible="false"] .hero-chart-tape,
        .hero-graph-bg[data-hero-visible="false"] .hero-node-drift,
        .hero-graph-bg[data-hero-visible="false"] .hero-node-pulse,
        .hero-graph-bg[data-hero-visible="false"] .hero-spiral-rotate {
          animation-play-state: paused;
        }
        @media (prefers-reduced-motion: reduce) {
          .hero-graph-layer { transform: none !important; transition: none !important; }
          .hero-chart-tape, .hero-node-drift, .hero-node-pulse, .hero-spiral-rotate { animation: none; }
        }
      `}</style>
    </div>
  );
}

export const SuiPoolLanding = memo(function SuiPoolLanding() {
  // Read the shared Hedera pool query — same cache key as HederaVaultCallout
  // above + the dashboard's useCommunityPool. Three consumers, one fetch.
  const { data: rawPool, isPending: loading } = useHederaPool('testnet');
  const pool = toPoolSummary(rawPool);

  // Hero ref kept for structural anchor; cursor-follow effects removed
  // per design request.
  const heroRef = useRef<HTMLElement>(null);

  // Build allocation legend (positive entries only)
  const allocationEntries = pool
    ? Object.entries(pool.allocation || {})
        .filter(([, v]) => Number(v) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
    : [];

  return (
    <div className="bg-system-bg-primary text-label-primary">
      {/* ─────────────────────────────────────────────────────────────── */}
      {/* HERO                                                            */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section ref={heroRef} className="relative isolate pt-20 pb-12 sm:pt-32 sm:pb-24 lg:pt-40 lg:pb-32 px-4 sm:px-5 lg:px-8 overflow-x-clip min-w-0">
        {/* Apple-style soft gradient backdrop — extends 100px above so
            the fixed navbar's backdrop-blur has something to blur
            instead of solid white. Height compensated via inset. */}
        <div className="absolute -top-24 left-0 right-0 bottom-0 -z-10 bg-gradient-to-b from-system-bg-tertiary via-system-bg-primary to-system-bg-primary" />
        {/* Depth-parallax graph backdrop (3 layers, cursor-driven).
            Reuses --sx/--sy from useCursorSpotlight — no extra listener.
            Extends up under the navbar (see HeroGraphBg for details). */}
        <HeroGraphBg />
        <div className="max-w-[1100px] mx-auto">
          {/* Single multichain status pill — SUI mainnet flagship + Hedera
              testnet as the primary EVM demo. One line, less visual noise
              than the previous two-pill row. */}
          <div className="flex items-center justify-center mb-8 sm:mb-10">
            <StatusPill
              left={
                <span className="inline-flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping" style={{ backgroundColor: '#00A79F' }} />
                    <span className="relative inline-flex rounded-full h-2 w-2" style={{ backgroundColor: '#00A79F' }} />
                  </span>
                  <span className="text-footnote font-medium text-label-secondary">
                    Live on <span style={{ color: '#00A79F' }} className="font-semibold">Hedera Testnet</span> · <span style={{ color: '#4DA2FF' }} className="font-semibold">SUI Mainnet</span>
                  </span>
                </span>
              }
              right={
                <span className="text-footnote font-semibold text-label-primary tabular-nums">
                  {formatCount(pool?.memberCount ?? 0, 'member', 'members')}
                </span>
              }
            />
          </div>

          {/* Headline — tightened to 2 short lines, no gradient text (the
              Vault Meter below is the visual signature). Space Grotesk
              display face gives numbers + short phrases distinctive shape. */}
          <h1
            className="font-display text-center text-[38px] xs:text-[44px] sm:text-[54px] md:text-[62px] lg:text-[68px] xl:text-[80px] font-semibold tracking-[-0.04em] leading-[0.96] text-label-primary mb-4 sm:mb-6"
            style={{ textWrap: 'balance', hyphens: 'none', overflowWrap: 'normal' }}
          >
            A vault that
            <br />
            <span className="whitespace-nowrap">shows its work.</span>
          </h1>

          {/* Subtitle — plain-English promise; brand-forward for search. */}
          <p className="text-center text-base sm:text-[19px] text-label-secondary max-w-[600px] mx-auto leading-relaxed mb-10 sm:mb-14 px-1">
            ZKward is an autonomous crypto vault. Seven AI agents make the trades.
            Every hedge closes with a cryptographic receipt you can verify yourself.
            Small pool on purpose. Real money.
          </p>

          {/* ─── VAULT METER (signature element) ─── */}
          {/* Shows the vault's live state as the hero's real visual, instead
              of a text hero + stat cards. NAV + composition + capacity in one
              card. This is "the product IS the pitch".
              As the hero exits the viewport, the card rises + shadow deepens
              via .vault-scroll-lift (native CSS scroll-driven animation,
              zero JS, respects reduced-motion). */}
          {/* .vault-tilt-scene → perspective(1200px) container for the
              cursor-driven tilt. useCursorSpotlight is attached only to
              THIS container (not the whole hero) so the card feels 3D
              without a page-wide pointer-follow background glow. */}
          <VaultTiltScene>
            <VaultMeter pool={pool} loading={loading} cap={TVL_CAP_USD} />
          </VaultTiltScene>
          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4 mb-6">
            {/* Magnetic button-in-button (soft-skill pattern) — the
                trailing arrow lives in its own nested circle instead of
                sitting naked next to the label. On hover the entire
                pair reacts as one: bg darkens, whole button pushes
                down slightly, arrow circle translates + scales. Custom
                cubic-bezier so the motion has real mass. */}
            <Link
              href="/dashboard"
              className="group inline-flex items-center justify-center gap-3 pl-6 pr-2.5 h-[52px] sm:h-[56px] bg-ios-blue text-white text-headline font-semibold rounded-ios-xl hover:bg-ios-blueHover active:scale-[0.97] shadow-ios-2 w-full sm:w-auto"
              style={{ transition: `all 500ms ${SPRING}` }}
            >
              Deposit USDC
              <span
                aria-hidden
                className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center group-hover:translate-x-1 group-hover:-translate-y-[1px] group-hover:scale-105"
                style={{ transition: `transform 500ms ${SPRING}` }}
              >
                <ArrowRight className="w-4 h-4" strokeWidth={2.5} />
              </span>
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-1 h-[52px] sm:h-[56px] px-2 text-headline font-medium text-label-secondary hover:text-ios-blue transition-colors"
            >
              How it works
              <ArrowRight className="w-4 h-4" strokeWidth={2.25} />
            </a>
          </div>

          {/* Install-as-app row — renders nothing when already installed or the
              browser hasn't emitted beforeinstallprompt yet. */}
          <div className="flex justify-center">
            <InstallAppButton className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-white/80 backdrop-blur border border-separator-opaque/40 text-label-secondary text-sm font-medium hover:text-ios-blue hover:border-ios-blue/40 active:scale-[0.98] transition-all" />
          </div>

        </div>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* LIVE COMPOSITION                                                */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-12 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-secondary min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="flex flex-col lg:flex-row gap-8 sm:gap-12 lg:gap-16 items-start min-w-0">
            {/* Left: heading */}
            <div className="lg:max-w-[420px] lg:sticky lg:top-24 min-w-0">
              <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
                Live composition
              </p>
              <h2 className="text-[26px] sm:text-[34px] md:text-[40px] lg:text-[48px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 sm:mb-5 break-words">
                Where your USDC is right now.
              </h2>
              <p className="text-sm sm:text-callout text-label-secondary leading-relaxed sm:leading-[1.55]">
                The AI rebalances every 30 minutes across BTC, ETH and SUI based
                on live market signals. Idle USDC counts as a defensive bucket.
                Refreshes every 30s.
              </p>
            </div>

            {/* Right: allocation visualization */}
            <div className="flex-1 w-full">
              {!loading && allocationEntries.length > 0 ? (
                <div className="bg-system-bg-primary rounded-ios-xl p-6 sm:p-8 shadow-ios-1 border border-separator-opaque/30">
                  {/* Stack bar */}
                  <div className="h-3 rounded-full overflow-hidden flex mb-6 bg-system-bg-grouped">
                    {allocationEntries.map(([asset, pct]) => (
                      <div
                        key={asset}
                        className={`bg-gradient-to-r ${ASSET_GRADIENTS[asset] || 'from-gray-300 to-gray-400'}`}
                        style={{ width: `${pct}%` }}
                        title={`${asset} ${pct}%`}
                      />
                    ))}
                  </div>

                  {/* Legend */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
                    {allocationEntries.map(([asset, pct]) => (
                      <div key={asset} className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-9 h-9 rounded-ios bg-gradient-to-br ${
                              ASSET_GRADIENTS[asset] || 'from-gray-300 to-gray-400'
                            } flex items-center justify-center text-white text-base font-semibold shadow-ios-1`}
                          >
                            {ASSET_ICONS[asset] || '?'}
                          </div>
                          <div>
                            <div className="text-headline font-semibold text-label-primary">{asset}</div>
                            <div className="text-caption-1 text-label-tertiary">
                              {pool ? formatUsd((pool.totalNAV * Number(pct)) / 100, 2) : '…'}
                            </div>
                          </div>
                        </div>
                        <div className="text-title-3 font-semibold text-label-primary tabular-nums">
                          {Number(pct).toFixed(1)}%
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="bg-system-bg-primary rounded-ios-xl p-8 shadow-ios-1 border border-separator-opaque/30 animate-pulse">
                  <div className="h-3 bg-system-bg-grouped rounded-full mb-6" />
                  <div className="space-y-4">
                    {[1, 2, 3, 4].map(i => (
                      <div key={i} className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-ios bg-system-bg-grouped" />
                          <div className="w-16 h-4 bg-system-bg-grouped rounded" />
                        </div>
                        <div className="w-12 h-4 bg-system-bg-grouped rounded" />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </Reveal>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* HOW IT WORKS                                                    */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-14 sm:py-20 md:py-28 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="text-center mb-10 sm:mb-14 md:mb-16">
            <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
              How it works
            </p>
            <h2 className="text-[26px] sm:text-[34px] md:text-[44px] lg:text-[52px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 sm:mb-4 break-words">
              Three moving parts. One loop.
            </h2>
            <p className="text-sm sm:text-callout text-label-secondary max-w-[560px] mx-auto leading-relaxed sm:leading-[1.55] px-1">
              It runs every five minutes, all day, without you. You deposit once and watch.
            </p>
          </div>

          <div className="max-w-[760px] mx-auto min-w-0">
            <TimelineStep
              step={1}
              icon={<Sparkles className="w-5 h-5" />}
              accent="from-ios-blue to-[#5AC8FA]"
              title="The AI reads the room"
              body="Ten signal sources — Polymarket, Kalshi, Deribit vol, funding rates from four venues, price momentum — fuse into a single allocation target. Seven agents have to agree before capital moves."
            />
            <TimelineStep
              step={2}
              icon={<Zap className="w-5 h-5" />}
              accent="from-[#34C759] to-[#30D158]"
              title="The pool rebalances"
              body="Your USDC is swapped across BTC, ETH, and SUI on-chain. Drift-based — the pool only trades when the allocation actually shifts. Nothing wasted on churn."
            />
            <TimelineStep
              step={3}
              icon={<ShieldCheck className="w-5 h-5" />}
              accent="from-[#AF52DE] to-[#BF5AF2]"
              title="A hedge lands with a proof"
              body="A matching BlueFin perpetual position balances the risk. Every open and close writes a STARK proof of the decision to the chain. Anyone can verify it. Nobody can fake it."
              last
            />
          </div>
        </Reveal>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* TRUST STRIP — safety guarantees on chain                        */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-12 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-secondary min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="text-center mb-8 sm:mb-12">
            <h2 className="text-[24px] sm:text-[28px] md:text-[36px] lg:text-[42px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 break-words">
              The rails are written into the contract.
            </h2>
            <p className="text-sm sm:text-callout text-label-secondary max-w-[560px] mx-auto leading-relaxed mb-2">
              Not a policy on our website. Rules the chain enforces, whether we&rsquo;re paying attention or not.
            </p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-2.5 sm:gap-4 min-w-0">
            <TrustBadge
              icon={<Lock className="w-5 h-5" />}
              title="Pool cap"
              value="$10,000"
              hint="Enforced by the Move contract. Not a marketing number."
            />
            <TrustBadge
              icon={<Layers className="w-5 h-5" />}
              title="Fresh oracle"
              value="Strict mode"
              hint="Deposits revert if the NAV attestation is older than two hours."
            />
            <TrustBadge
              icon={<ShieldCheck className="w-5 h-5" />}
              title="Withdraw throttle"
              value="25% / day"
              hint="A single account cannot drain the pool. Rate limit on-chain."
            />
            <TrustBadge
              icon={<BarChart3 className="w-5 h-5" />}
              title="Proofs, not promises"
              value="Post-quantum"
              hint="STARK proofs on the Goldilocks field. Quantum-safe by design."
            />
            <TrustBadge
              icon={<Layers className="w-5 h-5" />}
              title="Two chains, one code"
              value="Hedera + SUI"
              hint="Live on both. SUI is the flagship. Hedera is the fallback."
            />
          </div>
        </Reveal>
      </section>

      {/* PLATFORM SURFACES — discoverability for the BlackRock-shaped views */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-14 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-secondary border-y border-separator-opaque/20 min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="text-center mb-8 sm:mb-10 md:mb-12">
            <div className="inline-block text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary mb-2 sm:mb-3">
              Have a look around
            </div>
            <h2 className="text-[24px] sm:text-[28px] md:text-[36px] lg:text-[44px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 sm:mb-4 break-words">
              Every corner of ZKward is public.
            </h2>
            <p className="text-sm sm:text-callout md:text-[18px] text-label-secondary max-w-[640px] mx-auto leading-relaxed sm:leading-[1.5] px-1">
              The dashboard, the agents, the proofs, the whitepaper, the story.
              Nothing hidden behind a login except your own wallet.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 min-w-0">
            <SurfaceCard
              href="/dashboard"
              eyebrow="Dashboard"
              title="Your pool, in one screen."
              body="Balance, hedges, drawdown, and the proof feed. Refreshes every minute. What you see is what the chain says."
            />
            <SurfaceCard
              href="/rwa"
              eyebrow="Real-world assets"
              title="Off-chain assets, on-chain proof."
              body="Custodian signatures bind portfolios to real assets while keeping the holdings private. Built for issuers and institutions."
            />
            <SurfaceCard
              href="/agents"
              eyebrow="The seven agents"
              title="Meet the specialists."
              body="Lead, Risk, Hedging, Settlement, Reporting, Price Monitor, SUI Pool. Each has a job. Big trades need 2-of-3 to agree."
            />
            <SurfaceCard
              href="/zk"
              eyebrow="Zero-knowledge proofs"
              title="Not screenshots. Math."
              body="Post-quantum STARK proofs, verifiable in your browser. 180-bit soundness. No trusted setup, no elliptic curves."
            />
            <SurfaceCard
              href="/story"
              eyebrow="Our story"
              title="How we got here."
              body="A five-minute read. Warm, honest, and yes, we tell you when we lose money. That is the whole point."
            />
            <SurfaceCard
              href="/whitepaper"
              eyebrow="Whitepaper"
              title="The technical version."
              body="Prediction-market alpha, 7-agent architecture, STARK-attested execution, roadmap, references. For the engineers in the room."
            />
          </div>
        </Reveal>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* FOOTER CTA                                                      */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-14 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <div className="max-w-[720px] mx-auto text-center min-w-0">
          <h2 className="text-[24px] sm:text-[32px] md:text-[40px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 break-words">
            Come see it running.
          </h2>
          <p className="text-sm sm:text-callout text-label-secondary mb-6 leading-relaxed px-1">
            Connect a wallet, deposit USDC, close the tab. The AI takes it from there.
            {pool && <> {formatCount(pool.memberCount, 'member', 'members')} already in.</>}
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/dashboard"
              className="group inline-flex items-center justify-center gap-3 w-full sm:w-auto pl-6 pr-2.5 h-[52px] bg-ios-blue text-white text-headline font-semibold rounded-ios-xl hover:bg-ios-blueHover active:scale-[0.97] shadow-ios-2"
              style={{ transition: `all 500ms ${SPRING}` }}
            >
              Deposit USDC
              <span
                aria-hidden
                className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center group-hover:translate-x-1 group-hover:-translate-y-[1px] group-hover:scale-105"
                style={{ transition: `transform 500ms ${SPRING}` }}
              >
                <ArrowRight className="w-4 h-4" strokeWidth={2.5} />
              </span>
            </Link>
            <a
              href="https://github.com/ZkVanguard/zkward-ethglobal"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 h-[52px] px-2 text-headline font-medium text-label-secondary hover:text-ios-blue transition-colors"
            >
              View source
              <ArrowRight className="w-4 h-4" strokeWidth={2.25} />
            </a>
          </div>
          {pool?.paused && (
            <p className="mt-4 text-footnote text-ios-orange font-medium">
              Deposits currently paused for maintenance.
            </p>
          )}
        </div>
      </section>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Subcomponents (page-specific — shared primitives live in ./ui/landing)
// ───────────────────────────────────────────────────────────────────────────

// VaultMeter — the hero's signature element. A single card that IS the
// vault's live state: NAV, allocation, capacity. Replaces the generic
// text-hero + 4-stat-card pattern. Every landing sells; this one shows.
function VaultMeter({
  pool, loading, cap,
}: {
  pool: PoolSummary | null | undefined;
  loading: boolean;
  cap: number;
}) {
  const entries = pool
    ? Object.entries(pool.allocation || {})
        .filter(([, v]) => Number(v) > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]))
    : [];
  const capacityPct = pool ? Math.min(100, (pool.totalNAV / cap) * 100) : 0;

  // Double-Bezel structure (soft-skill Doppelrand). Outer shell reads
  // as an aluminium tray with a hairline ring; inner core is the glass
  // plate with a subtle inner-highlight catching a light source above.
  // Radii are mathematically concentric: outer 28px minus 6px padding
  // = 22px inner. Reads as machined hardware, not a flat browser card.
  return (
    <div className="rounded-[28px] bg-gradient-to-b from-black/[0.03] to-black/[0.015] ring-1 ring-black/[0.06] p-1.5">
      <div className="relative bg-system-bg-primary rounded-[22px] p-4 sm:p-6 overflow-hidden shadow-[inset_0_1px_1px_rgba(255,255,255,0.7),inset_0_-1px_1px_rgba(0,0,0,0.02)]">
      {/* Brand accent bar — thinner + softer gradient for machined feel */}
      <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-ios-blue to-transparent" />

      {/* NAV + Share price */}
      <div className="flex items-end justify-between gap-4 mb-5 sm:mb-6 pt-1">
        <div className="min-w-0">
          <div className="text-[10px] sm:text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-1.5">
            Pool NAV
          </div>
          {loading ? (
            // Skeleton matches final NAV width (~7ch) + height so data
            // arrival doesn't shift or "pop" — premium detail.
            <div className="h-[36px] sm:h-[52px] md:h-[60px] w-[7ch] rounded-md bg-system-bg-grouped animate-pulse" />
          ) : (
            <div className="text-[36px] sm:text-[52px] md:text-[60px] font-bold tabular-nums leading-none text-label-primary break-all">
              {formatUsd(pool?.totalNAV ?? 0)}
            </div>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-[10px] sm:text-caption-1 uppercase tracking-wide font-semibold text-label-tertiary mb-1.5">
            Share price
          </div>
          {loading ? (
            <div className="h-[20px] sm:h-[26px] w-[6ch] rounded-md bg-system-bg-grouped animate-pulse ml-auto" />
          ) : (
            <div className="text-[20px] sm:text-[26px] font-semibold tabular-nums text-label-primary">
              {`$${(pool?.sharePrice ?? 1).toFixed(4)}`}
            </div>
          )}
        </div>
      </div>

      {/* Composition bar + legend */}
      <div className="mb-5 sm:mb-6">
        <div className="h-2.5 rounded-full overflow-hidden flex bg-system-bg-grouped">
          {entries.length > 0 ? entries.map(([asset, pct]) => (
            <div
              key={asset}
              className={`bg-gradient-to-r ${ASSET_GRADIENTS[asset] || 'from-gray-300 to-gray-400'} transition-all duration-500`}
              style={{ width: `${pct}%` }}
              title={`${asset} ${pct}%`}
            />
          )) : (
            <div className="w-full bg-system-bg-grouped animate-pulse" />
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3 text-xs sm:text-caption-1">
          {entries.map(([asset, pct]) => (
            <div key={asset} className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full bg-gradient-to-br ${ASSET_GRADIENTS[asset]}`} />
              <span className="font-semibold text-label-primary">{asset}</span>
              <span className="tabular-nums text-label-secondary">{Number(pct).toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Capacity */}
      <div className="pt-5 sm:pt-6 border-t border-separator-opaque/30">
        <div className="flex items-center justify-between text-xs sm:text-caption-1 mb-2">
          <span className="text-label-tertiary uppercase tracking-wide font-semibold">Capacity</span>
          {loading ? (
            <span className="inline-block h-[12px] w-[12ch] rounded bg-system-bg-grouped animate-pulse" />
          ) : (
            <span className="tabular-nums text-label-secondary">
              {`${formatUsd(pool?.totalNAV ?? 0)} of ${formatUsd(cap)}`}
            </span>
          )}
        </div>
        <div className="h-1 rounded-full bg-system-bg-grouped overflow-hidden">
          <div
            className="h-full bg-ios-blue rounded-full transition-all duration-700 ease-out"
            style={{ width: `${capacityPct}%` }}
          />
        </div>
      </div>
      </div>
    </div>
  );
}

// TimelineStep — vertical connected step. Replaces the banned "3 equal
// feature cards" pattern. Content genuinely is a sequence, so numbers help.
function TimelineStep({
  step, icon, accent, title, body, last = false,
}: {
  step: number;
  icon: React.ReactNode;
  accent: string;
  title: string;
  body: string;
  last?: boolean;
}) {
  return (
    <div className="relative flex gap-4 sm:gap-6 pb-8 sm:pb-10 last:pb-0">
      {!last && (
        <div className="absolute left-[19px] sm:left-[23px] top-11 sm:top-13 bottom-2 w-px bg-gradient-to-b from-separator-opaque/60 to-separator-opaque/10" />
      )}
      <div className="relative flex-shrink-0">
        <div className={`w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-gradient-to-br ${accent} text-white flex items-center justify-center shadow-ios-1`}>
          {icon}
        </div>
        <div className="absolute -top-1.5 -right-1.5 w-5 h-5 sm:w-6 sm:h-6 rounded-full bg-white border border-separator-opaque/40 text-[10px] sm:text-caption-1 font-bold text-label-primary flex items-center justify-center tabular-nums">
          {step}
        </div>
      </div>
      <div className="flex-1 min-w-0 pt-1">
        <h3 className="text-lg sm:text-title-3 font-semibold text-label-primary mb-1.5 break-words">
          {title}
        </h3>
        <p className="text-sm sm:text-callout text-label-secondary leading-relaxed break-words">
          {body}
        </p>
      </div>
    </div>
  );
}

function SurfaceCard({
  href, eyebrow, title, body,
}: {
  href: string; eyebrow: string; title: string; body: string;
}) {
  return (
    <Link
      href={href}
      className="group block bg-system-bg-primary rounded-ios-xl p-4 sm:p-5 md:p-6 border border-separator-opaque/30 hover:shadow-ios-2 hover:border-ios-blue/30 active:scale-[0.99] transition-all duration-300 min-w-0"
    >
      <div className="flex items-center justify-between gap-2 mb-2 min-w-0">
        <div className="text-[10px] sm:text-caption-1 font-semibold uppercase tracking-wide text-label-tertiary truncate">
          {eyebrow}
        </div>
        <ArrowRight
          className="w-4 h-4 text-label-tertiary group-hover:text-ios-blue group-hover:translate-x-1 transition-all flex-shrink-0"
          strokeWidth={2}
        />
      </div>
      <h3 className="text-sm sm:text-headline font-semibold text-label-primary mb-1 sm:mb-1.5 leading-tight break-words">
        {title}
      </h3>
      <p className="text-xs sm:text-subheadline text-label-secondary leading-relaxed sm:leading-[1.5] break-words">{body}</p>
    </Link>
  );
}
