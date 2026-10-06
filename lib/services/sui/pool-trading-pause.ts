/**
 * Whether the SUI pool cron may move capital: settle, swap, rebalance, hedge.
 *
 * Off unless SUI_POOL_TRADING_ENABLED is set. The 2026-10-06 audit found
 * that the sizing and rebalance steps are wrong above the minimum-NAV gate
 * (perp size multiplied by leverage, spot sold and rebought every tick), and
 * they were quiet only because NAV was reported under that gate. Correcting
 * the NAV figure lifts it over the gate, so trading stays off until those
 * steps are fixed. Pricing, attestation, snapshots and reconciliation are not
 * affected: members can deposit and withdraw while this is off.
 *
 * Release path: set SUI_POOL_TRADING_ENABLED=1 in the environment.
 */
import { envFlag } from '@/lib/utils/env-flag';

export function isPoolTradingEnabled(): boolean {
  return envFlag('SUI_POOL_TRADING_ENABLED');
}
