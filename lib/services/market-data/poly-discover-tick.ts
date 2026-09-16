/**
 * Shared poly-discover tick implementation.
 *
 * Used by:
 *   * `app/api/cron/poly-discover/route.ts` — direct HTTP cron route.
 *   * `app/api/cron/sui-community-pool/route.ts` — inlined at the
 *      tail of the existing SUI cron tick (Vercel/QStash 10-schedule
 *      cap means we piggy-back instead of adding a standalone cron).
 *
 * Returns a structured result so the SUI cron can log it; the standalone
 * route serializes it as the HTTP response. Discord alerts + cron_state
 * writes happen here regardless of caller.
 */

import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { setCronState, getCronStateOr } from '@/lib/db/cron-state';
import { query } from '@/lib/db/postgres';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import {
  MultiAssetSignalService,
  getTrackedAssetList,
} from './MultiAssetSignalService';
import {
  fetchBroadCryptoMarkets,
  summarize as summarizeBroad,
  type BroadMarket,
} from './PolymarketBroadMarketsService';
import {
  appendSnapshot,
  computeMomentum,
  scoreRelevance,
  detectThemes,
  type MarketSnapshot,
  type MarketMomentum,
} from './PolymarketMomentumService';
import { interpretSignal, type InterpretedSignal } from '@/lib/services/ai/signal-interpreter';

export interface PolyDiscoverTickResult {
  success: boolean;
  ranAt: string;
  attempted: true;
  error?: string;
  discoveredCount: number;
  newAssets: string[];
  newSinceLastTick: string[];
  trackedButMissing: string[];
  trackedList: string[];
  broad: {
    summary: ReturnType<typeof summarizeBroad>;
    newHighImpactCount: number;
    hotMoversCount: number;
    themesAlerted: number;
  };
  interpretedCount: number;
  interpretedSample: Array<{
    slug: string;
    asset: string | null;
    direction: string;
    horizon: string;
    confidence: number;
    novelty: number;
    source: 'model' | 'regex-fallback';
  }>;
}

const CRON_KEY_SEEN = 'poly-discover:seenAssets';
const CRON_KEY_LAST_DISCOVERY = 'poly-discover:lastDiscovery';
const CRON_KEY_SEEN_BROAD = 'poly-discover:seenBroadSlugs';
const CRON_KEY_LAST_BROAD_SUMMARY = 'poly-discover:lastBroadSummary';
const CRON_KEY_TOP_RELEVANCE = 'poly-discover:topByRelevance';
const CRON_KEY_THEMES_STATE = 'poly-momentum:themes:state';

