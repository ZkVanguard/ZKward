/**
 * Members see when the pool contract is refusing deposits and withdrawals,
 * from the same chain read the health endpoint uses. These tests hold that
 * read to the contract's own rule, keep a failed read from passing as "open",
 * and check every locale can say it.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const fields: Record<string, unknown> = {};
let fail = false;
const getDynamicFieldObject = jest.fn(async ({ name }: { name: { value: number[] } }) => {
  if (fail) return { error: { code: 'rpc-unavailable' } };
  const key = Buffer.from(name.value).toString();
  return key in fields ? { data: { content: { fields: { value: fields[key] } } } } : { error: { code: 'dynamicFieldNotFound' } };
});
const getObject = jest.fn(async () => ({ data: { content: { fields: { treasury: '0xtreasury' } } } }));
jest.mock('@/lib/types/sui-pool-types', () => ({ SUI_USDC_POOL_CONFIG: { mainnet: { poolStateId: '0xpool' }, testnet: { poolStateId: '' } } }));
jest.mock('@/lib/services/sui/sui-failover-transport', () => ({
  createFailoverSuiClient: () => ({ getDynamicFieldObject, getObject }),
}));

import { readPoolAttestation } from '@/lib/services/sui/attestation-read';
import { ATTESTATION_MAX_AGE_MIN } from '@/lib/services/sui/attestation-status';

const NOW = Date.parse('2026-10-16T00:00:00Z');
const MIN = 60_000;

beforeEach(() => {
  fail = false;
  for (const k of Object.keys(fields)) delete fields[k];
  jest.clearAllMocks();
});

describe('readPoolAttestation', () => {
  it('open while the attestation is younger than the contract limit', async () => {
    fields.external_nav_required = true;
    fields.external_nav_ts_ms = String(NOW - 30 * MIN);
    const a = await readPoolAttestation('mainnet', NOW);
    expect(a).toMatchObject({ blocked: false, status: 'ok', treasury: '0xtreasury' });
    expect(a?.ageMin).toBeCloseTo(30, 6);
  });

  it('blocked once the attestation is older than the limit, as the contract decides', async () => {
    fields.external_nav_required = true;
    fields.external_nav_ts_ms = String(NOW - (ATTESTATION_MAX_AGE_MIN + 1) * MIN);
    expect(await readPoolAttestation('mainnet', NOW)).toMatchObject({ blocked: true, status: 'down' });
  });

  it('blocked when strict mode is on and the pool was never attested', async () => {
    fields.external_nav_required = true;
    expect(await readPoolAttestation('mainnet', NOW)).toMatchObject({ blocked: true, ageMin: undefined });
  });

  it('open when the contract does not require an attestation', async () => {
    fields.external_nav_ts_ms = String(NOW - 10_000 * MIN);
    expect(await readPoolAttestation('mainnet', NOW)).toMatchObject({ blocked: false });
  });

  it('an unreadable chain throws: unknown must not read as open', async () => {
    fail = true;
    await expect(readPoolAttestation('mainnet', NOW)).rejects.toThrow('rpc-unavailable');
  });
});

describe('where it is used', () => {
  const root = path.resolve(__dirname, '../..');
  const src = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('the health endpoint and the pool route both read through it', () => {
    expect(src('app/api/health/production/route.ts')).toContain('readPoolAttestation(network)');
    const route = src('app/api/sui/community-pool/route.ts');
    expect(route).toContain("action === 'availability'");
    expect(route).toContain('readPoolAttestation(network)');
    // a failed read is an error, never "open"
    expect(route).toMatch(/Could not read whether the pool is open[\s\S]{0,80}status: 502/);
  });

  it('the availability answer stays out of the long-lived shared cache', () => {
    const route = src('app/api/sui/community-pool/route.ts');
    const eligible = route.slice(route.indexOf('eligible:'));
    expect(eligible).not.toContain("'availability'");
    expect(route).toContain("'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60'");
  });

  it('every locale has the notice', () => {
    const locales = fs.readdirSync(path.join(root, 'messages')).filter((f) => f.endsWith('.json'));
    expect(locales.length).toBeGreaterThanOrEqual(13);
    for (const f of locales) {
      const ps = JSON.parse(fs.readFileSync(path.join(root, 'messages', f), 'utf8')).dashboard.poolStatus;
      expect({ locale: f, ok: !!ps?.pausedTitle && !!ps?.pausedBodyNoAge && String(ps?.pausedBody).includes('{hours}') }).toEqual({ locale: f, ok: true });
    }
  });
});
