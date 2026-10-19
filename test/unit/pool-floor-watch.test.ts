/**
 * The floor rule, watched on the live pool: the same rule as paper book -8,
 * honest about the venue's smallest order, and unable to place one.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateStrict: jest.fn(async (k: string) => state.get(k) ?? null),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));

import { planPoolFloor, runPoolFloorWatch } from '@/lib/services/sui/cron/pool-floor-watch';
import { floorTargetUsd } from '@/lib/services/paper-trader/floor-rule';

const PRICES = { BTC: 82_000, ETH: 2_400 };

beforeEach(() => state.clear());

describe('planPoolFloor', () => {
  it('wants the same exposure as the paper book rule, split across BTC and ETH', () => {
    const p = planPoolFloor(10_000, 10_500, PRICES);
    expect(p.targetUsd).toBeCloseTo(floorTargetUsd(10_000, 10_500), 6);
    expect(p.floorUsd).toBeCloseTo(9_450, 6);
    expect(p.perAsset.BTC.targetUsd + p.perAsset.ETH.targetUsd).toBeCloseTo(p.targetUsd, 6);
  });

  it('a $20 pool is far below the venue minimum, and says from what size it would trade', () => {
    const p = planPoolFloor(20, 20, PRICES);
    expect(p.tradable).toBe(false);
    expect(p.perAsset.BTC.minOrderUsd).toBeCloseTo(82, 6); // 0.001 BTC
    expect(p.perAsset.ETH.minOrderUsd).toBeCloseTo(24, 6); // 0.01 ETH
    // at its peak the rule holds 3 × 10 % = 30 % of the pool, 15 % per coin: 82 / 0.15
    expect(p.minPoolUsd).toBeCloseTo(82 / 0.15, 6);
  });

  it('a pool large enough at its peak is tradable; one sitting on its floor wants nothing', () => {
    expect(planPoolFloor(1_000, 1_000, PRICES).tradable).toBe(true);
    expect(planPoolFloor(900, 1_000, PRICES).targetUsd).toBe(0);
  });
});

describe('runPoolFloorWatch', () => {
  it('ratchets the peak up, never down', async () => {
    await runPoolFloorWatch({ navUsd: 20, pricesUSD: PRICES });
    await runPoolFloorWatch({ navUsd: 25, pricesUSD: PRICES });
    const later = await runPoolFloorWatch({ navUsd: 22, pricesUSD: PRICES });
    expect(state.get('pool-floor-watch:peak')).toBe(25);
    expect(later?.peakUsd).toBe(25);
  });

  it('without a value or a price there is no reading, and nothing is stored', async () => {
    expect(await runPoolFloorWatch({ navUsd: 0, pricesUSD: PRICES })).toBeNull();
    expect(await runPoolFloorWatch({ navUsd: 20, pricesUSD: { BTC: 82_000 } })).toBeNull();
    expect(state.size).toBe(0);
  });

  it('cannot place an order: it imports nothing that trades', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../lib/services/sui/cron/pool-floor-watch.ts'), 'utf8');
    expect(src).not.toMatch(/BluefinService|openHedge|closeHedge|signAndExecute|BluefinTreasury/);
  });
});
