/**
 * Cron Job: Liquidation Risk Monitor
 * 
 * Monitors all leveraged positions for liquidation risk and executes:
 * - Add collateral when margin level drops below threshold
 * - Reduce position size to improve health
 * - Emergency close before liquidation
 * - Alert generation for critical positions
 * 
 * Schedule: Every 10 minutes via Upstash QStash
 * 
 * Security: Verified by QStash signature or CRON_SECRET
 */

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';
import { verifyCronRequest } from '@/lib/qstash';
import { safeErrorResponse } from '@/lib/security/safe-error';
import { errMsg } from '@/lib/utils/error-handler';
import { getActiveHedges, isPaperHedge } from '@/lib/db/hedges';
import type { Hedge } from '@/lib/db/hedges';
import { notifyDiscord } from '@/lib/utils/discord-notify';
import { setCronState } from '@/lib/db/cron-state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Types
interface LeveragedPosition {
  id: string;
  asset: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  collateral: number;
  notionalValue: number;
  marginLevel: number; // 100% = safe, 0% = liquidated
  liquidationPrice: number;
  healthScore: number; // 0-100
  walletAddress: string;
  portfolioId?: number;
}

interface LiquidationAction {
  positionId: string;
  action: 'ADD_COLLATERAL' | 'REDUCE_SIZE' | 'EMERGENCY_CLOSE' | 'ALERT';
  amount?: number;
  reason: string;
  executed: boolean;
  txHash?: string;
}

interface LiquidationGuardResult {
  success: boolean;
  positionsChecked: number;
  actionsExecuted: LiquidationAction[];
  summary: {
    criticalCount: number;
    warningCount: number;
    healthyCount: number;
    totalCollateralAtRisk: number;
    averageMarginLevel: number;
  };
  duration: number;
  error?: string;
}

// Thresholds
const MARGIN_LEVEL_CRITICAL = 120; // Below 120% = emergency action
const MARGIN_LEVEL_WARNING = 150; // Below 150% = add collateral
const _MARGIN_LEVEL_HEALTHY = 200; // Above 200% = healthy
const LIQUIDATION_BUFFER_PERCENT = 5; // Close if within 5% of liquidation
const COLLATERAL_TOP_UP_PERCENT = 20; // Add 20% more collateral when needed
const SIZE_REDUCTION_PERCENT = 25; // Reduce size by 25% if collateral unavailable

/**
 * Fetch all leveraged positions from the hedge database
 */
async function fetchLeveragedPositions(): Promise<LeveragedPosition[]> {
  try {
    const hedges = await getActiveHedges();

    // Convert Hedge DB records to LeveragedPosition format
    // Only include real leveraged positions (leverage > 1). Skip paper
    // trades — they don't have BlueFin liquidation-price mechanics and
    // just spam warnings like "No live price for XRP" (2026-09-17).
    return hedges
      .filter((h: Hedge) =>
        h.leverage > 1 &&
        h.entry_price != null && h.entry_price > 0 &&
        !isPaperHedge(h)
      )
      .map((h: Hedge) => {
        const collateral = h.notional_value / h.leverage;
        return {
          id: h.order_id,
          asset: h.asset,
          side: h.side,
          entryPrice: h.entry_price!,
          currentPrice: h.current_price || h.entry_price!,
          size: h.size,
          leverage: h.leverage,
          collateral,
          notionalValue: h.notional_value,
          marginLevel: 200, // Will be recalculated with live prices
          liquidationPrice: h.liquidation_price || 0,
          healthScore: 100, // Will be recalculated
          walletAddress: h.wallet_address || '',
          portfolioId: h.portfolio_id || undefined,
        };
      });
  } catch (error: unknown) {
    logger.error('[LiquidationGuard] Error fetching positions from hedge DB', { error: errMsg(error) });
    return [];
  }
}

/**
 * Get current prices
 */
