'use client';

/**
 * What a visitor sees when a view throws: what happened, a way to retry and
 * a reference to quote. Before this a crashed view was a blank area.
 *
 * Used two ways: `SectionErrorBoundary` wraps one part of a page so the rest
 * keeps working; the route-level `error.tsx` files render `CrashScreen` for
 * anything that escapes.
 */
import { Component, useEffect, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { reportClientError } from '@/lib/utils/client-error-reporter';

export function CrashScreen({ error, onRetry }: { error: Error & { digest?: string }; onRetry: () => void }) {
  const t = useTranslations('crash');
  useEffect(() => {
    reportClientError({ kind: 'boundary', message: error.message || 'render error', stack: error.stack });
  }, [error]);
  return (
    <div role="alert" className="mx-auto max-w-md rounded-2xl border border-black/10 bg-white p-6 text-center my-8">
      <h2 className="text-[17px] font-semibold text-[#1d1d1f]">{t('title')}</h2>
      <p className="mt-2 text-[13px] leading-snug text-[#6e6e73]">{t('body')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex h-10 items-center rounded-xl bg-[#007AFF] px-5 text-[13px] font-semibold text-white active:scale-[0.98]"
      >
        {t('retry')}
      </button>
      {error.digest && <p className="mt-3 font-mono text-[11px] text-[#86868b]">{t('reference', { id: error.digest })}</p>}
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  /** Changing this clears a shown crash, e.g. the view the visitor switched to. */
  resetKey?: string;
}

export class SectionErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prev: BoundaryProps) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (this.state.error) return <CrashScreen error={this.state.error} onRetry={() => this.setState({ error: null })} />;
    return this.props.children;
  }
}
