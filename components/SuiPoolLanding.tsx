'use client';

import { memo, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/routing';
import {
  ArrowRight, ShieldCheck, Zap,
  Sparkles,
} from 'lucide-react';
import { InstallAppButton } from './InstallAppButton';
import { DataSourceMarquee } from './landing/DataSourceMarquee';
import { LiveSignalStrip } from './landing/LiveSignalStrip';
import { Safeguards } from './landing/Safeguards';
import { Reveal } from './ui/landing';

// Linear's signature spring curve. Read as: quick out, slow in — feels
// like real mass behind interactive elements instead of the default
// ease-in-out "slide-and-stop" cadence.
const SPRING = 'cubic-bezier(0.32, 0.72, 0, 1)';

import { useReducedMotion } from 'framer-motion';


// Touch devices have no cursor, so the hero's depth layers took no input
// at all there and the backdrop was hidden. This drives the same --sx/--sy
// from the phone's tilt (where the browser reports it without a prompt)
// and from scroll, so the layers still move at different speeds. Gated to
// coarse pointers: the desktop cursor-follow was removed by design.
function useTiltParallax<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) return;
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    let tiltX = 0, tiltY = 0, scrollY = 0, raf = 0;
    const apply = () => {
      raf = 0;
      el.style.setProperty('--sx', `${50 + tiltX}%`);
      el.style.setProperty('--sy', `${50 + tiltY + scrollY}%`);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply); };
    const onOrient = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return;
      // gamma: left-right roll (−90..90); beta: front-back pitch, ~45° when held normally.
      tiltX = clamp(e.gamma / 30, -1, 1) * 28;
      tiltY = clamp((e.beta - 45) / 30, -1, 1) * 18;
      schedule();
    };
    const onScroll = () => {
      const r = el.getBoundingClientRect();
      scrollY = clamp(-r.top / Math.max(1, r.height), 0, 1) * 36;
      schedule();
    };
    window.addEventListener('deviceorientation', onOrient);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener('deviceorientation', onOrient);
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, [ref, reduce]);
}


// Signal-source strip — real providers the aggregator reads every tick.
// Colors are each brand's public-facing accent, used only as a small dot
// (nominative fair use — describing which services we consume, not
// asserting endorsement). Ordered by weight class: prediction markets
// first, then venues, then options.

// HeroGraphBg. Three parallax layers behind the hero (CSS dot-grid +
// SVG chart curves + SVG node network). Reads --sx/--sy already
// published by useCursorSpotlight, translates each layer by a different
// factor (calc((--sx - 50%) * k)) so back layers drift slowly and the
// front layer tracks the cursor faster. That differential IS the 3D cue.
// All ios-blue at low opacity so the white canvas stays clean. On phones
// it is lighter (see .hero-graph-bg in globals.css) so the headline stays
// legible, and it moves with tilt and scroll (useTiltParallax).
//
// Reduced-motion + hydration: gated purely in CSS (@media prefers-
// reduced-motion). Not useReducedMotion() — that returns null on server
// and a real value on client's first render, which caused a hydration
// mismatch on the earlier revision.
// Front layer geometry. Replaced the previous 7-node polygon graph
// with Vogel's phyllotaxis (sunflower seed spiral). Each dot sits at
// angle i × golden-angle from the center and radius √i × scale. The
// resulting pattern shows both clockwise and counter-clockwise
// Fibonacci-numbered spiral arms. The exact math nature uses for
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
// One continuous smooth curve winding out from the center. The
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

