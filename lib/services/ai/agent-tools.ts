/**
 * Agent tool registry — read-only capabilities the Layer 3 specialized
 * agents (HedgingAgent, RiskAgent, ReportingAgent, SettlementAgent,
 * SuiPoolAgent) can call from within a tool-use LLM loop.
 *
 * ## Why in-process (not MCP protocol)
 *
 * Real Anthropic MCP is a client-side protocol (stdio/HTTP transports).
 * At Vercel runtime we already have direct import access to every data
 * source MCP would proxy — Aiven Postgres, unified-price-provider,
 * cron_state, signal_interpretations. Wrapping in-process functions
 * in the OpenAI tool-use format gives us the same reasoning capability
 * without a broker.
 *
 * ## Read-only invariant
 *
 * These tools NEVER mutate state. No trade opens, no cron writes, no
 * DB inserts. If an agent needs to act, it produces a recommendation
 * and the caller decides — the tool boundary is the safety boundary.
 *
 * ## Layout (2026-09-25 refactor)
 *
 * Tools moved to per-domain files under `./tools/`:
 *   - db-tools.ts       — Postgres reads (interpretations, hedges, cron_state, treasury)
 *   - price-tools.ts    — validated spot + market snapshot + prediction signal
 *   - market-tools.ts   — external APIs (Crypto.com, DefiLlama, CoinGecko, Owlracle, Deribit)
 *   - context-tools.ts  — composite `getAssetContext` fan-out tool
 * This file is now a thin registry + runner.
 */

import { logger } from '@/lib/utils/logger';
import type { AgentTool } from './tools/types';

import {
  queryRecentInterpretations,
  queryHedgeHistory,
  getCronStateSnapshot,
  queryPostmortemStats,
  getTreasuryStateTool,
} from './tools/db-tools';
import {
  getAssetPrice,
  getMarketSnapshot,
  getPredictionSignal,
} from './tools/price-tools';
import {
  getBroaderMarket,
  getDefiLlamaTvl,
  getFearGreedIndex,
  getCryptoNews,
  getHistoricalSummary,
  getOnchainSnapshot,
  getOptionsData,
} from './tools/market-tools';
import { getAssetContext } from './tools/context-tools';

// Re-export for external consumers that imported the type from this file
// pre-refactor.
export type { AgentTool } from './tools/types';

/** Public registry — the default tool set every Layer 3 agent gets. */
export const DEFAULT_AGENT_TOOLS: AgentTool[] = [
  getAssetContext,          // PREFERRED for single-asset questions
  queryRecentInterpretations,
  queryHedgeHistory,
  getAssetPrice,
  getMarketSnapshot,
  getPredictionSignal,
  getCronStateSnapshot,
  queryPostmortemStats,
  getTreasuryStateTool,
  getBroaderMarket,
  getDefiLlamaTvl,
  getFearGreedIndex,
  getCryptoNews,            // trending coins + hot narratives (CoinGecko)
  getHistoricalSummary,     // N-day high/low/change (CoinGecko market_chart)
  getOnchainSnapshot,       // ETH gas + top-chain TVL (Owlracle + DefiLlama)
  getOptionsData,           // BTC/ETH options IV + put/call + top strikes (Deribit)
] as AgentTool[];

/** Look up a tool by name — used by the runner to dispatch. */
export function toolByName(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.name === name);
}

/** Convert our internal tool shape to the OpenAI tool-schema payload. */
export function toolsToOpenAiSchema(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function runTool(
  tool: AgentTool,
  args: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const result = await tool.execute(args);
    return { ok: true, result };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('[AgentTools] tool failed', { name: tool.name, args, error: msg });
    return { ok: false, error: msg };
  }
}
