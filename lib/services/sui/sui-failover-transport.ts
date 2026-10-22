/**
 * Multi-provider SUI JSON-RPC failover.
 *
 * WHY this exists:
 *   Sui's official public fullnode `fullnode.mainnet.sui.io` fully
 *   deprecated JSON-RPC in 2026-07. The pool went dark until an operator
 *   manually swapped the env var. That failure had no self-healing — every
 *   cron kept hitting the dead URL, dashboard sat at $0, and no Discord
 *   alert fired because per-call errors were swallowed as generic "RPC
 *   failed" and the health endpoint only knew about ONE endpoint.
 *
 *   This transport implements `SuiTransport` (the pluggable interface
 *   the SuiClient constructor takes) with:
 *     • ordered provider list (env-overridable via SUI_MAINNET_RPC_LIST)
 *     • sticky current provider (per process)
 *     • rotate on hard failure (network error, non-2xx, JSON-RPC error
 *       code -32601 "method not found" / -32603 "internal", 429/5xx)
 *     • loud one-shot Discord ERROR on rotation
 *     • module-scope stats surfaced by `getFailoverStats()` for health
 *
 *   Kept in its own file (not sui-rpc-utils.ts) so the utils file stays
 *   small and stable — sui-rpc-utils.ts is imported by many services;
 *   this transport is imported by the ~5 hot-path call sites via
 *   `createFailoverSuiClient()`.
 */
import {
  SuiClient,
  type SuiTransport,
  type SuiTransportRequestOptions,
  type SuiTransportSubscribeOptions,
} from '@mysten/sui/client';
import { logger } from '@/lib/utils/logger';
import { notifyDiscord } from '@/lib/utils/discord-notify';

import { __resetSuiRpcOrderForTests, markSuiRpcWorking, suiRpcOrder } from '@/lib/services/sui/sui-rpc-utils';

// Alert dedupe — one Discord message per (fromUrl → toUrl) rotation per
// process lifetime. Cold starts reset. Good enough — Vercel Lambdas cycle
// within an hour, so a persistently-dead vendor pages hourly, not per-min.
const rotationAlertsSent = new Set<string>();

interface FailoverStats {
  activeUrl: string;
  providerHistory: string[]; // URLs tried, in order, most recent last
  rotationCount: number;
  lastRotationAt: number | null;
  lastRotationFromUrl: string | null;
  lastRotationReason: string | null;
}

const stats: FailoverStats = {
  activeUrl: '',
  providerHistory: [],
  rotationCount: 0,
  lastRotationAt: null,
  lastRotationFromUrl: null,
  lastRotationReason: null,
};

export function getFailoverStats(): Readonly<FailoverStats> {
  return { ...stats };
}

const HARD_FAIL_TIMEOUT_MS = 10_000;

/** Errors that mean the provider itself is broken, not the request. */
function isProviderDead(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    // postJsonRpc throws "HTTP <status>" for any non-2xx: a request error comes
    // back as 200 with a JSON-RPC error, so a 404 (JSON-RPC dropped), 429 or
    // 5xx is the provider's fault. A first provider's 404 was not rotated on
    // and took every server-side read down on 2026-10-22.
    /^HTTP \d{3}\b/.test(msg) ||
    msg.includes('has been deprecated') ||        // Sui public fullnode 2026-07
    msg.includes('Method not found') ||            // -32601 for standard methods
    (err instanceof Error && err.name === 'AbortError') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('fetch failed') ||
    msg.includes('AbortError')
  );
}

async function rotateAndAlert(
  network: 'mainnet' | 'testnet',
  fromUrl: string,
  toUrl: string,
  reason: string,
): Promise<void> {
  stats.rotationCount++;
  stats.lastRotationAt = Date.now();
  stats.lastRotationFromUrl = fromUrl;
  stats.lastRotationReason = reason;

  const dedupeKey = `${fromUrl}→${toUrl}`;
  if (rotationAlertsSent.has(dedupeKey)) return;
  rotationAlertsSent.add(dedupeKey);

  logger.error('[SUI-RPC-FAILOVER] Rotating provider', {
    network,
    from: fromUrl,
    to: toUrl,
    reason: reason.slice(0, 200),
  });
  try {
    await notifyDiscord(
      `SUI RPC provider **${new URL(fromUrl).host}** failed → switched to **${new URL(toUrl).host}**. Reason: ${reason.slice(0, 200)}`,
      'ERROR',
      { network, from: fromUrl, to: toUrl },
    );
  } catch {
    // notifyDiscord no-ops if webhook unset; don't wedge the transport
  }
}