// Precomputed parallax styles. Hoisting kills the per-render allocation
// that would happen if we built these objects inside the component.
// The factor triplet (-0.03, -0.07, -0.13) drives the differential
// translate; the Z-offset triplet (-40, 0, +30) drives real perspective
// depth (parent has perspective: 1400px). Combined, layers sit at
// physically different distances AND drift at different apparent
// speeds. The "3D" cue is both.
//
// Transition tightened 700ms → 250ms with a faster ease-out. Previous
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
  // the "3D" cue. Not just 2D differential translate. transform-style:
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
      className="hero-graph-bg absolute -top-24 left-0 right-0 bottom-0 -z-10 pointer-events-none overflow-hidden"
      style={{
        perspective: '1400px',
        perspectiveOrigin: '50% 30%',
        transformStyle: 'preserve-3d',
        // `contain` isolates this subtree — the browser can skip layout
        // + paint work when nothing inside it changes, and knows the
        // effects don't leak out (accurate: all layers are z-negative
        // absolutes clipped by our own overflow-hidden).
        contain: 'layout paint style',
        // Radial vignette over the headline, subtitle and buttons, so
        // the drifting nodes never sit on the words; the edges keep the
        // full effect for depth. Both prefixed forms so Safari and
        // Firefox agree.
        WebkitMaskImage:
          'radial-gradient(ellipse 48% 42% at 50% 40%, transparent 0%, transparent 48%, black 88%)',
        maskImage:
          'radial-gradient(ellipse 48% 42% at 50% 40%, transparent 0%, transparent 48%, black 88%)',
      }}
    >
      {/* Layer 1 — dot grid via CSS radial-gradient (SVG pattern without a
          viewBox tiles inconsistently across browsers on this project's
          layout; CSS gradient tile is deterministic + one line). Vertical
          fade via mask-image so the grid does not clash with headline
          text or the vault meter card. */}
      <div className="hero-graph-layer absolute -left-32 -right-32 top-0 bottom-0" style={LAYER_1_STYLE} />

      {/* Both SVG layers carry an explicit width: an absolutely positioned
          <svg> is a replaced element and keeps its intrinsic width (height ×
          viewBox ratio) when only left and right are set. On a phone that
          left the chart box ending at the viewport edge, which cut the fill
          in a vertical line. max-w-none opts out of the phone-wide
          `svg { max-width: 100% }` safety rule in globals.css, which would
          cap the box at the viewport again. */}
      {/* Layer 2 — chart polylines. Slow dashoffset sweep on the dashed line
          gives a "live tape" feel without any JS. Paths extended beyond
          viewBox 0-1200 (starting at -200, ending at 1400) so the chart
          keeps going off both sides — the visible container edges then
          show a chart in mid-flow rather than trailing off. `overflow=
          visible` allows the SVG to draw outside the viewBox. Layer
          stays extended -left-32/-right-32 for the 3D depth cue. */}
      <svg
        className="hero-graph-layer absolute -left-32 -right-32 top-0 bottom-0 h-full w-[calc(100%+16rem)] max-w-none"
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
        className="hero-graph-layer absolute -left-32 -right-32 top-0 bottom-0 h-full w-[calc(100%+16rem)] max-w-none"
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
        /* Below the desktop breakpoint: the layers show (they were hidden
           below md), lighter behind a headline that spans the width, and
           their tilt/scroll-driven moves ease over a longer time than the
           desktop cursor did. */
        /* The spiral disk is the busiest layer: kept faint so the hero reads calm. */
        .hero-graph-layer:nth-child(3) { opacity: 0.55; }
        @media (max-width: 1023px) {
          .hero-graph-bg {
            opacity: 0.72;
            /* The inline vignette clears an ellipse half the width of the
               box. At 1440px that is a soft centre; at 768px and below its
               edge falls inside the view and slices the chart fill with a
               vertical line. These layers are faint already, so no vignette. */
            -webkit-mask-image: none !important;
            mask-image: none !important;
          }
          /* The spiral disk is the busiest layer and the headline and stats
             fill the whole hero on a phone, so it goes fainter there. */
          .hero-graph-layer:nth-child(3) { opacity: 0.3; }
          .hero-graph-layer { transition-duration: 450ms; }
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
  const t = useTranslations('landing');
  // Cursor-follow on desktop was removed by design; on touch devices the
  // hero's depth layers follow tilt and scroll instead.
  const heroRef = useRef<HTMLElement>(null);
  useTiltParallax(heroRef);

  return (
    <div className="bg-system-bg-primary text-label-primary">
      {/* ─────────────────────────────────────────────────────────────── */}
      {/* HERO                                                            */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section ref={heroRef} className="relative isolate pt-20 pb-8 sm:pt-32 sm:pb-12 lg:pt-36 lg:pb-16 px-4 sm:px-5 lg:px-8 overflow-x-clip min-w-0">
        {/* Apple-style soft gradient backdrop — extends 100px above so
            the fixed navbar's backdrop-blur has something to blur
            instead of solid white. Height compensated via inset. */}
        <div className="absolute -top-24 left-0 right-0 bottom-0 -z-10 bg-gradient-to-b from-system-bg-tertiary via-system-bg-primary to-system-bg-primary" />
        {/* Depth-parallax graph backdrop (3 layers, cursor-driven).
            Reuses --sx/--sy from useCursorSpotlight — no extra listener.
            Extends up under the navbar (see HeroGraphBg for details). */}
        <HeroGraphBg />
        <div className="max-w-[1100px] mx-auto">

          {/* Two short lines; the promise (line two) carries the brand accent. */}
          <h1
            className="font-display text-center text-[38px] xs:text-[44px] sm:text-[54px] md:text-[62px] lg:text-[68px] xl:text-[80px] font-semibold tracking-[-0.04em] leading-[0.96] text-label-primary mb-4 sm:mb-6"
            style={{ textWrap: 'balance', hyphens: 'none', overflowWrap: 'normal' }}
          >
            {t('hero.headline1')}
            <br />
            <span className="whitespace-nowrap bg-gradient-to-r from-ios-blue via-[#3B82F6] to-[#5AC8FA] bg-clip-text text-transparent">{t('hero.headline2')}</span>
          </h1>

          {/* Subtitle — plain-English promise; brand-forward for search. */}
          <p className="text-center text-base sm:text-[19px] text-label-secondary max-w-[600px] mx-auto leading-relaxed mb-8 sm:mb-10 px-1">
            {t('hero.subtitle')}
          </p>

          {/* One clear next step. The app is where every path starts (signals,
              the simulated book, deposits), so the hero offers exactly that,
              plus a way to learn more first. */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-12 sm:mb-16">
            <Link
              href="/dashboard"
              className="group inline-flex items-center justify-center gap-3 w-full sm:w-auto pl-7 pr-2.5 h-[56px] bg-ios-blue text-white text-headline font-semibold rounded-ios-xl hover:bg-ios-blueHover active:scale-[0.97] shadow-ios-2"
              style={{ transition: `all 500ms ${SPRING}` }}
            >
              {t('cta.openApp')}
              <span
                aria-hidden
                className="w-10 h-10 rounded-full bg-white/15 flex items-center justify-center group-hover:translate-x-1"
                style={{ transition: `transform 500ms ${SPRING}` }}
              >
                <ArrowRight className="w-4 h-4" strokeWidth={2.5} />
              </span>
            </Link>
            <a
              href="#how-it-works"
              className="inline-flex items-center justify-center w-full sm:w-auto h-[56px] px-6 rounded-ios-xl border border-separator-opaque/50 bg-white/70 backdrop-blur text-headline font-semibold text-label-primary hover:border-ios-blue/40 hover:text-ios-blue transition-colors"
            >
              {t('cta.howItWorks')}
            </a>
          </div>

          <LiveSignalStrip />


          <DataSourceMarquee />

          {/* Install-as-app row — renders nothing when already installed or the
              browser hasn't emitted beforeinstallprompt yet. */}
          <div className="flex justify-center">
            <InstallAppButton className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-white/80 backdrop-blur border border-separator-opaque/40 text-label-secondary text-sm font-medium hover:text-ios-blue hover:border-ios-blue/40 active:scale-[0.98] transition-all" />
          </div>

        </div>
      </section>

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* HOW IT WORKS                                                    */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-14 sm:py-20 md:py-28 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <Reveal className="max-w-[1100px] mx-auto">
          <div className="text-center mb-10 sm:mb-14 md:mb-16">
            <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-wide text-ios-blue mb-2 sm:mb-3">
              {t('howItWorks.eyebrow')}
            </p>
            <h2 className="text-[26px] sm:text-[34px] md:text-[44px] lg:text-[52px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 sm:mb-4 break-words">
              {t('howItWorks.title')}
            </h2>
          </div>

          <div className="max-w-[760px] mx-auto min-w-0">
            <TimelineStep
              step={1}
              icon={<Sparkles className="w-5 h-5" />}
              accent="from-ios-blue to-[#5AC8FA]"
              title={t('howItWorks.step1.title')}
              body={t('howItWorks.step1.body')}
            />
            <TimelineStep
              step={2}
              icon={<Zap className="w-5 h-5" />}
              accent="from-[#34C759] to-[#30D158]"
              title={t('howItWorks.step2.title')}
              body={t('howItWorks.step2.body')}
            />
            <TimelineStep
              step={3}
              icon={<ShieldCheck className="w-5 h-5" />}
              accent="from-[#AF52DE] to-[#BF5AF2]"
              title={t('howItWorks.step3.title')}
              body={t('howItWorks.step3.body')}
              last
            />
          </div>
        </Reveal>
      </section>

      <Safeguards />

      {/* ─────────────────────────────────────────────────────────────── */}
      {/* FOOTER CTA                                                      */}
      {/* ─────────────────────────────────────────────────────────────── */}
      <section className="py-14 sm:py-20 md:py-24 px-4 sm:px-5 lg:px-8 bg-system-bg-primary min-w-0">
        <div className="max-w-[720px] mx-auto text-center min-w-0">
          <h2 className="text-[24px] sm:text-[32px] md:text-[40px] font-display font-semibold tracking-[-0.03em] leading-[1.05] text-label-primary mb-3 break-words">
            {t('finalCta.title')}
          </h2>
          <div className="mb-6" />
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link
              href="/dashboard"
              className="group inline-flex items-center justify-center gap-3 w-full sm:w-auto pl-6 pr-2.5 h-[52px] bg-ios-blue text-white text-headline font-semibold rounded-ios-xl hover:bg-ios-blueHover active:scale-[0.97] shadow-ios-2"
              style={{ transition: `all 500ms ${SPRING}` }}
            >
              {t('cta.openApp')}
              <span
                aria-hidden
                className="w-9 h-9 rounded-full bg-white/15 flex items-center justify-center group-hover:translate-x-1 group-hover:-translate-y-[1px] group-hover:scale-105"
                style={{ transition: `transform 500ms ${SPRING}` }}
              >
                <ArrowRight className="w-4 h-4" strokeWidth={2.5} />
              </span>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
});

// ───────────────────────────────────────────────────────────────────────────
// Subcomponents (page-specific. Shared primitives live in ./ui/landing)
// ───────────────────────────────────────────────────────────────────────────

// TimelineStep. Vertical connected step. Replaces the banned "3 equal
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

