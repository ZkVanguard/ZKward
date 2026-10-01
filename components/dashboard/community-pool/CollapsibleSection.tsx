'use client';

import { memo, useEffect, useState, useRef, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

interface CollapsibleSectionProps {
  title: ReactNode;
  summary?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  /** Default open on desktop, closed on mobile. Set `defaultOpenMobile` to override. */
  defaultOpenMobile?: boolean;
  /** Also collapsible at ≥640px (heavy, rarely-needed panels). */
  collapsibleOnDesktop?: boolean;
  /** Initial state on desktop when `collapsibleOnDesktop`. */
  defaultOpenDesktop?: boolean;
  className?: string;
}

/**
 * iOS-style collapsible section for the community pool.
 * - Below 640px: starts closed unless `defaultOpenMobile`. Header is a full-width
 *   tap target that toggles content.
 * - 640px and up: always expanded (no toggle) unless `collapsibleOnDesktop`.
 *
 * This is how we reduce the "wall of dense cards" the pool used to show on
 * mobile after every panel had loaded.
 */
export const CollapsibleSection = memo(function CollapsibleSection({
  title,
  summary,
  icon,
  children,
  defaultOpenMobile = false,
  collapsibleOnDesktop = false,
  defaultOpenDesktop = true,
  className = '',
}: CollapsibleSectionProps) {
  const [isMobile, setIsMobile] = useState(false);
  const [open, setOpen] = useState(true);
  const mountedRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)');
    const apply = () => {
      const mobile = mq.matches;
      setIsMobile(mobile);
      // Only auto-collapse on first mount; don't fight the user's manual toggles.
      if (!mountedRef.current) {
        setOpen(mobile ? defaultOpenMobile : collapsibleOnDesktop ? defaultOpenDesktop : true);
        mountedRef.current = true;
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [defaultOpenMobile, collapsibleOnDesktop, defaultOpenDesktop]);

  // Desktop / >=sm: a plain section unless this one opted into collapsing
  if (!isMobile && !collapsibleOnDesktop) {
    return <div className={className}>{children}</div>;
  }

  return (
    <div className={`border-b border-gray-100 dark:border-gray-700 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 sm:px-5 py-3 min-h-[52px] hover:bg-black/[0.02] active:bg-black/[0.03] transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {icon && <span className="flex-shrink-0">{icon}</span>}
          <span className="font-semibold text-sm text-gray-900 dark:text-white truncate">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {summary && !open && (
            <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums truncate max-w-[140px]">
              {summary}
            </span>
          )}
          <ChevronDown
            className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${
              open ? 'rotate-180' : ''
            }`}
          />
        </div>
      </button>
      {/* data-inside-collapsible lets the child's own h3 header hide on mobile
          via a CSS rule in globals.css — avoids duplicate "Allocation" +
          "Current Holdings" chrome when a section is opened. */}
      {open && (
        <div className="pb-1" data-inside-collapsible="true">
          {children}
        </div>
      )}
    </div>
  );
});
