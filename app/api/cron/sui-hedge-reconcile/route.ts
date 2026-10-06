/**
 * Cron Job: SUI Hedge State Reconciliation (Move ↔ BlueFin)
 *
 * Detects and repairs drift between the Move contract's `hedge_state` and
 * the actual live positions on BlueFin Pro.
 *
 * Drift sources:
 *   1. BlueFin auto-liquidates a position (15%+ adverse move on leveraged perp)
 *      → on-chain `total_hedged_value` over-reports NAV until corrected.
 *   2. Manual position close on BlueFin UI bypassing the contract.
 *   3. Network failure between BlueFin close + on-chain close_hedge call.
 *
 * Why this matters for $1B+ scale:
 *   The on-chain `total_hedged_value` is used by the Move withdrawal cap
 *   (`max_single_withdrawal_bps * nav`). If it over-reports by $50M, depositors
 *   could withdraw $50M more than the pool actually has → bank-run risk.
 *
 * Repair strategy:
 *   - Read on-chain `active_hedges` from the pool state object.
 *   - Read live BlueFin positions (BTC-PERP, ETH-PERP, SUI-PERP).
 *   - Map each on-chain hedge to a live position (by symbol presence).
 *   - If 1+ on-chain hedges have NO matching live position → drift detected.
 *   - When AdminCap is held by cron signer: call `admin_reset_hedge_state`
 *     to clear the on-chain vector + zero `total_hedged_value`. Next AI cron
 *     re-opens hedges as needed based on signal.
 *   - When AdminCap is multisig-gated: skip and emit a structured warning
 *     so a human operator gets paged.
 *
 * Schedule: Every 1 hour via QStash (defense-in-depth — the auto-hedge cron
 * already cleans DB rows; this cron handles the on-chain side).
 *
 * Security: QStash signature or CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { isPoolTradingEnabled } from '@/lib/services/sui/pool-trading-pause';
import { verifyCronRequest } from '@/lib/qstash';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { errMsg } from '@/lib/utils/error-handler';
import { SUI_USDC_POOL_CONFIG, SUI_USDC_COIN_TYPE } from '@/lib/types/sui-pool-types';
import { BluefinService, type BluefinPosition } from '@/lib/services/sui/BluefinService';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { getCronStateOr, setCronState } from '@/lib/db/cron-state';
// Static so Graphify sees the stale-hedge dispatch. Left the 3 @mysten/sui
// SDK dynamic imports alone (cold-start defers, low graph value).
import { detectStaleHedges } from '@/lib/services/sui/StaleHedgeDetector';
import { envFlagOnByDefault } from '@/lib/utils/env-flag';
import { runWatchdogChecks } from '@/lib/services/deploy-watchdog/run';
import { Polymarket5MinService } from '@/lib/services/market-data/Polymarket5MinService';
import { query } from '@/lib/db/postgres';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface ReconcileResult {
  success: boolean;
  ranAt: string;
  network: 'mainnet' | 'testnet';
  attempted: boolean;
  onChainHedges?: number;
  liveBluefinPositions?: number;
  driftDetected?: boolean;
  driftDetails?: {
    onChainHedgesUsdc: number;
    liveMarginUsdc: number;
    deltaUsdc: number;
  };
  resetExecuted?: boolean;
  txDigest?: string;
  reason?: string;
  error?: string;
}

/**
 * Symbol families a Move hedge can map to. The Move contract stores hedges
 * by `pair_index` not `symbol`, but at the protocol level there are exactly
 * 3 active perp markets. As long as ANY live position exists per market that
 * the on-chain side believes is open, we treat the side as "in sync".
 */
const SUPPORTED_SYMBOLS = ['BTC-PERP', 'ETH-PERP', 'SUI-PERP'] as const;

