"use client";

import React from 'react';
import Image from 'next/image';

export function Logo({ className = '', alt = 'ZKward' }: { className?: string; alt?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      {/* Glass tile — lifts the mark off the navbar's own glass so it
          reads as brand, not blended background. Inner top-highlight +
          soft outer shadow do the glass-on-glass work; backdrop-blur
          keeps the tile crisp when the hero art moves behind it. */}
      <span
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-[12px] border border-white/50 bg-gradient-to-b from-white/60 to-white/25 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_2px_rgba(0,0,0,0.08),0_4px_12px_-4px_rgba(83,114,255,0.25)]"
      >
        {/* No `priority` — Next 16 injects <link rel="preload"> for it, then
            renders the <img> after hydration, so the browser flags the
            preload as unused. The SVG is ~2 KB and lives in the navbar
            (top of every page); it loads instantly regardless. */}
        <Image
          src="/logo-official.svg"
          alt={alt}
          width={32}
          height={32}
          className="h-8 w-8"
        />
      </span>
      <span className="text-title-3 font-semibold text-label-primary tracking-tight hidden sm:inline">
        ZKward
      </span>
    </div>
  );
}

export default Logo;
