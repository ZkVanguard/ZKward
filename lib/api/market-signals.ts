/**
 * Browser-side readers for market signals. The dashboard used to import the
 * signal services themselves, which put that code in every visitor's bundle
 * and ran the upstream calls from the browser. It reads the API instead.
 */
import type { FiveMinBTCSignal, FiveMinSignalHistory, PredictionMarket } from '@/lib/types/market-signals';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchRelevantMarkets(assets: string[]): Promise<PredictionMarket[]> {
  const j = await getJson<{ predictions?: PredictionMarket[] }>(
    `/api/predictions?assets=${encodeURIComponent(assets.join(','))}`,
  );
  return j.predictions ?? [];
}

export async function fetchTopMarkets(limit: number): Promise<PredictionMarket[]> {
  const j = await getJson<{ predictions?: PredictionMarket[] }>(`/api/predictions?top=${limit}`);
  return j.predictions ?? [];
}

const EMPTY_HISTORY: FiveMinSignalHistory = {
  signals: [],
  accuracy: { correct: 0, total: 0, rate: 0 },
  streak: { direction: 'MIXED', count: 0 },
  avgConfidence: 0,
};

export async function fetchFiveMinSignal(): Promise<{ signal: FiveMinBTCSignal | null; history: FiveMinSignalHistory }> {
  const j = await getJson<{ detail?: FiveMinBTCSignal | null; historyDetail?: FiveMinSignalHistory }>(
    '/api/polymarket/5min-signal',
  );
  return { signal: j.detail ?? null, history: j.historyDetail ?? EMPTY_HISTORY };
}

export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
