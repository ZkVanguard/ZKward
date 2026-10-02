/**
 * Shapes of the market signals the dashboard renders. The services that
 * produce them run on the server; the UI needs only these types and reads
 * the data through the API (`lib/api/market-signals.ts`).
 */

export interface PredictionMarket {
  id: string;
  question: string;
  category: 'volatility' | 'price' | 'event' | 'protocol' | 'regulation' | 'adoption' | 'market' | 'defi';
  probability: number; // 0-100
  volume: string;
  impact: 'HIGH' | 'MODERATE' | 'LOW';
  relatedAssets: string[];
  lastUpdate: number;
  confidence: number; // 0-100, based on volume and liquidity
  recommendation?: 'HEDGE' | 'MONITOR' | 'IGNORE';
  source?: 'polymarket' | 'crypto-analysis' | 'delphi' | 'manifold';
  aiSummary?: string; // AI-generated agent analysis summary
  agentAnalysis?: {
    riskAgent: string;
    hedgingAgent: string;
    sentiment: 'bullish' | 'bearish' | 'neutral';
    actionRationale: string;
    analyzedAt: number;
  };
  
  // Enhanced AI-relevant fields
  /** Liquidity depth on the prediction market */
  liquidity?: number;
  /** Open interest (total outstanding bets) */
  openInterest?: number;
  /** Probability change in last hour (momentum) */
  probabilityChange1h?: number;
  /** Probability change in last 24 hours */
  probabilityChange24h?: number;
  /** Time until market resolution (ms) */
  timeToResolution?: number;
  /** Resolution date ISO string */
  resolutionDate?: string;
  /** Market sentiment derived from order flow */
  orderFlowSentiment?: 'buying' | 'selling' | 'balanced';
  /** Smart money indicator based on large trades */
  smartMoneyDirection?: 'accumulating' | 'distributing' | 'neutral';
  /** Historical accuracy of similar markets from this source */
  sourceAccuracy?: number;
  /** Correlation with BTC price movement */
  btcCorrelation?: number;
  /** Urgency score for time-sensitive decisions */
  urgencyScore?: number;
}

export interface FiveMinBTCSignal {
  /** Unique market ID from Polymarket */
  marketId: string;
  /** Current 5-min window label, e.g. "11:00-11:05PM ET" */
  windowLabel: string;
  /** UP or DOWN — which direction the crowd believes */
  direction: 'UP' | 'DOWN';
  /** Probability of the winning direction (0-100) */
  probability: number;
  /** Probability specifically for UP outcome (0-100) */
  upProbability: number;
  /** Probability specifically for DOWN outcome (0-100) */
  downProbability: number;
  /** Price BTC must beat for UP resolution */
  priceToBeat: number;
  /** Current BTC price (from market context if available) */
  currentPrice: number;
  /** Total volume on this 5-min market ($) */
  volume: number;
  /** Current liquidity (order-book depth) on this 5-min market ($) */
  liquidity: number;
  /** Confidence score (0-100) based on volume + probability skew + liquidity */
  confidence: number;
  /** Actionable recommendation for agents */
  recommendation: 'HEDGE_SHORT' | 'HEDGE_LONG' | 'WAIT';
  /** Signal strength: how strong the directional conviction is */
  signalStrength: 'STRONG' | 'MODERATE' | 'WEAK';
  /** Seconds remaining in this 5-min window (snapshot at fetch time) */
  timeRemainingSeconds: number;
  /** Absolute timestamp (ms) when this 5-min window ends */
  windowEndTime: number;
  /** When this signal was fetched */
  fetchedAt: number;
  /** Raw market question from Polymarket */
  question: string;
  /** Source URL for verification */
  sourceUrl: string;
}

export interface FiveMinSignalHistory {
  /** Recent signals (last 30 minutes = up to 6 signals) */
  signals: FiveMinBTCSignal[];
  /** Running accuracy: how many past signals were correct */
  accuracy: { correct: number; total: number; rate: number };
  /** Current streak direction */
  streak: { direction: 'UP' | 'DOWN' | 'MIXED'; count: number };
  /** Average confidence across recent signals */
  avgConfidence: number;
}

/** One asset's aggregate signal as `/api/predictions/per-asset` reports it. */
export interface PerAssetSignal {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  recommendation: string;
  confidence: number;
  consensus: number;
  probability: number;
  sourceCount: number;
  sources: Array<{ name: string; direction: 'UP' | 'DOWN' | 'NEUTRAL'; confidence: number; weight: number }>;
}
