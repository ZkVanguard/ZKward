/**
 * GET /api/predictions/per-asset
 *
 * Read-only window into PredictionAggregatorService.getPerAssetPredictions
 * for ops + verification. Surfaces the full per-asset aggregation including:
 *   - Per-asset Polymarket 5-min signals (multi-asset, not just BTC)
 *   - Delphi + Manifold sources routed by relatedAssets
 *   - BlueFin funding rate sentiment
 *   - Cross-asset alignment as its own source
 *   - SignalDriftFusion upgrades (synthetic STRONG)
 *
 * Optional ?assets=BTC,ETH,SOL,XRP,DOGE to override the default scan.
 * Optional ?auto=1 to use the dynamic Polymarket-discovered universe.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readLimiter } from '@/lib/security/rate-limiter';
import { PredictionAggregatorService } from '@/lib/services/market-data/PredictionAggregatorService';
import { getDynamicTrackedAssets, getTrackedAssetList } from '@/lib/services/market-data/MultiAssetSignalService';
import { SignalDriftFusion, type FusionUpgrade } from '@/lib/services/market-data/SignalDriftFusion';
import { withOriginCache } from '@/lib/utils/origin-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 20;

async function handleGet(req: NextRequest): Promise<NextResponse> {
  const limited = readLimiter.check(req);
  if (limited) return limited;

  const url = new URL(req.url);
  const assetsParam = url.searchParams.get('assets');
  const useAuto = url.searchParams.get('auto') === '1';

  let assets: string[];
  if (assetsParam) {
    assets = assetsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  } else if (useAuto) {
    assets = await getDynamicTrackedAssets();
  } else {
    assets = getTrackedAssetList();
  }

  const start = Date.now();
  const predictions = await PredictionAggregatorService.getPerAssetPredictions(assets);
  const driftSnapshot = SignalDriftFusion.getHistorySnapshot();

  return NextResponse.json({
    success: true,
    fetchedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    assets,
    predictions: Object.fromEntries(
      Object.entries(predictions).map(([asset, p]) => {
        // Recover the fusion upgrade from the source bag — surfaces drift
        // detail so callers can see WHY synthetic STRONG isn't firing
        // (e.g., drift FLAT vs alignment FAIL vs funding CONFLICT).
        let upgrade: FusionUpgrade | undefined;
        for (const s of p.sources) {
          const raw = s.rawData as { fusionUpgrade?: FusionUpgrade } | undefined;
          if (raw?.fusionUpgrade) { upgrade = raw.fusionUpgrade; break; }
        }
        return [asset, {
          direction: p.direction,
          recommendation: p.recommendation,
          confidence: Math.round(p.confidence),
          consensus: Math.round(p.consensus),
          probability: Math.round(p.probability * 10) / 10,
          sourceCount: p.sources.length,
          sources: p.sources.map(s => ({
            name: s.name,
            direction: s.direction,
            confidence: Math.round(s.confidence),
            weight: Math.round(s.weight * 1000) / 10,            // %
          })),
          syntheticStrong: p.sources.some(s => s.name.includes('synthetic STRONG')),
          hasManifold: p.sources.some(s => s.name.startsWith('Manifold:')),
          hasAlignment: p.sources.some(s => s.name.startsWith('Cross-asset alignment')),
          reasoning: p.reasoning,
          // Diagnostic — exposes why upgrade fired (or didn't):
          fusion: upgrade ? {
            upgradedToStrong: upgrade.upgradedToStrong,
            syntheticConfidence: Math.round(upgrade.syntheticConfidence),
            reasons: upgrade.reasons,
            fundingAlign: upgrade.fundingAlign,
            probDrift: upgrade.drift && {
              direction: upgrade.drift.driftDirection,
              consistency: Math.round(upgrade.drift.directionConsistency * 100),
              netDelta: Math.round(upgrade.drift.netDelta * 10) / 10,
              samples: upgrade.drift.samples,
            },
            priceDrift: upgrade.priceDrift && {
              direction: upgrade.priceDrift.driftDirection,
              consistency: Math.round(upgrade.priceDrift.directionConsistency * 100),
              netDelta: Math.round(upgrade.priceDrift.netDelta * 100) / 100,
              samples: upgrade.priceDrift.samples,
            },
            alignment: upgrade.alignment && {
              dominantDirection: upgrade.alignment.dominantDirection,
              dominancePct: Math.round(upgrade.alignment.dominancePct),
              up: upgrade.alignment.upCount,
              down: upgrade.alignment.downCount,
              neutral: upgrade.alignment.neutralCount,
              directionalVoters: upgrade.alignment.directionalVoters,
            },
          } : null,
        }];
      }),
    ),
    driftHistory: driftSnapshot,
  }, {
    // Fresh for 30 s at the edge. A cold aggregator scan takes ~10 s, so the
    // edge may answer stale for up to a day while it refreshes in the
    // background; every reader polls and gets the refreshed copy next time.
    headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=86400' },
  });
}

export const GET = withOriginCache({ name: 'per-asset', freshSec: 30, params: ['assets', 'auto'] }, handleGet);
