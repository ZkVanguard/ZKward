/**
 * Signal-outcome resolver — shared tick implementation.
 *
 * Extracted 2026-09-18 from app/api/cron/resolve-outcomes/route.ts so the
 * polymarket-edge-trader piggyback can call the same logic inline instead
 * of via HTTP fetch. Fetch-based piggyback silently failed in prod because
 * VERCEL_URL resolves to a deployment-specific URL that hits deployment
 * protection when called cross-deploy — direct import bypasses the network.
 *
 * Contract: idempotent (outcome_correct IS NULL filter), debounced via
 * tryClaimCronRun so multiple invocations per QStash tick window are safe.
 */
import { tryClaimCronRun, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import {
  unresolvedDirectionalPastHorizon,
  resolveDirectional,
  type InterpretationRow,
} from '@/lib/db/signal-interpretations';
import { getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';

export const RESOLVE_OUTCOMES_CRON_KEY = 'resolve-outcomes';
export const RESOLVE_OUTCOMES_TICK_INTERVAL_MS = 25 * 60 * 1000; // 25 min claim debounce
export const RESOLVE_OUTCOMES_HEARTBEAT_KEY = `cron:lastRun:${RESOLVE_OUTCOMES_CRON_KEY}`;
export const RESOLVE_OUTCOMES_LIMIT = 200;

export interface ResolveOutcomesSummary {
  claimed: boolean;
  scanned: number;
  resolved: number;
  correct: number;
  wrong: number;
  priceFailed: number;
  skipped: number;
  detail?: string;
}

/**
 * Run one resolver tick. Returns a summary rather than a Response so callers
 * (cron route + piggyback) can share the same logic.
 */
export async function runResolveOutcomesTick(
  now: number = Date.now(),
): Promise<ResolveOutcomesSummary> {
  const summary: ResolveOutcomesSummary = {
    claimed: false,
    scanned: 0,
    resolved: 0,
    correct: 0,
    wrong: 0,
    priceFailed: 0,
    skipped: 0,
  };

  const claim = await tryClaimCronRun(RESOLVE_OUTCOMES_CRON_KEY, RESOLVE_OUTCOMES_TICK_INTERVAL_MS, now);
  if (!claim.claimed) {
    summary.detail = claim.reason ?? 'debounce';
    return summary;
  }
  summary.claimed = true;
  await setCronState(RESOLVE_OUTCOMES_HEARTBEAT_KEY, now).catch(() => undefined);

  const rows = await unresolvedDirectionalPastHorizon(RESOLVE_OUTCOMES_LIMIT);
  summary.scanned = rows.length;
  if (rows.length === 0) {
    summary.detail = 'nothing to resolve';
    return summary;
  }

  // Batch by asset — one price fetch per asset, applied to all its rows.
  const byAsset = new Map<string, InterpretationRow[]>();
  for (const r of rows) {
    if (!r.asset) { summary.skipped++; continue; }
    const arr = byAsset.get(r.asset) ?? [];
    arr.push(r);
    byAsset.set(r.asset, arr);
  }

  for (const [asset, group] of byAsset.entries()) {
    let exitPrice: number;
    try {
      const v = await getMultiSourceValidatedPrice(asset, { minSources: 2, timeout: 5000 });
      if (!Number.isFinite(v.price) || v.price <= 0) {
        throw new Error(`bad price: ${v.price}`);
      }
      exitPrice = v.price;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[ResolveOutcomes] price fetch failed', { asset, count: group.length, error: msg });
      summary.priceFailed += group.length;
      continue;
    }

    for (const r of group) {
      const entry = Number(r.entry_price_usd ?? 0);
      if (!Number.isFinite(entry) || entry <= 0) {
        summary.skipped++;
        continue;
      }
      const direction = r.direction as 'UP' | 'DOWN';
      if (direction !== 'UP' && direction !== 'DOWN') {
        summary.skipped++;
        continue;
      }
      try {
        const result = await resolveDirectional(r.slug, direction, entry, exitPrice);
        summary.resolved++;
        if (result.correct) summary.correct++;
        else summary.wrong++;
      } catch (err) {
        logger.warn('[ResolveOutcomes] resolve failed', {
          slug: r.slug,
          error: err instanceof Error ? err.message : err,
        });
        summary.skipped++;
      }
    }
  }

  logger.info('[ResolveOutcomes] tick complete', summary);

  if (summary.resolved > 0) {
    const hitRate = summary.correct / summary.resolved;
    const level = hitRate < 0.4 ? 'WARN' : 'INFO';
    void notifyDiscord(
      `Signal resolver: ${summary.resolved} judged, ${summary.correct}/${summary.resolved} correct (${(hitRate * 100).toFixed(0)}%)`,
      level,
      { source: 'resolve-outcomes', ...summary },
    ).catch(() => undefined);
  }

  return summary;
}
