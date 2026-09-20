import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';

// Define routing configuration - shared between middleware and navigation
export const routing = defineRouting({
  locales: ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko', 'pt', 'ru', 'ar', 'hi', 'it', 'ne'],
  defaultLocale: 'en',
  localePrefix: 'as-needed'
});

// Export navigation utilities that use the routing config
export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);

// Export types and constants for convenience
export type Locale = (typeof routing.locales)[number];
export const locales = routing.locales;
export const defaultLocale = routing.defaultLocale;

export const localeNames: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  zh: '中文',
  ja: '日本語',
  ko: '한국어',
  pt: 'Português',
  ru: 'Русский',
  ar: 'العربية',
  hi: 'हिन्दी',
  it: 'Italiano',
  ne: 'नेपाली',
};
