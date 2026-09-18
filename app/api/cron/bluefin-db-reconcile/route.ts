/**
 * Cron Job: BlueFin Positions ↔ DB hedges reconciliation
 *
 * Closes the third drift path that the existing reconcilers don't cover:
 *
 *   sui-hedge-reconcile cron:    on-chain Move active_hedges ↔ BlueFin positions
 *   SuiHedgeReconciler service:  on-chain Move active_hedges ↔ DB hedges
 *   THIS cron:                   BlueFin positions ↔ DB hedges
 *
 * Why DB ↔ BlueFin drift matters:
 *  • Manual close via BlueFin UI: position disappears, DB still says "active"
 *    → analytics dashboards show ghost positions, share-price math wrong.
 *  • Manual open via BlueFin UI: position exists, DB has no row
 *    → reconciler can't compute PnL, cron may try to double-open.
 *  • Partial fills, liquidations, auto-deleverages — same divergence shapes.
 *
 * Drift repair (idempotent, fail-closed):
 *   1. Pull DB rows where chain='sui' AND status='active'.
 *   2. Pull live BlueFin positions.
 *   3. For each DB row not matched by a live BlueFin position of the same
 *      symbol+side: mark status='closed' with `realized_pnl=0` (no data —
 *      we don't know the exit price; this matches the existing reconciler
 *      behavior for vanished hedges, see [[hedge-pnl-columns]] memo).
 *   4. (We intentionally do NOT insert orphan BlueFin positions into the
 *      DB. That requires entry_price + opened-at metadata we don't have.
 *      Surface them in the Discord alert instead — operator triages.)
 *
 * Schedule: 15 min on QStash. Faster than sui-hedge-reconcile (hourly)
 * because DB-side drift directly affects user-facing analytics.
 *
 * Security: QStash signature or CRON_SECRET via verifyCronRequest.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { BluefinService, BLUEFIN_PAIRS } from '@/lib/services/sui/BluefinService';
import { classifyPosition } from '@/lib/services/sui/dust-manager';
import { getActiveHedges, closeHedge, createHedge, type Hedge } from '@/lib/db/hedges';
import { getCronStateOr, setCronState } from '@/lib/db/cron-state';
import { SUI_COMMUNITY_POOL_PORTFOLIO_ID } from '@/lib/constants';
import { query } from '@/lib/db/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const CRON_KEY_LAST_RUN = 'cron:lastRun:bluefin-db-reconcile';

// T1-C: max-hold force-close. Perp positions ride indefinitely while AI
// keeps the same direction; if the AI is stuck wrong for days the pool
// bleeds without any direction-flip or kill-switch triggering. Force-
// close any position older than HEDGE_MAX_HOLD_HOURS to bound the
// "stuck wrong" loss window. Default 24h matches the trader's daily
// PnL cap horizon. Disable by setting HEDGE_MAX_HOLD_HOURS=0.
const HEDGE_MAX_HOLD_HOURS = Number(process.env.HEDGE_MAX_HOLD_HOURS ?? 24);

interface ReconcileResult {
  success: boolean;
  ranAt: string;
  dbActiveCount: number;
  bluefinPositionsCount: number;
  phantomDbRows: Array<{ id: number; symbol: string; side: string; size: number }>;
  orphanBluefinPositions: Array<{ symbol: string; side: string; size: number }>;
  closedDbRowIds: number[];
  syncedDbRowIds: number[];
  ageForceClosed: Array<{ id: number; symbol: string; side: string; ageHours: number; closeOk: boolean; error?: string }>;
  error?: string;
}

type LivePosition = {
  symbol?: string; side?: string; size?: number;
  markPrice?: number; entryPrice?: number; unrealizedPnl?: number;
  leverage?: number;
};

function findMatchingPosition(
  hedge: Hedge,
  positions: LivePosition[],
): LivePosition | null {
  const hMarket = String(hedge.market || '').toUpperCase();
  const hSide = String(hedge.side || '').toUpperCase();
  return positions.find(p =>
    String(p.symbol || '').toUpperCase() === hMarket &&
    String(p.side || '').toUpperCase() === hSide,
  ) ?? null;
}

function matchesPosition(hedge: Hedge, positions: LivePosition[]): boolean {
  return findMatchingPosition(hedge, positions) !== null;
}

export async function GET(request: NextRequest): Promise<NextResponse<ReconcileResult>> {
  const ranAt = new Date().toISOString();
  void setCronState(CRON_KEY_LAST_RUN, Date.now()).catch(() => {});

  const auth = await verifyCronRequest(request, 'BluefinDbReconcile');
  if (auth !== true) {
    return NextResponse.json(
      {
        success: false, ranAt, dbActiveCount: 0, bluefinPositionsCount: 0,
        phantomDbRows: [], orphanBluefinPositions: [], closedDbRowIds: [], syncedDbRowIds: [], ageForceClosed: [],
        error: 'Unauthorized',
      } as ReconcileResult,
      { status: 401 },
    );
  }

  try {
    const bf = BluefinService.getInstance();
    const [dbHedges, positions, balance] = await Promise.all([
      getActiveHedges(undefined, 'sui'),
      bf.getPositions(),
      bf.getBalance().catch(() => 0),  // best-effort for cache write
    ]);

    // Refresh shared `bluefin:nav-last-good` cache whenever we have a
    // clean read here. Reconciler runs every 15 min, so combined with
    // bluefin-health (5 min) the NAV cache cadence becomes 5-15 min
    // from multiple redundant sources — if either cron's BlueFin call
    // succeeds, downstream consumers stay fresh.
    try {
      const { refreshBluefinCache } = await import('@/lib/services/sui/bluefin-read-safe');
      await refreshBluefinCache({
        free: balance,
        positions: positions as unknown as Array<Record<string, unknown>>,
        source: 'bluefin-db-reconcile',
      });
    } catch { /* best-effort */ }

    // Safety bail: BlueFin's /positions endpoint occasionally returns []
    // during transient venue issues (observed during the 2026-05-30 closeHedge
    // incident). If we run the phantom-close loop on that empty response,
    // every DB row with notional >= $1 gets marked closed at realized_pnl=0,
    // even though the positions are still live on BlueFin. Bail in that case
    // so the next 15-min tick can retry. We only bail when DB has SOME
    // notional-bearing rows — a genuinely empty pool is fine.
    const dbNotionalCount = dbHedges.filter(h => Number(h.notional_value ?? 0) >= 1).length;
    if (positions.length === 0 && dbNotionalCount > 0) {
      logger.error('[bluefin-db-reconcile] safety-bail: BlueFin returned 0 positions but DB has active notional hedges — refusing to mass-close (likely venue API blip)', {
        dbNotionalCount, dbActiveTotal: dbHedges.length,
      });
      await notifyDiscord(
        `bluefin-db-reconcile safety bail: BlueFin /positions returned [] while DB has ${dbNotionalCount} active notional-bearing hedge(s). Refusing to phantom-close. Will retry next tick.`,
        'WARN',
        { dbNotionalCount, dbActiveTotal: dbHedges.length },
      );
      return NextResponse.json({
        success: false, ranAt,
        dbActiveCount: dbHedges.length, bluefinPositionsCount: 0,
        phantomDbRows: [], orphanBluefinPositions: [], closedDbRowIds: [], syncedDbRowIds: [], ageForceClosed: [],
        error: `safety-bail: empty positions vs ${dbNotionalCount} notional DB hedges`,
      } as ReconcileResult);
    }

    // T1-C: force-close positions older than HEDGE_MAX_HOLD_HOURS. Runs
    // BEFORE the phantom/orphan reconciliation so the close shows up as
    // a phantom on the next tick if BlueFin processes it quickly.
    const ageForceClosed: ReconcileResult['ageForceClosed'] = [];
    if (HEDGE_MAX_HOLD_HOURS > 0) {
      const cutoffMs = Date.now() - HEDGE_MAX_HOLD_HOURS * 3600_000;
      // TTL that must match sui-hedge-reconcile's stale-close TTL —
      // both loops set/read the same stale-dust-flag:<id> key so
      // suppression is coordinated. If they diverge, one loop keeps
      // hammering the venue while the other backs off.
      const CLOSE_SUPPRESS_TTL_MS = 24 * 60 * 60 * 1000;
      for (const h of dbHedges) {
        // Skip operational micro-hedges. Reconstructed-orphan rows used
        // to be skipped here too on the theory that their created_at is
        // adoption-time (not real open-time on the venue) so max-hold
        // would fire prematurely. In practice that made every orphan
        // immortal — hedge #190 (adopted 2026-06-12, ETH SHORT $31 vs
        // signal LONG for 77 days) sat here bleeding funding because
        // this skip masked it from the age check. Use created_at as the
        // best-available age proxy; false-positive early close is safer
        // than never closing. Operational filter still requires BOTH
        // sub-$1 notional AND leverage=1x — real low-priced 3x hedges
        // (SUI-PERP when SUI < $1) must age-bound too.
        const notional = Number(h.notional_value ?? 0);
        const leverage = Number(h.leverage ?? 1);
        if (notional < 1 && leverage <= 1) continue;
        const createdMs = new Date(h.created_at).getTime();
        if (!Number.isFinite(createdMs) || createdMs > cutoffMs) continue;
        // Confirm it's actually still open on BlueFin before closing —
        // otherwise we'd just be alerting on a stale DB row that the
        // phantom-reconciler is about to clean up.
        const symbol = String(h.market || '');
        if (!matchesPosition(h, positions as Array<{ symbol?: string; side?: string; size?: number }>)) continue;
        // Coordinate with sui-hedge-reconcile: if the stale-close loop
        // has already tagged this hedge as DUST_LOCKED / SILENT_REJECT
        // within the TTL window, skip the max-hold attempt too. Prior
        // rev fired 96 close attempts/day on hedge #190 (every 15 min)
        // for the same silent-reject the hourly stale-close had already
        // classified — pure venue-side noise, zero closes.
        const suppressFlagKey = `stale-dust-flag:${h.id}`;
        const suppressAt = Number(await getCronStateOr<number>(suppressFlagKey, 0));
        if (suppressAt > 0 && Date.now() - suppressAt < CLOSE_SUPPRESS_TTL_MS) continue;
        const ageHours = (Date.now() - createdMs) / 3600_000;
        try {
          const closeRes = await bf.closeHedge({ symbol });
          ageForceClosed.push({
            id: h.id, symbol, side: String(h.side || ''),
            ageHours: Number(ageHours.toFixed(2)),
            closeOk: !!closeRes.success,
            error: closeRes.success ? undefined : closeRes.error,
          });
          // Set the shared suppress flag when we see a suppressible
          // failure — coordinates the two loops (max-hold + hourly
          // stale-close both back off 24h after either sees the same
          // venue-side lock).
          if (!closeRes.success &&
              (closeRes.code === 'DUST_LOCKED' || closeRes.code === 'SILENT_REJECT')) {
            await setCronState(suppressFlagKey, Date.now());
          }
        } catch (e) {
          ageForceClosed.push({
            id: h.id, symbol, side: String(h.side || ''),
            ageHours: Number(ageHours.toFixed(2)),
            closeOk: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (ageForceClosed.length > 0) {
        const ok = ageForceClosed.filter(c => c.closeOk).length;
        await notifyDiscord(
          `Max-hold force-close: ${ok}/${ageForceClosed.length} position(s) closed after ${HEDGE_MAX_HOLD_HOURS}h. ${ageForceClosed.map(c => `${c.symbol} ${c.side} ${c.ageHours}h ${c.closeOk ? 'OK' : 'FAIL'}`).join(', ')}.`,
          ok === ageForceClosed.length ? 'INFO' : 'WARN',
          { hours: HEDGE_MAX_HOLD_HOURS, closed: ageForceClosed },
        );
      }
    }

    const phantomDbRows: ReconcileResult['phantomDbRows'] = [];
    const closedDbRowIds: number[] = [];
    const syncedDbRowIds: number[] = [];
    const livePositions = positions as LivePosition[];
    for (const h of dbHedges) {
      // Skip paper trades — they never hit BlueFin so they'd always
      // look "phantom" here and get force-closed with pnl=0. The
      // getActiveHedges query filter was fixed 2026-09-17 to respect
      // the chain param, but guard here too so a future caller can't
      // regress this.
      if (h.simulation_mode || h.chain === 'hedera-testnet' || h.portfolio_id === -3) {
        continue;
      }

      // Skip operational micro-hedges only — the $0.01 transport entries
      // that exist purely as capability artifacts on the Move side (lev=1x,
      // sub-$1 notional, never on BlueFin). Filtering on notional alone
      // accidentally caught real low-priced SUI hedges (e.g. SUI-PERP LONG
      // 0.97 SUI × $0.76 = $0.88 notional, 3x lev) and left them
      // permanently out-of-sync. Require BOTH conditions to skip.
      const notional = Number(h.notional_value ?? 0);
      const leverage = Number(h.leverage ?? 1);
      if (notional < 1 && leverage <= 1) continue;

      const livePos = findMatchingPosition(h, livePositions);
      if (!livePos) {
        phantomDbRows.push({
          id: h.id,
          symbol: String(h.market || ''),
          side: String(h.side || ''),
          size: Number(h.size ?? 0),
        });
        try {
          // Use last-known current_pnl (refreshed each tick by the live-sync
          // block below from venue's unrealizedPnl) as the realized estimate.
          // Writing 0 was under-counting closed-hedge performance across the
          // entire history — same failure mode as close-hedge-impl.ts before
          // its unrealizedPnl fallback fix.
          const estRealized = Number(h.current_pnl ?? 0);
          await closeHedge(h.order_id, estRealized);
          closedDbRowIds.push(h.id);
        } catch (e) {
          logger.warn('[bluefin-db-reconcile] failed to close phantom DB row', {
            id: h.id, error: e instanceof Error ? e.message : String(e),
          });
        }
        continue;
      }

      // Matched: sync size + notional + current_price + current_pnl from live
      // BlueFin so the DB-sourced UI panel (HedgesPanel via /api/sui/community-pool)
      // doesn't fall out of sync with the live-sourced one (AutoHedgePanel via
      // /api/community-pool/auto-hedge). Without this, DB sizes drift over partial
      // fills/funding (observed on 2026-06-14: SUI-PERP DB=0.97 vs live=0.82, 17%
      // drift) and current_pnl stays stale (ETH-PERP DB=-$0.24 vs live=+$3.43,
      // $3.67 drift) until manual repair.
      const liveSize = Number(livePos.size ?? 0);
      const liveMark = Number(livePos.markPrice ?? livePos.entryPrice ?? 0);
      const liveEntry = Number(livePos.entryPrice ?? 0);
      const liveLeverage = Number(livePos.leverage ?? 0);
      const liveUpnl = Number(livePos.unrealizedPnl ?? 0);
      if (liveSize > 0 && liveMark > 0) {
        const liveNotional = liveSize * liveMark;
        const dbSize = Number(h.size ?? 0);
        const dbPnl = Number(h.current_pnl ?? 0);
        const dbEntry = Number(h.entry_price ?? 0);
        const dbLeverage = Number(h.leverage ?? 0);
        const sizeDriftPct = dbSize > 0 ? Math.abs(liveSize - dbSize) / dbSize : 1;
        const pnlDriftAbs = Math.abs(liveUpnl - dbPnl);
        // Entry drift is logged + repaired separately from size/pnl drift.
        // Entry changes when the venue records partial fills or weighted-
        // average updates (observed 2026-06-21: DB entry $1664 vs venue
        // truth $2016 on ETH SHORT — a $352 drift causing every consumer
        // reading DB-rooted entries to misrepresent the position).
        const entryDriftPct = dbEntry > 0 && liveEntry > 0
          ? Math.abs(liveEntry - dbEntry) / dbEntry
          : (liveEntry > 0 ? 1 : 0);
        const leverageDrift = Math.abs(liveLeverage - dbLeverage);
        const hadAnyDrift = sizeDriftPct > 0.001
          || pnlDriftAbs > 0.01
          || (liveEntry > 0 && entryDriftPct > 0.005)
          || (liveLeverage > 0 && leverageDrift > 0.01);
        // Only write if something actually moved — saves DB writes on no-op ticks.
        if (hadAnyDrift) {
          try {
            // Compose UPDATE dynamically so we only touch fields that have
            // a meaningful venue value (e.g. leverage=0 from a stale SDK
            // response shouldn't clobber the real DB leverage).
            const sets: string[] = [
              'size = $1',
              'notional_value = $2',
              'current_price = $3',
              'current_pnl = $4',
              "price_source = 'bluefin-live'",
              'price_updated_at = CURRENT_TIMESTAMP',
              'updated_at = CURRENT_TIMESTAMP',
            ];
            const params: Array<number> = [liveSize, liveNotional, liveMark, liveUpnl];
            let nextParam = 5;
            if (liveEntry > 0) {
              sets.push(`entry_price = $${nextParam++}`);
              params.push(liveEntry);
            }
            if (liveLeverage > 0) {
              sets.push(`leverage = $${nextParam++}`);
              params.push(liveLeverage);
            }
            params.push(h.id);
            await query(
              `UPDATE hedges SET ${sets.join(', ')} WHERE id = $${nextParam} AND status = 'active'`,
              params,
            );
            syncedDbRowIds.push(h.id);
            // Material entry drift suggests a fill happened or the venue
            // restated the position — page ops via Discord (INFO) so we
            // know the position changed under us.
            if (liveEntry > 0 && entryDriftPct > 0.05) {
              await notifyDiscord(
                `Entry-price drift repaired: ${h.market} ${h.side} ` +
                `DB=$${dbEntry.toFixed(4)} → venue=$${liveEntry.toFixed(4)} ` +
                `(${(entryDriftPct * 100).toFixed(1)}%). Likely a fill / weighted-avg restate.`,
                'INFO',
                { id: h.id, market: h.market, side: h.side, dbEntry, liveEntry, entryDriftPct },
              ).catch(() => {});
            }
          } catch (e) {
            logger.warn('[bluefin-db-reconcile] live-sync UPDATE failed', {
              id: h.id, error: e instanceof Error ? e.message : String(e),
            });
          }
        }
      }
    }

    const orphanBluefinPositions: ReconcileResult['orphanBluefinPositions'] = [];
    const orphanInsertedIds: number[] = [];
    // De-duplication window for reconstructed_* recovery rows. Without it,
    // a jittery BlueFin /positions response (visible on tick N, gone on
    // tick N+1, visible again on tick N+2) generates a fresh
    // reconstructed_<symbol>_<side>_<ts> order every visible tick because
    // the newly-created row was already closed as a phantom on the next.
    // That's how a single manually-opened ETH-SHORT produced 37 SHORT
    // rows in a single day on 2026-06-12 and skewed all downstream
    // analytics to "86% short bias" for a month afterwards. Look for a
    // recently-created recovery row with the same market+side before
    // inserting a new one.
    const RECOVERY_DEDUPE_HOURS = 6;
    const recentRecoveryMatch = async (symbol: string, side: string): Promise<boolean> => {
      try {
        const { query } = await import('@/lib/db/postgres');
        const rows = await query<{ id: number }>(
          `SELECT id FROM hedges
           WHERE chain = 'sui'
             AND market = $1
             AND side = $2
             AND order_id LIKE 'reconstructed_%'
             AND created_at >= NOW() - make_interval(hours => $3)
           LIMIT 1`,
          [symbol, side, RECOVERY_DEDUPE_HOURS],
        );
        return rows.length > 0;
      } catch (e) {
        // On DB probe error, err on the side of NOT inserting a duplicate
        // — a missing recovery row is easier to detect + fix than a
        // duplicate storm poisoning the analytics.
        logger.warn('[bluefin-db-reconcile] dedupe probe failed, treating as duplicate to be safe', {
          symbol, side, error: e instanceof Error ? e.message : String(e),
        });
        return true;
      }
    };
    for (const p of positions) {
      const pp = p as unknown as Record<string, unknown>;
      const symbol = String(pp.symbol || '').toUpperCase();
      const side = String(pp.side || '').toUpperCase();
      const size = Number(pp.size ?? 0);
      const matchedInDb = dbHedges.some(h =>
        String(h.market || '').toUpperCase() === symbol
        && String(h.side || '').toUpperCase() === side,
      );
      if (!matchedInDb && symbol && size > 0) {
        // Second guard: does a recovery row for this exact (market, side)
        // already exist within the dedupe window? If so, this is the
        // orphan storm scenario — bail.
        if (await recentRecoveryMatch(symbol, side)) {
          logger.info('[bluefin-db-reconcile] skipping duplicate orphan recovery', {
            symbol, side, size,
            reason: `recovery row for this shape exists within ${RECOVERY_DEDUPE_HOURS}h window`,
          });
          continue;
        }
        orphanBluefinPositions.push({ symbol, side, size });
        // Auto-recover: insert a reconstructed DB row with markPrice as the
        // entry estimate. Without this, the orphan sits forever and every
        // future reconcile tick re-alerts. The cron's createHedge sometimes
        // fails silently after openHedge succeeds (DB hiccup, schema drift),
        // so this is the closing-the-loop mechanism.
        try {
          const asset = symbol.replace('-PERP', '');
          const markPrice = Number(pp.markPrice ?? pp.entryPrice ?? 0);
          const leverage = Number(pp.leverage ?? 3);
          const notionalUsd = size * (markPrice || 0);
          if (notionalUsd > 0) {
            const reconstructed = await createHedge({
              orderId: `reconstructed_${symbol}_${side}_${Date.now()}`,
              portfolioId: SUI_COMMUNITY_POOL_PORTFOLIO_ID,
              walletAddress: (process.env.SUI_ADMIN_ADDRESS || '').trim(),
              asset,
              market: symbol,
              side: side as 'LONG' | 'SHORT',
              size,
              notionalValue: notionalUsd,
              leverage,
              entryPrice: markPrice,
              simulationMode: false,
              chain: 'sui',
              reason: `Orphan auto-recovered by bluefin-db-reconcile (entry=markPrice estimate; openHedge succeeded but createHedge missed)`,
            });
            orphanInsertedIds.push(reconstructed.id);
          }
        } catch (insertErr) {
          logger.warn('[bluefin-db-reconcile] orphan insert failed', {
            symbol, side, size,
            error: insertErr instanceof Error ? insertErr.message : String(insertErr),
          });
        }
      }
    }

    const drifted = phantomDbRows.length > 0 || orphanBluefinPositions.length > 0;
    if (drifted) {
      // Discord only alerts on ACTUAL orphan adoption (new
      // reconstructed_ rows inserted), not every reconcile that
      // touched a phantom row. Pure phantom cleanups happen every
      // time an operator closes a position manually on BlueFin — no
      // capital at risk, no action needed, so keep them off Discord.
      // Was firing INFO/WARN every 15 min for weeks pre-fix.
      const insertedCount = orphanInsertedIds.length;
      if (insertedCount > 0) {
        const orphanDesc = orphanBluefinPositions
          .map(r => `${r.symbol} ${r.side} ${r.size}`)
          .join(', ');
        await notifyDiscord(
          `Orphan BlueFin position adopted into DB (${insertedCount} row${insertedCount === 1 ? '' : 's'}): ${orphanDesc}. Phantoms cleaned: ${phantomDbRows.length}.`,
          'WARN',
          { phantomDbRows, orphanBluefinPositions, closedDbRowIds, orphanInsertedIds },
        );
      }
    }

    // Dust escalation scan: any active DB hedge whose live venue size is
    // sub-minQty gets flagged for ONE KILL alert + retry suppression.
    // Catches pre-2026-07-01 born-dust positions (before openHedge 1.5×
    // guard) and any orphan adopted at sub-minQty. Cross-checks against
    // live positions so a stale DB row doesn't falsely flag a healthy
    // hedge. Skips operational micro-hedges (notional < $1 + leverage=1).
    // Uses dust-manager.classifyPosition — single source of truth.
    try {
      for (const h of dbHedges) {
        const symbol = String(h.market || '');
        if (!(symbol in BLUEFIN_PAIRS)) continue;
        const notional = Number(h.notional_value ?? 0);
        const leverage = Number(h.leverage ?? 1);
        if (notional < 1 && leverage <= 1) continue;
        const livePos = positions.find(
          p => String((p as { symbol?: string }).symbol) === symbol
            && String((p as { side?: string }).side || '').toUpperCase() === String(h.side || '').toUpperCase(),
        );
        const liveSize = Math.abs(Number((livePos as { size?: number })?.size ?? 0));
        if (liveSize <= 0) continue;
        const cls = classifyPosition(symbol, liveSize);
        if (cls.exitPath !== 'UNCLEARABLE') continue;
        // Time-bound the dust flag (24h TTL). Boolean-forever prior rev
        // permanently muted this KILL alert once fired; if the position
        // ever un-sticks we want to re-page. See matching note in
        // sui-hedge-reconcile/route.ts stale-close block.
        const dustFlagKey = `stale-dust-flag:${h.id}`;
        const DUST_FLAG_TTL_MS = 24 * 60 * 60 * 1000;
        const flaggedAt = Number(await getCronStateOr<number>(dustFlagKey, 0));
        if (flaggedAt > 0 && Date.now() - flaggedAt < DUST_FLAG_TTL_MS) continue;
        await setCronState(dustFlagKey, Date.now());
        await notifyDiscord(
          `🔒 Hedge #${h.id} ${symbol} ${h.side} DUST-LOCKED (venue size ${liveSize} < minQty ${cls.minQty}). Unclearable on-order-book — escalate via BlueFin Discord #ticket-desk. Auto-close will skip this hedge.`,
          'KILL', { hedgeId: h.id, symbol, side: h.side, liveSize, minQty: cls.minQty },
        ).catch(() => {});
      }
    } catch { /* best-effort — dust scan is diagnostic, don't fail reconcile */ }

    logger.info('[bluefin-db-reconcile] complete', {
      dbActive: dbHedges.length,
      bluefinPositions: positions.length,
      phantomsClosed: closedDbRowIds.length,
      orphans: orphanBluefinPositions.length,
      liveSynced: syncedDbRowIds.length,
    });

    return NextResponse.json({
      success: true,
      ranAt,
      dbActiveCount: dbHedges.length,
      bluefinPositionsCount: positions.length,
      phantomDbRows,
      orphanBluefinPositions,
      closedDbRowIds,
      syncedDbRowIds,
      ageForceClosed,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('[bluefin-db-reconcile] error', { error: msg });
    return NextResponse.json(
      {
        success: false, ranAt, dbActiveCount: 0, bluefinPositionsCount: 0,
        phantomDbRows: [], orphanBluefinPositions: [], closedDbRowIds: [], syncedDbRowIds: [], ageForceClosed: [],
        error: msg,
      },
      { status: 500 },
    );
  }
}

export const POST = GET;
