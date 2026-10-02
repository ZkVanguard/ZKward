'use client';

import { useState, useEffect } from 'react';
import { Link } from '@/i18n/routing';
import { useTranslations } from 'next-intl';

export const CONSENT_KEY = 'zkward_cookie_consent';
/** Fired on window when the visitor saves a cookie choice. */
export const CONSENT_EVENT = 'cookie-consent-updated';

interface ConsentSettings {
  necessary: boolean;    // Always true, required for operation
  analytics: boolean;    // Platform improvement analytics
  preferences: boolean;  // User preferences storage
  timestamp: string;
}

export function CookieConsent() {
  const t = useTranslations('cookies');
  const [showBanner, setShowBanner] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [settings, setSettings] = useState<ConsentSettings>({
    necessary: true,
    analytics: false,
    preferences: false,
    timestamp: '',
  });

  useEffect(() => {
    // Check if consent already given
    const stored = localStorage.getItem(CONSENT_KEY);
    if (!stored) {
      // Small delay to prevent flash on page load
      setTimeout(() => setShowBanner(true), 1000);
    } else {
      try {
        const parsed = JSON.parse(stored);
        setSettings(parsed);
      } catch {
        setShowBanner(true);
      }
    }
  }, []);

  const saveConsent = (consent: ConsentSettings) => {
    const withTimestamp = { ...consent, timestamp: new Date().toISOString() };
    localStorage.setItem(CONSENT_KEY, JSON.stringify(withTimestamp));
    setSettings(withTimestamp);
    setShowBanner(false);
    
    // Dispatch event for analytics service to pick up
    window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: withTimestamp }));
  };

  const acceptAll = () => {
    saveConsent({
      necessary: true,
      analytics: true,
      preferences: true,
      timestamp: '',
    });
  };

  const acceptNecessary = () => {
    saveConsent({
      necessary: true,
      analytics: false,
      preferences: false,
      timestamp: '',
    });
  };

  const saveCustom = () => {
    saveConsent(settings);
  };

  if (!showBanner) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[100] px-3 pt-3 pb-safe sm:p-4 sm:pb-safe-4 bg-white/95 backdrop-blur-xl border-t border-black/10 shadow-2xl rounded-t-[24px] sm:rounded-none max-h-[92vh] overflow-y-auto animate-slide-up"
    >
      {/* Sheet-handle indicator on mobile — signals dismiss/interact affordance */}
      <div className="sm:hidden flex justify-center pb-2 -mt-1">
        <div className="w-9 h-1 rounded-full bg-black/15" />
      </div>

      <div className="max-w-6xl mx-auto">
        {!showDetails ? (
          // Simple Banner
          <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 md:gap-4">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-label-primary text-base sm:text-lg mb-0.5 sm:mb-1">
                🍪 {t('title')}
              </h3>
              <p className="text-label-tertiary text-[13px] sm:text-sm leading-relaxed">
                {t('description')}{' '}
                <Link href="/privacy" className="text-ios-blue underline underline-offset-2">{t('privacyPolicy')}</Link>
              </p>
            </div>
            {/* Primary CTA on top on mobile for thumb reach */}
            <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 flex-shrink-0">
              <button
                onClick={() => setShowDetails(true)}
                className="h-11 sm:h-auto px-4 py-2 text-sm font-medium text-label-primary bg-transparent sm:bg-transparent hover:bg-system-bg-secondary active:scale-[0.98] rounded-xl sm:rounded-lg transition-all"
              >
                {t('customize')}
              </button>
              <button
                onClick={acceptNecessary}
                className="h-11 sm:h-auto px-4 py-2 text-sm font-medium text-label-primary bg-system-bg-secondary hover:bg-[#e8e8ed] active:scale-[0.98] rounded-xl sm:rounded-lg transition-all"
              >
                {t('necessaryOnly')}
              </button>
              <button
                onClick={acceptAll}
                className="h-11 sm:h-auto px-5 py-2 text-sm font-medium text-white bg-ios-blue hover:bg-[#0056b3] active:scale-[0.98] rounded-xl sm:rounded-lg transition-all shadow-sm"
              >
                {t('acceptAll')}
              </button>
            </div>
          </div>
        ) : (
          // Detailed Settings
          <div className="space-y-3 sm:space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-label-primary text-base sm:text-lg">{t('settings')}</h3>
              <button
                onClick={() => setShowDetails(false)}
                className="w-9 h-9 flex items-center justify-center rounded-full text-label-tertiary hover:text-label-primary hover:bg-system-bg-secondary active:scale-[0.9] transition-all"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-4">
              {/* Necessary Cookies */}
              <div className="p-3 sm:p-4 bg-system-bg-secondary rounded-xl">
                <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
                  <span className="font-medium text-label-primary text-sm sm:text-base">{t('necessary')}</span>
                  <span className="text-[10px] sm:text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full flex-shrink-0">{t('alwaysOn')}</span>
                </div>
                <p className="text-[11px] sm:text-xs text-label-tertiary leading-relaxed">
                  {t('necessaryDescription')}
                </p>
              </div>

              {/* Analytics Cookies */}
              <div className="p-3 sm:p-4 bg-system-bg-secondary rounded-xl">
                <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
                  <span className="font-medium text-label-primary text-sm sm:text-base">{t('analytics')}</span>
                  <label className="relative inline-flex items-center cursor-pointer h-11 w-11 sm:h-auto sm:w-auto justify-end pr-0.5 sm:pr-0">
                    <input
                      type="checkbox"
                      checked={settings.analytics}
                      onChange={(e) => setSettings({ ...settings, analytics: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-ios-blue after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
                  </label>
                </div>
                <p className="text-[11px] sm:text-xs text-label-tertiary leading-relaxed">
                  {t('analyticsDescription')}
                </p>
              </div>

              {/* Preferences Cookies */}
              <div className="p-3 sm:p-4 bg-system-bg-secondary rounded-xl">
                <div className="flex items-center justify-between gap-2 mb-1.5 sm:mb-2">
                  <span className="font-medium text-label-primary text-sm sm:text-base">{t('preferences')}</span>
                  <label className="relative inline-flex items-center cursor-pointer h-11 w-11 sm:h-auto sm:w-auto justify-end pr-0.5 sm:pr-0">
                    <input
                      type="checkbox"
                      checked={settings.preferences}
                      onChange={(e) => setSettings({ ...settings, preferences: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-gray-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:bg-ios-blue after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all"></div>
                  </label>
                </div>
                <p className="text-[11px] sm:text-xs text-label-tertiary leading-relaxed">
                  {t('preferencesDescription')}
                </p>
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3 pt-1 sm:pt-2">
              <button
                onClick={acceptNecessary}
                className="h-11 sm:h-auto px-4 py-2 text-sm font-medium text-label-primary bg-system-bg-secondary hover:bg-[#e8e8ed] active:scale-[0.98] rounded-xl sm:rounded-lg transition-all"
              >
                {t('rejectOptional')}
              </button>
              <button
                onClick={saveCustom}
                className="h-11 sm:h-auto px-5 py-2 text-sm font-medium text-white bg-ios-blue hover:bg-[#0056b3] active:scale-[0.98] rounded-xl sm:rounded-lg transition-all shadow-sm"
              >
                {t('savePreferences')}
              </button>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        @keyframes slide-up {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .animate-slide-up {
          animation: slide-up 0.3s cubic-bezier(0.22, 1, 0.36, 1);
        }
      `}</style>
    </div>
  );
}

// Hook to check consent status
export function useConsent() {
  const [consent, setConsent] = useState<ConsentSettings | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem(CONSENT_KEY);
    if (stored) {
      try {
        setConsent(JSON.parse(stored));
      } catch {
        setConsent(null);
      }
    }

    const handleUpdate = (e: CustomEvent<ConsentSettings>) => {
      setConsent(e.detail);
    };

    window.addEventListener(CONSENT_EVENT, handleUpdate as EventListener);
    return () => window.removeEventListener(CONSENT_EVENT, handleUpdate as EventListener);
  }, []);

  return consent;
}

export default CookieConsent;
