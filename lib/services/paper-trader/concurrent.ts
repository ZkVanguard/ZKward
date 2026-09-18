/**
 * Concurrent-position support for the paper trader.
 *
 * When PAPER_MAX_CONCURRENT > 1, positions are stored as an array under
 * KEY_POSITIONS instead of the single KEY_POSITION slot. Single-position
 * mode (default) remains untouched so existing behavior and tests are
 * unaffected.
 *
 * Contract:
 *   - Active positions are the source of truth in cron_state.
 *   - Same-asset never opens twice concurrently (one asset = one position).
 *   - Correlation cluster gate prevents 3× same-direction on
 *     BTC/ETH/SOL from acting like one giant leveraged bet.
 *
 * Migration: on first read after enabling concurrent mode, if
 * KEY_POSITION holds a single position and KEY_POSITIONS is empty, the
 * single position is promoted into the array and KEY_POSITION cleared.
 */
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import type { SimulatedPosition, Side } from './simulated-executor';
import {
  KEY_POSITION,
  KEY_ORDER_ID,
  KEY_POSITIONS,
  PAPER_CORRELATION_CLUSTERS,
  PAPER_MAX_SAME_DIR_PER_CLUSTER,
} from './config';

export interface ActivePosition {
  orderId: string;
  position: SimulatedPosition;
}

/** Read the current active-positions array, migrating any legacy single
 *  position into the array on first read. Idempotent. */
export async function loadActivePositions(): Promise<ActivePosition[]> {
  const arr = (await getCronState<ActivePosition[]>(KEY_POSITIONS)) ?? [];
  if (arr.length > 0) return arr;

  // Migrate legacy single-position storage into the array shape.
  const legacyPos = await getCronState<SimulatedPosition>(KEY_POSITION);
  const legacyOrderId = await getCronState<string>(KEY_ORDER_ID);
  if (legacyPos && legacyOrderId) {
    const migrated: ActivePosition[] = [{ orderId: legacyOrderId, position: legacyPos }];
    await setCronState(KEY_POSITIONS, migrated).catch(() => undefined);
    await setCronState(KEY_POSITION, null).catch(() => undefined);
    await setCronState(KEY_ORDER_ID, null).catch(() => undefined);
    logger.info('[PaperTrader:concurrent] migrated legacy single position into array', {
      asset: legacyPos.asset,
      side: legacyPos.side,
    });
    return migrated;
  }
  return [];
}

export async function saveActivePositions(positions: ActivePosition[]): Promise<void> {
  await setCronState(KEY_POSITIONS, positions).catch(() => undefined);
}

/** Add a fresh entry to the active-positions array. */
export async function addActivePosition(entry: ActivePosition): Promise<void> {
  const arr = await loadActivePositions();
  arr.push(entry);
  await saveActivePositions(arr);
}

/** Remove a position by orderId (called at close). No-op if not found. */
export async function removeActivePosition(orderId: string): Promise<void> {
  const arr = await loadActivePositions();
  const filtered = arr.filter((p) => p.orderId !== orderId);
  if (filtered.length !== arr.length) await saveActivePositions(filtered);
}

/** Update a position's mutable fields (e.g. peakUnrealizedPnl) in-place. */
export async function updateActivePosition(
  orderId: string,
  updater: (pos: SimulatedPosition) => SimulatedPosition,
): Promise<void> {
  const arr = await loadActivePositions();
  let changed = false;
  const next = arr.map((p) => {
    if (p.orderId !== orderId) return p;
    changed = true;
    return { ...p, position: updater(p.position) };
  });
  if (changed) await saveActivePositions(next);
}

// ── Mode-aware facade (2026-09-18) ───────────────────────────────────
//
// Hides the KEY_POSITION-vs-KEY_POSITIONS branching from callers. All
// paper-trader write sites (open, update, close) go through these three
// functions rather than checking PAPER_MAX_CONCURRENT themselves.
//
// Motivation: two 2026-09-18 bugs (PR #127 orphaned DB rows, PR #129
// blind /paper endpoint) came from a caller forgetting the mode check.
// Centralizing the branch removes the class of bug entirely.
//
// Legacy mode retained (not deleted) because unit tests still exercise
// the KEY_POSITION path directly; a rip-out would churn 30+ test cases
// with no behavior improvement.
import { PAPER_MAX_CONCURRENT } from './config';

/** Open a new position. Legacy: writes KEY_POSITION + KEY_ORDER_ID.
 *  Concurrent: appends to the array. */
export async function positionOpen(entry: ActivePosition): Promise<void> {
  if (PAPER_MAX_CONCURRENT > 1) {
    await addActivePosition(entry);
    return;
  }
  const { setCronState } = await import('@/lib/db/cron-state');
  await setCronState(KEY_POSITION, entry.position);
  await setCronState(KEY_ORDER_ID, entry.orderId);
}

/** Mutate a position (typically to bump peakUnrealizedPnl).
 *  In legacy mode this rewrites KEY_POSITION. */
export async function positionUpdate(
  orderId: string,
  updater: (pos: SimulatedPosition) => SimulatedPosition,
): Promise<void> {
  if (PAPER_MAX_CONCURRENT > 1) {
    await updateActivePosition(orderId, updater);
    return;
  }
  const { getCronState, setCronState } = await import('@/lib/db/cron-state');
  const pos = await getCronState<SimulatedPosition>(KEY_POSITION);
  if (pos) await setCronState(KEY_POSITION, updater(pos));
}

/** Close/remove a position from the store. */
export async function positionClose(orderId: string): Promise<void> {
  if (PAPER_MAX_CONCURRENT > 1) {
    await removeActivePosition(orderId);
    return;
  }
  const { setCronState } = await import('@/lib/db/cron-state');
  await setCronState(KEY_POSITION, null);
  await setCronState(KEY_ORDER_ID, null);
}

// ── Entry gates ──────────────────────────────────────────────────────

/** Which cluster does this asset belong to (if any)? Returns null when
 *  the asset isn't in any correlation cluster. */
export function clusterFor(asset: string): string[] | null {
  for (const cluster of PAPER_CORRELATION_CLUSTERS) {
    if (cluster.includes(asset)) return cluster;
  }
  return null;
}

/** Reject a candidate open if:
 *  - the same asset is already active (no doubling up on one asset)
 *  - opening this direction would exceed PAPER_MAX_SAME_DIR_PER_CLUSTER
 *    for the cluster the asset belongs to
 *
 * Returns null when the candidate is allowed, or a rejection reason
 * string when it isn't.
 */
export function rejectionReason(
  candidateAsset: string,
  candidateSide: Side,
  active: ActivePosition[],
): string | null {
  // Same-asset dedup
  if (active.some((p) => p.position.asset === candidateAsset)) {
    return `already active on ${candidateAsset}`;
  }
  // Correlation cluster cap
  const cluster = clusterFor(candidateAsset);
  if (cluster) {
    const sameDirInCluster = active.filter(
      (p) => cluster.includes(p.position.asset) && p.position.side === candidateSide,
    ).length;
    if (sameDirInCluster >= PAPER_MAX_SAME_DIR_PER_CLUSTER) {
      return `cluster ${cluster.join('/')} already has ${sameDirInCluster} ${candidateSide} — max ${PAPER_MAX_SAME_DIR_PER_CLUSTER}`;
    }
  }
  return null;
}
