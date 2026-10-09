/**
 * The perp venue client: what gets signed, what goes on the wire, and that a
 * missing money field is an error rather than a zero.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as crypto from 'crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  sortKeysDeep,
  signingMessage,
  signerFromSecret,
  signedBody,
  sizeForNotional,
  clientOrderId,
  perpNetwork,
  perpVenueConfigured,
  getAccount,
  getPositions,
  getMarket,
  submitMarketOrder,
  __resetPerpSignerForTests,
} from '@/lib/services/solana/perp-venue';
import { base58Decode, base58Encode } from '@/lib/services/solana/cluster';

const ENV = ['SOLANA_PERPS_NETWORK', 'SOLANA_PERPS_ACCOUNT', 'SOLANA_PERPS_SIGNER_SECRET'] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = global.fetch;
const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];
const answer = (payload: unknown, ok = true, status = 200) => {
  global.fetch = jest.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : null });
    return { ok, status, json: async () => payload };
  }) as unknown as typeof fetch;
};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  calls.length = 0;
  __resetPerpSignerForTests();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  global.fetch = realFetch;
});

describe('signing', () => {
  it('sorts keys at every level and serialises compactly', () => {
    expect(JSON.stringify(sortKeysDeep({ b: 1, a: { d: [{ z: 1, y: 2 }], c: true } }))).toBe('{"a":{"c":true,"d":[{"y":2,"z":1}]},"b":1}');
    expect(signingMessage('create_market_order', { symbol: 'BTC', amount: '0.1' }, 1716200000000, 30000)).toBe(
      '{"data":{"amount":"0.1","symbol":"BTC"},"expiry_window":30000,"timestamp":1716200000000,"type":"create_market_order"}',
    );
  });

  it('derives the public key and signs the message so the key verifies it', () => {
    const kp = Keypair.generate();
    for (const secret of [JSON.stringify([...kp.secretKey]), base58Encode(kp.secretKey)]) {
      const signer = signerFromSecret(secret);
      expect(signer.publicKey).toBe(kp.publicKey.toBase58());
      const message = signingMessage('create_market_order', { symbol: 'ETH' }, 1, 30000);
      const spki = crypto.createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(new PublicKey(signer.publicKey).toBytes())]),
        format: 'der',
        type: 'spki',
      });
      expect(crypto.verify(null, Buffer.from(message), spki, Buffer.from(base58Decode(signer.sign(message))))).toBe(true);
    }
  });

  it('an agent key names itself; the account signing for itself does not', () => {
    const account = Keypair.generate();
    const agent = Keypair.generate();
    const own = signedBody('t', { symbol: 'BTC' }, { account: account.publicKey.toBase58(), signer: signerFromSecret(JSON.stringify([...account.secretKey])), now: 5 });
    expect(own).toMatchObject({ account: account.publicKey.toBase58(), agent_wallet: null, timestamp: 5, expiry_window: 30000, symbol: 'BTC' });
    const viaAgent = signedBody('t', { symbol: 'BTC' }, { account: account.publicKey.toBase58(), signer: signerFromSecret(JSON.stringify([...agent.secretKey])), now: 5 });
    expect(viaAgent.agent_wallet).toBe(agent.publicKey.toBase58());
    expect(viaAgent.account).toBe(account.publicKey.toBase58());
  });
});

describe('order sizing and ids', () => {
  it('rounds DOWN to the lot and never returns float noise', () => {
    expect(sizeForNotional(100, 82514, 0.00001)).toBe(0.00121);
    expect(sizeForNotional(100, 109.59, 0.01)).toBe(0.91);
    expect(sizeForNotional(50, 2484.3, 0.0001)).toBe(0.0201);
    expect(sizeForNotional(0, 100, 0.01)).toBe(0);
    expect(sizeForNotional(100, 0, 0.01)).toBe(0);
  });

  it('the request id is a UUID and the same for the same order', () => {
    const id = clientOrderId('solsleeve_BTC_1791558450');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(clientOrderId('solsleeve_BTC_1791558450')).toBe(id);
    expect(clientOrderId('solsleeve_BTC_1791558451')).not.toBe(id);
  });
});

describe('configuration', () => {
  it('is the test network unless mainnet is named, and unconfigured without both values', () => {
    expect(perpNetwork()).toBe('testnet');
    process.env.SOLANA_PERPS_NETWORK = 'Mainnet';
    expect(perpNetwork()).toBe('mainnet');
    expect(perpVenueConfigured()).toBe(false);
    process.env.SOLANA_PERPS_ACCOUNT = 'Acct';
    expect(perpVenueConfigured()).toBe(false);
    process.env.SOLANA_PERPS_SIGNER_SECRET = '[1]';
    expect(perpVenueConfigured()).toBe(true);
  });
});

describe('wire', () => {
  it('reads go to the test host by default and parse money fields', async () => {
    answer({ success: true, data: { balance: '2000.5', account_equity: '2150.25', available_to_spend: '1800.75' } });
    expect(await getAccount('Acct')).toEqual({ balanceUsd: 2000.5, equityUsd: 2150.25, availableToSpendUsd: 1800.75 });
    expect(calls[0].url).toBe('https://test-api.pacifica.fi/api/v1/account?account=Acct');
  });

  it('a missing money field is an error, never a zero', async () => {
    answer({ success: true, data: { balance: '10', available_to_spend: '10' } });
    await expect(getAccount('Acct')).rejects.toThrow(/account_equity is not a number/);
    answer({ success: true, data: [{ symbol: 'BTC', side: 'bid', entry_price: '82000' }] });
    await expect(getPositions('Acct')).rejects.toThrow(/amount is not a number/);
  });

  it('a refusal from the venue throws with its reason', async () => {
    answer({ success: false, data: null, error: 'Account not found', code: 404 }, false, 404);
    await expect(getAccount('Acct')).rejects.toThrow(/Account not found/);
  });

  it('bid is long, ask is short; an unknown market is an error', async () => {
    answer({ success: true, data: [{ symbol: 'ETH', side: 'ask', amount: '0.5', entry_price: '2500' }] });
    expect(await getPositions('Acct')).toEqual([{ symbol: 'ETH', side: 'SHORT', size: 0.5, entryPrice: 2500 }]);
    answer({ success: true, data: [{ symbol: 'ETH', lot_size: '0.0001', min_order_size: '10', max_leverage: 50 }] });
    await expect(getMarket('DOGE')).rejects.toThrow(/no DOGE market/);
  });

  it('a market order is signed, carries the fields unwrapped, and returns the venue order id', async () => {
    const account = Keypair.generate();
    process.env.SOLANA_PERPS_ACCOUNT = account.publicKey.toBase58();
    process.env.SOLANA_PERPS_SIGNER_SECRET = JSON.stringify([...account.secretKey]);
    answer({ order_id: 12345 });
    expect(await submitMarketOrder({ symbol: 'BTC', side: 'SHORT', size: 0.00121, reduceOnly: true, orderId: 'o1' })).toEqual({ orderId: 12345 });
    const sent = calls[0];
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://test-api.pacifica.fi/api/v1/orders/create_market');
    expect(sent.body).toMatchObject({ symbol: 'BTC', amount: '0.00121', side: 'ask', reduce_only: true, slippage_percent: '0.5', account: account.publicKey.toBase58(), agent_wallet: null });
    expect(typeof sent.body!.signature).toBe('string');
    expect(sent.body).not.toHaveProperty('data');
  });
});
