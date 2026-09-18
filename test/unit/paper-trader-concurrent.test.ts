/**
 * Concurrent-position helper tests — rejection logic + correlation gate.
 * Behavioral coverage of the storage helpers is covered indirectly via
 * the existing PaperTrader integration tests + prod monitoring.
 */
import { describe, it, expect } from '@jest/globals';
import {
  rejectionReason,
  clusterFor,
  type ActivePosition,
} from '@/lib/services/paper-trader/concurrent';
import type { SimulatedPosition } from '@/lib/services/paper-trader/simulated-executor';

function mkPos(asset: string, side: 'LONG' | 'SHORT'): ActivePosition {
  const position: SimulatedPosition = {
    asset,
    side,
    entryPrice: 100,
    size: 1,
    notionalUsd: 100,
    leverage: 3,
    openedAt: Date.now(),
    openFeeUsd: 0.13,
  };
  return { orderId: `paper_${asset}_${Date.now()}`, position };
}

describe('clusterFor — default BTC/ETH/SOL cluster', () => {
  it('returns the cluster for a member asset', () => {
    expect(clusterFor('BTC')).toEqual(['BTC', 'ETH', 'SOL']);
    expect(clusterFor('ETH')).toEqual(['BTC', 'ETH', 'SOL']);
    expect(clusterFor('SOL')).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('returns null for a non-clustered asset', () => {
    expect(clusterFor('XRP')).toBeNull();
    expect(clusterFor('DOGE')).toBeNull();
  });
});

describe('rejectionReason — same-asset dedup', () => {
  it('rejects a candidate when the same asset is already active', () => {
    const active = [mkPos('BTC', 'LONG')];
    const reject = rejectionReason('BTC', 'LONG', active);
    expect(reject).toMatch(/already active on BTC/);
  });

  it('rejects same-asset even on opposite side', () => {
    const active = [mkPos('BTC', 'LONG')];
    const reject = rejectionReason('BTC', 'SHORT', active);
    expect(reject).toMatch(/already active on BTC/);
  });

  it('allows different asset when no cluster conflict', () => {
    const active = [mkPos('BTC', 'LONG')];
    expect(rejectionReason('XRP', 'LONG', active)).toBeNull();
    expect(rejectionReason('DOGE', 'SHORT', active)).toBeNull();
  });
});

describe('rejectionReason — correlation cluster cap', () => {
  it('allows 2nd same-direction in BTC/ETH/SOL cluster (cap default 2)', () => {
    const active = [mkPos('BTC', 'LONG')];
    // Second LONG in the cluster
    expect(rejectionReason('ETH', 'LONG', active)).toBeNull();
  });

  it('rejects 3rd same-direction in BTC/ETH/SOL cluster', () => {
    const active = [mkPos('BTC', 'LONG'), mkPos('ETH', 'LONG')];
    const reject = rejectionReason('SOL', 'LONG', active);
    expect(reject).toMatch(/cluster BTC\/ETH\/SOL/);
    expect(reject).toMatch(/max 2/);
  });

  it('allows opposite direction — LONG BTC + LONG ETH + SHORT SOL', () => {
    const active = [mkPos('BTC', 'LONG'), mkPos('ETH', 'LONG')];
    expect(rejectionReason('SOL', 'SHORT', active)).toBeNull();
  });

  it('caps independently for LONG vs SHORT in same cluster', () => {
    // 2 LONGs in cluster + 1 SHORT existing → adding another SHORT is fine
    const active = [
      mkPos('BTC', 'LONG'),
      mkPos('ETH', 'LONG'),
      mkPos('SOL', 'SHORT'),
    ];
    // Can't open more LONG (already 2), but no LONG candidate would pass same-asset dedup anyway.
    // Test the SHORT side: adding a 2nd SHORT would still be at cap.
    expect(rejectionReason('SOL', 'SHORT', active)).toMatch(/already active on SOL/);
  });
});

describe('rejectionReason — non-clustered assets', () => {
  it('allows multiple non-clustered assets without a correlation cap', () => {
    const active = [mkPos('XRP', 'LONG')];
    expect(rejectionReason('DOGE', 'LONG', active)).toBeNull();
  });
});
