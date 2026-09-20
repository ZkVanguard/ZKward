"use client";

import React from 'react';
import Image from 'next/image';

export function Logo({ className = '', alt = 'ZKward' }: { className?: string; alt?: string }) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {/* No `priority` — Next 16 injects <link rel="preload"> for it, then
          renders the <img> after hydration, so the browser flags the
          preload as unused. The SVG is ~2 KB and lives in the navbar
          (top of every page); it loads instantly regardless. */}
      <Image
        src="/logo-official.svg"
        alt={alt}
        width={36}
        height={36}
        className="h-9 w-9 rounded-lg"
      />
      <span className="text-title-3 font-semibold text-label-primary tracking-tight hidden sm:inline">
        ZKward
      </span>
    </div>
  );
}

export default Logo;
