/**
 * Proves the failover transport actually rotates on hard failure and
 * stays sticky on success. Mocks `fetch` so no live RPC is hit.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Isolate module-scope stats between tests.
let __resetFailoverStateForTests: () => void;
let createFailoverSuiClient: (network: 'mainnet' | 'testnet') => unknown;
let getFailoverStats: () => Readonly<{
  activeUrl: string;
  providerHistory: string[];
  rotationCount: number;
  lastRotationAt: number | null;
  lastRotationFromUrl: string | null;
  lastRotationReason: string | null;
}>;

const origFetch = globalThis.fetch;
const origEnv = process.env;

describe('FailoverJsonRpcTransport', () => {
  beforeEach(async () => {
    process.env = {
      ...origEnv,
      SUI_MAINNET_RPC_LIST: 'https://provider-a.test,https://provider-b.test,https://provider-c.test',
      DISCORD_WEBHOOK_URL: '', // silence notifyDiscord
    };
    // Fresh import each test — otherwise the module-scoped stats leak.
    delete require.cache[require.resolve('@/lib/services/sui/sui-failover-transport')];
    const mod = await import('@/lib/services/sui/sui-failover-transport');
    __resetFailoverStateForTests = mod.__resetFailoverStateForTests;
    createFailoverSuiClient = mod.createFailoverSuiClient;
    getFailoverStats = mod.getFailoverStats;
    __resetFailoverStateForTests();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    process.env = origEnv;
  });

  it('stays on primary when it succeeds', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createFailoverSuiClient('mainnet') as { getObject: (a: unknown) => Promise<unknown> };
    await client.getObject({ id: '0x0', options: {} });

    expect(seenUrls).toEqual(['https://provider-a.test']);
    expect(getFailoverStats().rotationCount).toBe(0);
    expect(getFailoverStats().activeUrl).toBe('https://provider-a.test');
  });

  it('rotates when primary returns 429 rate-limit', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      if (url === 'https://provider-a.test') {
        return new Response('Too Many Requests', { status: 429, statusText: 'Too Many Requests' });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createFailoverSuiClient('mainnet') as { getObject: (a: unknown) => Promise<unknown> };
    await client.getObject({ id: '0x0', options: {} });

    expect(seenUrls).toEqual([
      'https://provider-a.test',
      'https://provider-b.test',
    ]);
    expect(getFailoverStats().rotationCount).toBe(1);
    expect(getFailoverStats().activeUrl).toBe('https://provider-b.test');
    expect(getFailoverStats().lastRotationFromUrl).toBe('https://provider-a.test');
  });

  it('rotates on JSON-RPC deprecated-method error', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === 'https://provider-a.test') {
        return new Response(JSON.stringify({
          jsonrpc: '2.0', id: 1,
          error: { code: -32601, message: 'Method not found. JSON-RPC on public fullnodes has been deprecated.' },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const client = createFailoverSuiClient('mainnet') as { getObject: (a: unknown) => Promise<unknown> };
    await client.getObject({ id: '0x0', options: {} });

    expect(getFailoverStats().rotationCount).toBe(1);
    expect(getFailoverStats().activeUrl).toBe('https://provider-b.test');
  });

  it('rotates on HTTP 404, a provider that has dropped JSON-RPC (2026-10-22)', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url === 'https://provider-a.test') {
        return new Response('{"error":{"code":-32601,"message":"Sui JSON-RPC has been deprecated."}}', { status: 404, statusText: 'Not Found' });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { status: 200 });
    }) as typeof fetch;

    const client = createFailoverSuiClient('mainnet') as { getObject: (a: unknown) => Promise<unknown> };
    await client.getObject({ id: '0x0', options: {} });

    expect(getFailoverStats().activeUrl).toBe('https://provider-b.test');
  });

  it('a new client starts at the provider that last answered, not the dead first one', async () => {
    const seenUrls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seenUrls.push(url);
      if (url === 'https://provider-a.test') return new Response('gone', { status: 404, statusText: 'Not Found' });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), { status: 200 });
    }) as typeof fetch;

    type C = { getObject: (a: unknown) => Promise<unknown> };
    await (createFailoverSuiClient('mainnet') as C).getObject({ id: '0x0', options: {} });
    await (createFailoverSuiClient('mainnet') as C).getObject({ id: '0x0', options: {} });

    expect(seenUrls).toEqual(['https://provider-a.test', 'https://provider-b.test', 'https://provider-b.test']);
  });

  it('rotates through all providers and rethrows when everyone is dead', async () => {
    globalThis.fetch = (async (_url: string) => {
      return new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' });
    }) as typeof fetch;

    const client = createFailoverSuiClient('mainnet') as { getObject: (a: unknown) => Promise<unknown> };
    await expect(client.getObject({ id: '0x0', options: {} })).rejects.toThrow(/HTTP 502/);
  });

  it('does NOT rotate on real request errors (e.g. invalid params)', async () => {
    globalThis.fetch = (async (_url: string) => {
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 1,
        error: { code: -32602, message: 'Invalid params' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const client = createFailoverSuiClient('mainnet') as { getObject: (a: unknown) => Promise<unknown> };
    await expect(client.getObject({ id: '0x0', options: {} })).rejects.toThrow(/Invalid params/);
    expect(getFailoverStats().rotationCount).toBe(0);
  });
});
