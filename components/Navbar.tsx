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

function ConnectButtonStub({ label }: { label: string }) {
  return (
    <Link
      href="/dashboard"
      className="group inline-flex items-center gap-2 px-4 h-11 bg-ios-blue text-white rounded-[12px] text-[14px] font-semibold hover:bg-ios-blueHover active:scale-[0.97] transition-all duration-200 shadow-ios-1"
    >
      {label}
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

  // Five links, no more. Home is implicit via the logo, so it earns no
  // slot. ZK / RWA / Simulator stay reachable by URL and from footer,
  // but they compete with the primary five and lose. Vault is the
  // money page, Agents is the tech, Whitepaper is the receipt,
  // Story is the human hook, FAQ closes the loop.
  const navLinks = [
    { href: '/dashboard', label: t('vault') },
    { href: '/agents', label: t('agents') },
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
      className={`fixed top-0 left-0 right-0 z-50 pt-safe pl-safe pr-safe backdrop-blur-2xl backdrop-saturate-[180%] border-b transition-all duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:from-transparent before:via-white/60 before:to-transparent ${
        scrolled
          ? 'bg-system-bg-primary/65 shadow-[0_1px_0_rgba(255,255,255,0.4)_inset,0_8px_24px_-12px_rgba(0,0,0,0.12)] border-separator-opaque/25'
          : 'bg-system-bg-primary/45 shadow-[0_1px_0_rgba(255,255,255,0.35)_inset] border-white/25'
      }`}
    >
      <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8">
        {/* No overflow clip on the row: the logo tile's outer blue glow
            (12px shadow) sits flush at this edge and got severed by
            overflow-x-clip, reading as "cut off on the left". The -mr-2
            on the hamburger stays inside the parent's px-4/6/8 padding,
            so no scrollWidth escapes the page anyway. */}
        <div className="flex items-center justify-between h-[56px] min-w-0">
          {/* Logo — brand mark + wordmark. Logo component already renders
              the "ZKward" text from sm: (640px+); no extra span needed.
              ml-1 sm:ml-2 gives the glass tile air off the container's
              padding edge — without it the tile reads as clamped to the
              left rail because its border makes it look "closed off"
              compared to the softer text-links on the right. */}
          <Link href="/" className="flex items-center gap-2 ml-1 sm:ml-2">
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
            {isDashboard ? <ConnectButton /> : <ConnectButtonStub label={t('enterApp')} />}
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
          <div className="lg:hidden pb-safe-4 border-t border-black/10 animate-fade-in max-h-[calc(100vh-56px-env(safe-area-inset-top))] overflow-y-auto">
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
              {isDashboard ? <ConnectButton /> : <ConnectButtonStub label={t('enterApp')} />}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
});
