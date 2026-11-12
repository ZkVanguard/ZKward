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
import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  suiRpcCircuitBreaker,
  suiCachedFetch,
  invalidateSuiCache,
  suiFetchWithTimeout,
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

describe('suiFetchWithTimeout: answered by the gRPC bridge', () => {
  beforeEach(() => suiRpcCircuitBreaker.recordSuccess());

  it('a request the bridge cannot answer is a 502 with a JSON-RPC error, and counts against the breaker', async () => {
    const res = await suiFetchWithTimeout('mainnet', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'suix_noSuchMethod', params: [] }) });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ id: 3, error: { message: expect.stringMatching(/not available/) } });
    expect(suiRpcCircuitBreaker.failures).toBe(1);
  });

  it('a body that is not JSON is a 400', async () => {
    expect((await suiFetchWithTimeout('mainnet', { method: 'POST', body: 'nope' })).status).toBe(400);
  });
});
