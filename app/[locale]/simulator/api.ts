import { logger } from '@/lib/utils/logger';
import type { RealPriceData, RealRiskAssessment, RealZKProof } from './types';
import { initialPortfolio } from './constants';

export async function fetchRealPrices(): Promise<Record<string, number>> {
  try {
    const res = await fetch('/api/prices?symbols=BTC,ETH,CRO&source=exchange');
    if (res.ok) {
      const data = await res.json();
      const prices: Record<string, number> = {};
      data.data?.forEach((p: RealPriceData) => { prices[p.symbol] = p.price; });
      return prices;
    }
  } catch (e) { logger.warn('Failed to fetch real prices', { component: 'Simulator', error: String(e) }); }
  return {};
}

/**
 * Ask for a proof that a hedge is inside its caps: leverage and notional within
 * the limits, and the notional covering size times price. Null when the prover
 * is unreachable or refuses.
 */
export async function generateHedgePolicyProof(
  hedge: { asset: string; side: 'LONG' | 'SHORT'; leverageX: number; notionalUsd: number; entryPriceUsd: number },
  caps: { leverageCap: number; notionalCapUsd: number },
): Promise<RealZKProof | null> {
  try {
    const entryPriceCents = Math.round(hedge.entryPriceUsd * 100);
    const sizeMilli = Math.floor((hedge.notionalUsd / hedge.entryPriceUsd) * 1000);
    // The declared notional must cover size times price, so round it up from them.
    const notionalValueUsdcCents = Math.ceil((sizeMilli * entryPriceCents) / 1000);
    const res = await fetch('/api/zk-proof/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        hedge: { asset: hedge.asset, side: hedge.side, leverageX: hedge.leverageX, notionalValueUsdcCents, sizeMilli, entryPriceCents, timestampMs: Date.now() },
        caps: { leverage_cap: caps.leverageCap, notional_cap_cents: Math.round(caps.notionalCapUsd * 100) },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && typeof data.commitment === 'string') {
        return { commitment: data.commitment, verified: data.verified === true, protocol: String(data.protocol ?? ''), durationMs: Number(data.duration_ms ?? 0) };
      }
    }
  } catch (e) { logger.warn('Failed to generate ZK proof', { component: 'Simulator', error: String(e) }); }
  return null;
}

export async function assessRealRisk(portfolioValue: number, positions: { symbol: string; value: number }[]): Promise<RealRiskAssessment | null> {
  try {
    const res = await fetch('/api/agents/risk/assess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolioValue, positions }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.riskMetrics || data;
    }
  } catch (e) { logger.warn('Failed to assess risk', { component: 'Simulator', error: String(e) }); }
  return null;
}

export async function executeSimulatedHedge(asset: string, side: 'LONG' | 'SHORT', notionalValue: number): Promise<{ success: boolean; orderId?: string; txHash?: string; autoApproved?: boolean }> {
  try {
    const dynamicAutoApprovalThreshold = initialPortfolio.totalValue * 0.10;
    const isAutoApproved = notionalValue <= dynamicAutoApprovalThreshold;

    const res = await fetch('/api/agents/hedging/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portfolioId: 1,
        asset,
        side,
        notionalValue,
        leverage: 10,
        reason: 'Trump Tariff Event - Emergency Hedge (Auto-Approved)',
        autoApprovalEnabled: true,
        autoApprovalThreshold: dynamicAutoApprovalThreshold,
        signature: isAutoApproved ? undefined : '0xMANUAL_SIGNATURE',
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return { success: data.success, orderId: data.orderId, txHash: data.txHash, autoApproved: data.autoApproved ?? isAutoApproved };
    }
  } catch (e) { logger.warn('Failed to execute hedge', { component: 'Simulator', error: String(e) }); }
  return { success: false };
}

export async function fetchPredictionData(): Promise<{
  predictions: Array<{
    id: string;
    question: string;
    probability: number;
    volume: string;
    impact: string;
    recommendation: string;
    source: string;
  }>;
  analysis: {
    predictionRiskScore: number;
    overallSentiment: string;
    hedgeSignals: number;
  };
} | null> {
  try {
    const res = await fetch('/api/predictions?assets=BTC,ETH,CRO');
    if (res.ok) {
      const data = await res.json();
      return { predictions: data.predictions || [], analysis: data.analysis || {} };
    }
  } catch (e) { logger.warn('Failed to fetch predictions', { component: 'Simulator', error: String(e) }); }
  return null;
}

export async function executeAgentCommand(command: string): Promise<{
  success: boolean;
  response: string;
  details?: {
    strategy?: string;
    riskAnalysis?: unknown;
    hedgingStrategy?: unknown;
    zkProofs?: unknown[];
  };
}> {
  try {
    const res = await fetch('/api/agents/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (res.ok) {
      const data = await res.json();
      return { success: data.success, response: data.response || 'Command executed', details: data.details };
    }
  } catch (e) { logger.warn('Failed to execute agent command', { component: 'Simulator', error: String(e) }); }
  return { success: false, response: 'Agent unavailable' };
}

export async function fetchPolymarketData(): Promise<Array<{
  question: string;
  outcomePrices: string;
  volume: string;
  liquidity: string;
}>> {
  try {
    const res = await fetch('/api/polymarket?limit=20&closed=false');
    if (res.ok) {
      const data = await res.json();
      return data.slice(0, 10).map((m: { question?: string; title?: string; outcomePrices?: string; volume?: string; liquidity?: string }) => ({
        question: m.question || m.title,
        outcomePrices: m.outcomePrices || '50/50',
        volume: m.volume || '0',
        liquidity: m.liquidity || '0',
      }));
    }
  } catch (e) { logger.warn('Failed to fetch Polymarket', { component: 'Simulator', error: String(e) }); }
  return [];
}

export async function askAI(prompt: string): Promise<{ response: string; model: string; success: boolean }> {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: prompt,
        conversationId: 'simulator-session',
        context: { source: 'simulator', scenario: 'trump-tariff-replay' },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.response) {
        return { response: data.response, model: data.metadata?.model || 'ollama/qwen', success: true };
      }
    }
  } catch (e) { logger.warn('Failed to call AI', { component: 'Simulator', error: String(e) }); }
  return { response: 'AI unavailable', model: 'none', success: false };
}
