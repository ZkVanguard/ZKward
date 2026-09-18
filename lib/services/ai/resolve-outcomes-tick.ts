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
  unresolvedBinaryPastHorizon,
  resolveDirectional,
  resolveBinary,
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
  binaryScanned: number;
  binaryResolved: number;
  binaryStillOpen: number;
  detail?: string;
}

interface PolymarketMarket {
  slug?: string;
  closed?: boolean;
  outcomes?: string;    // JSON string like '["Yes","No"]'
  outcomePrices?: string; // JSON string like '["1","0"]'
}

/**
 * Fetch a single Polymarket market by slug. Returns null on any error;
 * caller treats null as "still open, skip for now".
 */
async function fetchPolymarketMarket(slug: string): Promise<PolymarketMarket | null> {
  try {
    // `?closed=true` is REQUIRED to fetch resolved markets. The default
    // endpoint filters them out — which is exactly the ones we want to
    // score. Diagnosed 2026-09-18: 2 past-horizon BINARY interpretations
    // sat unresolved because the resolver hit the "active only" endpoint.
    const resp = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&closed=true`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (resp.ok) {
      const arr = (await resp.json()) as PolymarketMarket[];
      if (arr && arr.length > 0) return arr[0];
    }
    // Fallback: still-open market (not yet closed). extractBinaryOutcome
    // returns null for these; caller counts as binaryStillOpen and retries
    // next tick.
    const respActive = await fetch(
      `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`,
      { signal: AbortSignal.timeout(6000) },
    );
    if (!respActive.ok) return null;
    const arrActive = (await respActive.json()) as PolymarketMarket[];
    return arrActive && arrActive.length > 0 ? arrActive[0] : null;
  } catch {
    return null;
  }
}

/**
 * Given a resolved Polymarket market, return true if it resolved YES,
 * false if NO, or null if we can't tell (not yet resolved).
 */
function extractBinaryOutcome(m: PolymarketMarket): boolean | null {
  if (!m.closed) return null;
  try {
    const prices = JSON.parse(m.outcomePrices || '[]') as string[];
    // outcomes[0]="Yes", outcomes[1]="No" — resolution sets one to "1" and the other to "0"
    if (prices.length < 2) return null;
    const yes = parseFloat(prices[0]);
    const no = parseFloat(prices[1]);
    if (!Number.isFinite(yes) || !Number.isFinite(no)) return null;
    if (yes >= 0.99) return true;
    if (no >= 0.99) return false;
    return null; // ambiguous — market resolution not final
  } catch {
    return null;
  }
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
    binaryScanned: 0,
    binaryResolved: 0,
    binaryStillOpen: 0,
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

  // Binary resolver runs in parallel — no shared state with directional path.
  // Even if the directional loop has nothing to do, we still try binaries.
  const binaryRows = await unresolvedBinaryPastHorizon(RESOLVE_OUTCOMES_LIMIT);
  summary.binaryScanned = binaryRows.length;
  for (const r of binaryRows) {
    const direction = r.direction as 'BINARY_YES' | 'BINARY_NO';
    if (direction !== 'BINARY_YES' && direction !== 'BINARY_NO') {
      summary.skipped++;
      continue;
    }
    const market = await fetchPolymarketMarket(r.slug);
    if (!market) {
      summary.binaryStillOpen++;
      continue;
    }
    const actualYes = extractBinaryOutcome(market);
    if (actualYes === null) {
      summary.binaryStillOpen++;
      continue;
    }
    try {
      const result = await resolveBinary(r.slug, direction, actualYes);
      summary.binaryResolved++;
      summary.resolved++;
      if (result.correct) summary.correct++;
      else summary.wrong++;
    } catch (err) {
      logger.warn('[ResolveOutcomes] binary resolve failed', {
        slug: r.slug,
        error: err instanceof Error ? err.message : err,
      });
      summary.skipped++;
    }
  }

  if (rows.length === 0 && binaryRows.length === 0) {
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
