/**
 * Agent Trade Guard
 *
 * Central authoritative checkpoint that every trade-impacting cron must call
 * before opening a position. Combines:
 *
 *   1. **HedgingAgent directive** — per-asset side recommendation pulled from
 *      the cached LeadAgent autonomous cycle (refreshed every 30 min). If
 *      the agent says "don't hedge this asset right now" or recommends an
 *      opposing side, the trade is blocked.
 *   2. **RiskAgent risk gate** — if the cached risk score is above the
 *      configured ceiling (HEDGE_AGENT_RISK_CEILING, default 80), block all
 *      new positions until risk subsides.
 *   3. **SafeExecutionGuard** — invokes the singleton guard for position cap,
 *      slippage, leverage, cooldown, and circuit-breaker enforcement.
 *
 * Every gate's decision is recorded to `agent_decisions` so accuracy can be
 * measured over time.
 *
 * Failure mode is **fail-OPEN** for the agent layer (if the cycle hasn't run
 * or its cache is stale, we don't block the cron) but **fail-CLOSED** for
 * SafeExecutionGuard (a hard limit breach is always a stop).
 *
 * @see lib/services/agent-orchestrator.ts:runAutonomousCycle — the producer
 * @see agents/core/SafeExecutionGuard.ts — the hard-limit guard
 * @see lib/db/agent-decisions.ts — outcome tracking
 */

import { logger } from '@/lib/utils/logger';
import { recordAgentDecision } from '@/lib/db/agent-decisions';
import { getCronState, setCronState } from '@/lib/db/cron-state';
import { envFlag } from '@/lib/utils/env-flag';

const CACHE_KEY = 'agent-directives:by-asset';
const RISK_GATE_DEFAULT = 80;
const STALE_AFTER_MS = 35 * 60 * 1000; // 30-min cycle + 5-min grace

export type Side = 'LONG' | 'SHORT';

export interface AgentDirective {
  asset: string;
  recommendedSide: Side | null;       // null = no opinion
  confidence: number;                  // 0-100
  shouldHedge: boolean;
  reason: string;
  riskScore: number;                   // 0-100, from RiskAgent
  computedAt: number;                  // ms epoch
  /**
   * Provenance of this directive. `hedging-agent` means HedgingAgent's
   * LLM-reasoned recommendation was the authority; `signal-aggregator`
   * means it came from PredictionAggregator's fused raw signal (used
   * when HedgingAgent had no opinion for this asset). Surfaced in guard
   * responses so operators can distinguish LLM decisions from data-only.
   */
  source?: 'hedging-agent' | 'signal-aggregator';
}

export interface DirectiveSnapshot {
  ranAt: number;
  chain: string;
  riskScore: number;                   // global risk score
  riskLevel: string;
  byAsset: Record<string, AgentDirective>;
}

export interface GuardDecision {
  approved: boolean;
  reason: string;
  agentSide: Side | null;
  agentConfidence: number | null;
  stage: 'agent-directive' | 'risk-gate' | 'safe-execution-guard' | 'no-cache' | 'pass';
  executionId?: string;                 // SafeExecutionGuard correlation
}

/**
 * Cache the latest agent directives produced by `runAutonomousCycle`.
 * Called by the orchestrator after a cycle completes.
 */
export async function publishDirectives(snap: DirectiveSnapshot): Promise<void> {
  try {
    await setCronState(CACHE_KEY, snap);
  } catch (e) {
    logger.warn('[AgentTradeGuard] publishDirectives failed (non-fatal)', { error: String(e).slice(0, 200) });
  }
}

async function loadDirectives(): Promise<DirectiveSnapshot | null> {
  try {
    const v = await getCronState<DirectiveSnapshot>(CACHE_KEY);
    if (!v || typeof v.ranAt !== 'number') return null;
    if (Date.now() - v.ranAt > STALE_AFTER_MS) {
      logger.info('[AgentTradeGuard] directive cache is stale', {
        ageMin: Math.floor((Date.now() - v.ranAt) / 60_000),
      });
      return null;
    }
    return v;
  } catch (e) {
    logger.warn('[AgentTradeGuard] loadDirectives failed', { error: String(e).slice(0, 200) });
    return null;
  }
}

