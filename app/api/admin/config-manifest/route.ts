/**
 * Admin: Agent Config Manifest.
 *
 * One endpoint that exposes every tunable knob the platform is running
 * with, so agents (and operators) can inspect their operating rules
 * without grepping code. Turns "what env is the platform on RIGHT NOW"
 * into a single curl.
 *
 * Categories:
 *   gates      — v0.3.0 defense env-flags (envFlag-based)
 *   trader     — polymarket-edge-trader tunables
 *   profitLock — profit-lock guard thresholds
 *   rpc        — SUI RPC circuit breaker + cache TTLs
 *   watchdog   — deploy-watchdog + state-integrity windows
 *   pairs      — BLUEFIN_PAIRS constants (venue min/step per market)
 *
 * All values shown are what the current build IS using — reading env
 * live so drift between docs and reality is impossible. No side effects.
 *
 * Auth: CRON_SECRET.
 */
import { NextRequest, NextResponse } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { envFlag, envFlagOnByDefault } from '@/lib/utils/env-flag';
import {
  SUI_STATS_TTL_MS, SUI_MEMBER_TTL_MS, SUI_MEMBERS_TTL_MS,
  suiRpcCircuitBreaker,
} from '@/lib/services/sui/sui-rpc-utils';
import { suiGrpcUrl } from '@/lib/services/sui/sui-grpc-bridge';
import { DRIFT_GRACE_MS, KILL_ESCALATE_MS } from '@/lib/services/deploy-watchdog/decide';
import { BLUEFIN_PAIRS } from '@/lib/services/sui/BluefinService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

function envNum(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null) return def;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : def;
}

export async function GET(req: NextRequest) {
  const auth = await verifyCronRequest(req, 'ConfigManifest');
  if (auth !== true) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    ts: new Date().toISOString(),
    build: {
      commit: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 8) || 'local',
      branch: process.env.VERCEL_GIT_COMMIT_REF || 'unknown',
    },

    // v0.3.0 defense gates (envFlag-parsed)
    gates: {
      portfolioDriverExecute: envFlagOnByDefault('PORTFOLIO_DRIVER_EXECUTE'),
      staleHedgeAutoClose: envFlagOnByDefault('STALE_HEDGE_AUTO_CLOSE'),
      alertResponseExecute: envFlagOnByDefault('ALERT_RESPONSE_EXECUTE'),
      alertResponseExecuteHalt: envFlag('ALERT_RESPONSE_EXECUTE_HALT'),
      regretTrackerDisable: envFlag('REGRET_TRACKER_DISABLE'),
      suiAutoHedgeDisable: envFlag('SUI_AUTO_HEDGE_DISABLE'),
      profitLockDisable: envFlag('PROFIT_LOCK_DISABLE'),
    },

    // polymarket-edge-trader — every tunable at once
    trader: {
      minConfidence: envNum('POLYMARKET_EDGE_MIN_CONFIDENCE', 55),
      minConsensus: envNum('POLYMARKET_EDGE_MIN_CONSENSUS', 50),
      minFreeCollateralUsd: envNum('POLYMARKET_EDGE_MIN_COLLATERAL', 15),
      baseStakeUsd: envNum('POLYMARKET_EDGE_BASE_STAKE_USD', 5),
      maxStakeUsd: envNum('POLYMARKET_EDGE_MAX_STAKE_USD', 500),
      stakePctOfFree: envNum('POLYMARKET_EDGE_STAKE_PCT', 0.30),
      dynamicBasePct: envNum('POLYMARKET_EDGE_DYNAMIC_BASE_PCT', 0.20),
      leverage: envNum('POLYMARKET_EDGE_LEVERAGE', 3),
      maxConsecutiveLosses: envNum('POLYMARKET_EDGE_MAX_CONSECUTIVE_LOSSES', 5),
      maxDrawdownPct: envNum('POLYMARKET_EDGE_MAX_DRAWDOWN_PCT', 0.30),
      maxSlippageBps: envNum('POLYMARKET_EDGE_MAX_SLIPPAGE_BPS', 30),
      dailyLossCapUsd: envNum('POLYMARKET_EDGE_DAILY_LOSS_CAP_USD', -10),
      signalFlipScoreCollapse: envNum('POLYMARKET_EDGE_SIGNAL_FLIP_SCORE_COLLAPSE', 0.7),
      regretConvictionGateDisable: envFlag('REGRET_CONVICTION_GATE_DISABLE'),
    },

    // profit-lock guard tiers
    profitLock: {
      drawdownStartPct: envNum('PROFIT_LOCK_DRAWDOWN_START', 5),
      zeroRiskAtPct: envNum('PROFIT_LOCK_ZERO_RISK_AT', 20),
      recoveryReengageMinPct: envNum('RECOVERY_REENGAGE_MIN_IMPROVEMENT_PCT', 5),
      recoveryReengageMaxPct: envNum('RECOVERY_REENGAGE_MAX_IMPROVEMENT_PCT', 15),
      recoveryReengageMaxBonusPct: envNum('RECOVERY_REENGAGE_MAX_BONUS_PCT', 30),
      recoveryReengageDisable: envFlag('RECOVERY_REENGAGE_DISABLE'),
    },

    // stale hedge policy
    staleHedge: {
      ageDays: envNum('STALE_HEDGE_AGE_DAYS', 7),
      minFlips: envNum('STALE_HEDGE_MIN_FLIPS', 2),
      autoClose: envFlagOnByDefault('STALE_HEDGE_AUTO_CLOSE'),
    },

    // SUI RPC infrastructure
    rpc: {
      grpcUrl: suiGrpcUrl('mainnet'),
      circuitBreaker: {
        threshold: suiRpcCircuitBreaker.threshold,
        resetTimeoutMs: suiRpcCircuitBreaker.resetTimeout,
        currentState: suiRpcCircuitBreaker.state,
        currentFailures: suiRpcCircuitBreaker.failures,
      },
      cacheTtl: {
        stats: SUI_STATS_TTL_MS,
        member: SUI_MEMBER_TTL_MS,
        members: SUI_MEMBERS_TTL_MS,
      },
    },

    // deploy-watchdog escalation windows
    watchdog: {
      driftGraceMs: DRIFT_GRACE_MS,
      killEscalateMs: KILL_ESCALATE_MS,
    },

    // BlueFin venue contract specs (per-symbol constants)
    pairs: Object.fromEntries(
      Object.entries(BLUEFIN_PAIRS).map(([k, v]) => [k, {
        symbol: v.symbol,
        minQuantity: v.minQuantity,
        stepSize: v.stepSize,
        maxLeverage: v.maxLeverage,
      }]),
    ),

    // Cross-cutting network
    network: (process.env.SUI_NETWORK || 'mainnet').trim(),

    _meta: {
      docstring: 'Live values the current build IS using. Change env vars in Vercel and re-deploy to update.',
      relatedEndpoints: [
        '/api/health/production — subset (gates + build)',
        '/api/admin/state-snapshot — runtime cron_state',
      ],
    },
  });
}
