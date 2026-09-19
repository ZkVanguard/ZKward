/**
 * Agent guard gate — SafeExecutionGuard + HedgingAgent invariants.
 *
 * Extracted from polymarket-edge-trader/route.ts on 2026-09-19 as
 * part of the P1-F declutter. Pure wrapper — caller handles logging,
 * recordSkip, NextResponse on rejection.
 *
 * This is the SAME gate the sui-community-pool cron uses, so both
 * traders share the same limits, cooldowns, and circuit breakers.
 * Previously the polymarket-edge-trader had its own inline risk gate
 * ("mirrors RiskAgent's invariants without needing the actual agent");
 * this unifies both under one authoritative path.
 */
import { checkBeforeTrade } from '@/lib/services/agents/agent-trade-guard';
import type { GuardDecision } from '@/lib/services/agents/agent-trade-guard';

export interface AgentGateInput {
  asset: string;
  side: 'LONG' | 'SHORT';
  notionalUsd: number;
}

export interface AgentGateResult {
  /** The guard decision — always returned so callers can pass it to
   *  completeTrade() at close time. */
  guard: GuardDecision;
  /** Non-null when the guard rejected the trade. Caller wires
   *  logger.warn + recordSkip + short-circuit response. */
  skipReason: string | null;
}

export async function runAgentGate(input: AgentGateInput): Promise<AgentGateResult> {
  const guard = await checkBeforeTrade({
    chain: 'sui',
    asset: input.asset,
    intendedSide: input.side,
    notionalUsd: input.notionalUsd,
    agentSource: 'polymarket-edge-trader',
  });

  if (!guard.approved) {
    return {
      guard,
      skipReason: `agent-guard blocked ${input.asset} ${input.side} ($${input.notionalUsd.toFixed(2)}) at stage=${guard.stage}: ${guard.reason}`,
    };
  }
  return { guard, skipReason: null };
}
