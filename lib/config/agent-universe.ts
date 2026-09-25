/**
 * Agent asset universe — single source of truth for "which markets do the
 * agents monitor and act on?"
 *
 * Composed from three inputs, in priority order:
 *
 *   1. Pool assets — inherently 4-asset because `community_pool_usdc.move`
 *      hardcodes struct fields `btc_bps / eth_bps / sui_bps / cro_bps`.
 *      Adding a 5th requires a Move upgrade + package redeploy. The names
 *      are read from `parseTargetAllocation`'s return keys so this file
 *      never lies about pool composition.
 *
 *   2. Trader assets — from `lib/config/trader-assets.ts`. The trader has
 *      per-symbol BlueFin invariants (minQty, step) that also can't be
 *      discovered dynamically, so its list is contract-locked too.
 *
 *   3. Dynamic Polymarket universe — `resolveTrackedAssets()` returns the
 *      live 5-min-binary universe (10+ assets typically) when
 *      POLYMARKET_TRACKED_ASSETS=auto, else the static explicit list.
 *
 * Everything else in the agent stack (HedgingAgent directives, Delphi
 * fetches, price-monitor feeds, poly-discover relevance) should call
 * `resolveAgentUniverse()` instead of hardcoding an asset list. The
 * synchronous `AGENT_UNIVERSE_FLOOR` export is available for call sites
 * that can't await.
 */

import { SUPPORTED_ASSETS as TRADER_ASSETS } from './trader-assets';

/**
 * Pool asset symbols the agents actively signal on. Was 4 (BTC/ETH/SUI/CRO)
 * matching the Move struct field names `btc_bps / eth_bps / sui_bps /
 * cro_bps`; CRO was dropped from the signalling universe when Cronos got
 * nuked (task #13) — the on-chain `cro_bps` field is a dead slot pending a
 * Move upgrade and always reads 0, so producing signals for it just added
 * noise to the dashboard "Live signals" table.
 */
export const POOL_ASSETS = ['BTC', 'ETH', 'SUI'] as const;
export type PoolAsset = (typeof POOL_ASSETS)[number];

/**
 * Synchronous floor — union of contract-locked lists. Every asset here has
 * a real on-chain / venue-level presence, so no discovery can ever remove
 * it. Use this when you can't await (rare).
 */
export const AGENT_UNIVERSE_FLOOR: string[] = Array.from(
  new Set<string>([...POOL_ASSETS, ...TRADER_ASSETS]),
);

/**
 * Async composer — floor UNION dynamic Polymarket universe. Preferred over
 * `AGENT_UNIVERSE_FLOOR` at call sites that can await, so agents pick up
 * newly-listed 5-min binaries without a code change.
 *
 * Discovery failure is non-fatal — the floor still covers pool + trader.
 */
export async function resolveAgentUniverse(): Promise<string[]> {
  try {
    const { resolveTrackedAssets } = await import('../services/market-data/MultiAssetSignalService');
    const dynamic = await resolveTrackedAssets();
    return Array.from(new Set<string>([...AGENT_UNIVERSE_FLOOR, ...dynamic]));
  } catch {
    return AGENT_UNIVERSE_FLOOR;
  }
}
