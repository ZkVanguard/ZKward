/**
 * Shared sidebar nav button — used by both Menu + Platform sections of the
 * desktop sidebar, and (via the same shape) the mobile drawer nav.
 *
 * Extracted from dashboard/page.tsx 2026-09-18: the same 30-line JSX
 * was duplicated inline three times. One component, one visual spec.
 */
import type { ComponentType } from 'react';

// Icon type widened to any ComponentType accepting className — matches the
// nav-items registry which uses both lucide + custom icons.
interface Props {
  icon: ComponentType<{ className?: string }>;
  label: string;
  isActive: boolean;
  badge?: string | number;
  onClick: () => void;
}

export function SidebarNavButton({ icon: Icon, label, isActive, badge, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      className={`w-[calc(100%-16px)] mx-2 mb-1 flex items-center gap-3 px-4 py-2.5 rounded-[12px] text-left transition-all duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] ${
        isActive
          ? 'bg-ios-blue shadow-[0_2px_8px_rgba(0,105,217,0.25)]'
          : 'hover:bg-system-bg-secondary'
      }`}
    >
      <Icon className={`w-5 h-5 ${isActive ? 'text-white' : 'text-label-quaternary'}`} />
      <span className={`text-[15px] font-medium tracking-[-0.01em] ${isActive ? 'text-white' : 'text-label-primary'}`}>
        {label}
      </span>
      {badge && (
        <span
          className={`ml-auto px-2 py-0.5 text-[11px] font-semibold rounded-full shadow-sm ${
            isActive ? 'bg-white/20 text-white' : 'bg-ios-green text-white'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
