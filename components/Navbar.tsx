'use client';

import { memo, useState, useEffect } from 'react';
import nextDynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { Link } from '../i18n/routing';
import { LanguageSelector } from './LanguageSelector';
import { Menu, X, ArrowRight } from 'lucide-react';
import Logo from './Logo';
import { useTranslations } from 'next-intl';

// ConnectButton lazily imported — pulls @mysten/dapp-kit + @mysten/sui
// + ethers (~800 KB). We only render it on /dashboard so that chunk
// never lands in the marketing bundle. Static stub used elsewhere
// routes users to the app entry point instead.
const ConnectButton = nextDynamic(
  () => import('./ConnectButton').then((m) => ({ default: m.ConnectButton })),
  { ssr: false, loading: () => <ConnectButtonSkeleton /> },
);

function ConnectButtonSkeleton() {
  return <div className="h-11 w-32 rounded-[12px] bg-system-bg-secondary animate-pulse" />;
}

function ConnectButtonStub() {
  return (
    <Link
      href="/dashboard"
      className="group inline-flex items-center gap-2 px-4 h-11 bg-ios-blue text-white rounded-[12px] text-[14px] font-semibold hover:bg-ios-blueHover active:scale-[0.97] transition-all duration-200 shadow-ios-1"
    >
      Enter app
      <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-0.5 transition-transform" strokeWidth={2.5} />
    </Link>
  );
}

export const Navbar = memo(function Navbar() {
  const [isOpen, setIsOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const t = useTranslations('nav');
  const pathname = usePathname();
  // Only /dashboard has the WalletProviders context in scope. Anywhere
  // else we render a stub link to keep the wallet SDK out of the
  // marketing bundle.
  const isDashboard = pathname?.includes('/dashboard') ?? false;

  // Detect scroll past 20px via IntersectionObserver on an injected sentinel.
  // Replaces window.addEventListener('scroll') which fired every frame.
  // Sentinel is absolute-positioned at y=20px in the document; when it exits
  // the viewport, we've crossed the threshold. O(1) per scroll direction.
  useEffect(() => {
    const sentinel = document.createElement('div');
    sentinel.style.cssText =
      'position:absolute;top:20px;left:0;width:1px;height:1px;pointer-events:none;';
    document.body.insertBefore(sentinel, document.body.firstChild);
    const io = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 },
    );
    io.observe(sentinel);
    return () => {
      io.disconnect();
      sentinel.remove();
    };
  }, []);

  // Focused nav — one product (SUI vault), one narrative (agents + ZK + RWA), one document (whitepaper).
  // Pricing/Developers/Simulator/Docs are still reachable by direct URL but not linked from the top nav.
  const navLinks = [
    { href: '/', label: t('home') },
    { href: '/dashboard', label: t('vault') },
    { href: '/agents', label: t('agents') },
    { href: '/zk', label: t('zk') },
    { href: '/rwa', label: t('rwa') },
    { href: '/whitepaper', label: t('whitepaper') },
    { href: '/story', label: t('story') },
    { href: '/faq', label: 'FAQ' },
  ];

  return (
    <nav
      // Translucency deliberately low + backdrop-blur strong so the
      // hero's phyllotaxis + spotlight bleed through the navbar glass.
      // Previously 90% opaque → only 10% show-through, reading as a
      // hard white bar sitting on top of the effect instead of glass.
      // The graph bg in SuiPoolLanding extends 96px above section top
      // so the navbar has real content to blur across its full height.
      className={`fixed top-0 left-0 right-0 z-50 pt-safe pl-safe pr-safe transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] ${
        scrolled
          ? 'bg-system-bg-primary/72 backdrop-blur-xl shadow-ios-1 border-b border-separator-opaque/20'
          : 'bg-system-bg-primary/60 backdrop-blur-xl'
      }`}
    >
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
        {/* overflow-x-clip contains the 8-16px scrollWidth caused by the
            -ml-2 / -mr-2 negative margins on the Logo and hamburger button.
            Those margins are intentional (they push the tap targets to the
            visual edge of the nav bar without expanding the padded content
            box), but they inflate scrollWidth and register as inner overflow
            on responsive audits. Clip contains it without altering layout. */}
        <div className="flex items-center justify-between h-[52px] min-w-0 overflow-x-clip">
          {/* Logo — brand mark + wordmark. Logo component already renders
              the "ZKward" text from sm: (640px+); no extra span needed. */}
          <Link href="/" className="flex items-center gap-2 -ml-2">
            <Logo />
          </Link>

          {/* Desktop Navigation - Centered with proper spacing */}
          <div className="hidden lg:flex items-center justify-center flex-1 gap-1 mx-8">
            {navLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="px-3 h-11 flex items-center text-[16px] font-normal text-label-secondary hover:text-ios-blue active:scale-[0.98] transition-all duration-[200ms] ease-[cubic-bezier(0.4,0,0.2,1)] whitespace-nowrap"
              >
                {link.label}
              </Link>
            ))}
          </div>

          {/* Desktop - Language Selector + Connect Button (Right side) */}
          <div className="hidden lg:flex items-center gap-3">
            <LanguageSelector />
            {isDashboard ? <ConnectButton /> : <ConnectButtonStub />}
          </div>

          {/* Mobile Menu Button - Proper 44pt touch target */}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="lg:hidden w-11 h-11 flex items-center justify-center -mr-2 text-label-primary hover:text-ios-blue active:scale-[0.96] transition-all duration-[200ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
            aria-label="Toggle menu"
          >
            {isOpen ? (
              <X className="w-6 h-6" strokeWidth={2} />
            ) : (
              <Menu className="w-6 h-6" strokeWidth={2} />
            )}
          </button>
        </div>

        {/* Mobile Navigation - Clean iOS-style list */}
        {isOpen && (
          <div className="lg:hidden pb-safe-4 border-t border-black/10 animate-fade-in max-h-[calc(100vh-52px-env(safe-area-inset-top))] overflow-y-auto">
            <div className="py-2 space-y-0.5">
              {navLinks.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="block px-3 h-11 flex items-center text-[17px] text-label-primary hover:bg-system-bg-grouped active:scale-[0.98] active:bg-black/[0.04] rounded-ios transition-all duration-[200ms] ease-[cubic-bezier(0.4,0,0.2,1)] truncate"
                  onClick={() => setIsOpen(false)}
                >
                  {link.label}
                </Link>
              ))}
            </div>
            <div className="mt-3 pt-3 px-3 border-t border-black/10 space-y-3">
              <LanguageSelector />
              {isDashboard ? <ConnectButton /> : <ConnectButtonStub />}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
});
