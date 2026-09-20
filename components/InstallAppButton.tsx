'use client';

import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

// Type shim — beforeinstallprompt isn't in the standard lib.d.ts.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Install-app button.
 *
 * Renders nothing until the browser fires beforeinstallprompt (i.e. all PWA
 * install criteria are met AND the app isn't already installed). Also renders
 * nothing when running in standalone mode (already installed). Tapping the
 * button surfaces the OS install dialog.
 *
 * iOS Safari does NOT fire beforeinstallprompt. We show a hint there instead
 * telling the user to use the share-sheet "Add to Home Screen" flow.
 */
export function InstallAppButton({ className = '' }: { className?: string }) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isIos, setIsIos] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // Detect standalone (already installed via previous session).
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS-specific check
      (window.navigator as { standalone?: boolean }).standalone === true;
    if (standalone) {
      setInstalled(true);
      return;
    }

    // iOS Safari path: no prompt event; fall back to instructions.
    const ua = window.navigator.userAgent;
    const isIosDevice = /iPhone|iPad|iPod/.test(ua) && !/CriOS|FxiOS/.test(ua);
    if (isIosDevice) setIsIos(true);

    const onPrompt = (e: Event) => {
      // Stash the event so we can surface it later on user gesture.
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      setInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Post-install: nothing to show.
  if (installed) return null;

  if (isIos) {
    return (
      <button
        onClick={() =>
          alert(
            'To install: tap the Share icon in Safari, scroll down, and tap "Add to Home Screen".'
          )
        }
        className={
          className ||
          'inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-white border border-[#d2d2d7] text-[#1d1d1f] text-sm font-medium hover:bg-[#f5f5f7] active:scale-[0.98] transition-all'
        }
      >
        <Download className="w-4 h-4" />
        Install app
      </button>
    );
  }

  // Chrome / Edge / Android: real install prompt.
  if (!deferredPrompt) return null;

  const handleInstall = async () => {
    try {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
    } catch {
      /* user dismissed */
    } finally {
      setDeferredPrompt(null);
    }
  };

  return (
    <button
      onClick={handleInstall}
      className={
        className ||
        'inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-white border border-[#d2d2d7] text-[#1d1d1f] text-sm font-medium hover:bg-[#f5f5f7] active:scale-[0.98] transition-all'
      }
    >
      <Download className="w-4 h-4" />
      Install app
    </button>
  );
}
