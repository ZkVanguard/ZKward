'use client';

import { CrashScreen } from '@/components/CrashScreen';

export default function LocaleError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <CrashScreen error={error} onRetry={retry} />;
}