async function getCurrentPrices(assets: string[]): Promise<Record<string, number>> {
  try {
    const baseUrl = process.env.VERCEL 
      ? 'https://zkward.com' 
      : process.env.NEXTAUTH_URL || 'http://localhost:3000';
    
    const response = await fetch(`${baseUrl}/api/prices?assets=${assets.join(',')}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    
    if (!response.ok) {
      return getDefaultPrices();
    }
    
    const data = await response.json();
    return data.prices || getDefaultPrices();
  } catch {
    return getDefaultPrices();
  }
}

function getDefaultPrices(): Record<string, number> {
  // Return empty map — no hardcoded prices. Callers must handle missing prices.
  logger.warn('[LiquidationGuard] No live prices available — returning empty price map');
  return {};
}

/**
 * Calculate margin level for a position
 * Margin Level = (Equity / Used Margin) * 100
 * Equity = Collateral + Unrealized P&L
 */
function calculateMarginLevel(position: LeveragedPosition, currentPrice: number): { marginLevel: number; liquidationPrice: number; healthScore: number } {
  const priceChange = currentPrice - position.entryPrice;
  const direction = position.side === 'LONG' ? 1 : -1;
  const unrealizedPnl = direction * (priceChange / position.entryPrice) * position.notionalValue;
  
  const equity = position.collateral + unrealizedPnl;
  const usedMargin = position.notionalValue / position.leverage;
  const marginLevel = (equity / usedMargin) * 100;
  
  // Calculate liquidation price
  // For LONG: liquidation when equity = 0, so price drops enough to wipe collateral
  // For SHORT: liquidation when price rises enough to wipe collateral
  const maxLossPercent = (position.collateral / position.notionalValue) * 100;
  const liquidationPrice = position.side === 'LONG'
    ? position.entryPrice * (1 - maxLossPercent / 100)
    : position.entryPrice * (1 + maxLossPercent / 100);
  
  // Health score 0-100
  const healthScore = Math.min(100, Math.max(0, (marginLevel - 100) / 2));
  
  return { marginLevel, liquidationPrice, healthScore };
}

/**
 * Check how close position is to liquidation
 */
function getDistanceToLiquidation(position: LeveragedPosition, currentPrice: number): number {
  const { liquidationPrice } = calculateMarginLevel(position, currentPrice);
  
  if (position.side === 'LONG') {
    return ((currentPrice - liquidationPrice) / currentPrice) * 100;
  } else {
    return ((liquidationPrice - currentPrice) / currentPrice) * 100;
  }
}

/**
 * Execute add collateral — falls back to position reduction if unavailable
 */
async function addCollateral(position: LeveragedPosition, amount: number): Promise<{ success: boolean; txHash?: string }> {
  // Collateral top-up is not supported by the current hedge execution pipeline.
  // Log the need and return false so the caller falls through to reducePosition().
  logger.warn(`[LiquidationGuard] Collateral top-up not available for ${position.id} ($${amount.toFixed(2)}) — will attempt position reduction`);
  return { success: false };
}

/**
 * Execute reduce size
 */
async function reducePosition(position: LeveragedPosition, reductionPercent: number): Promise<{ success: boolean; txHash?: string }> {
  try {
    const baseUrl = process.env.VERCEL 
      ? 'https://zkward.com' 
      : process.env.NEXTAUTH_URL || 'http://localhost:3000';
    
    // Calculate reduction value
    const notionalReduction = position.notionalValue * (reductionPercent / 100);
    
    // For reducing a position, we close part of it by taking the opposite side
    const response = await fetch(`${baseUrl}/api/agents/hedging/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INTERNAL_API_SECRET || process.env.CRON_SECRET}`,
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        portfolioId: position.portfolioId || 1,
        asset: position.asset,
        side: position.side === 'LONG' ? 'SHORT' : 'LONG', // Opposite to reduce
        notionalValue: notionalReduction,
        leverage: position.leverage,
        reason: `Reduce position size by ${reductionPercent}% to improve margin`,
        walletAddress: position.walletAddress,
        autoApprovalEnabled: true,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[LiquidationGuard] Failed to reduce position ${position.id}:`, { error: errorText });
      return { success: false };
    }
    
    const result = await response.json();
    return { success: result.success, txHash: result.txHash };
  } catch (error) {
    logger.error(`[LiquidationGuard] Error reducing position:`, { error: errMsg(error) });
    return { success: false };
  }
}

/**
 * Execute emergency close
 */
