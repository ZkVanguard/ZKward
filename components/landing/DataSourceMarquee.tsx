'use client';

/**
 * The markets the signal stack reads, as a scrolling strip of their logos.
 *
 * Why a strip and not a list of names: visitors recognise a logo faster than
 * a word, and these providers appear in every source cell of the ledger, so
 * showing them is social proof that stays true by itself. Every file in
 * `public/logos/sources/` is the provider's own published wordmark (brand
 * kit or docs site), unaltered apart from a mono fill on the two that are
 * only published in white.
 *
 * The track is rendered twice and translated by half its width, so the loop
 * is seamless. It pauses on hover and focus, and with reduced motion it
 * stands still as a wrapped row (see `.source-marquee` in globals.css).
 */
import { useEffect, useRef } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { SIGNAL_PROVIDERS, logoPath, type SignalProvider } from '@/lib/api/signal-providers';

const LOGO_HEIGHT = 26;

function Tile({ source, copy }: { source: SignalProvider; copy?: boolean }) {
  const t = useTranslations('landing.sources');
  const role = t(`roles.${source.role}`);
  const height = source.markOnly ? 30 : LOGO_HEIGHT;
  return (
    <a
      href={source.href}
      target="_blank"
      rel="noopener noreferrer"
      aria-hidden={copy}
      tabIndex={copy ? -1 : 0}
      title={`${source.name} · ${role}`}
      className="group flex items-center gap-2.5 h-16 px-6 rounded-2xl border border-separator-opaque/40 bg-white shrink-0 opacity-90 transition-all duration-200 hover:opacity-100 hover:border-separator-opaque hover:shadow-ios-1 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/60"
    >
      <Image
        src={logoPath(source)}
        alt={`${source.name} logo`}
        width={Math.round(height * source.ratio)}
        height={height}
        unoptimized
        // The second copy starts off-screen; lazy loading would leave its tiles blank as they scroll in.
        loading="eager"
        style={{ height, width: 'auto' }}
      />
      {source.markOnly && (
        <span className="text-[17px] font-semibold tracking-[-0.02em] text-label-primary">{source.name}</span>
      )}
      <span className="sr-only">{role}</span>
    </a>
  );
}

export function DataSourceMarquee() {
  const t = useTranslations('landing.sources');
  const mask = 'linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent)';
  // Stop the loop while the strip is off screen (styles/globals.css reads
  // data-offscreen): no compositor work for a strip nobody can see.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      el.dataset.offscreen = e.isIntersecting ? 'false' : 'true';
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div className="mx-auto max-w-[1100px] mb-12 sm:mb-16 min-w-0">
      <p className="text-center text-[10px] sm:text-caption-2 font-semibold uppercase tracking-[0.14em] text-label-tertiary mb-4 sm:mb-5">
        {t('eyebrow')}
      </p>
      <div ref={ref} className="source-marquee relative overflow-hidden" style={{ WebkitMaskImage: mask, maskImage: mask }}>
        <div className="source-marquee-track flex w-max gap-3 sm:gap-4 py-1">
          {SIGNAL_PROVIDERS.map((s) => <Tile key={s.slug} source={s} />)}
          {SIGNAL_PROVIDERS.map((s) => <Tile key={`${s.slug}-copy`} source={s} copy />)}
        </div>
      </div>
    </div>
  );
}
