/**
 * The NAV attestation prices every deposit and withdrawal. These tests pin
 * what is attested, when a large change is allowed through, and that a
 * wallet short of gas is reported instead of silently failing for days.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const POOL = '0xe814e094' + 'd'.repeat(56);
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

let chain = { balanceRaw: '3157800', hedgedRaw: '3095269', priorRaw: '7316909' as string | null, tsMs: Date.now() - 5 * 60_000, gasMist: '19815161', capOwner: '' };
const signAndExecuteTransaction = jest.fn(async (_: unknown) => ({ digest: 'DIGEST', effects: { status: { status: 'success' } } }));
jest.mock('@/lib/services/sui/sui-failover-transport', () => ({
  createFailoverSuiClient: () => ({
    getObject: async ({ id }: { id: string }) =>
      id === CAP
        ? { data: { owner: { AddressOwner: chain.capOwner } } }
        : { data: { content: { fields: { balance: chain.balanceRaw, hedge_state: { fields: { total_hedged_value: chain.hedgedRaw } } } } } },
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

beforeEach(() => {
  jest.clearAllMocks();
  built.length = 0;
  state.clear();
  process.env.SUI_POOL_ADMIN_KEY = SIGNER_KEY;
  process.env.SUI_ADMIN_CAP_ID = CAP;
  delete process.env.SUI_ORACLE_CAP_ID;
  const signer = Ed25519Keypair.fromSecretKey(Buffer.from(SIGNER_KEY, 'hex')).toSuiAddress();
  chain = { balanceRaw: '3157800', hedgedRaw: '3095269', priorRaw: '7316909', tsMs: Date.now() - 5 * 60_000, gasMist: '19815161', capOwner: signer };
});

describe('what is attested', () => {
  it('external = NAV − pool balance. The hedged amount is NOT subtracted: it is off-chain value the share price must include', async () => {
    // NAV 11.00 with 3.1578 in the pool → 7.8422 external. The old formula gave 7.8422 − 3.0953 = 4.7469.
    const r = await attestExternalNav('mainnet', 11.0);
    expect(r.pushed).toBe(true);
    expect(attested()).toEqual([7_842_200n]);
    expect(r.externalNavUsd).toBeCloseTo(7.8422, 6);
  });

  it('share price on chain then equals NAV ÷ shares, with or without an open hedge', async () => {
    await attestExternalNav('mainnet', 11.0);
    const [external] = attested();
    const pricedOn = BigInt(chain.balanceRaw) + external; // total_assets_including_external
    expect(pricedOn).toBe(11_000_000n);
  });

  it('a NAV below the pool balance attests zero rather than a negative number', async () => {
    chain.priorRaw = null;
    const r = await attestExternalNav('mainnet', 1.0);
    expect(r.pushed).toBe(true);
    expect(attested()).toEqual([0n]);
  });

  it('an unreadable pool object is refused, not treated as a zero balance', async () => {
    chain.balanceRaw = undefined as unknown as string;
    const r = await attestExternalNav('mainnet', 11.0);
    expect(r.pushed).toBe(false);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });
});

describe('gas', () => {
  it('the budget fits the wallet that froze the pool (0.0198 SUI): the attestation goes through', async () => {
    const r = await attestExternalNav('mainnet', 11.0);
    expect(r.pushed).toBe(true);
    expect(built[0].budget!).toBeLessThan(Number(chain.gasMist));
  });

  it('a wallet that cannot cover the budget is reported with the numbers, and nothing is signed', async () => {
    chain.gasMist = '1000000';
    const r = await attestExternalNav('mainnet', 11.0);
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/insufficient gas/);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it('reports how old the on-chain attestation is, so the caller can alert', async () => {
    chain.tsMs = Date.now() - 6651 * 60_000;
    chain.gasMist = '1';
    const r = await attestExternalNav('mainnet', 11.0);
    expect(r.attestationAgeMin!).toBeGreaterThan(6650);
  });
});

describe('a change of more than 30%', () => {
  const NAV = 19.8778; // → external 16.72 against 7.316909 on chain

  it('is not attested on the first or second sighting, and says why', async () => {
    const first = await attestExternalNav('mainnet', NAV);
    const second = await attestExternalNav('mainnet', NAV);
    expect(first.pushed).toBe(false);
    expect(first.error).toMatch(/awaiting confirmation \(1\/3\)/);
    expect(second.error).toMatch(/awaiting confirmation \(2\/3\)/);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
    expect(notifyDiscord).toHaveBeenCalledTimes(1);
  });

  it('on the third consecutive sighting is walked there in ONE transaction, every link inside the contract bound', async () => {
    await attestExternalNav('mainnet', NAV);
    await attestExternalNav('mainnet', NAV);
    const third = await attestExternalNav('mainnet', NAV);
    expect(third.pushed).toBe(true);
    expect(signAndExecuteTransaction).toHaveBeenCalledTimes(1);
    const path = attested();
    expect(path.length).toBe(4);
    // the target is floored from a decimal, so it may sit one micro-dollar under
    expect(16_720_000n - path[path.length - 1] <= 1n).toBe(true);
    let cur = 7_316_909n;
    for (const step of path) {
      const delta = step > cur ? step - cur : cur - step;
      expect((delta * 10_000n) / cur <= 3000n).toBe(true);
      cur = step;
    }
    expect(built[built.length - 1].budget!).toBeLessThan(Number(chain.gasMist));
    expect(state.get('sui-nav-attest:pending-large-change')).toBeNull();
  });

  it('a different target restarts the count: one bad read cannot reprice the pool', async () => {
    await attestExternalNav('mainnet', NAV);
    await attestExternalNav('mainnet', NAV);
    const glitch = await attestExternalNav('mainnet', 60.0);
    expect(glitch.pushed).toBe(false);
    expect(glitch.error).toMatch(/1\/3/);
    const after = await attestExternalNav('mainnet', NAV);
    expect(after.error).toMatch(/1\/3/);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it('a normal-sized change is unaffected by a pending large one', async () => {
    await attestExternalNav('mainnet', NAV);
    const normal = await attestExternalNav('mainnet', 11.0);
    expect(normal.pushed).toBe(true);
    expect(attested().length).toBe(1);
  });

  it('a collapse to zero is refused instead of looping', async () => {
    const r = await attestExternalNav('mainnet', 3.0);
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/cannot be reached/);
  });
});

describe('who may attest', () => {
  it('does nothing when the cap is not held by the signer', async () => {
    chain.capOwner = '0x' + '9'.repeat(64);
    const r = await attestExternalNav('mainnet', 11.0);
    expect(r.pushed).toBe(false);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });
});