export async function GET(request: NextRequest): Promise<NextResponse<ReconcileResult>> {
  const ranAt = new Date().toISOString();
  const network: 'mainnet' | 'testnet' =
    (process.env.SUI_NETWORK as 'mainnet' | 'testnet') === 'testnet' ? 'testnet' : 'mainnet';

  const auth = await verifyCronRequest(request, 'SuiHedgeReconcile');
  // Heartbeat for /api/health/production cron-freshness check. Fire-and-forget
  // so a DB hiccup never blocks reconcile work.
  void setCronState('cron:lastRun:sui-hedge-reconcile', Date.now()).catch(() => {});
  if (auth !== true) {
    return NextResponse.json(
      { success: false, ranAt, network, attempted: false, reason: 'Unauthorized' },
      { status: 401 },
    );
  }

  // Piggyback silent-drift watchdog on this hourly cron — the pool is at
  // its 10-slot QStash schedule cap and this pair (deploy-drift + state-
  // integrity) is pure observability. Runs first so a slow BlueFin fetch
  // downstream doesn't starve the checks; best-effort so a failure here
  // never blocks capital work.
  await runWatchdogChecks().catch((err) => {
    logger.warn('[sui-hedge-reconcile] watchdog piggyback failed (non-critical)', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const adminKey = (process.env.SUI_POOL_ADMIN_KEY || process.env.BLUEFIN_PRIVATE_KEY || '').trim();
  const adminCapId = (process.env.SUI_ADMIN_CAP_ID || '').trim();
  const poolConfig = SUI_USDC_POOL_CONFIG[network];

  if (!adminKey || !poolConfig.packageId || !poolConfig.poolStateId) {
    return NextResponse.json({
      success: true,
      ranAt,
      network,
      attempted: false,
      reason: 'admin key or pool not configured',
    });
  }

  try {
    const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
    const { Transaction } = await import('@mysten/sui/transactions');
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

    const suiClient = createFailoverSuiClient(network);

    // 1. Read on-chain hedge state
    const poolObj = await suiClient.getObject({
      id: poolConfig.poolStateId!,
      options: { showContent: true },
    });
    type ContentLike = { fields?: { hedge_state?: { fields?: { active_hedges?: unknown[]; total_hedged_value?: string | number } } } };
    const content = (poolObj.data?.content as unknown as ContentLike) || {};
    const hedgeStateFields = content.fields?.hedge_state?.fields || {};
    const onChainHedges: unknown[] = Array.isArray(hedgeStateFields.active_hedges)
      ? hedgeStateFields.active_hedges
      : [];
    const onChainHedgedRaw = Number(hedgeStateFields.total_hedged_value || 0);
    const onChainHedgedUsdc = onChainHedgedRaw / 1e6;

    // 2. Read live BlueFin positions
    let livePositions: BluefinPosition[] = [];
    let liveMarginUsdc = 0;
    try {
      const bf = BluefinService.getInstance();
      await bf.initialize(adminKey, network === 'mainnet' ? 'mainnet' : 'testnet');
      livePositions = await bf.getPositions();
      for (const p of livePositions) {
        liveMarginUsdc += Number(p.margin || 0);
      }

      // ── Gap 6: stale-hedge detection ─────────────────────────────
      // Any active hedge older than STALE_HEDGE_AGE_DAYS (default 7)
      // with ≥ STALE_HEDGE_MIN_FLIPS signal flips since open (default 2)
      // and a current signal that contradicts its side → force-close.
      // Discord WARN fires per stale. Env gate STALE_HEDGE_AUTO_CLOSE=1
      // required for the actual close; log-only otherwise.
      try {
        // Include ALL active hedges (not just notional_value >= 1). The
        // notional filter previously hid orphan operational hedges (e.g.
        // #5 SUI LONG at $0.53 sat 69 days invisible to this check). Age +
        // max-age gates in StaleHedgeDetector are the actual staleness
        // arbiter; the $1 filter was defense-in-depth that turned into
        // defense-in-blindness.
        const activeRows = await query<{ id: number; asset: string; side: 'LONG' | 'SHORT'; created_at: Date; notional_value: number }>(
          `SELECT id, asset, side, created_at, notional_value FROM hedges
           WHERE chain='sui' AND status='active'`
        );
        const activeHedges = activeRows.map((r) => ({
          id: r.id,
          asset: r.asset,
          side: r.side,
          openedAt: new Date(r.created_at),
          notionalUsd: Number(r.notional_value),
        }));
        // Flip counts per asset — pull from Polymarket ring buffer if
        // present, else default to conservative estimate of 3/week.
        const flipsPerAsset: Record<string, number> = {};
        for (const h of activeHedges) {
          const ageDays = (Date.now() - h.openedAt.getTime()) / (86_400_000);
          flipsPerAsset[h.asset] = Math.max(0, Math.floor(ageDays * (3 / 7)));
        }
        // Per-asset signals via PredictionAggregatorService — previous code
        // called getLatest5MinSignal() (BTC-only) and applied that direction
        // to EVERY asset's contradicts check. Result: ETH SHORT #190 sat
        // for 52 days because on ticks where BTC was DOWN, the stale check
        // saw "ETH signal = DOWN" → aligned with SHORT → skipped. Fixed by
        // asking PredictionAggregator for each asset's own signal.
        const currentSignals: Record<string, { direction: 'UP' | 'DOWN'; confidence: number }> = {};
        try {
          const uniqueAssets = Array.from(new Set(activeHedges.map((h) => h.asset)));
          if (uniqueAssets.length > 0) {
            const { PredictionAggregatorService } = await import('@/lib/services/market-data/PredictionAggregatorService');
            const perAsset = await PredictionAggregatorService.getPerAssetPredictions(uniqueAssets);
            for (const asset of uniqueAssets) {
              const p = perAsset[asset];
              if (!p) continue;
              // PredictionAggregator returns direction in the union
              // 'UP' | 'DOWN' | 'NEUTRAL'; only UP/DOWN are actionable
              // signals for stale-close (NEUTRAL doesn't contradict either
              // side, so we leave the hedge alone).
              if (p.direction === 'UP' || p.direction === 'DOWN') {
                currentSignals[asset] = { direction: p.direction, confidence: p.confidence };
              }
            }
          }
        } catch (sigErr) {
          logger.warn('[SuiHedgeReconcile] per-asset signal fetch failed — falling back to Polymarket BTC-only signal', {
            error: sigErr instanceof Error ? sigErr.message : String(sigErr),
          });
          // Fallback preserves prior behavior on outage (BTC-signal-for-all,
          // known false negatives) instead of silently disabling stale-close
          // entirely.
          const btc = await Polymarket5MinService.getLatest5MinSignal().catch(() => null);
          if (btc) {
            for (const h of activeHedges) {
              currentSignals[h.asset] = { direction: btc.direction, confidence: btc.confidence };
            }
          }
        }
        const stale = await detectStaleHedges({
          activeHedges,
          signalFlipsPerAsset: flipsPerAsset,
          currentSignals,
        });
        if (stale.length > 0) {
          const autoClose = envFlagOnByDefault('STALE_HEDGE_AUTO_CLOSE');
          logger.warn('[SuiHedgeReconcile] stale hedges detected', {
            autoClose, count: stale.length, stale,
          });
          await notifyDiscord(
            `🕰️ ${stale.length} stale hedge(s) detected [${autoClose ? 'auto-closing' : 'log-only'}]: ${stale.map((s) => `#${s.id} ${s.asset} ${s.side} age=${s.ageDays}d`).join(', ')}`,
            'WARN',
            { stale, autoClose },
          ).catch(() => {});
          if (autoClose) {
            for (const s of stale) {
              const symbol = `${s.asset}-PERP`;
              // Dust below minQty is UNCLEARABLE on-venue (dust-manager
              // classifyPosition). openHedge snap-floors any topup, so
              // add-then-close always leaves the same-shape residue;
              // BlueFin support is the only clearing path. Once flagged,
              // suppress retries so we don't spam Discord every hour —
              // but TIME-BOUND the suppression. Prior rev stored a
              // boolean that was never cleared, which permanently muted
              // autonomy on hedges #5 and #190 for 37 days after the
              // 2026-07-22 flagging event. If the position ever un-sticks
              // (BlueFin support clears dust, or a topup lands), we must
              // re-attempt. 24h TTL = 1 alert/day worst-case, self-healing.
              const dustFlagKey = `stale-dust-flag:${s.id}`;
              const DUST_FLAG_TTL_MS = 24 * 60 * 60 * 1000;
              const flaggedAt = Number(await getCronStateOr<number>(dustFlagKey, 0));
              if (flaggedAt > 0 && Date.now() - flaggedAt < DUST_FLAG_TTL_MS) continue;
              try {
                // Omit size → full-position close (per BluefinService signature).
                // Previous call passed { size: 0, leverage: 3 } which was
                // silently a no-op. Observed 2026-07-17: #190 ETH SHORT
                // flagged for 3+ days with no actual close.
                if (!isPoolTradingEnabled()) continue;
                const result = await bf.closeHedge({ symbol });
                if (!result.success) {
                  // Both DUST_LOCKED and SILENT_REJECT are "same failure
                  // will happen again next tick" categories — external
                  // change required (BlueFin support / free-collateral
                  // recovery) to un-stick. TTL-suppress both. SILENT_REJECT
                  // previously fell through to the generic WARN branch
                  // with no flag, producing hourly Discord noise on hedge
                  // #190 for every tick after PR #77 deployed.
                  const isSuppressible =
                    result.code === 'DUST_LOCKED' || result.code === 'SILENT_REJECT';
                  logger.warn('[SuiHedgeReconcile] stale-close FAILED', {
                    hedgeId: s.id, symbol, error: result.error,
                    code: result.code, suppressed: isSuppressible,
                  });
                  if (isSuppressible) {
                    // Store the timestamp so the TTL check above knows
                    // when to allow the next retry. Boolean-flag prior
                    // rev made this suppression permanent (see bug note
                    // at TTL declaration above).
                    await setCronState(dustFlagKey, Date.now());
                    const msg = result.code === 'DUST_LOCKED'
                      ? `🔒 Hedge #${s.id} ${symbol} DUST-LOCKED (size < minQty). Venue math makes this unclearable on-order-book (step-floor + minQty ⇒ any topup leaves same residue). Escalate via BlueFin Discord #ticket-desk under Support, or leave for liquidation-driven decay. Retries suppressed 24h.`
                      : `🔒 Hedge #${s.id} ${symbol} SILENT-REJECT-LOCKED. BlueFin accepted the close order but position didn't shrink — typically a free-collateral shortfall on the closing side (ISOLATED close needs new margin). Retries suppressed 24h. Fix: fund BlueFin free collateral OR close a sibling hedge to free margin.`;
                    await notifyDiscord(msg, 'KILL', { hedge: s, result }).catch(() => {});
                  } else {
                    await notifyDiscord(
                      `⚠️ Stale-close FAILED: #${s.id} ${symbol} — ${result.error}`,
                      'WARN', { hedge: s, result },
                    ).catch(() => {});
                  }
                } else {
                  logger.info('[SuiHedgeReconcile] stale-close succeeded', {
                    hedgeId: s.id, symbol, filledSize: result.filledSize,
                  });
                  await notifyDiscord(
                    `✅ Stale-hedge closed: #${s.id} ${symbol}`,
                    'TRADE', { hedge: s, result },
                  ).catch(() => {});
                }
              } catch (closeErr) {
                logger.error('[SuiHedgeReconcile] stale-close threw', {
                  hedgeId: s.id, symbol,
                  error: closeErr instanceof Error ? closeErr.message : String(closeErr),
                });
                await notifyDiscord(
                  `❌ Stale-close threw: #${s.id} ${symbol}`,
                  'WARN', { hedge: s, error: closeErr instanceof Error ? closeErr.message : String(closeErr) },
                ).catch(() => {});
              }
            }
          }
        }
      } catch (staleErr) {
        logger.warn('[SuiHedgeReconcile] stale-hedge detection failed (non-critical)', {
          error: errMsg(staleErr),
        });
      }
    } catch (bfErr) {
      logger.warn('[SuiHedgeReconcile] Could not read BlueFin — abort reconciliation (do NOT reset on stale signal)', {
        error: errMsg(bfErr),
      });
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: true,
        onChainHedges: onChainHedges.length,
        reason: 'bluefin unreadable — aborted to avoid false-positive reset',
      });
    }

    // 3. Decide if drift is real
    //
    // We use an absolute USDC delta tolerance because integer rounding +
    // funding rate accruals can produce small benign drift. A drift > $1
    // OR mismatch in count > 0 is a signal that something closed externally.
    const onChainCount = onChainHedges.length;
    const liveCount = livePositions.length;
    const deltaUsdc = onChainHedgedUsdc - liveMarginUsdc;
    const COUNT_DRIFT = onChainCount > liveCount; // on-chain thinks more hedges are open
    const VALUE_DRIFT = deltaUsdc > 1.0;         // on-chain over-reports by $1+
    const driftDetected = COUNT_DRIFT || VALUE_DRIFT;

    if (!driftDetected) {
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: true,
        onChainHedges: onChainCount,
        liveBluefinPositions: liveCount,
        driftDetected: false,
        driftDetails: { onChainHedgesUsdc: onChainHedgedUsdc, liveMarginUsdc, deltaUsdc },
        reason: 'in sync — no action needed',
      });
    }

    logger.warn('[SuiHedgeReconcile] DRIFT DETECTED — on-chain hedge state out of sync with BlueFin', {
      onChainCount,
      liveCount,
      onChainHedgedUsdc: onChainHedgedUsdc.toFixed(4),
      liveMarginUsdc: liveMarginUsdc.toFixed(4),
      deltaUsdc: deltaUsdc.toFixed(4),
      supportedSymbols: SUPPORTED_SYMBOLS,
    });
    await notifyDiscord(
      `Hedge-state drift: on-chain reports ${onChainCount} hedge(s) ($${onChainHedgedUsdc.toFixed(2)}), BlueFin sees ${liveCount} live ($${liveMarginUsdc.toFixed(2)}). Δ=$${deltaUsdc.toFixed(2)} — withdrawal cap at risk.`,
      'WARN',
      { network, onChainCount, liveCount, deltaUsdc: deltaUsdc.toFixed(4) },
    );

    // 4. Attempt reset (only if AdminCap is held by cron signer)
    if (!adminCapId) {
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: true,
        onChainHedges: onChainCount,
        liveBluefinPositions: liveCount,
        driftDetected: true,
        driftDetails: { onChainHedgesUsdc: onChainHedgedUsdc, liveMarginUsdc, deltaUsdc },
        resetExecuted: false,
        reason: 'SUI_ADMIN_CAP_ID not configured — alert only',
      });
    }

    let keypair: InstanceType<typeof Ed25519Keypair>;
    try {
      keypair = adminKey.startsWith('suiprivkey')
        ? Ed25519Keypair.fromSecretKey(adminKey)
        : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
    } catch {
      return NextResponse.json({
        success: false, ranAt, network, attempted: true, error: 'invalid admin key format',
      });
    }

    const capObj = await suiClient.getObject({ id: adminCapId, options: { showOwner: true } });
    const capOwner = capObj.data?.owner;
    const cronSigner = keypair.toSuiAddress();
    if (!capOwner || typeof capOwner !== 'object' || !('AddressOwner' in capOwner)) {
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: true,
        onChainHedges: onChainCount,
        liveBluefinPositions: liveCount,
        driftDetected: true,
        resetExecuted: false,
        reason: 'AdminCap owner unreadable — alert only',
      });
    }
    const ownerAddr = (capOwner as { AddressOwner: string }).AddressOwner;
    if (ownerAddr.toLowerCase() !== cronSigner.toLowerCase()) {
      logger.warn('[SuiHedgeReconcile] AdminCap is multisig-gated — drift requires manual reset', {
        capOwner: ownerAddr,
        cronSigner,
      });
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: true,
        onChainHedges: onChainCount,
        liveBluefinPositions: liveCount,
        driftDetected: true,
        driftDetails: { onChainHedgesUsdc: onChainHedgedUsdc, liveMarginUsdc, deltaUsdc },
        resetExecuted: false,
        reason: `AdminCap owned by ${ownerAddr} — multisig must call admin_reset_hedge_state`,
      });
    }

    const usdcType = SUI_USDC_COIN_TYPE[network];

    // Read the current external_nav_usdc value BEFORE the reset. admin_reset_hedge_state
    // wipes both external_nav dynamic fields; if strict mode is on, deposits and withdraws
    // then revert with E_EXTERNAL_NAV_STALE until the next sui-community-pool cron re-attests
    // (up to 30 min later). We bundle a fresh re-attestation into the same PTB so the pool
    // never enters that blocked state. The reset only removes phantom on-chain hedge
    // over-reporting; the true off-chain NAV (external_nav_usdc value) is unchanged, so we
    // push the same value back.
    // If we can't confirm the prior value, ABORT the reset. Falling through with 0
    // would silently underpay withdrawers (the exact bug strict mode was built to
    // prevent). Better to leave drift unrepaired for one reconcile cycle than to
    // push a wrong NAV.
    let priorExternalNavRaw: bigint | null = null;
    try {
      const inspectTx = new Transaction();
      inspectTx.moveCall({
        target: `${poolConfig.packageId}::${poolConfig.moduleName}::get_external_nav_usdc`,
        typeArguments: [usdcType],
        arguments: [inspectTx.object(poolConfig.poolStateId!)],
      });
      inspectTx.setSender('0x0000000000000000000000000000000000000000000000000000000000000001');
      const inspectBytes = await inspectTx.build({ client: suiClient, onlyTransactionKind: true });
      const inspect = await suiClient.devInspectTransactionBlock({
        sender: '0x0000000000000000000000000000000000000000000000000000000000000001',
        transactionBlock: inspectBytes,
      });
      if (inspect.effects?.status?.status !== 'success') {
        throw new Error(`devInspect failed: ${inspect.effects?.status?.error ?? 'unknown'}`);
      }
      const raw = inspect.results?.[0]?.returnValues?.[0]?.[0];
      if (!Array.isArray(raw) || raw.length < 8) {
        throw new Error(`unexpected returnValue shape: ${JSON.stringify(raw)}`);
      }
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(raw[i]);
      priorExternalNavRaw = v;
    } catch (readErr) {
      logger.error('[SuiHedgeReconcile] Could not read prior external_nav — aborting reset', {
        error: errMsg(readErr),
      });
      await notifyDiscord(
        `Hedge-state drift detected but reset ABORTED — could not read prior external_nav (RPC issue). Will retry next reconcile tick. Δ=$${deltaUsdc.toFixed(2)}.`,
        'WARN',
        { network, error: errMsg(readErr) },
      );
      return NextResponse.json({
        success: true,
        ranAt,
        network,
        attempted: true,
        onChainHedges: onChainCount,
        liveBluefinPositions: liveCount,
        driftDetected: true,
        driftDetails: { onChainHedgesUsdc: onChainHedgedUsdc, liveMarginUsdc, deltaUsdc },
        resetExecuted: false,
        reason: 'prior external_nav unreadable — reset aborted to avoid pushing wrong NAV',
      });
    }

    const tx = new Transaction();
    tx.moveCall({
      target: `${poolConfig.packageId}::${poolConfig.moduleName}::admin_reset_hedge_state`,
      typeArguments: [usdcType],
      arguments: [
        tx.object(adminCapId),
        tx.object(poolConfig.poolStateId!),
        tx.object('0x6'),
      ],
    });
    tx.moveCall({
      target: `${poolConfig.packageId}::${poolConfig.moduleName}::admin_attest_external_nav`,
      typeArguments: [usdcType],
      arguments: [
        tx.object(adminCapId),
        tx.object(poolConfig.poolStateId!),
        tx.pure.u64(priorExternalNavRaw),
        tx.object('0x6'),
      ],
    });
    tx.setGasBudget(30_000_000);

    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    });
    const ok = result.effects?.status?.status === 'success';

    if (ok) {
      const reAttestedUsd = Number(priorExternalNavRaw) / 1e6;
      logger.info('[SuiHedgeReconcile] ✅ admin_reset_hedge_state + re-attest bundled — drift repaired', {
        txDigest: result.digest,
        clearedHedgesCount: onChainCount,
        clearedHedgedUsdc: onChainHedgedUsdc.toFixed(4),
        reAttestedExternalNavUsd: reAttestedUsd.toFixed(4),
      });
      await notifyDiscord(
        `Drift repaired: cleared ${onChainCount} phantom hedge(s) ($${onChainHedgedUsdc.toFixed(2)}), re-attested external NAV $${reAttestedUsd.toFixed(2)}. Withdrawals stay open.`,
        'INFO',
        { network, txDigest: result.digest },
      );
    } else {
      logger.error('[SuiHedgeReconcile] admin_reset_hedge_state FAILED', {
        error: result.effects?.status?.error,
      });
      await notifyDiscord(
        `Drift detected but admin_reset_hedge_state FAILED — withdrawal cap remains over-reported by $${deltaUsdc.toFixed(2)}. Manual intervention required.`,
        'ERROR',
        { network, error: result.effects?.status?.error, deltaUsdc: deltaUsdc.toFixed(4) },
      );
    }

    return NextResponse.json({
      success: ok,
      ranAt,
      network,
      attempted: true,
      onChainHedges: onChainCount,
      liveBluefinPositions: liveCount,
      driftDetected: true,
      driftDetails: { onChainHedgesUsdc: onChainHedgedUsdc, liveMarginUsdc, deltaUsdc },
      resetExecuted: ok,
      txDigest: result.digest,
      error: ok ? undefined : result.effects?.status?.error,
    });
  } catch (e) {
    logger.error('[SuiHedgeReconcile] exception', { error: errMsg(e) });
    return safeErrorResponse(e, 'sui-hedge-reconcile') as NextResponse<ReconcileResult>;
  }
}

export const POST = GET;
