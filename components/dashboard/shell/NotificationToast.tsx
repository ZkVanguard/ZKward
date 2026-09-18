/**
 * Toast — one-liner status message anchored to top-center.
 * Uses design tokens (`text-white bg-label-primary`) so it survives
 * light/dark auto-switching without a Tailwind gray override.
 */
export function NotificationToast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="fixed top-20 lg:top-[68px] left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300 max-w-md px-4">
      <div className="flex items-start gap-3 px-5 py-4 bg-label-primary text-white rounded-2xl shadow-ios-3">
        <div className="w-2 h-2 mt-1.5 bg-ios-green rounded-full animate-pulse flex-shrink-0" />
        <p className="text-sm font-medium whitespace-pre-line leading-relaxed">
          {message}
        </p>
      </div>
    </div>
  );
}
