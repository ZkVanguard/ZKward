"use client";

import React from 'react';
import Image from 'next/image';

export function Logo({ className = '', alt = 'ZKward' }: { className?: string; alt?: string }) {
  return (
    <div className={`flex shrink-0 items-center gap-2.5 ${className}`}>
      {/* Glass tile — lifts the mark off the navbar's own glass so it
          reads as brand, not blended background. Inner top-highlight +
          soft outer shadow do the glass-on-glass work; backdrop-blur
          keeps the tile crisp when the hero art moves behind it.

          36px in the 56px bar leaves 10px of air above and below. At 40px
          it left 8px and the tile read as cropped by the bar. shrink-0 on
          the tile and the mark so no flex pressure in the navbar row can
          squeeze the lockup out of square. */}
      <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-white/50 bg-gradient-to-b from-white/60 to-white/25 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_-4px_rgba(83,114,255,0.25)]">
        {/* No `priority` — Next 16 injects <link rel="preload"> for it, then
            renders the <img> after hydration, so the browser flags the
            preload as unused. The SVG is ~2 KB and lives in the navbar
            (top of every page); it loads instantly regardless.

            32px mark in a 36px tile. Measured SVG bbox uses only 82% of its
            500x500 viewBox, so the visible mark lands at ~26px inside the
            tile — enough presence to read as brand, still 2px of tile
            around it. overflow-hidden on the tile clips defensively so no
            SVG stroke can escape past the rounded corner. */}
        <Image
          src="/logo-official.svg"
          alt={alt}
          width={32}
          height={32}
          className="h-8 w-8 shrink-0"
        />
      </span>
      <span className="text-title-3 font-semibold text-label-primary tracking-tight hidden sm:inline">
        ZKward
      </span>
    </div>
  );
}

export default Logo;
