/**
 * The NAV attestation prices every deposit and withdrawal. These tests pin
 * what is attested, when a large change is allowed through, and that a
 * wallet short of gas is reported instead of silently failing for days.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

const CAP = '0xcap';
const SIGNER_KEY = '11'.repeat(32);

jest.mock('@/lib/services/sui/SuiCommunityPoolService', () => ({
  SUI_USDC_POOL_CONFIG: { mainnet: { packageId: '0xpkg', poolStateId: '0xe814e094' + 'd'.repeat(56), moduleName: 'community_pool_usdc' }, testnet: {} },
  SUI_USDC_COIN_TYPE: { mainnet: '0xusdc::usdc::USDC', testnet: '0xusdc::usdc::USDC' },
}));
jest.mock('@/lib/services/sui/cron/signal-gating', () => ({ isStrongHedgeSignal: jest.fn() }));

const state = new Map<string, unknown>();
jest.mock('@/lib/db/cron-state', () => ({
  getCronStateOr: jest.fn(async (k: string, d: unknown) => (state.has(k) && state.get(k) !== null ? state.get(k) : d)),
  setCronState: jest.fn(async (k: string, v: unknown) => { state.set(k, v); }),
}));
const notifyDiscord = jest.fn(async (..._a: unknown[]) => {});
jest.mock('@/lib/utils/discord-notify', () => ({ notifyDiscord: (...a: unknown[]) => notifyDiscord(...a) }));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

interface FakeTx { calls: Array<{ target: string; arguments: unknown[] }>; budget?: number }
const built: FakeTx[] = [];
jest.mock('@mysten/sui/transactions', () => ({
  Transaction: class {
    calls: Array<{ target: string; arguments: unknown[] }> = [];
    budget?: number;
    pure = { u64: (v: unknown) => ({ u64: BigInt(v as bigint) }) };
    constructor() { built.push(this as unknown as FakeTx); }
    object(id: string) { return id; }
    moveCall(c: { target: string; arguments: unknown[] }) { this.calls.push(c); }
    setGasBudget(b: number) { this.budget = b; }
  },
}));

let chain = { balanceRaw: '3157800', priorRaw: '7316909' as string | null, tsMs: 0, gasMist: '19815161', capOwner: '' };
const signAndExecuteTransaction = jest.fn(async (_: unknown) => ({ digest: 'DIGEST', effects: { status: { status: 'success' } } }));
jest.mock('@/lib/services/sui/sui-failover-transport', () => ({
  createFailoverSuiClient: () => ({
    getObject: async ({ id }: { id: string }) =>
      id === CAP
        ? { data: { owner: { AddressOwner: chain.capOwner } } }
        : { data: { content: { fields: { balance: chain.balanceRaw, hedge_state: { fields: { total_hedged_value: '3095269' } } } } } },
    getDynamicFieldObject: async ({ name }: { name: { value: number[] } }) => {
      const key = Buffer.from(name.value).toString();
      if (key === 'external_nav_usdc') return chain.priorRaw === null ? { error: { code: 'dynamicFieldNotFound' } } : { data: { content: { fields: { value: chain.priorRaw } } } };
      return { data: { content: { fields: { value: String(chain.tsMs) } } } };
    },
    getBalance: async () => ({ totalBalance: chain.gasMist }),
    signAndExecuteTransaction: (a: unknown) => signAndExecuteTransaction(a),
  }),
}));

import { attestExternalNav } from '@/lib/services/sui/cron/nav-oracle';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const attested = () => built[built.length - 1].calls.map((c) => (c.arguments[2] as { u64: bigint }).u64);
const attest = (externalUsd: number, trusted = true) => attestExternalNav('mainnet', { externalUsd, trusted });
const accepts = (prior: bigint, path: bigint[]) => {
  let cur = prior;
  for (const step of path) {
    const delta = step > cur ? step - cur : cur - step;
    if ((delta * 10_000n) / cur > 3000n) return false;
    cur = step;
  }
  return true;
};
const PENDING = 'sui-nav-attest:pending-large-change';
const LAST = 'sui-nav-attest:last';
/** External the venue-and-wallet read gives today; 7.316909 is on chain. */
const CORRECTED = 16.72;

