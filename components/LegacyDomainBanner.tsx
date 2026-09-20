'use client';

/**
 * Rebrand transition banner.
 *
 * Shown only when the current hostname is a zkvanguard.xyz variant.
 * Client-side check so a single build serves both origins without
 * SSR needing to know the request host. Dismissible per-session
 * (sessionStorage) so it doesn't nag users who saw it once.
 *
 * Remove this component entirely (and its import in [locale]/layout.tsx)
 * once zkvanguard.xyz is fully retired (planned ≥12 months after cutover
 * per proxy.ts ALLOWED_ORIGINS comment).
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

const LEGACY_HOSTS = new Set(['zkvanguard.xyz', 'www.zkvanguard.xyz']);
const DISMISS_KEY = 'legacy-domain-banner-dismissed';

export function LegacyDomainBanner() {
  const t = useTranslations('legacyBanner');
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!LEGACY_HOSTS.has(window.location.hostname)) return;
    if (sessionStorage.getItem(DISMISS_KEY) === '1') return;
    setShow(true);
  }, []);

  if (!show) return null;

  const newUrl = typeof window !== 'undefined'
    ? `https://zkward.com${window.location.pathname}${window.location.search}`
    : 'https://zkward.com';

  return (
    <div
      role="status"
      style={{
        background: '#111827',
        color: '#f9fafb',
        padding: '10px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        fontSize: 14,
        lineHeight: 1.4,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexWrap: 'wrap',
      }}
    >
      <span>
        {t.rich('message', {
          strong: (chunks) => <strong>{chunks}</strong>,
          link: (chunks) => (
            <a
              href={newUrl}
              style={{ color: '#60a5fa', textDecoration: 'underline', fontWeight: 600 }}
            >
              {chunks}
            </a>
          ),
        })}
      </span>
      <button
        type="button"
        onClick={() => {
          sessionStorage.setItem(DISMISS_KEY, '1');
          setShow(false);
        }}
        aria-label={t('dismiss')}
        style={{
          background: 'transparent',
          color: '#9ca3af',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 4,
          padding: '2px 8px',
          cursor: 'pointer',
          fontSize: 13,
        }}
      >
        {t('dismiss')}
      </button>
    </div>
  );
}
