/**
 * Signal-outcome resolver — closes the learning loop.
 *
 * ## Why
 *
 * `signal_interpretations` rows are written every time the model interprets
 * a Polymarket title into a directional (UP/DOWN) prediction with a
 * captured entry_price_usd and horizon_end. Without a resolver, `outcome_correct`
 * stays NULL forever — the postmortem pipeline can't compute hit rate, the
 * per-source calibrator can't weight sources by accuracy, and paper-trader
 * regret feedback runs on garbage.
 *
 * Forensic on 2026-09-17 (before this shipped): 10 interpretations, all
 * `outcome_correct = NULL`, 122 paper trades executed with zero ground
 * truth on whether the model was directionally right. Cron ships that.
 *
 * ## Cadence
 *
 * Every 30 min via QStash. Cheap: one DB SELECT + one multi-source price
 * fetch per unique asset (5-10 assets max), one UPDATE per resolved row.
 * Skips gracefully if there's nothing to resolve.
 *
 * ## Contract
 *
 * - Directional (UP/DOWN) interpretations only. Binary (BINARY_YES/NO)
 *   still need Polymarket's resolution oracle; skip them here.
 *   entry_price_usd + horizon_end MUST be present — filter enforces this.
 * - Uses `getMultiSourceValidatedPrice` (min 2 agreeing sources, 2% dev cap)
 *   so a single stale feed can't poison the outcome record.
 * - Idempotent: `outcome_correct IS NULL` filter prevents double-resolution.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { tryClaimCronRun, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import {
  unresolvedDirectionalPastHorizon,
  resolveDirectional,
  type InterpretationRow,
} from '@/lib/db/signal-interpretations';
import { getMultiSourceValidatedPrice } from '@/lib/services/market-data/unified-price-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const CRON_KEY = 'resolve-outcomes';
const TICK_INTERVAL_MS = 25 * 60 * 1000; // 25 min — leaves headroom under 30-min schedule
const HEARTBEAT_KEY = `cron:lastRun:${CRON_KEY}`;
const RESOLVE_LIMIT = 200;

interface ResolveSummary {
  scanned: number;
  resolved: number;
  correct: number;
  wrong: number;
  priceFailed: number;
  skipped: number;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  const auth = await verifyCronRequest(request, 'ResolveOutcomes');
  if (auth !== true) return auth;

  const now = Date.now();
  const claim = await tryClaimCronRun(CRON_KEY, TICK_INTERVAL_MS, now);
  if (!claim.claimed) {
    return NextResponse.json({ skipped: true, reason: claim.reason ?? 'debounce' });
  }
  await setCronState(HEARTBEAT_KEY, now).catch(() => {});

  const summary: ResolveSummary = {
    scanned: 0, resolved: 0, correct: 0, wrong: 0, priceFailed: 0, skipped: 0,
  };

  try {
    const rows = await unresolvedDirectionalPastHorizon(RESOLVE_LIMIT);
    summary.scanned = rows.length;

    if (rows.length === 0) {
      return NextResponse.json({ ok: true, summary, detail: 'nothing to resolve' });
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

    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[ResolveOutcomes] tick failed', { error: msg });
    return NextResponse.json({ error: msg, summary }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
