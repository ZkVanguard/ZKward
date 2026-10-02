/**
 * A failed members read must never be presented as "the pool has no members".
 * Right after a deploy (fresh instance, nothing cached) a rate-limited chain
 * read returned `[]`, and the route cached `count: 0` at the CDN as fact.
 */
import { describe, it, expect } from '@jest/globals';
import { SuiUsdcPoolService } from '@/lib/services/sui/SuiUsdcPoolService';

type Internals = {
  isDeployed: () => boolean;
  getPoolStateId: () => Promise<string>;
  readAllMembers: () => Promise<unknown[]>;
  lastGoodMembers: unknown[] | null;
};

function serviceWithFailingRead(lastGood: unknown[] | null) {
  const svc = new SuiUsdcPoolService('testnet');
  const s = svc as unknown as Internals;
  s.isDeployed = () => true;
  s.getPoolStateId = async () => '0xpool';
  s.readAllMembers = async () => {
    throw new Error('429 rate limited');
  };
  s.lastGoodMembers = lastGood;
  return svc;
}

describe('SUI members list on a failed chain read', () => {
  it('fails when there is no earlier complete list', async () => {
    await expect(serviceWithFailingRead(null).getAllMembers()).rejects.toThrow('429');
  });

  it('serves the last complete list when there is one', async () => {
    const lastGood = [{ address: '0xabc', shares: 5 }];
    await expect(serviceWithFailingRead(lastGood).getAllMembers()).resolves.toBe(lastGood);
  });
});