export async function runPolyDiscoverTick(): Promise<PolyDiscoverTickResult> {
  const ranAt = new Date().toISOString();
  try {
    const [discovery, broad] = await Promise.all([
      MultiAssetSignalService.discoverAvailableAssets(),
      fetchBroadCryptoMarkets({ bypassCache: true }),
    ]);
    const tracked = new Set(getTrackedAssetList());
    const seenBefore = new Set(await getCronStateOr<string[]>(CRON_KEY_SEEN, []));
    const seenBroadSlugs = new Set(await getCronStateOr<string[]>(CRON_KEY_SEEN_BROAD, []));

    const discoveredAssets = discovery.assets;
    const newAssets = discoveredAssets.filter(a => !tracked.has(a));
    const newSinceLastTick = discoveredAssets.filter(a => !seenBefore.has(a));
    const trackedButMissing = Array.from(tracked).filter(a => !discoveredAssets.includes(a));

    const seenAfter = Array.from(new Set([...seenBefore, ...discoveredAssets])).sort();
    await setCronState(CRON_KEY_SEEN, seenAfter).catch(() => {});
    await setCronState(CRON_KEY_LAST_DISCOVERY, {
      ts: Date.now(),
      assets: discoveredAssets,
      perAsset: discovery.perAsset,
    }).catch(() => {});

    if (newSinceLastTick.length > 0) {
      const top = newSinceLastTick
        .map(a => {
          const d = discovery.perAsset[a];
          return `${a} (vol24h=$${(d?.volume24hr ?? 0).toFixed(0)}, liq=$${(d?.liquidity ?? 0).toFixed(0)})`;
        })
        .join(', ');
      await notifyDiscord(
        `New 5-min binary listings detected on Polymarket: ${top}. ` +
        `Add to POLYMARKET_TRACKED_ASSETS to feed the SUI cron's AI.`,
        'INFO',
        { newSinceLastTick, trackedList: Array.from(tracked).sort() },
      );
    }

    const broadSummary = summarizeBroad(broad);
    const newBroadHigh = broad
      .filter(m => m.horizon !== '5min')
      .filter(m => !seenBroadSlugs.has(m.slug))
      .filter(m => m.volume24hr >= 50_000)
      .sort((a, b) => b.volume24hr - a.volume24hr)
      .slice(0, 5);

    if (newBroadHigh.length > 0) {
      const lines = newBroadHigh
        .map(m =>
          `${m.assets.join('/')} ${m.horizon} ${m.marketType}: ` +
          `"${m.question.substring(0, 80)}${m.question.length > 80 ? '…' : ''}" ` +
          `(p=${m.probability.toFixed(0)}%, vol=$${(m.volume24hr / 1000).toFixed(0)}k)`,
        )
        .join('\n');
      await notifyDiscord(
        `New HIGH-impact crypto markets on Polymarket:\n${lines}`,
        'INFO',
        {
          markets: newBroadHigh.map(m => ({ slug: m.slug, horizon: m.horizon, type: m.marketType, vol: m.volume24hr })),
          totals: broadSummary,
        },
      );
    }

    // Interpret new high-impact markets with the fine-tuned Signal Interpreter.
    // Guarded by SIGNAL_INTERPRETER_ENABLED — off = regex fallback, no network call.
    // Only labels NEW markets (filtered by seenBroadSlugs above), so cost is
    // bounded per tick. Cap at 5 to stay inside the 30s cron maxDuration when
    // the model server is remote.
    const INTERP_CAP = 5;
    const toInterpret = newBroadHigh.slice(0, INTERP_CAP);
    const interpretations: Array<{ market: BroadMarket; signal: InterpretedSignal }> = [];
    if (toInterpret.length > 0) {
      const results = await Promise.allSettled(
        toInterpret.map(m =>
          interpretSignal(m.question, {
            category: m.marketType,
            endDate: m.endDate ?? undefined,
          }).then(signal => ({ market: m, signal })),
        ),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') interpretations.push(r.value);
      }
      logger.info('[PolyDiscover] interpreted new markets', {
        attempted: toInterpret.length,
        succeeded: interpretations.length,
        modelUsed: interpretations.filter(i => i.signal.source === 'model').length,
        regexFallback: interpretations.filter(i => i.signal.source === 'regex-fallback').length,
      });
    }
    const interpretedSample = interpretations.map(({ market, signal }) => ({
      slug: market.slug,
      asset: signal.asset,
      direction: signal.direction,
      horizon: signal.horizon,
      confidence: signal.confidence,
      novelty: signal.meta?.novelty ?? 0,
      source: signal.source,
    }));

    // ponytail: cap at last 2000 slugs. 2026-07-31 audit found this blob had
    // grown to 32,429 items / 1.2 MB — every read parsed the whole thing.
    // 2000 is ~10 days at ~200 new markets/day, plenty of dedup memory.
    const SEEN_SLUGS_CAP = 2000;
    const seenBroadAfter = Array.from(new Set([
      ...seenBroadSlugs,
      ...broad.filter(m => m.horizon !== '5min').map(m => m.slug),
    ])).slice(-SEEN_SLUGS_CAP);
    await setCronState(CRON_KEY_SEEN_BROAD, seenBroadAfter).catch(() => {});
    await setCronState(CRON_KEY_LAST_BROAD_SUMMARY, {
      ts: Date.now(),
      summary: broadSummary,
    }).catch(() => {});

    // Momentum
    const momentumTargets: BroadMarket[] = broad
      .filter(m => m.horizon !== '5min')
      .sort((a, b) => b.volume24hr - a.volume24hr)
      .slice(0, 75);

    const allMomenta: MarketMomentum[] = [];
    const now = Date.now();
    for (const m of momentumTargets) {
      const histKey = `poly-momentum:history:${m.slug}`;
      const prev = await getCronStateOr<MarketSnapshot[]>(histKey, []);
      const snap: MarketSnapshot = {
        ts: now,
        probability: m.probability,
        volume24hr: m.volume24hr,
        liquidity: m.liquidity,
      };
      const next = appendSnapshot(prev, snap);
      await setCronState(histKey, next).catch(() => {});
      const mom = computeMomentum(m, next);
      if (mom) allMomenta.push(mom);
    }

    const HOT_THRESHOLD = Number(process.env.POLY_HOT_THRESHOLD || 60);
    const hotMovers = allMomenta
      .filter(m => m.hotness >= HOT_THRESHOLD && Math.abs(m.probabilityDelta) >= 5)
      .sort((a, b) => b.hotness - a.hotness)
      .slice(0, 5);

    if (hotMovers.length > 0) {
      const lines = hotMovers.map(h =>
        `🔥 [${h.hotness}] ${h.assets.join('/')}: "${h.question.substring(0, 70)}${h.question.length > 70 ? '…' : ''}" ` +
        `Δp=${h.probabilityDelta > 0 ? '+' : ''}${h.probabilityDelta.toFixed(1)}% ` +
        `vol×${h.volumeRatio.toFixed(2)} over ${h.windowMinutes.toFixed(0)}min`,
      ).join('\n');
      await notifyDiscord(
        `HOT prediction-market movers (last 30min):\n${lines}`,
        'INFO',
        {
          hotCount: hotMovers.length,
          markets: hotMovers.map(h => ({ slug: h.slug, hotness: h.hotness, deltaP: h.probabilityDelta, volRatio: h.volumeRatio })),
        },
      );
    }

    // Relevance — score newly-discovered markets against the full agent
    // universe (pool + trader + dynamic Polymarket). Sourced from the
    // shared composer so this file never falls out of sync with the pool
    // struct or trader config.
    const { resolveAgentUniverse } = await import('@/lib/config/agent-universe');
    const relevanceCtx = { poolAssets: await resolveAgentUniverse(), rebalanceMinutes: 30 };
    const ranked = broad
      .filter(m => m.horizon !== '5min')
      .map(m => ({ market: m, relevance: scoreRelevance(m, relevanceCtx) }))
      .sort((a, b) => b.relevance.score - a.relevance.score)
      .slice(0, 25)
      .map(({ market, relevance }) => ({
        slug: market.slug,
        question: market.question,
        horizon: market.horizon,
        marketType: market.marketType,
        assets: market.assets,
        probability: market.probability,
        volume24hr: market.volume24hr,
        score: relevance.score,
        reasons: relevance.reasons,
      }));
    await setCronState(CRON_KEY_TOP_RELEVANCE, { ts: now, ranked }).catch(() => {});

    // Themes
    const themes = detectThemes(broad);
    const prevThemeState = await getCronStateOr<Record<string, number>>(CRON_KEY_THEMES_STATE, {});
    const themeAlerts: string[] = [];
    const nextThemeState: Record<string, number> = {};
    for (const t of themes) {
      nextThemeState[t.theme] = t.marketCount;
      const prevCount = prevThemeState[t.theme] || 0;
      if (t.marketCount >= 3 && t.marketCount - prevCount >= 2) {
        const dir = t.weightedDirection > 0.2 ? 'BULLISH'
          : t.weightedDirection < -0.2 ? 'BEARISH'
          : 'MIXED';
        themeAlerts.push(
          `📈 Theme heating: **${t.theme}** ${prevCount} → ${t.marketCount} markets, ` +
          `$${(t.totalVolume24hr / 1000).toFixed(0)}k 24h, ${dir} (affects ${t.affectsAssets.join('/')})`,
        );
      }
    }
    await setCronState(CRON_KEY_THEMES_STATE, nextThemeState).catch(() => {});
    if (themeAlerts.length > 0) {
      await notifyDiscord(
        `Emerging prediction-market themes:\n${themeAlerts.join('\n')}`,
        'INFO',
        { themes: themes.slice(0, 10).map(t => ({ theme: t.theme, count: t.marketCount, dir: t.weightedDirection })) },
      );
    }

    if (trackedButMissing.length > 0) {
      logger.warn('[PolyDiscover] tracked assets missing from current Polymarket window', {
        trackedButMissing,
      });
    }

    // ponytail: prune stale poly-momentum:history rows. Each tick writes
    // history for top-75 markets by volume; when a market ages out of top-75
    // (resolves/expires) its row is orphaned. 2026-07-31 audit found 32k
    // orphaned rows accumulated over months. 7-day window keeps the ring
    // buffers relevant for currently-active markets.
    try {
      await query(
        "DELETE FROM cron_state WHERE key LIKE 'poly-momentum:history:%' AND updated_at < now() - interval '7 days'",
      );
    } catch (pruneErr) {
      logger.warn('[PolyDiscover] history prune failed (non-critical)', {
        error: pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
      });
    }

    logger.info('[PolyDiscover] tick complete', {
      discoveredCount: discoveredAssets.length,
      newSinceLastTickCount: newSinceLastTick.length,
      trackedCount: tracked.size,
      broadTotal: broadSummary.total,
      newBroadHigh: newBroadHigh.length,
      hotMovers: hotMovers.length,
      themesAlerted: themeAlerts.length,
    });

    return {
      success: true,
      ranAt,
      attempted: true,
      discoveredCount: discoveredAssets.length,
      newAssets,
      newSinceLastTick,
      trackedButMissing,
      trackedList: Array.from(tracked).sort(),
      broad: {
        summary: broadSummary,
        newHighImpactCount: newBroadHigh.length,
        hotMoversCount: hotMovers.length,
        themesAlerted: themeAlerts.length,
      },
      interpretedCount: interpretations.length,
      interpretedSample,
    };
  } catch (err) {
    const error = errMsg(err);
    logger.error('[PolyDiscover] tick failed', { error });
    return {
      success: false,
      ranAt,
      attempted: true,
      error,
      discoveredCount: 0,
      newAssets: [],
      newSinceLastTick: [],
      trackedButMissing: [],
      trackedList: [],
      broad: {
        summary: summarizeBroad([]),
        newHighImpactCount: 0,
        hotMoversCount: 0,
        themesAlerted: 0,
      },
      interpretedCount: 0,
      interpretedSample: [],
    };
  }
}
