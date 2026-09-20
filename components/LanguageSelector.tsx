'use client';

import { useState, useEffect, useRef } from 'react';
import { Globe } from 'lucide-react';
import { locales, localeNames, useRouter, usePathname, type Locale } from '../i18n/routing';
import { useLocale } from 'next-intl';

export function LanguageSelector() {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const currentLocale = useLocale() as Locale;
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLocaleChange = (locale: Locale) => {
    // next-intl writes its own NEXT_LOCALE cookie on router.replace so the
    // choice survives across sessions. No need for a parallel localStorage
    // entry that no code reads.
    setIsOpen(false);
    router.replace(pathname, { locale });
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 h-11 text-[16px] font-normal text-[#1d1d1f] hover:text-[#007AFF] active:scale-[0.98] transition-all duration-[200ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
        aria-label="Select language"
      >
        <Globe className="w-5 h-5" />
        <span className="hidden sm:inline">{localeNames[currentLocale]}</span>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-48 bg-white rounded-[14px] shadow-[0_8px_30px_rgba(0,0,0,0.12)] border border-black/10 py-2 z-50 animate-fade-in">
          <div className="max-h-[400px] overflow-y-auto">
            {locales.map((locale) => (
              <button
                key={locale}
                onClick={() => handleLocaleChange(locale)}
                className={`w-full px-4 py-2.5 text-left text-[15px] transition-colors ${
                  currentLocale === locale
                    ? 'bg-[#007AFF]/10 text-[#007AFF] font-semibold'
                    : 'text-[#1d1d1f] hover:bg-black/5'
                }`}
              >
                {localeNames[locale]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