beforeEach(() => {
  jest.clearAllMocks();
  built.length = 0;
  state.clear();
  process.env.SUI_POOL_ADMIN_KEY = SIGNER_KEY;
  process.env.SUI_ADMIN_CAP_ID = CAP;
  delete process.env.SUI_ORACLE_CAP_ID;
  const signer = Ed25519Keypair.fromSecretKey(Buffer.from(SIGNER_KEY, 'hex')).toSuiAddress();
  chain = { balanceRaw: '3157800', priorRaw: '7316909', tsMs: Date.now() - 5 * 60_000, gasMist: '19815161', capOwner: signer };
});

describe('what is attested', () => {
  it('the external figure it is given, unchanged: nothing is subtracted for open hedges', async () => {
    const r = await attest(7.8422);
    expect(r.pushed).toBe(true);
    expect(attested()).toEqual([7_842_200n]);
    expect(r.externalNavUsd).toBeCloseTo(7.8422, 6);
  });

  it('a deposit landing between the NAV read and the attestation does not move the attested value', async () => {
    await attest(7.8422);
    const before = attested();
    chain.balanceRaw = String(3_157_800 + 4_900_000); // $4.90 deposited mid-tick
    await attest(7.8422);
    expect(attested()).toEqual(before);
  });

  it('the service builds that figure from one read: admin holdings plus the venue account', () => {
    const src = readFileSync(join(process.cwd(), 'lib/services/sui/SuiUsdcPoolService.ts'), 'utf8');
    expect(src).toContain('externalUsdc: offChainPoolCapital + bluefinValueUsdc');
    expect(src).toContain('adminRead: usedAdminBalances');
    const step4 = readFileSync(join(process.cwd(), 'lib/services/sui/cron/step-4-nav-defense.ts'), 'utf8');
    expect(step4).toContain('externalUsd: basis.externalUsdc');
    expect(step4).toContain('!basis.adminRead');
    expect(step4).not.toMatch(/attestExternalNav\(network, navUsd\)/);
  });

  it('refuses a figure that is not a non-negative number', async () => {
    for (const bad of [NaN, -1, Infinity]) expect((await attest(bad)).pushed).toBe(false);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it('an unreadable pool object is refused, not treated as a zero balance', async () => {
    chain.balanceRaw = undefined as unknown as string;
    expect((await attest(7.8422)).pushed).toBe(false);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });
});

describe('gas', () => {
  it('the budget fits the wallet that froze the pool (0.0198 SUI): the attestation goes through', async () => {
    expect((await attest(7.8422)).pushed).toBe(true);
    expect(built[0].budget!).toBeLessThan(Number(chain.gasMist));
  });

  it('a wallet that cannot cover the budget is reported with the numbers, and nothing is signed', async () => {
    chain.gasMist = '1000000';
    const r = await attest(7.8422);
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/insufficient gas/);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it('reports how old the on-chain attestation is, so the caller can alert', async () => {
    chain.tsMs = Date.now() - 6651 * 60_000;
    chain.gasMist = '1';
    expect((await attest(7.8422)).attestationAgeMin!).toBeGreaterThan(6650);
  });
});

describe('a repricing of more than 30%', () => {
  it('is not attested on the first or second sighting, and says why', async () => {
    const first = await attest(CORRECTED);
    const second = await attest(CORRECTED);
    expect(first.error).toMatch(/awaiting confirmation \(1\/3\)/);
    expect(second.error).toMatch(/awaiting confirmation \(2\/3\)/);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
  });

  it('on the third consecutive sighting is walked there in ONE transaction, every link inside the contract bound', async () => {
    await attest(CORRECTED);
    await attest(CORRECTED);
    const third = await attest(CORRECTED);
    expect(third.pushed).toBe(true);
    expect(signAndExecuteTransaction).toHaveBeenCalledTimes(1);
    const path = attested();
    expect(path.length).toBe(4);
    // the target is floored from a decimal, so it may sit one micro-dollar under
    expect(16_720_000n - path[path.length - 1] <= 1n).toBe(true);
    expect(accepts(7_316_909n, path)).toBe(true);
    expect(built[built.length - 1].budget!).toBeLessThan(Number(chain.gasMist));
    expect(state.get(PENDING)).toBeNull();
    const last = state.get(LAST) as { balanceRaw: string; externalRaw: string };
    expect(last.balanceRaw).toBe('3157800');
    expect(last.externalRaw).toBe(String(path[path.length - 1]));
  });

  it('a different target restarts the count: one bad read cannot reprice the pool', async () => {
    await attest(CORRECTED);
    await attest(CORRECTED);
    expect((await attest(12.0)).error).toMatch(/1\/3/);
    expect((await attest(CORRECTED)).error).toMatch(/1\/3/);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it('an ordinary attestation in between ends the count: "in a row" means in a row', async () => {
    await attest(CORRECTED);
    await attest(CORRECTED);
    expect((await attest(7.8422)).pushed).toBe(true);
    expect(state.get(PENDING)).toBeNull();
    chain.priorRaw = '7842200';
    expect((await attest(CORRECTED)).error).toMatch(/1\/3/);
  });

  it('a count older than an hour is not continued', async () => {
    state.set(PENDING, { targetRaw: '16720000', count: 2, firstSeen: Date.now() - 2 * 60 * 60_000 });
    expect((await attest(CORRECTED)).error).toMatch(/1\/3/);
  });

  it('needs a live venue read: a cached figure is never walked to', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await attest(CORRECTED, false);
      expect(r.pushed).toBe(false);
      expect(r.error).toMatch(/not live/);
    }
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it('is capped: a rise of more than three times needs an operator, however often it is read', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await attest(60.0);
      expect(r.pushed).toBe(false);
      expect(r.error).toMatch(/more than 3x/);
    }
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it('a collapse that cannot be reached needs an operator', async () => {
    const r = await attest(0);
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/out of reach/);
  });
});

describe('value moving between the pool and outside is not a repricing', () => {
  it('USDC returned to the pool: external falls far, total is unchanged, and it is attested at once', async () => {
    // last attestation: $3.16 in the pool, $16.72 outside
    state.set(LAST, { balanceRaw: '3157800', externalRaw: '16720000', at: Date.now() });
    chain.priorRaw = '16720000';
    // the venue money comes back: $19.38 in the pool, $0.50 outside
    chain.balanceRaw = '19377800';
    const r = await attest(0.5);
    expect(r.pushed).toBe(true);
    const path = attested();
    expect(path.length).toBeGreaterThan(1);
    expect(path[path.length - 1]).toBe(500_000n);
    expect(accepts(16_720_000n, path)).toBe(true);
    expect(notifyDiscord).toHaveBeenCalledTimes(1); // the "moved in N steps" notice, no confirmation wait
  });

  it('when everything comes back, it walks as far as one transaction allows and continues next tick', async () => {
    state.set(LAST, { balanceRaw: '3157800', externalRaw: '16720000', at: Date.now() });
    chain.priorRaw = '16720000';
    chain.balanceRaw = '19877800';
    const r = await attest(0);
    expect(r.pushed).toBe(true);
    const path = attested();
    expect(path.length).toBe(16);
    expect(accepts(16_720_000n, path)).toBe(true);
    expect(Number(path[path.length - 1])).toBeLessThan(16_720_000 * 0.005);
    expect(built[built.length - 1].budget!).toBeLessThan(Number(chain.gasMist));
  });

  it('but a fall that is NOT matched by the pool balance is a repricing and waits', async () => {
    state.set(LAST, { balanceRaw: '3157800', externalRaw: '16720000', at: Date.now() });
    chain.priorRaw = '16720000';
    const r = await attest(5.0);
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/1\/3/);
  });
});

describe('who may attest', () => {
  it('does nothing when the cap is not held by the signer', async () => {
    chain.capOwner = '0x' + '9'.repeat(64);
    expect((await attest(7.8422)).pushed).toBe(false);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });
});