/**
 * SuiTransport implementation that rotates through a list of Sui RPC
 * providers. Sticky by default — once a provider works, it stays
 * pinned. Rotates immediately on any hard failure.
 */
class FailoverSuiTransport implements SuiTransport {
  private network: 'mainnet' | 'testnet';

  constructor(network: 'mainnet' | 'testnet') {
    this.network = network;
    const first = suiRpcOrder(network)[0];
    if (!first) {
      throw new Error(`No SUI RPC providers configured for ${network}`);
    }
    stats.activeUrl = first;
    if (stats.providerHistory[stats.providerHistory.length - 1] !== first) {
      stats.providerHistory.push(first);
    }
  }

  private async postJsonRpc(url: string, body: string, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HARD_FAIL_TIMEOUT_MS);
    // Compose caller's signal with our timeout signal.
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const json = await res.json() as { result?: unknown; error?: { code: number; message: string } };
      if (json.error) {
        const err = new Error(json.error.message) as Error & { code: number };
        err.code = json.error.code;
        throw err;
      }
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async request<T = unknown>(input: SuiTransportRequestOptions): Promise<T> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: input.method,
      params: input.params,
    });

    // Try each provider once, starting from the last one that answered in
    // this process (shared with the raw JSON-RPC helper).
    const order = suiRpcOrder(this.network);
    let lastErr: unknown = null;
    for (let idx = 0; idx < order.length; idx++) {
      const url = order[idx];
      try {
        const result = await this.postJsonRpc(url, body, input.signal);
        markSuiRpcWorking(this.network, url);
        // Success — report it if we rotated.
        if (idx !== 0) {
          const fromUrl = order[0];
          stats.activeUrl = url;
          stats.providerHistory.push(url);
          if (stats.providerHistory.length > 20) stats.providerHistory.shift();
          const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
          void rotateAndAlert(this.network, fromUrl, url, reason);
        }
        return result as T;
      } catch (err) {
        lastErr = err;
        if (!isProviderDead(err)) {
          // Not a provider fault (e.g. real -32602 invalid params) — surface
          // to the caller instead of rotating.
          throw err;
        }
        // Provider looks dead — continue to next.
      }
    }
    // All providers failed. Throw the last error so the caller can decide.
    throw lastErr ?? new Error('All SUI RPC providers failed');
  }

  async subscribe<T = unknown>(_input: SuiTransportSubscribeOptions<T>): Promise<() => Promise<boolean>> {
    // We don't use websocket subscriptions anywhere in the codebase.
    // If we ever do, they should target a single stable paid provider,
    // not failover — websockets don't rotate cleanly.
    throw new Error('FailoverSuiTransport does not support subscribe');
  }
}

/**
 * Preferred SuiClient constructor for every service in this repo. Uses
 * the failover transport so a single vendor death auto-degrades to the
 * next healthy provider without operator intervention.
 */
export function createFailoverSuiClient(network: 'mainnet' | 'testnet' = 'mainnet'): SuiClient {
  const transport = new FailoverSuiTransport(network);
  return new SuiClient({ transport });
}

/** Test hook — reset dedupe + stats. Not called at runtime. */
export function __resetFailoverStateForTests(): void {
  rotationAlertsSent.clear();
  __resetSuiRpcOrderForTests();
  stats.activeUrl = '';
  stats.providerHistory = [];
  stats.rotationCount = 0;
  stats.lastRotationAt = null;
  stats.lastRotationFromUrl = null;
  stats.lastRotationReason = null;
}
