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
import type { GateSignal } from '@/lib/services/paper-trader/entry-gates';

type GatePrediction = GateSignal['prediction'];

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

/** The vote the feedback loop's verdicts would cast, recorded beside the live one. */
export const SHADOW_SOURCE = 'aggregate:v2';
export const gateSource = (gate: string): string => `gate:${gate}`;
/**
 * Shadow and gate rows exist to be judged, and nothing judges beyond four
 * hours: a day-long horizon gives the loop about one window a day.
 */
const MEASURE_ONLY_MAX_HORIZON_MIN = 240;

/**
 * What the feedback loop needs recorded beside the votes the traders saw.
 * Every part is optional: the plain snapshot never depends on one.
 */
export interface SnapshotExtras {
  /** Each coin's votes before any was weighted or removed. Without it a removed source stops being measured and can never earn its way back. */
  rawSources?: Record<string, ScanSource[]>;
  /** The shadow vote per coin. */
  shadow?: Record<string, Pick<ScanPrediction, 'direction' | 'confidence' | 'probability'>>;
  /** Per coin, the entry gates that would refuse its current signal. */
  gateRefusals?: Record<string, string[]>;
}

/**
 * Pure row builder: one row per directional source per horizon, plus one
 * 'aggregate' row per asset per horizon (the composite the traders act on).
 * NEUTRAL calls are not rows — "no opinion" can't be right or wrong.
 * Assets without a validated price are skipped entirely (no entry anchor
 * → the resolver could never score them).
 *
 * A gate row carries the direction of the signal the gate refused, so its
 * measured result is the result of the trades that gate keeps out: negative
 * means the gate helps.
 */
export function buildSnapshotRows(
  scanAll: Record<string, ScanPrediction>,
  priceByAsset: Map<string, number>,
  now: number,
  normalizeKey: (name: string, type: string) => string,
  horizonsMin: number[] = HORIZONS_MIN,
  extras: SnapshotExtras = {},
): RecordSignalArgs[] {
  const rows: RecordSignalArgs[] = [];
  for (const [asset, pred] of Object.entries(scanAll)) {
    const entryPrice = priceByAsset.get(asset.toUpperCase());
    if (!entryPrice || entryPrice <= 0) continue;
    for (const horizonMin of horizonsMin) {
      const windowEndTime = now + horizonMin * 60_000;
      for (const s of extras.rawSources?.[asset] ?? pred.sources ?? []) {
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
      if (horizonMin > MEASURE_ONLY_MAX_HORIZON_MIN) continue;
      const shadow = extras.shadow?.[asset];
      if (shadow && (shadow.direction === 'UP' || shadow.direction === 'DOWN')) {
        rows.push({
          source: SHADOW_SOURCE,
          asset,
          horizonMin,
          windowEndTime,
          direction: shadow.direction,
          probability: Math.max(0, Math.min(1, (shadow.probability ?? shadow.confidence) / 100)),
          confidence: shadow.confidence,
          entryPrice,
        });
      }
      if (pred.direction === 'UP' || pred.direction === 'DOWN') {
        for (const gate of extras.gateRefusals?.[asset] ?? []) {
          rows.push({
            source: gateSource(gate),
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
  }
  return rows;
}

/** Gate checks read the book's history and a volatility feed; the snapshot does not wait on them past this. */
const GATE_BUDGET_MS = 8_000;

/**
 * Gather the extras for one snapshot. Each part fails to "absent" on its
 * own: a part that only measures must never cost the snapshot itself.
 */
async function gatherSnapshotExtras(
  scanAll: Record<string, ScanPrediction>,
  universe: string[],
  now: number,
  normalizeKey: (name: string, type: string) => string,
): Promise<SnapshotExtras> {
  const extras: SnapshotExtras = {};
  try {
    const { PredictionAggregatorService } = await import('./PredictionAggregatorService');
    const raw = await PredictionAggregatorService.getPerAssetRawSources(universe);
    extras.rawSources = raw;
    const [{ applyLoopVerdicts, getLoopState }, { calculateAggregation }] = await Promise.all([import('./feedback-loop'), import('./aggregator-math')]);
    const state = await getLoopState();
    extras.shadow = Object.fromEntries(
      Object.entries(raw).map(([asset, sources]) => [asset, calculateAggregation(applyLoopVerdicts(sources, state, asset, normalizeKey))]),
    );
  } catch (e) {
    logger.warn('[SignalLedger] raw votes or shadow vote unavailable this snapshot', { error: errMsg(e) });
  }
  try {
    const { entryGateSetting, gateRefusals } = await import('@/lib/services/paper-trader/entry-gates');
    const collect = async (): Promise<Record<string, string[]>> => {
      const setting = await entryGateSetting(now);
      const out: Record<string, string[]> = {};
      // One coin at a time: each coin's gates already run side by side, and
      // five coins at once would take a large share of the connection pool.
      for (const [asset, pred] of Object.entries(scanAll)) {
        if (pred.direction !== 'UP' && pred.direction !== 'DOWN') continue;
        out[asset] = await gateRefusals({ asset, direction: pred.direction, prediction: pred as unknown as GatePrediction }, setting);
      }
      return out;
    };
    const refusals = await Promise.race([collect(), new Promise<null>((resolve) => setTimeout(() => resolve(null), GATE_BUDGET_MS))]);
    if (refusals) extras.gateRefusals = refusals;
    else logger.warn('[SignalLedger] gate checks exceeded their budget; no gate rows this snapshot');
  } catch (e) {
    logger.warn('[SignalLedger] gate checks unavailable this snapshot', { error: errMsg(e) });
  }
  return extras;
}

export interface LedgerTickSummary {
  snapshotted: boolean;
  recorded: number;
  resolved: number;
  correct: number;
  voided: number;
  pruned: number;
  /** Set on the tick that re-judged the ledger: what the feedback loop now holds. */
  loop?: string;
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

      const scanAll = scan.all as unknown as Record<string, ScanPrediction>;
      const extras = await gatherSnapshotExtras(scanAll, PAPER_UNIVERSE, now, normalizeSourceKey);
      const rows = buildSnapshotRows(scanAll, priceByAsset, now, normalizeSourceKey, undefined, extras);
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

  // 2b) Once a day the feedback loop re-judges the ledger. It rides a
  //     snapshot tick so its "already done today?" read costs one state read
  //     per ten minutes, not one per tick.
  if (summary.snapshotted) {
    try {
      const { runFeedbackLoopEvaluation } = await import('./feedback-loop');
      const state = await runFeedbackLoopEvaluation(now);
      if (state) {
        const c = state.counts;
        summary.loop = `judged ${c.cellsJudged + c.familiesJudged}, proven ${c.proven}, wrong-way ${c.wrongWay}, pending ${c.pending}`;
      }
    } catch (e) {
      logger.warn('[SignalLedger] feedback-loop evaluation failed (non-fatal)', { error: errMsg(e) });
    }
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
