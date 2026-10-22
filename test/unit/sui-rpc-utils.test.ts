/**
 * Contract lock for the SUI RPC infrastructure — circuit breaker + cache.
 *
 * Capital-adjacent: when the SUI RPC is down or flaking, EVERY read
 * (NAV, pool state, member positions) fails. The circuit breaker is
 * the difference between "one bad RPC call" and "cascade of thrown
 * errors on every downstream cron tick." The dedup cache is the
 * difference between "100 dashboard users spike our RPC quota" and
 * "1 call serves them all."
 *
 * These state transitions have burned us before (a broken retry loop
 * exhausted the SUI RPC quota during the 2026-05-30 incident). Anchor
 * the exact rules here.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  suiRpcCircuitBreaker,
  suiCachedFetch,
  invalidateSuiCache,
  suiFetchWithTimeout,
  suiRpcProviders,
  __resetSuiRpcOrderForTests,
} from '@/lib/services/sui/sui-rpc-utils';

describe('suiRpcCircuitBreaker state machine', () => {
  beforeEach(() => {
    // Reset the singleton before every test — it lives at module scope
    suiRpcCircuitBreaker.recordSuccess();
  });

  it('starts in "closed" state — canAttempt=true', () => {
    expect(suiRpcCircuitBreaker.state).toBe('closed');
    expect(suiRpcCircuitBreaker.canAttempt()).toBe(true);
  });

  it('opens after threshold consecutive failures (5)', () => {
    for (let i = 0; i < 5; i++) suiRpcCircuitBreaker.recordFailure();
    expect(suiRpcCircuitBreaker.state).toBe('open');
    expect(suiRpcCircuitBreaker.canAttempt()).toBe(false);
  });

  it('single success in closed state does not open it (regression: no false trip)', () => {
    suiRpcCircuitBreaker.recordFailure();
    suiRpcCircuitBreaker.recordSuccess();
    expect(suiRpcCircuitBreaker.state).toBe('closed');
    expect(suiRpcCircuitBreaker.failures).toBe(0);
  });

  it('recordSuccess resets failure counter (any success clears history)', () => {
    for (let i = 0; i < 3; i++) suiRpcCircuitBreaker.recordFailure();
    expect(suiRpcCircuitBreaker.failures).toBe(3);
    suiRpcCircuitBreaker.recordSuccess();
    expect(suiRpcCircuitBreaker.failures).toBe(0);
    expect(suiRpcCircuitBreaker.state).toBe('closed');
  });

  it('open state transitions to half-open after resetTimeout', () => {
    for (let i = 0; i < 5; i++) suiRpcCircuitBreaker.recordFailure();
    expect(suiRpcCircuitBreaker.state).toBe('open');
    // Simulate resetTimeout elapsed by rewinding lastFailure
    suiRpcCircuitBreaker.lastFailure = Date.now() - suiRpcCircuitBreaker.resetTimeout - 1_000;
    expect(suiRpcCircuitBreaker.canAttempt()).toBe(true);
    expect(suiRpcCircuitBreaker.state).toBe('half-open');
  });

  it('half-open allows the probe attempt', () => {
    suiRpcCircuitBreaker.state = 'half-open';
    expect(suiRpcCircuitBreaker.canAttempt()).toBe(true);
  });

  it('half-open + success → closed (recovery path)', () => {
    suiRpcCircuitBreaker.state = 'half-open';
    suiRpcCircuitBreaker.failures = 5;
    suiRpcCircuitBreaker.recordSuccess();
    expect(suiRpcCircuitBreaker.state).toBe('closed');
    expect(suiRpcCircuitBreaker.failures).toBe(0);
  });
});

describe('suiCachedFetch dedup + caching', () => {
  beforeEach(() => {
    invalidateSuiCache();
  });

  it('caches results within TTL window', async () => {
    let callCount = 0;
    const fetcher = async () => { callCount++; return { value: 42 }; };
    const key = 'test-cache-hit';

    const first = await suiCachedFetch(key, fetcher, 5000);
    const second = await suiCachedFetch(key, fetcher, 5000);

    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
    expect(callCount).toBe(1); // only fetched once
  });

  it('dedupes concurrent requests to the same key', async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return { value: 'shared' };
    };
    const key = 'test-dedup';

    // 5 concurrent callers should trigger only 1 fetch
    const results = await Promise.all([
      suiCachedFetch(key, fetcher, 5000),
      suiCachedFetch(key, fetcher, 5000),
      suiCachedFetch(key, fetcher, 5000),
      suiCachedFetch(key, fetcher, 5000),
      suiCachedFetch(key, fetcher, 5000),
    ]);
    expect(results.every((r) => (r as { value: string }).value === 'shared')).toBe(true);
    expect(callCount).toBe(1);
  });

  it('refetches after TTL expires', async () => {
    let callCount = 0;
    const fetcher = async () => { callCount++; return { n: callCount }; };
    const key = 'test-ttl-expiry';

    await suiCachedFetch(key, fetcher, 10);
    await new Promise((r) => setTimeout(r, 20)); // wait past TTL
    await suiCachedFetch(key, fetcher, 10);

    expect(callCount).toBe(2);
  });

  it('separate keys are cached separately', async () => {
    let call = 0;
    const fetcher = async () => { call++; return { call }; };
    await suiCachedFetch('key-a', fetcher, 5000);
    await suiCachedFetch('key-b', fetcher, 5000);
    expect(call).toBe(2);
  });

  it('invalidateSuiCache() clears every entry', async () => {
    let count = 0;
    const fetcher = async () => { count++; return count; };
    await suiCachedFetch('inv-1', fetcher, 5000);
    await suiCachedFetch('inv-2', fetcher, 5000);
    invalidateSuiCache();
    await suiCachedFetch('inv-1', fetcher, 5000); // should refetch
    await suiCachedFetch('inv-2', fetcher, 5000); // should refetch
    expect(count).toBe(4);
  });
});

describe('suiFetchWithTimeout: one provider list, rotated', () => {
  const origFetch = globalThis.fetch;
  const origEnv = process.env;
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const call = () => suiFetchWithTimeout('mainnet', { method: 'POST', body: '{}' }, 1000);

  beforeEach(() => {
    process.env = { ...origEnv, SUI_MAINNET_RPC_LIST: 'https://a.test,https://b.test' };
    __resetSuiRpcOrderForTests();
    suiRpcCircuitBreaker.recordSuccess();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    process.env = origEnv;
  });

  it('moves past a provider that answers 404, and starts at the working one next time', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      return url === 'https://a.test' ? new Response('gone', { status: 404 }) : ok({ result: 1 });
    }) as typeof fetch;
    expect(await (await call()).json()).toEqual({ result: 1 });
    await call();
    expect(seen).toEqual(['https://a.test', 'https://b.test', 'https://b.test']);
  });

  it('a 200 that only says JSON-RPC is deprecated counts as a dead provider', async () => {
    globalThis.fetch = (async (url: string) =>
      url === 'https://a.test'
        ? ok({ jsonrpc: '2.0', error: { code: -32000, message: 'Sui JSON-RPC endpoint has been deprecated.' } })
        : ok({ result: 2 })) as typeof fetch;
    expect(await (await call()).json()).toEqual({ result: 2 });
  });

  it('a request error (HTTP 200 with a JSON-RPC error) is returned, not rotated past', async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(url);
      return ok({ jsonrpc: '2.0', error: { code: -32602, message: 'Invalid params' } });
    }) as typeof fetch;
    expect((await (await call()).json()).error.code).toBe(-32602);
    expect(seen).toEqual(['https://a.test']);
  });

  it('the mainnet defaults hold no provider that has dropped JSON-RPC', () => {
    process.env = { ...origEnv, SUI_MAINNET_RPC_LIST: '', SUI_MAINNET_RPC: '' };
    const list = suiRpcProviders('mainnet');
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const dead of ['blockvision', 'nodeinfra', 'fullnode.mainnet.sui.io']) expect(list.join(',')).not.toContain(dead);
  });
});
