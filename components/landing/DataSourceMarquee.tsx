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
import Image from 'next/image';
import { useTranslations } from 'next-intl';

type Role = 'predictionMarket' | 'perpetuals' | 'options' | 'spot' | 'venue';

interface Source {
  name: string;
  slug: string;
  role: Role;
  href: string;
  /** Intrinsic aspect ratio of the wordmark (width / height), so the tile reserves the right width at a fixed height. */
  ratio: number;
  /** A mark-only logo gets the brand name set beside it. */
  markOnly?: boolean;
}

/** Every provider the aggregator reads (see PredictionAggregatorService): markets first, then the exchanges behind the microstructure sources. */
const SOURCES: readonly Source[] = [
  { name: 'Polymarket', slug: 'polymarket', role: 'predictionMarket', href: 'https://polymarket.com', ratio: 911 / 168 },
  { name: 'Kalshi', slug: 'kalshi', role: 'predictionMarket', href: 'https://kalshi.com', ratio: 772 / 226 },
  { name: 'Manifold', slug: 'manifold', role: 'predictionMarket', href: 'https://manifold.markets', ratio: 1, markOnly: true },
  { name: 'Binance', slug: 'binance', role: 'perpetuals', href: 'https://www.binance.com', ratio: 632 / 127 },
  { name: 'Bybit', slug: 'bybit', role: 'perpetuals', href: 'https://www.bybit.com', ratio: 13547 / 4513 },
  { name: 'Deribit', slug: 'deribit', role: 'options', href: 'https://www.deribit.com', ratio: 4000 / 1201 },
  { name: 'Crypto.com', slug: 'crypto-com', role: 'spot', href: 'https://crypto.com/exchange', ratio: 120 / 24 },
  { name: 'BlueFin', slug: 'bluefin', role: 'venue', href: 'https://bluefin.io', ratio: 83 / 18 },
];

const LOGO_HEIGHT = 26;

function Tile({ source, copy }: { source: Source; copy?: boolean }) {
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
        src={`/logos/sources/${source.slug}.svg`}
        alt={`${source.name} logo`}
        width={Math.round(height * source.ratio)}
        height={height}
        unoptimized
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
  return (
    <div className="mx-auto max-w-[1100px] mb-12 sm:mb-16 min-w-0">
      <p className="text-center text-[10px] sm:text-caption-2 font-semibold uppercase tracking-[0.14em] text-label-tertiary mb-4 sm:mb-5">
        {t('eyebrow')}
      </p>
      <div className="source-marquee relative overflow-hidden" style={{ WebkitMaskImage: mask, maskImage: mask }}>
        <div className="source-marquee-track flex w-max gap-3 sm:gap-4 py-1">
          {SOURCES.map((s) => <Tile key={s.slug} source={s} />)}
          {SOURCES.map((s) => <Tile key={`${s.slug}-copy`} source={s} copy />)}
        </div>
      </div>
      <p className="text-center text-[11px] sm:text-caption-1 text-label-tertiary mt-3 sm:mt-4">
        {t('caption')}
      </p>
    </div>
  );
}