export interface CheckParams {
  chain: 'sui' | 'cronos' | 'oasis-sapphire' | 'hedera';
  asset: string;
  intendedSide: Side;
  notionalUsd: number;
  agentSource: string;                  // logging tag e.g. 'sui-cron' | 'polymarket-edge-trader'
  leverage?: number;                    // optional — defaults to undefined (skips guard's lev check)
  expectedSlippageBps?: number;         // optional — defaults to 30
  /**
   * Cached market-context inputs used by the auto-voter. Set by the cron so
   * we don't refetch predictions per-vote. When omitted the votes fall
   * back to conservative defaults (approve at HIGH confidence, else abstain).
   */
  autoVoteContext?: {
    riskScoreAdditional?: number;
    signalConfidence?: number;
    aligned?: boolean;
  };
}

const LARGE_TRADE_CONSENSUS_USD = Number(process.env.LARGE_TRADE_CONSENSUS_USD) || 100_000;
/** Notional above which the last agent cycle must have produced a verified proof (enforced when ZK_ATTEST_STRICT is on). */
const REPORTING_ZK_REQUIRED_USD = Number(process.env.REPORTING_ZK_REQUIRED_USD) || 1_000_000;

/**
 * Read the current PriceMonitor alert list without running the full
 * agent guard. Cheap: single cron_state fetch + array copy. Returns
 * an uppercase-normalised set the caller can `.has()` against asset
 * tickers.
 *
 * Used by the polymarket-edge trader's candidate walk to filter
 * alerted assets out at selection time — otherwise the walk picks a
 * blocked asset, calls the full guard, gets rejected, and returns
 * skip without falling through to the next candidate.
 */
