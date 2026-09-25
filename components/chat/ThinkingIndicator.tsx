'use client';

import { useEffect, useState } from 'react';

/**
 * Cheerful "thinking" indicator for chat streams.
 *
 * The plain spinner reads as stuck — this replaces it with three
 * gradient dots bouncing on a lazy 900 ms cycle plus a status label
 * that rotates every 1.4 s through 4 phases so users can see the
 * agent is actively working, not frozen.
 *
 * Zero dependencies beyond React + Tailwind. Cycling stops when the
 * component unmounts (which happens the moment the first content
 * token arrives).
 */

export interface ThinkingIndicatorProps {
  /**
   * Overriding label list. Rotates round-robin every 1.4 s.
   * When only one string is passed the label stays static.
   */
  phases?: string[];
  /** Extra classes for the outer flex container. */
  className?: string;
}

const DEFAULT_PHASES = [
  'Thinking',
  'Checking signals',
  'Consulting sources',
  'Cross-referencing',
];

export function ThinkingIndicator({
  phases = DEFAULT_PHASES,
  className = '',
}: ThinkingIndicatorProps) {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (phases.length <= 1) return;
    const id = setInterval(() => setI((prev) => (prev + 1) % phases.length), 1400);
    return () => clearInterval(id);
  }, [phases.length]);

  return (
    <span
      className={`inline-flex items-center gap-2 text-label-tertiary text-body ${className}`}
      aria-live="polite"
      aria-label={phases[i]}
    >
      <span className="flex items-center gap-1">
        <span
          className="w-1.5 h-1.5 rounded-full bg-gradient-to-br from-violet-400 to-fuchsia-400 animate-bounce"
          style={{ animationDelay: '0ms', animationDuration: '900ms' }}
        />
        <span
          className="w-1.5 h-1.5 rounded-full bg-gradient-to-br from-fuchsia-400 to-rose-400 animate-bounce"
          style={{ animationDelay: '150ms', animationDuration: '900ms' }}
        />
        <span
          className="w-1.5 h-1.5 rounded-full bg-gradient-to-br from-rose-400 to-amber-400 animate-bounce"
          style={{ animationDelay: '300ms', animationDuration: '900ms' }}
        />
      </span>
      <span
        key={i}
        className="bg-gradient-to-r from-violet-500 via-fuchsia-500 to-rose-500 bg-clip-text text-transparent font-medium"
        // Small fade-in on each phase switch — CSS-only, keyed on i so React remounts.
        style={{ animation: 'fadeInThinking 400ms ease-out' }}
      >
        {phases[i]}
        <span className="text-label-tertiary">…</span>
      </span>
      <style>{`
        @keyframes fadeInThinking {
          from { opacity: 0.3; transform: translateY(1px); }
          to   { opacity: 1;   transform: translateY(0);   }
        }
      `}</style>
    </span>
  );
}
