/**
 * Signal Ledger tick — snapshots every prediction source's directional call
 * at fixed horizons and resolves expired ones against the tape.
 *
 * Root-fix Pillar 2 (docs/_ops/PAPER_TRADER_ROOT_AUDIT_2026-09-27.md):
 * learning decoupled from trading. Trades supply ~5-40 labeled outcomes a
 * day; this supplies thousands, scored against fixed-horizon forward
 * returns instead of exit-policy-dependent trade windows. The admission
 * gate (Pillar 3) flips on once ledger cells reach n≥500.
 *
 * Runs on the paper-fast-tick (60s). Snapshots are debounced to
 * SIGNAL_LEDGER_SNAPSHOT_MIN (default 10min); resolution runs every tick
 * so windows close within ~1-2min of expiry (the honesty cap in
 * signal-outcomes voids anything resolved >15min late).
 *
 * Volume: ~10 sources × 5 assets × 3 horizons × 144 snapshots/day ≈ 20k
 * rows/day; terminal rows pruned after 90 days.
 */

import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import {
  recordSignal,
  resolveExpiredSignals,
  pruneOldSignalOutcomes,
  type RecordSignalArgs,
} from '@/lib/db/signal-outcomes';

const SNAPSHOT_DEBOUNCE_MS =
  Number(process.env.SIGNAL_LEDGER_SNAPSHOT_MIN || 10) * 60_000;
const HORIZONS_MIN: number[] = (process.env.SIGNAL_LEDGER_HORIZONS_MIN || '30,60,240')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 5 && n <= 24 * 60);
const RETENTION_DAYS = Number(process.env.SIGNAL_LEDGER_RETENTION_DAYS || 90);

const KEY_LAST_SNAPSHOT = 'signal-ledger:last-snapshot';
const KEY_LAST_PRUNE = 'signal-ledger:last-prune';
const KEY_LAST_SUPPLY_ALARM = 'signal-ledger:last-supply-alarm';

interface ScanSource {
  name: string;
  type?: string;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence?: number;
  probability?: number;
}

interface ScanPrediction {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence: number;
  probability?: number;
  sources: ScanSource[];
}

/**
 * Pure row builder: one row per directional source per horizon, plus one
 * 'aggregate' row per asset per horizon (the composite the traders act on).
 * NEUTRAL calls are not rows — "no opinion" can't be right or wrong.
 * Assets without a validated price are skipped entirely (no entry anchor
 * → the resolver could never score them).
 */
export function buildSnapshotRows(
  scanAll: Record<string, ScanPrediction>,
  priceByAsset: Map<string, number>,
  now: number,
  normalizeKey: (name: string, type: string) => string,
  horizonsMin: number[] = HORIZONS_MIN,
): RecordSignalArgs[] {
  const rows: RecordSignalArgs[] = [];
  for (const [asset, pred] of Object.entries(scanAll)) {
    const entryPrice = priceByAsset.get(asset.toUpperCase());
    if (!entryPrice || entryPrice <= 0) continue;
    for (const horizonMin of horizonsMin) {
      const windowEndTime = now + horizonMin * 60_000;
      for (const s of pred.sources ?? []) {
        if (s.direction !== 'UP' && s.direction !== 'DOWN') continue;
        rows.push({
          source: normalizeKey(s.name ?? '', s.type ?? ''),
          asset,
          horizonMin,
          windowEndTime,
          direction: s.direction,
          probability: Math.max(0, Math.min(1, (s.probability ?? s.confidence ?? 50) / 100)),
          confidence: s.confidence,
          entryPrice,
        });
      }
      if (pred.direction === 'UP' || pred.direction === 'DOWN') {
        rows.push({
          source: 'aggregate',
          asset,
          horizonMin,
          windowEndTime,
          direction: pred.direction,
          probability: Math.max(0, Math.min(1, (pred.probability ?? pred.confidence) / 100)),
          confidence: pred.confidence,
          entryPrice,
        });
      }
    }
  }
  return rows;
}

export interface LedgerTickSummary {
  snapshotted: boolean;
  recorded: number;
  resolved: number;
  correct: number;
  voided: number;
  pruned: number;
}