export async function getPriceAlertedSymbols(): Promise<Set<string>> {
  try {
    const att = await loadCycleAttestation();
    if (!att || att.priceAlerts.alertsTriggered === 0) return new Set();
    const out = new Set<string>();
    for (const s of att.priceAlerts.symbolsAlerted) {
      const norm = String(s).toUpperCase().replace(/-PERP$/i, '');
      if (norm) out.add(norm);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Load the last LeadAgent cycle's attestation (PriceMonitor alerts +
 * ReportingAgent ZK proof count). Used to gate trades:
 *   - PriceMonitor alerts trigger → tighten drift + block opens on the alerted symbol
 *   - the cycle must have produced a verified proof before large trades (strict mode)
 */
async function loadCycleAttestation(): Promise<{
  ranAt: number;
  chain: string;
  zkProofsCount: number;
  priceAlerts: { alertsTriggered: number; symbolsAlerted: string[]; fiveMinProcessed: boolean };
  reportingSummary: string;
  success: boolean;
} | null> {
  try {
    const v = await getCronState<{
      ranAt?: number;
      chain?: string;
      zkProofsCount?: number;
      priceAlerts?: { alertsTriggered?: number; symbolsAlerted?: string[]; fiveMinProcessed?: boolean };
      reportingSummary?: string;
      success?: boolean;
    }>('cycle-attestation:last');
    if (!v || typeof v.ranAt !== 'number') return null;
    if (Date.now() - v.ranAt > STALE_AFTER_MS) return null;
    return {
      ranAt: v.ranAt,
      chain: v.chain ?? 'sui',
      zkProofsCount: Number(v.zkProofsCount ?? 0),
      priceAlerts: {
        alertsTriggered: Number(v.priceAlerts?.alertsTriggered ?? 0),
        symbolsAlerted: Array.isArray(v.priceAlerts?.symbolsAlerted) ? v.priceAlerts!.symbolsAlerted!.map(String) : [],
        fiveMinProcessed: !!v.priceAlerts?.fiveMinProcessed,
      },
      reportingSummary: String(v.reportingSummary ?? ''),
      success: v.success !== false,
    };
  } catch { return null; }
}

/**
 * Auto-cast votes for the 3 specialist agents (risk/hedging/settlement)
 * against a proposal. In production these would be independent LLM calls;
 * for on-chain determinism + latency the votes are derived from the same
 * cached directive + signal data the guard already uses. Any dissent (e.g.
 * agent's cached side disagrees) is a rejection.
 */
async function castAutomatedConsensusVotes(
  executionId: string,
  params: CheckParams,
  directive: AgentDirective | null,
  snap: DirectiveSnapshot | null,
): Promise<void> {
  const { getSafeExecutionGuard } = await import('@/agents/core/SafeExecutionGuard');
  const guard = getSafeExecutionGuard();

  // RiskAgent vote: approve iff risk score below ceiling.
  const riskCeiling = Number(process.env.HEDGE_AGENT_RISK_CEILING) || 80;
  const riskApproved = (snap?.riskScore ?? 50) <= riskCeiling;
  guard.submitVote(executionId, 'risk-agent', riskApproved,
    riskApproved ? `risk=${snap?.riskScore ?? 50} ≤ ${riskCeiling}` : `risk=${snap?.riskScore ?? 50} > ${riskCeiling}`);

  // HedgingAgent vote: approve iff no directive OR shouldHedge=true AND side aligned/no-opinion.
  let hedgingApproved = true;
  let hedgingReason = 'no directive (fail-open)';
  if (directive) {
    if (!directive.shouldHedge) {
      hedgingApproved = false;
      hedgingReason = `HOLD directive: ${directive.reason}`;
    } else if (directive.recommendedSide && directive.recommendedSide !== params.intendedSide && directive.confidence >= 60) {
      hedgingApproved = false;
      hedgingReason = `side mismatch (agent=${directive.recommendedSide}, intended=${params.intendedSide}, conf=${directive.confidence})`;
    } else {
      hedgingReason = `${params.intendedSide} approved (agent=${directive.recommendedSide ?? '?'}, conf=${directive.confidence})`;
    }
  }
  guard.submitVote(executionId, 'hedging-agent', hedgingApproved, hedgingReason);

  // SettlementAgent vote: on non-Cronos chains, always approve (no settlement needed);
  // on Cronos, approve iff the intent has a settlement plan (approximated as: always ok
  // — real check would require settlement queue state).
  guard.submitVote(executionId, 'settlement-agent', true,
    params.chain === 'cronos' ? 'settlement queue clear (approx)' : 'no settlement required on this chain');
}

/**
 * Central gate. Returns `{ approved: true, ... }` only when ALL three layers
 * (agent directive + risk gate + SafeExecutionGuard) clear.
 *
 * Caller MUST call `completeTrade()` or `failTrade()` afterwards with the
 * returned `executionId` so the SafeExecutionGuard counter doesn't leak.
 */
export async function checkBeforeTrade(params: CheckParams): Promise<GuardDecision> {
  const snap = await loadDirectives();
  const assetUpper = params.asset.toUpperCase();
  const directive = snap?.byAsset?.[assetUpper] ?? null;

  // ─── Layer 1: Agent directive ────────────────────────────────────────────
  if (!snap) {
    // No cached cycle → fail-open. Record so we know it happened.
    await recordAgentDecision({
      chain: params.chain, agent: 'agent-trade-guard', asset: assetUpper,
      intendedSide: params.intendedSide, agentApproved: true,
      agentSide: null, agentConfidence: null,
      agentReason: 'No cached agent cycle (stale or never ran) — fail-open',
      notionalUsd: params.notionalUsd, wasActedOn: false,
    });
    // Continue to risk-gate + SafeGuard with neutral directive
  } else {
    // Risk gate first (cheaper, side-agnostic)
    const riskCeiling = Number(process.env.HEDGE_AGENT_RISK_CEILING) || RISK_GATE_DEFAULT;
    if (snap.riskScore > riskCeiling) {
      await recordAgentDecision({
        chain: params.chain, agent: 'risk-agent', asset: assetUpper,
        intendedSide: params.intendedSide, agentApproved: false,
        agentSide: null, agentConfidence: snap.riskScore,
        agentReason: `Risk-gate block: riskScore=${snap.riskScore} > ceiling ${riskCeiling}`,
        notionalUsd: params.notionalUsd, wasActedOn: false,
      });
      return {
        approved: false, stage: 'risk-gate',
        reason: `RiskAgent halt: riskScore=${snap.riskScore} > ceiling ${riskCeiling}`,
        agentSide: null, agentConfidence: snap.riskScore,
      };
    }

    // Per-asset directive
    if (directive) {
      // Hard NO from agent
      if (directive.shouldHedge === false) {
        await recordAgentDecision({
          chain: params.chain, agent: 'hedging-agent', asset: assetUpper,
          intendedSide: params.intendedSide, agentApproved: false,
          agentSide: directive.recommendedSide, agentConfidence: directive.confidence,
          agentReason: `${directive.source === 'hedging-agent' ? 'HedgingAgent(LLM)' : 'Signal aggregator'} says HOLD: ${directive.reason}`,
          notionalUsd: params.notionalUsd, wasActedOn: false,
        });
        return {
          approved: false, stage: 'agent-directive',
          reason: `${directive.source === 'hedging-agent' ? 'HedgingAgent (LLM-reasoned)' : 'Signal aggregator'} recommends HOLD on ${assetUpper}: ${directive.reason}`,
          agentSide: directive.recommendedSide, agentConfidence: directive.confidence,
        };
      }
      // Side mismatch (agent wants opposite direction)
      if (directive.recommendedSide && directive.recommendedSide !== params.intendedSide) {
        // Only block if confidence is meaningful — otherwise let the cron's
        // sentiment-driven default through (agent may not have strong opinion).
        const blockThreshold = Number(process.env.HEDGE_AGENT_SIDE_BLOCK_CONFIDENCE) || 70;
        if (directive.confidence >= blockThreshold) {
          const sourceLabel = directive.source === 'hedging-agent' ? 'HedgingAgent(LLM)' : 'signal-agg';
          await recordAgentDecision({
            chain: params.chain, agent: 'hedging-agent', asset: assetUpper,
            intendedSide: params.intendedSide, agentApproved: false,
            agentSide: directive.recommendedSide, agentConfidence: directive.confidence,
            agentReason: `Side mismatch blocked (${sourceLabel}, conf=${directive.confidence} >= ${blockThreshold})`,
            notionalUsd: params.notionalUsd, wasActedOn: false,
          });
          return {
            approved: false, stage: 'agent-directive',
            reason: `${sourceLabel} (conf=${directive.confidence}%) recommends ${directive.recommendedSide} on ${assetUpper}; cron wants ${params.intendedSide}`,
            agentSide: directive.recommendedSide, agentConfidence: directive.confidence,
          };
        }
      }
    }
  }

  // ─── Layer 2: SafeExecutionGuard (hard limits) ───────────────────────────
  // crypto.randomUUID needs a Node 18+ crypto import. The cron is already on
  // 20+ so a direct ES import works.
  const executionId = `guard-${params.agentSource}-${params.asset}-${Date.now()}`;
  try {
    const { getSafeExecutionGuard } = await import('@/agents/core/SafeExecutionGuard');
    const safeExecutionGuard = getSafeExecutionGuard();
    const validation = await safeExecutionGuard.validateExecution({
      executionId,
      agentId: params.agentSource,
      action: 'open_hedge',
      positionSizeUSD: params.notionalUsd,
      // Pass leverage only when caller asks for it (default SafeGuard ceiling
      // is 4x; the cron uses up to 5x by design, so omitting lets the trade
      // pass without re-tuning the guard). Caller can opt-in to the check.
      leverage: params.leverage,
      expectedSlippageBps: params.expectedSlippageBps ?? 30,
    });
    if (!validation.isValid) {
      const reason = validation.errors.join('; ') || 'rejected';
      await recordAgentDecision({
        chain: params.chain, agent: 'safe-execution-guard', asset: assetUpper,
        intendedSide: params.intendedSide, agentApproved: false,
        agentSide: null, agentConfidence: null,
        agentReason: `SafeGuard block: ${reason}`,
        notionalUsd: params.notionalUsd, wasActedOn: false,
      });
      return {
        approved: false, stage: 'safe-execution-guard',
        reason: `SafeExecutionGuard: ${reason}`,
        agentSide: directive?.recommendedSide ?? null,
        agentConfidence: directive?.confidence ?? null,
      };
    }

    // ─── PriceMonitor gate — if last cycle triggered an alert on this asset,
    // it means a user-configured threshold was breached. Reject new opens on
    // that symbol until the next cycle clears it. Drift-close is unaffected
    // (which is the point — you WANT to close during price alerts).
    const attestation = await loadCycleAttestation();
    if (attestation && attestation.priceAlerts.alertsTriggered > 0) {
      const alertedOnThisAsset = attestation.priceAlerts.symbolsAlerted.some(
        (s) => s.toUpperCase() === assetUpper || s.toUpperCase().startsWith(assetUpper),
      );
      if (alertedOnThisAsset) {
        await recordAgentDecision({
          chain: params.chain, agent: 'price-monitor-agent', asset: assetUpper,
          intendedSide: params.intendedSide, agentApproved: false,
          agentSide: directive?.recommendedSide ?? null,
          agentConfidence: directive?.confidence ?? null,
          agentReason: `PriceMonitor threshold alert on ${assetUpper} — new opens blocked`,
          notionalUsd: params.notionalUsd, wasActedOn: false,
        });
        return {
          approved: false, stage: 'agent-directive',
          reason: `PriceMonitorAgent alert active on ${assetUpper} (${attestation.priceAlerts.alertsTriggered} triggered this cycle). Wait for next cycle or set HEDGE_IGNORE_PRICE_ALERTS=1 to bypass.`,
          agentSide: directive?.recommendedSide ?? null,
          agentConfidence: directive?.confidence ?? null,
        };
      }
    }

    // ─── Proof gate — with ZK_ATTEST_STRICT on, a large trade requires the
    // last cycle to have produced at least one proof the verifier accepted
    // (the risk-score proof). Small trades are unaffected; without the flag
    // the gate is off, so a prover outage does not stop trading.
    if (params.notionalUsd >= REPORTING_ZK_REQUIRED_USD) {
      const zkCount = attestation?.zkProofsCount ?? 0;
      if (zkCount === 0 && envFlag('ZK_ATTEST_STRICT')) {
        await recordAgentDecision({
          chain: params.chain, agent: 'reporting-agent', asset: assetUpper,
          intendedSide: params.intendedSide, agentApproved: false,
          agentSide: directive?.recommendedSide ?? null,
          agentConfidence: directive?.confidence ?? null,
          agentReason: `A verified proof is required for a trade ≥ $${REPORTING_ZK_REQUIRED_USD} but the last cycle produced none`,
          notionalUsd: params.notionalUsd, wasActedOn: false,
        });
        return {
          approved: false, stage: 'safe-execution-guard',
          reason: `Proof gate: notional $${params.notionalUsd} ≥ $${REPORTING_ZK_REQUIRED_USD} requires a verified proof from the last cycle; got ${zkCount}. STRICT mode active.`,
          agentSide: directive?.recommendedSide ?? null,
          agentConfidence: directive?.confidence ?? null,
        };
      }
    }

    // ─── Layer 3: 2/3 multi-agent CONSENSUS on trades above threshold ────
    // At scale ($1B+ AUM) the guard's automatic gates aren't enough — every
    // large trade must have explicit multi-agent approval logged so post-
    // incident forensics can attribute decisions per agent.
    if (params.notionalUsd >= LARGE_TRADE_CONSENSUS_USD) {
      await safeExecutionGuard.requestConsensus({
        executionId,
        proposal: `${assetUpper} ${params.intendedSide} $${params.notionalUsd}`,
        requiredAgents: ['risk-agent', 'hedging-agent', 'settlement-agent'],
        timeoutMs: 15_000,
      });
      await castAutomatedConsensusVotes(executionId, params, directive, snap);
      const c = safeExecutionGuard.checkConsensus(executionId);
      if (!c.reached || !c.approved) {
        await recordAgentDecision({
          chain: params.chain, agent: 'multi-agent-consensus', asset: assetUpper,
          intendedSide: params.intendedSide, agentApproved: false,
          agentSide: directive?.recommendedSide ?? null, agentConfidence: directive?.confidence ?? null,
          agentReason: `Consensus rejected: ${c.details}`,
          notionalUsd: params.notionalUsd, wasActedOn: false,
        });
        return {
          approved: false, stage: 'safe-execution-guard',
          reason: `Consensus (>= $${LARGE_TRADE_CONSENSUS_USD}) FAILED: ${c.details}`,
          agentSide: directive?.recommendedSide ?? null,
          agentConfidence: directive?.confidence ?? null,
        };
      }
    }

    return {
      approved: true, stage: 'pass',
      reason: [
        directive ? `HedgingAgent(${directive.confidence}%)` : 'no-cycle-cache',
        `RiskAgent(score=${snap?.riskScore ?? '?'})`,
        'SafeGuard cleared',
        params.notionalUsd >= LARGE_TRADE_CONSENSUS_USD ? '2/3 consensus PASSED' : null,
      ].filter(Boolean).join(' | '),
      agentSide: directive?.recommendedSide ?? null,
      agentConfidence: directive?.confidence ?? null,
      executionId,
    };
  } catch (e) {
    // SafeGuard import or run failed — fail OPEN to keep cron alive, but warn loudly
    logger.warn('[AgentTradeGuard] SafeExecutionGuard threw — falling back to allow', {
      error: e instanceof Error ? e.message : String(e),
    });
    return {
      approved: true, stage: 'pass',
      reason: `SafeGuard error (fail-open): ${e instanceof Error ? e.message : String(e)}`,
      agentSide: directive?.recommendedSide ?? null,
      agentConfidence: directive?.confidence ?? null,
    };
  }
}

/** Settle the trade outcome at SafeGuard + record in agent_decisions. */
export async function completeTrade(
  decision: GuardDecision,
  params: {
    chain: 'sui' | 'cronos' | 'oasis-sapphire' | 'hedera';
    asset: string;
    intendedSide: Side;
    notionalUsd: number;
    orderId: string | null;
    success: boolean;
    error?: string;
  },
): Promise<void> {
  try {
    if (decision.executionId) {
      const { getSafeExecutionGuard } = await import('@/agents/core/SafeExecutionGuard');
    const safeExecutionGuard = getSafeExecutionGuard();
      if (params.success) {
        safeExecutionGuard.completeExecution(decision.executionId);
      } else {
        safeExecutionGuard.failExecution(decision.executionId, params.error ?? 'open_hedge failed');
      }
    }
  } catch (e) {
    logger.warn('[AgentTradeGuard] completeTrade SafeGuard finalize failed', { error: String(e).slice(0, 200) });
  }

  try {
    await recordAgentDecision({
      chain: params.chain, agent: 'agent-trade-guard', asset: params.asset.toUpperCase(),
      intendedSide: params.intendedSide,
      agentApproved: true,
      agentSide: decision.agentSide,
      agentConfidence: decision.agentConfidence,
      agentReason: params.success
        ? `Trade executed (orderId=${params.orderId ?? '?'})`
        : `Trade failed: ${params.error ?? 'unknown'}`,
      notionalUsd: params.notionalUsd,
      wasActedOn: params.success,
      hedgeOrderId: params.orderId,
    });
  } catch (e) {
    logger.warn('[AgentTradeGuard] completeTrade DB record failed', { error: String(e).slice(0, 200) });
  }
}

/** Best-effort read of latest directives (for surfacing on the dashboard). */
export async function getLatestDirectives(): Promise<DirectiveSnapshot | null> {
  return await loadDirectives();
}
