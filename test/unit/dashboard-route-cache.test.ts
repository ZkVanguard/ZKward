/**
 * Dashboard reads answer from the CDN instead of making a visitor wait.
 *
 * A short stale window expired between visits on a quiet site, so nearly every
 * visitor waited for a full rebuild (up to 12 s). These routes may be served
 * stale for up to a day while the CDN refreshes them; the views poll, so the
 * refreshed copy replaces it within one interval. The autonomy and risk routes
 * read only the database: live signals come from the shared per-asset read.
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const LONG_STALE = /stale-while-revalidate=(86400|\$\{staleSeconds\})/;

const POOL_WIDE_ROUTES = [
  'app/api/dashboard/autonomy-status/route.ts',
  'app/api/platform/risk-overview/route.ts',
  'app/api/paper-trader/status/route.ts',
  'app/api/platform/nav-history/route.ts',
  'app/api/hedera/nav-history/route.ts',
  'app/api/predictions/per-asset/route.ts',
  'app/api/solana-pool/status/route.ts',
  'app/api/solana-pool/history/route.ts',
  'app/api/sui/community-pool/route.ts',
];

describe('dashboard route caching', () => {
  it.each(POOL_WIDE_ROUTES)('%s may be served stale while it refreshes', (rel) => {
    expect(src(rel)).toMatch(LONG_STALE);
  });

  it('the SUI pool keeps the short window for per-user reads and quotes', () => {
    const s = src('app/api/sui/community-pool/route.ts');
    expect(s).toMatch(/staleSeconds: number = cdnTtlSeconds \* 2/);
    // the user-position and swap-quote responses pass no stale override
    expect(s).toMatch(/address: position\.address[\s\S]*?\}, 15\);/);
  });

  it.each(['app/api/dashboard/autonomy-status/route.ts', 'app/api/platform/risk-overview/route.ts'])(
    '%s does not wait on the signal aggregator',
    (rel) => {
      expect(src(rel)).not.toMatch(/live-signals|getLiveAssetSignals|PredictionAggregatorService/);
    },
  );

  it('every browser signal read shares one query over the bare per-asset URL', () => {
    const hook = src('lib/hooks/useLiveSignals.ts');
    expect(hook).toMatch(/queryKey: \['per-asset-signals'\]/);
    expect(src('lib/api/market-signals.ts')).toMatch(/\('\/api\/predictions\/per-asset'\)/);
    for (const rel of ['components/dashboard/MarketLeanBoard.tsx', 'app/[locale]/paper/page.tsx', 'components/dashboard/LiveAutonomyPanel.tsx', 'components/dashboard/pages/RiskTab.tsx']) {
      expect(src(rel)).toMatch(/usePerAssetSignals\(\)/);
    }
  });
});
