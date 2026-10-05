import { NextRequest, NextResponse } from 'next/server';
import { readLimiter } from '@/lib/security/rate-limiter';

export const runtime = 'nodejs';
export const maxDuration = 15;

/**
 * Server-side RPC proxy to avoid CORS issues with third-party RPC providers.
 * Browser requests go to /api/rpc/{chain}, and the server forwards them upstream.
 * Includes multiple fallback providers and timeouts for reliability.
 */

const UPSTREAM_RPC_URLS: Record<string, string[]> = {
  sepolia: [
    'https://ethereum-sepolia-rpc.publicnode.com',
    'https://sepolia.drpc.org',
  ],
  ethereum: [
    'https://eth.drpc.org',
    'https://ethereum-rpc.publicnode.com',
    'https://rpc.ankr.com/eth',
  ],
  hedera: [
    'https://testnet.hashio.io/api',
    'https://mainnet.hashio.io/api',
  ],
  plasma: [
    'https://plasma.drpc.org',
  ],
  // SUI mainnet — matches server-side failover in sui-failover-transport.ts.
  // fullnode.mainnet.sui.io killed JSON-RPC 2026-07 AND has no browser CORS.
  sui: [
    'https://sui-mainnet-endpoint.blockvision.org',
    'https://sui-rpc.publicnode.com',
    'https://sui-mainnet.nodeinfra.com',
  ],
  'sui-testnet': [
    'https://sui-testnet-endpoint.blockvision.org',
    'https://sui-testnet.publicnode.com',
  ],
};

// Allowed chains to prevent SSRF via arbitrary chain names
const ALLOWED_CHAINS = new Set(Object.keys(UPSTREAM_RPC_URLS));

const RPC_TIMEOUT_MS = 8000;

// Blocked JSON-RPC methods that could be dangerous when proxied
const BLOCKED_METHOD_PREFIXES = ['debug_', 'miner_', 'admin_', 'personal_', 'txpool_'];
const BLOCKED_METHODS = new Set(['eth_sendTransaction', 'eth_sign', 'eth_signTransaction']);

async function fetchWithTimeout(url: string, body: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chain: string }> }
) {
  // Without a limit, this proxy becomes free RPC — burns upstream
  // provider allowances (drpc.org, Ankr, publicnode) for arbitrary
  // clients. readLimiter = 120/min/IP matches normal wallet activity.
  const limited = readLimiter.check(request);
  if (limited) return limited;

  const { chain } = await params;

  if (!ALLOWED_CHAINS.has(chain)) {
    return NextResponse.json({ error: 'Unknown chain' }, { status: 404 });
  }

  const upstreams = UPSTREAM_RPC_URLS[chain];
  const body = await request.text();

  // Validate JSON-RPC request and block dangerous methods
  try {
    const parsed = JSON.parse(body);
    const method = parsed?.method;
    if (typeof method === 'string') {
      if (BLOCKED_METHODS.has(method) || BLOCKED_METHOD_PREFIXES.some(p => method.startsWith(p))) {
        return NextResponse.json({ error: 'Method not allowed' }, { status: 403 });
      }
    }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  for (const upstream of upstreams) {
    try {
      const response = await fetchWithTimeout(upstream, body, RPC_TIMEOUT_MS);

      if (!response.ok) continue;

      const data = await response.text();
      return new NextResponse(data, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      // Timeout or network error — try next provider
      continue;
    }
  }

  return NextResponse.json(
    { error: 'RPC request failed' },
    { status: 502 }
  );
}