async function emergencyClose(position: LeveragedPosition, reason: string): Promise<{ success: boolean; txHash?: string }> {
  try {
    const baseUrl = process.env.VERCEL 
      ? 'https://zkward.com' 
      : process.env.NEXTAUTH_URL || 'http://localhost:3000';
    
    // Close entire position by taking opposite side
    const response = await fetch(`${baseUrl}/api/agents/hedging/execute`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INTERNAL_API_SECRET || process.env.CRON_SECRET}`,
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        portfolioId: position.portfolioId || 1,
        asset: position.asset,
        side: position.side === 'LONG' ? 'SHORT' : 'LONG', // Opposite to close
        notionalValue: position.notionalValue, // Close full value
        leverage: position.leverage,
        reason: `EMERGENCY CLOSE: ${reason}`,
        walletAddress: position.walletAddress,
        autoApprovalEnabled: true,
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[LiquidationGuard] Emergency close failed for ${position.id}:`, { error: errorText });
      return { success: false };
    }
    
    const result = await response.json();
    return { success: result.success, txHash: result.txHash };
  } catch (error) {
    logger.error(`[LiquidationGuard] Error in emergency close:`, { error: errMsg(error) });
    return { success: false };
  }
}

// NOTE: getMockPositions removed — production code must never use mock data.
// For testing, use the E2E test scripts in scripts/test-* instead.

/**
 * Main guard function
 */
async function guardPositions(): Promise<{ positions: LeveragedPosition[]; actions: LiquidationAction[]; summary: LiquidationGuardResult['summary'] }> {
  const positions = await fetchLeveragedPositions();
  const assets = [...new Set(positions.map(p => p.asset))];
  const prices = await getCurrentPrices(assets);
  
  const actions: LiquidationAction[] = [];
  let criticalCount = 0;
  let warningCount = 0;
  let healthyCount = 0;
  let totalCollateralAtRisk = 0;
  let totalMarginLevel = 0;
  
  for (const position of positions) {
    const currentPrice = prices[position.asset];
    if (!currentPrice || currentPrice <= 0) {
      logger.warn(`[LiquidationGuard] No live price for ${position.asset} — skipping position ${position.id}`);
      continue;
    }
    const { marginLevel, liquidationPrice, healthScore } = calculateMarginLevel(position, currentPrice);
    const distanceToLiq = getDistanceToLiquidation(position, currentPrice);
    
    // Update position with current calculations
    position.marginLevel = marginLevel;
    position.liquidationPrice = liquidationPrice;
    position.healthScore = healthScore;
    position.currentPrice = currentPrice;
    
    totalMarginLevel += marginLevel;
    
    logger.info(`[LiquidationGuard] Checking ${position.id}: ${position.side} ${position.asset} ${position.leverage}x`, {
      marginLevel: `${marginLevel.toFixed(1)}%`,
      healthScore,
      distanceToLiq: `${distanceToLiq.toFixed(2)}%`,
      liquidationPrice: liquidationPrice.toFixed(2),
    });
    
    // Check if within liquidation buffer
    if (distanceToLiq < LIQUIDATION_BUFFER_PERCENT) {
      logger.error(`[LiquidationGuard] EMERGENCY: ${position.id} within ${distanceToLiq.toFixed(2)}% of liquidation!`);
      await notifyDiscord(
        `EMERGENCY CLOSE: ${position.id} (${position.side} ${position.asset} ${position.leverage}x) is ${distanceToLiq.toFixed(2)}% from liquidation @ $${liquidationPrice.toFixed(2)}. Collateral at risk: $${position.collateral.toFixed(2)}.`,
        'KILL',
        { positionId: position.id, asset: position.asset, distanceToLiq: distanceToLiq.toFixed(2), liquidationPrice: liquidationPrice.toFixed(2) },
      );

      const result = await emergencyClose(position, `Emergency close: ${distanceToLiq.toFixed(2)}% from liquidation`);
      actions.push({
        positionId: position.id,
        action: 'EMERGENCY_CLOSE',
        reason: `Only ${distanceToLiq.toFixed(2)}% from liquidation price (${liquidationPrice.toFixed(2)})`,
        executed: result.success,
        txHash: result.txHash,
      });

      criticalCount++;
      totalCollateralAtRisk += position.collateral;
      continue;
    }

    // Check critical margin level
    if (marginLevel < MARGIN_LEVEL_CRITICAL) {
      logger.warn(`[LiquidationGuard] CRITICAL: ${position.id} margin level ${marginLevel.toFixed(1)}%`);
      await notifyDiscord(
        `Margin CRITICAL: ${position.id} (${position.asset} ${position.leverage}x) at ${marginLevel.toFixed(1)}% (threshold ${MARGIN_LEVEL_CRITICAL}%). Attempting collateral top-up or size reduction.`,
        'ERROR',
        { positionId: position.id, asset: position.asset, marginLevel: marginLevel.toFixed(1) },
      );
      
      // Try to add collateral first
      const topUpAmount = position.collateral * (COLLATERAL_TOP_UP_PERCENT / 100);
      const addResult = await addCollateral(position, topUpAmount);
      
      if (addResult.success) {
        actions.push({
          positionId: position.id,
          action: 'ADD_COLLATERAL',
          amount: topUpAmount,
          reason: `Margin level critical at ${marginLevel.toFixed(1)}%`,
          executed: true,
          txHash: addResult.txHash,
        });
      } else {
        // Fallback: reduce position size
        const reduceResult = await reducePosition(position, SIZE_REDUCTION_PERCENT);
        actions.push({
          positionId: position.id,
          action: 'REDUCE_SIZE',
          amount: position.size * (SIZE_REDUCTION_PERCENT / 100),
          reason: `Margin level critical at ${marginLevel.toFixed(1)}%, collateral unavailable`,
          executed: reduceResult.success,
          txHash: reduceResult.txHash,
        });
      }
      
      criticalCount++;
      totalCollateralAtRisk += position.collateral;
      continue;
    }
    
    // Check warning margin level
    if (marginLevel < MARGIN_LEVEL_WARNING) {
      logger.warn(`[LiquidationGuard] WARNING: ${position.id} margin level ${marginLevel.toFixed(1)}%`);
      await notifyDiscord(
        `Margin warning: ${position.id} (${position.asset} ${position.leverage}x) at ${marginLevel.toFixed(1)}% (threshold ${MARGIN_LEVEL_WARNING}%). Attempting collateral top-up.`,
        'WARN',
        { positionId: position.id, asset: position.asset, marginLevel: marginLevel.toFixed(1) },
      );
      
      const topUpAmount = position.collateral * (COLLATERAL_TOP_UP_PERCENT / 100);
      const addResult = await addCollateral(position, topUpAmount);
      
      actions.push({
        positionId: position.id,
        action: addResult.success ? 'ADD_COLLATERAL' : 'ALERT',
        amount: topUpAmount,
        reason: `Margin level warning at ${marginLevel.toFixed(1)}%`,
        executed: addResult.success,
        txHash: addResult.txHash,
      });
      
      warningCount++;
      continue;
    }
    
    // Healthy position
    healthyCount++;
  }
  
  return {
    positions,
    actions,
    summary: {
      criticalCount,
      warningCount,
      healthyCount,
      totalCollateralAtRisk,
      averageMarginLevel: positions.length > 0 ? totalMarginLevel / positions.length : 0,
    },
  };
}

