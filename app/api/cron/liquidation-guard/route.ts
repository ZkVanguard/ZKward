/**
 * Cron Job: Liquidation Guard
 *
 * Reads the pool's positions from the venue and closes one that is about to
 * be liquidated, because a liquidation costs the margin and a penalty and a
 * close a few percent earlier does not.
 *
 * It judges by the venue's own liquidation price (see liquidation-risk.ts).
 * Until 2026-10-12 it estimated one from database rows and sent its closes to
 * a route that did not exist, so it alerted every run and never acted.
 *
 * It acts while pool trading is paused: the pause stops the system opening or
 * resizing risk, not a last-resort close (the same exemption the venue-health
 * flatten has; see pool-trading-pause.ts).
 *
 * Schedule: every 10 minutes, from the master job's fanout.
 * Security: jobs-service signature or CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { errMsg } from '@/lib/utils/error-handler';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { setCronState, tryClaimCronRun } from '@/lib/db/cron-state';
import { BluefinService } from '@/lib/services/sui/BluefinService';
import {
  liquidationDistancePct, liquidationLevel, LIQUIDATION_EMERGENCY_PCT, LIQUIDATION_WARNING_PCT,
} from '@/lib/services/sui/liquidation-risk';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** One close attempt per symbol in this window: overlapping runs must not both send it. */
const CLOSE_CLAIM_MS = 5 * 60 * 1000;

interface GuardAction {
  symbol: string;
  side: 'LONG' | 'SHORT';
  action: 'EMERGENCY_CLOSE' | 'ALERT';
  distancePct: number;
  liquidationPrice: number;
  executed: boolean;
  txHash?: string;
  error?: string;
}

interface LiquidationGuardResult {
  success: boolean;
  positionsChecked: number;
  actionsExecuted: GuardAction[];
  summary: { criticalCount: number; warningCount: number; healthyCount: number; unknownCount: number; marginAtRiskUsd: number };
  duration: number;
  error?: string;
}

const EMPTY_SUMMARY = { criticalCount: 0, warningCount: 0, healthyCount: 0, unknownCount: 0, marginAtRiskUsd: 0 };

export async function GET(request: NextRequest): Promise<NextResponse<LiquidationGuardResult>> {
  const startTime = Date.now();

  const authResult = await verifyCronRequest(request, 'LiquidationGuard');
  if (authResult !== true) {
    return NextResponse.json(
      { success: false, positionsChecked: 0, actionsExecuted: [], summary: EMPTY_SUMMARY, duration: Date.now() - startTime, error: 'Unauthorized' },
      { status: 401 },
    );
  }
  // After auth: an unauthenticated hit must not make the job look alive.
  void setCronState('cron:lastRun:liquidation-guard', Date.now()).catch(() => {});

  const network: 'mainnet' | 'testnet' = (process.env.SUI_NETWORK || '').trim() === 'mainnet' ? 'mainnet' : 'testnet';
  const adminKey = (process.env.BLUEFIN_PRIVATE_KEY || process.env.SUI_POOL_ADMIN_KEY || '').trim();
  if (!adminKey) {
    return NextResponse.json({ success: true, positionsChecked: 0, actionsExecuted: [], summary: EMPTY_SUMMARY, duration: Date.now() - startTime, error: 'venue key not configured — nothing to guard' });
  }

  try {
    const bf = BluefinService.getInstance();
    await bf.initialize(adminKey, network);
    // Strict: an unreadable venue is an error, not "no positions at risk".
    const positions = await bf.getPositionsStrict();

    const actions: GuardAction[] = [];
    const summary = { ...EMPTY_SUMMARY };

    for (const p of positions) {
      if (!(p.size > 0)) continue;
      const distancePct = liquidationDistancePct(p);
      const level = liquidationLevel(distancePct);
      if (level === 'unknown') { summary.unknownCount++; continue; }
      if (level === 'healthy') { summary.healthyCount++; continue; }
      const distance = distancePct as number;
      const context = { chain: 'sui', symbol: p.symbol, side: p.side, size: p.size, mark: p.markPrice, liquidationPrice: p.liquidationPrice, distancePct: distance.toFixed(2) };
      summary.marginAtRiskUsd += Number(p.margin) || 0;

      if (level === 'warning') {
        summary.warningCount++;
        await notifyDiscord(
          `${p.symbol} ${p.side} is ${distance.toFixed(1)}% from liquidation at $${p.liquidationPrice} (closes automatically under ${LIQUIDATION_EMERGENCY_PCT}%, warns under ${LIQUIDATION_WARNING_PCT}%).`,
          'WARN', context,
        ).catch(() => {});
        actions.push({ symbol: p.symbol, side: p.side, action: 'ALERT', distancePct: distance, liquidationPrice: p.liquidationPrice, executed: false });
        continue;
      }

      summary.criticalCount++;
      const claim = await tryClaimCronRun(`liquidation-guard:close:${p.symbol}`, CLOSE_CLAIM_MS, Date.now());
      if (!claim.claimed) {
        actions.push({ symbol: p.symbol, side: p.side, action: 'EMERGENCY_CLOSE', distancePct: distance, liquidationPrice: p.liquidationPrice, executed: false, error: 'a close for this symbol was sent in the last five minutes' });
        continue;
      }
      await notifyDiscord(
        `EMERGENCY CLOSE: ${p.symbol} ${p.side} ${p.size} is ${distance.toFixed(2)}% from liquidation at $${p.liquidationPrice}. Closing on the venue.`,
        'KILL', context,
      ).catch(() => {});
      const close = await bf.closeHedge({ symbol: p.symbol }).catch((e) => ({ success: false, error: errMsg(e) }) as { success: false; error: string; txDigest?: undefined });
      if (!close.success) {
        await notifyDiscord(
          `Emergency close of ${p.symbol} ${p.side} FAILED (${String(close.error || 'not confirmed').slice(0, 160)}). It is ${distance.toFixed(2)}% from liquidation: close it by hand on the venue.`,
          'ERROR', context,
        ).catch(() => {});
      }
      actions.push({
        symbol: p.symbol, side: p.side, action: 'EMERGENCY_CLOSE', distancePct: distance, liquidationPrice: p.liquidationPrice,
        executed: close.success === true, txHash: close.txDigest, ...(close.success ? {} : { error: String(close.error || 'not confirmed') }),
      });
    }

    logger.info('[LiquidationGuard] Complete', { positions: positions.length, summary, actions: actions.length });
    return NextResponse.json({ success: true, positionsChecked: positions.length, actionsExecuted: actions, summary, duration: Date.now() - startTime });
  } catch (error: unknown) {
    logger.error('[LiquidationGuard] Error:', error);
    return safeErrorResponse(error, 'Liquidation guard') as NextResponse<LiquidationGuardResult>;
  }
}

// The jobs service sends POST by default — support both methods
export const POST = GET;
