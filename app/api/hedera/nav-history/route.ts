/**
 * Hedera pool NAV history — direct from chain, no DB.
 *
 * Reads Deposited + Withdrawn events on the SimpleUsdcVault from Hedera
 * Mirror Node (official indexer), reconstructs a share-price time series,
 * and returns the same shape the SUI chart consumer already knows.
 *
 * Data flow (no Aiven, no cron):
 *   Mirror Node /contracts/{addr}/results/logs
 *   → decode Deposited(amount, shares) / Withdrawn(shares, amount)
 *   → fold running totalAssets + totalShares
 *   → sharePrice at each event's timestamp
 *   → downsample to the requested bucket
 */

import { NextRequest, NextResponse } from 'next/server';
import { keccak256, toHex, hexToBigInt } from 'viem';
import { logger } from '@/lib/utils/logger';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

// ─── Event signatures ─────────────────────────────────────────────────────
// Precomputed once — keccak256 of the event signatures.
const TOPIC_DEPOSITED = keccak256(toHex('Deposited(address,uint256,uint256)'));
const TOPIC_WITHDRAWN = keccak256(toHex('Withdrawn(address,uint256,uint256)'));

// USDC has 6 decimals. Shares in SimpleUsdcVault are stored in the SAME
// unit as USDC (asset-scaled), because the contract's fold is
// `shares = amount * (totalShares + 1) / (before + 1)` which preserves
// asset decimals. So SHARES_DECIMALS = 6 too, not 18.
const USDC_DECIMALS = 6;
const SHARES_DECIMALS = 6;

interface Point {
  t: string;          // ISO timestamp
  sharePrice: number; // USDC / share (human)
  navUsd: number;     // pool USDC balance (human)
}

interface NavHistoryResponse {
  asOf: string;
  window: string;
  count: number;
  first?: Point;
  last?: Point;
  peak?: { t: string; sharePrice: number };
  points: Point[];
  source: 'mirror-node';
}

function mirrorTimestampToDate(ts: string): Date {
  const secs = parseInt(ts.split('.')[0], 10);
  return new Date(secs * 1000);
}

function humanFromDecimals(hex: string, decimals: number): number {
  const raw = hexToBigInt(hex as `0x${string}`);
  // Number() loses precision above 2^53 but that's fine for share-price
  // display (well below trillions).
  const denom = 10 ** decimals;
  return Number(raw) / denom;
}

/** Extract two 32-byte words from a log's `data` field. */
function twoWords(data: string): [string, string] {
  const stripped = data.replace(/^0x/, '');
  const w0 = '0x' + stripped.slice(0, 64);
  const w1 = '0x' + stripped.slice(64, 128);
  return [w0, w1];
}

export async function GET(request: NextRequest): Promise<NextResponse<NavHistoryResponse | { error: string }>> {
  const windowParam = (request.nextUrl.searchParams.get('window') ?? '30d') as '7d' | '30d' | '60d' | 'all';
  const bucketParam = request.nextUrl.searchParams.get('bucket') ?? 'hour';

  const pool = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool;
  if (!pool || pool === '0x0000000000000000000000000000000000000000') {
    return NextResponse.json({ error: 'pool not deployed' }, { status: 404 });
  }

  const base = 'https://testnet.mirrornode.hedera.com/api/v1';

  // Fetch ALL contract logs and filter server-side. Mirror Node's
  // `topic0=` query filter returns 0 results in practice even when the
  // topic hash matches what unfiltered results show — a known quirk.
  // Filtering in-code is O(n) but n is bounded by the pool's lifetime
  // event count, which is small for the demo.
  async function fetchAllLogs(): Promise<Array<{
    data: string; topics: string[]; timestamp: string; transaction_hash: string;
  }>> {
    const url = `${base}/contracts/${pool}/results/logs?order=asc&limit=100`;
    try {
      const r = await fetch(url, { next: { revalidate: 30 } });
      if (!r.ok) {
        logger.warn('[hedera-nav-history] mirror non-ok', { url, status: r.status });
        return [];
      }
      const j = (await r.json()) as { logs?: Array<{
        data: string; topics: string[]; timestamp: string; transaction_hash: string;
      }> };
      return j.logs ?? [];
    } catch (e) {
      logger.warn('[hedera-nav-history] mirror fetch failed', {
        url, error: e instanceof Error ? e.message : String(e),
      });
      return [];
    }
  }

  const allLogs = await fetchAllLogs();
  const depositLogs = allLogs.filter((l) => l.topics?.[0] === TOPIC_DEPOSITED);
  const withdrawLogs = allLogs.filter((l) => l.topics?.[0] === TOPIC_WITHDRAWN);

  interface Event {
    kind: 'deposit' | 'withdraw';
    ts: Date;
    amount: number; // USDC human
    shares: number; // shares human
  }

  const events: Event[] = [];
  for (const log of depositLogs) {
    const [amountHex, sharesHex] = twoWords(log.data);
    events.push({
      kind: 'deposit',
      ts: mirrorTimestampToDate(log.timestamp),
      amount: humanFromDecimals(amountHex, USDC_DECIMALS),
      shares: humanFromDecimals(sharesHex, SHARES_DECIMALS),
    });
  }
  for (const log of withdrawLogs) {
    // Withdrawn packs shares FIRST then amount.
    const [sharesHex, amountHex] = twoWords(log.data);
    events.push({
      kind: 'withdraw',
      ts: mirrorTimestampToDate(log.timestamp),
      amount: humanFromDecimals(amountHex, USDC_DECIMALS),
      shares: humanFromDecimals(sharesHex, SHARES_DECIMALS),
    });
  }
  events.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  // Fold running state. Uses virtual-offset share-price (matches on-chain).
  let totalAssets = 0;
  let totalShares = 0;
  const points: Point[] = [];
  for (const ev of events) {
    if (ev.kind === 'deposit') {
      totalAssets += ev.amount;
      totalShares += ev.shares;
    } else {
      totalAssets = Math.max(0, totalAssets - ev.amount);
      totalShares = Math.max(0, totalShares - ev.shares);
    }
    const sharePrice = totalShares > 0
      ? (totalAssets + 1e-6) / (totalShares + 1e-18)
      : 1;
    points.push({
      t: ev.ts.toISOString(),
      sharePrice: Number.isFinite(sharePrice) ? sharePrice : 1,
      navUsd: totalAssets,
    });
  }

  // Window filter (drop points before cutoff). "all" keeps everything.
  const now = Date.now();
  const cutoff = (() => {
    switch (windowParam) {
      case '7d':  return now - 7 * 24 * 3600e3;
      case '30d': return now - 30 * 24 * 3600e3;
      case '60d': return now - 60 * 24 * 3600e3;
      default:    return 0;
    }
  })();
  const filtered = points.filter((p) => new Date(p.t).getTime() >= cutoff);

  const peak = filtered.reduce<{ t: string; sharePrice: number } | undefined>(
    (acc, p) => (acc && acc.sharePrice >= p.sharePrice ? acc : { t: p.t, sharePrice: p.sharePrice }),
    undefined,
  );

  const body: NavHistoryResponse = {
    asOf: new Date().toISOString(),
    window: windowParam,
    count: filtered.length,
    first: filtered[0],
    last: filtered[filtered.length - 1],
    peak,
    points: filtered,
    source: 'mirror-node',
  };
  // Deliberately not tagging bucketParam in the response — Mirror gives us
  // exactly one point per event, no need to server-side downsample for a
  // sub-100-event pool. If deposit volume grows, add bucketing here.
  void bucketParam;

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=86400' },
  });
}