/**
 * GET handler for Vercel Cron
 */
export async function GET(request: NextRequest): Promise<NextResponse<LiquidationGuardResult>> {
  const startTime = Date.now();
  void setCronState('cron:lastRun:liquidation-guard', Date.now()).catch(() => {});

  // Security: Verify QStash signature or CRON_SECRET
  const authResult = await verifyCronRequest(request, 'LiquidationGuard');
  if (authResult !== true) {
    return NextResponse.json(
      { success: false, positionsChecked: 0, actionsExecuted: [], summary: { criticalCount: 0, warningCount: 0, healthyCount: 0, totalCollateralAtRisk: 0, averageMarginLevel: 0 }, duration: Date.now() - startTime, error: 'Unauthorized' },
      { status: 401 }
    );
  }
  
  logger.info('[LiquidationGuard] Starting liquidation risk monitoring');
  
  try {
    const result = await guardPositions();
    
    logger.info(`[LiquidationGuard] Complete: ${result.positions.length} positions checked`, {
      summary: result.summary,
      actionsCount: result.actions.length,
    });
    
    return NextResponse.json({
      success: true,
      positionsChecked: result.positions.length,
      actionsExecuted: result.actions,
      summary: result.summary,
      duration: Date.now() - startTime,
    });
    
  } catch (error: unknown) {
    logger.error('[LiquidationGuard] Error:', error);
    return safeErrorResponse(error, 'Liquidation guard') as NextResponse<LiquidationGuardResult>;
  }
}

// QStash sends POST by default — support both methods
export const POST = GET;