/** One ledger tick: resolve always, snapshot on debounce, prune daily. */
export async function runSignalLedgerTick(now: number = Date.now()): Promise<LedgerTickSummary> {
  const summary: LedgerTickSummary = {
    snapshotted: false, recorded: 0, resolved: 0, correct: 0, voided: 0, pruned: 0,
  };

  // 1) Resolve expired windows every tick — cheap when nothing is pending.
  try {
    const r = await resolveExpiredSignals({ maxBatch: 300, now });
    summary.resolved = r.resolved;
    summary.correct = r.correct;
    summary.voided = r.voided;
  } catch (e) {
    logger.warn('[SignalLedger] resolve failed (non-fatal)', { error: errMsg(e) });
  }

  // 2) Snapshot on debounce.
  try {
    const last = (await getCronState<number>(KEY_LAST_SNAPSHOT)) ?? 0;
    if (now - last >= SNAPSHOT_DEBOUNCE_MS) {
      await setCronState(KEY_LAST_SNAPSHOT, now);

      const { PredictionAggregatorService } = await import('./PredictionAggregatorService');
      const { PAPER_UNIVERSE } = await import('@/lib/services/paper-trader/config');
      const { normalizeSourceKey } = await import('@/lib/services/ai/source-calibrator');
      const { getMultiSourceValidatedPrice } = await import('./unified-price-provider');

      // Gates zeroed: the ledger observes EVERYTHING, including sources and
      // assets the trader would reject — that's the point (observation is
      // free, influence is earned). 20s aggregator TTL means this reuses
      // the scan the traders just made on the same tick.
      const scan = await PredictionAggregatorService.scanAndPickBest(PAPER_UNIVERSE, {
        minConfidence: 0, minConsensus: 0, minSources: 1,
      });

      const priceByAsset = new Map<string, number>();
      await Promise.allSettled(
        Object.keys(scan.all).map(async (asset) => {
          const v = await getMultiSourceValidatedPrice(asset, {
            minSources: 2, maxDeviationPercent: 2, timeout: 8000,
          });
          if (Number.isFinite(v.price) && v.price > 0) priceByAsset.set(asset.toUpperCase(), v.price);
        }),
      );

      const rows = buildSnapshotRows(
        scan.all as unknown as Record<string, ScanPrediction>,
        priceByAsset,
        now,
        normalizeSourceKey,
      );
      // Sequential-ish in chunks — recordSignal is an idempotent single
      // INSERT; chunking keeps pool pressure bounded on a 20-row tick.
      const CHUNK = 20;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await Promise.allSettled(rows.slice(i, i + CHUNK).map((r) => recordSignal(r)));
      }
      summary.recorded = rows.length;
      summary.snapshotted = true;
    }
  } catch (e) {
    logger.warn('[SignalLedger] snapshot failed (non-fatal)', { error: errMsg(e) });
  }

  // 3) Daily prune of terminal rows past retention.
  try {
    const lastPrune = (await getCronState<number>(KEY_LAST_PRUNE)) ?? 0;
    if (now - lastPrune >= 24 * 60 * 60_000) {
      await setCronState(KEY_LAST_PRUNE, now);
      summary.pruned = await pruneOldSignalOutcomes(RETENTION_DAYS);
    }
  } catch (e) {
    logger.warn('[SignalLedger] prune failed (non-fatal)', { error: errMsg(e) });
  }

  // 4) Signal-supply staleness alarm (root audit R5): the AI interpreter
  //    died silently on 2026-09-23 and nothing noticed for 4 days. This
  //    lives here because the fast-tick is the always-alive path. WARN
  //    (ring-buffer-visible) at most once per 12h while stale.
  try {
    await checkSignalSupplyAlarm(now);
  } catch { /* alarm must never break the tick */ }

  return summary;
}

const SUPPLY_WARN_AFTER_MS = Number(process.env.SIGNAL_SUPPLY_WARN_AFTER_H || 6) * 3_600_000;
const SUPPLY_ALARM_DEBOUNCE_MS = 12 * 3_600_000;

async function checkSignalSupplyAlarm(now: number): Promise<void> {
  const lastAlarm = (await getCronState<number>(KEY_LAST_SUPPLY_ALARM)) ?? 0;
  if (now - lastAlarm < SUPPLY_ALARM_DEBOUNCE_MS) return;

  const { query } = await import('@/lib/db/postgres');
  const rows = await query<{ latest: string | null }>(
    `SELECT MAX(interpreted_at)::text AS latest FROM signal_interpretations`,
  );
  const latest = rows[0]?.latest ? new Date(rows[0].latest).getTime() : 0;
  if (!latest) return; // table empty/new — nothing to compare
  const ageMs = now - latest;
  if (ageMs < SUPPLY_WARN_AFTER_MS) return;

  await setCronState(KEY_LAST_SUPPLY_ALARM, now);
  const ageH = Math.round(ageMs / 3_600_000);
  const { notifyDiscord } = await import('@/lib/utils/discord-notify');
  await notifyDiscord(
    `Signal supply STALE — newest signal_interpretations row is ${ageH}h old. ` +
    `The AI interpreter is not producing. ` +
    `Check SIGNAL_INTERPRETER_ENABLED / SIGNAL_INTERPRETER_MODEL_URL on Vercel + Ollama tunnel.`,
    'WARN',
    { component: 'signal-ledger', ageHours: ageH },
  ).catch(() => undefined);
}
