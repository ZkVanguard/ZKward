/**
 * Agent decisions table — every trade-impacting recommendation an agent
 * makes is recorded here, along with whether it was acted on and the eventual
 * outcome. Foundation for accuracy tracking + (later) self-improvement.
 *
 * The table is append-only and no agent decision is ever deleted. Outcomes
 * are read from the decision's closed hedge row, not stored here.
 */

import { query } from './postgres';
import { TRADE_OUTCOME_SQL } from './hedges';
import { logger } from '@/lib/utils/logger';

export interface AgentDecisionRow {
  id: number;
  chain: string;
  agent: string;
  asset: string;
  intended_side: 'LONG' | 'SHORT' | null;
  agent_approved: boolean;
  agent_side: 'LONG' | 'SHORT' | null;
  agent_confidence: number | null;
  agent_reason: string | null;
  notional_usd: number;
  was_acted_on: boolean;
  hedge_order_id: string | null;
  created_at: Date;
  outcome_pnl_usd: number | null;
  outcome_settled_at: Date | null;
}

export interface RecordAgentDecisionParams {
  chain: 'sui' | 'cronos' | 'oasis-sapphire' | 'hedera';
  agent: string;
  asset: string;
  intendedSide: 'LONG' | 'SHORT' | null;
  agentApproved: boolean;
  agentSide: 'LONG' | 'SHORT' | null;
  agentConfidence: number | null;
  agentReason: string | null;
  notionalUsd: number;
  wasActedOn: boolean;
  hedgeOrderId?: string | null;
}

let tableEnsured = false;

async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS agent_decisions (
        id           SERIAL PRIMARY KEY,
        chain        TEXT NOT NULL,
        agent        TEXT NOT NULL,
        asset        TEXT NOT NULL,
        intended_side       TEXT,
        agent_approved      BOOLEAN NOT NULL,
        agent_side          TEXT,
        agent_confidence    NUMERIC(5,2),
        agent_reason        TEXT,
        notional_usd        NUMERIC(20,4) NOT NULL DEFAULT 0,
        was_acted_on        BOOLEAN NOT NULL DEFAULT false,
        hedge_order_id      TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        outcome_pnl_usd     NUMERIC(20,6),
        outcome_settled_at  TIMESTAMPTZ
      )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_agent_decisions_order ON agent_decisions (hedge_order_id) WHERE hedge_order_id IS NOT NULL`);
    await query(`CREATE INDEX IF NOT EXISTS idx_agent_decisions_chain_time ON agent_decisions (chain, created_at DESC)`);
    tableEnsured = true;
  } catch (e) {
    logger.warn('[AgentDecisions] ensureTable failed (will retry on next call)', { error: String(e).slice(0, 200) });
  }
}

export async function recordAgentDecision(p: RecordAgentDecisionParams): Promise<number | null> {
  try {
    await ensureTable();
    const rows = await query<{ id: number }>(
      `INSERT INTO agent_decisions (
         chain, agent, asset, intended_side, agent_approved, agent_side,
         agent_confidence, agent_reason, notional_usd, was_acted_on, hedge_order_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        p.chain, p.agent, p.asset, p.intendedSide,
        p.agentApproved, p.agentSide, p.agentConfidence, p.agentReason,
        p.notionalUsd, p.wasActedOn, p.hedgeOrderId ?? null,
      ],
    );
    return rows[0]?.id ?? null;
  } catch (e) {
    // Decision recording must never crash the cron — DB issues are non-fatal
    logger.warn('[AgentDecisions] recordAgentDecision failed (non-fatal)', { error: String(e).slice(0, 200) });
    return null;
  }
}

/**
 * Roll-up of agent accuracy over a recent window.
 * — approved_count: agent said go, hedge was opened, outcome settled
 * — net_pnl_usd: sum of outcomes for approved decisions
 * — rejected_avoidance_usd: theoretical "loss avoided" = hedges agent
 *   rejected that, if opened at the same time, would likely have lost. We
 *   can't compute this here without a hypothetical; reported as null and
 *   filled in later by a separate analysis job.
 */
export async function getRecentAgentScorecard(chain: string, days = 7): Promise<{
  totalDecisions: number;
  approvedCount: number;
  rejectedCount: number;
  actedOnCount: number;
  settledCount: number;
  netPnlUsd: number;
  winRate: number | null;
}> {
  try {
    await ensureTable();
    const rows = await query<{
      total: string; approved: string; rejected: string;
      acted: string; settled: string; net_pnl: string | null;
      wins: string;
    }>(
      // Outcomes come from the decision's closed hedge row, counted like every
      // other trade reader (TRADE_OUTCOME_SQL): a reconciled close is not a result.
      `SELECT
         COUNT(*)::int                                                         AS total,
         COUNT(*) FILTER (WHERE d.agent_approved)::int                         AS approved,
         COUNT(*) FILTER (WHERE NOT d.agent_approved)::int                     AS rejected,
         COUNT(*) FILTER (WHERE d.was_acted_on)::int                           AS acted,
         COUNT(h.order_id) FILTER (WHERE d.was_acted_on)::int                  AS settled,
         COALESCE(SUM(h.realized_pnl) FILTER (WHERE d.was_acted_on), 0)::numeric AS net_pnl,
         COUNT(*) FILTER (WHERE d.was_acted_on AND h.realized_pnl > 0)::int    AS wins
       FROM agent_decisions d
       LEFT JOIN (
         SELECT order_id, realized_pnl FROM hedges
          WHERE status IN ('closed', 'liquidated') AND ${TRADE_OUTCOME_SQL}
       ) h ON h.order_id = d.hedge_order_id
       WHERE d.chain = $1
         AND d.created_at > NOW() - ($2::int || ' days')::interval`,
      [chain, days],
    );
    const r = rows[0];
    const settled = Number(r?.settled ?? 0);
    const wins = Number(r?.wins ?? 0);
    return {
      totalDecisions: Number(r?.total ?? 0),
      approvedCount: Number(r?.approved ?? 0),
      rejectedCount: Number(r?.rejected ?? 0),
      actedOnCount: Number(r?.acted ?? 0),
      settledCount: settled,
      netPnlUsd: Number(r?.net_pnl ?? 0),
      winRate: settled > 0 ? wins / settled : null,
    };
  } catch (e) {
    logger.warn('[AgentDecisions] getRecentAgentScorecard failed', { error: String(e).slice(0, 200) });
    return { totalDecisions: 0, approvedCount: 0, rejectedCount: 0, actedOnCount: 0, settledCount: 0, netPnlUsd: 0, winRate: null };
  }
}
