/**
 * The two calls where the pool contract checks a number to the unit.
 * Each rule the contract enforces is restated here as a small function, so
 * the helpers are tested against the contract's arithmetic, not their own.
 */
import { describe, it, expect } from '@jest/globals';
import { attestPath, closeHedgeArgs, splitProRata } from '@/lib/services/sui/cron/onchain-math';

/** community_pool_usdc.move, attest_external_nav_internal: change_bps <= 3000, integer division. */
const contractAcceptsAttest = (prior: bigint, next: bigint): boolean => {
  if (prior === 0n) return true;
  const delta = next > prior ? next - prior : prior - next;
  return (delta * 10_000n) / prior <= 3000n;
};
/** community_pool_usdc.move, close_hedge: coin >= expected_return. */
const contractAcceptsClose = (collateral: bigint, coin: bigint, pnl: bigint, isProfit: boolean): boolean => {
  const expected = isProfit ? collateral + pnl : pnl >= collateral ? 0n : collateral - pnl;
  return coin >= expected;
};
const walk = (prior: bigint, path: bigint[]) => {
  let cur = prior;
  for (const step of path) {
    if (!contractAcceptsAttest(cur, step)) return false;
    cur = step;
  }
  return true;
};

describe('attestPath', () => {
  it('a change inside the bound is one attestation', () => {
    expect(attestPath(7_316_909n, 8_000_000n)).toEqual({ path: [8_000_000n], reached: true });
    expect(attestPath(7_316_909n, 7_316_909n)).toEqual({ path: [7_316_909n], reached: true });
    expect(attestPath(10_000_000n, 7_100_000n)).toEqual({ path: [7_100_000n], reached: true });
  });

  it('the first attestation has no prior to be bounded by', () => {
    expect(attestPath(0n, 16_720_000n)).toEqual({ path: [16_720_000n], reached: true });
  });

  it('the live catch-up (7.32 → 16.72) is a chain the contract accepts link by link and ends on the target', () => {
    const { path, reached } = attestPath(7_316_909n, 16_720_000n)!;
    expect(reached).toBe(true);
    expect(path.length).toBe(4);
    expect(path[path.length - 1]).toBe(16_720_000n);
    expect(walk(7_316_909n, path)).toBe(true);
    // and the direct jump is what the contract refuses
    expect(contractAcceptsAttest(7_316_909n, 16_720_000n)).toBe(false);
  });

  it('a large fall is walked down the same way', () => {
    const { path, reached } = attestPath(16_720_000n, 3_000_000n)!;
    expect(reached).toBe(true);
    expect(path[path.length - 1]).toBe(3_000_000n);
    expect(walk(16_720_000n, path)).toBe(true);
  });

  it('every link is accepted across a spread of sizes, including values where integer division bites', () => {
    for (const prior of [1n, 3n, 7n, 10n, 999n, 1_000_001n, 7_316_909n, 9_999_999_999_999n]) {
      for (const target of [prior * 5n, prior * 2n + 1n, prior + 1n, (prior * 2n) / 3n + 1n, 0n]) {
        const w = attestPath(prior, target, 64);
        if (!w) continue;
        expect(walk(prior, w.path)).toBe(true);
        if (w.reached) expect(w.path[w.path.length - 1]).toBe(target);
      }
    }
  });

  it('a fall to zero makes progress every call instead of refusing: USDC returned to the pool must stop being counted outside it', () => {
    const first = attestPath(16_786_870n, 0n)!;
    expect(first.reached).toBe(false);
    expect(first.path.length).toBe(16);
    expect(walk(16_786_870n, first.path)).toBe(true);
    const left = first.path[first.path.length - 1];
    expect(Number(left) / 16_786_870).toBeLessThan(0.005);
    // the next call continues from where this one stopped
    const second = attestPath(left, 0n)!;
    expect(walk(left, second.path)).toBe(true);
    expect(second.path[second.path.length - 1] < left).toBe(true);
  });

  it('stops at the step limit and says it has not arrived', () => {
    const w = attestPath(1_000_000n, 1_000_000_000_000n, 16)!;
    expect(w.reached).toBe(false);
    expect(w.path.length).toBe(16);
    expect(walk(1_000_000n, w.path)).toBe(true);
  });

  it('refuses input that cannot be walked', () => {
    expect(attestPath(-1n, 5n)).toBeNull();
    expect(attestPath(5n, -1n)).toBeNull();
    expect(attestPath(1n, 100n)).toBeNull(); // 29% of one unit is zero: no step exists
  });
});

describe('closeHedgeArgs', () => {
  // The state that aborted 411 closes on 2026-09-29/30: two hedges, a wallet
  // holding less than their collateral.
  const collaterals = [2_813_881n, 281_388n];
  const adminRaw = 502_133n;

  it('the live case: both closes pass the contract check', () => {
    const shares = splitProRata(adminRaw, collaterals);
    shares.forEach((share, i) => {
      const a = closeHedgeArgs(collaterals[i], share);
      expect(a.isProfit).toBe(false);
      expect(contractAcceptsClose(collaterals[i], a.amountRaw, a.pnlRaw, a.isProfit)).toBe(true);
    });
  });

  it('the old arithmetic fails that same check (floor of the return and floor of the loss, separately)', () => {
    const total = Number(collaterals[0] + collaterals[1]) / 1e6;
    const admin = Number(adminRaw) / 1e6;
    const failures = collaterals.filter((c) => {
      const collateral = Number(c) / 1e6;
      const ret = admin * (collateral / total);
      const amountRaw = BigInt(Math.floor(ret * 1e6));
      const pnlRaw = BigInt(Math.floor(Math.abs(ret - collateral) * 1e6));
      return !contractAcceptsClose(c, amountRaw, pnlRaw, false);
    });
    expect(failures.length).toBeGreaterThan(0);
  });

  it('the coin always satisfies the contract, for loss, break-even and profit', () => {
    for (const collateral of [1n, 281_388n, 2_813_881n, 10_000_000_000n]) {
      for (const ret of [0n, 1n, collateral - 1n, collateral, collateral + 1n, collateral * 3n]) {
        if (ret < 0n) continue;
        const a = closeHedgeArgs(collateral, ret);
        expect(contractAcceptsClose(collateral, a.amountRaw, a.pnlRaw, a.isProfit)).toBe(true);
        // and it never claims more profit than the coin carries
        if (a.isProfit) expect(collateral + a.pnlRaw).toBe(ret);
      }
    }
  });

  it('refuses negative amounts', () => {
    expect(() => closeHedgeArgs(-1n, 1n)).toThrow();
    expect(() => closeHedgeArgs(1n, -1n)).toThrow();
  });
});

describe('splitProRata', () => {
  it('never hands out more than is available', () => {
    for (const available of [0n, 1n, 502_133n, 999_999_999n]) {
      const shares = splitProRata(available, [2_813_881n, 281_388n, 7n]);
      expect(shares.reduce((a, b) => a + b, 0n) <= available).toBe(true);
    }
  });

  it('splits in proportion and handles an all-zero set', () => {
    expect(splitProRata(100n, [3n, 1n])).toEqual([75n, 25n]);
    expect(splitProRata(100n, [0n, 0n])).toEqual([0n, 0n]);
    expect(splitProRata(100n, [])).toEqual([]);
  });
});
