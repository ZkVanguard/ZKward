export interface RealPriceData {
  symbol: string;
  price: number;
  change24h?: number;
  source: string;
}

export interface RealRiskAssessment {
  var: number;
  volatility: number;
  sharpeRatio: number;
  riskScore: number;
  overallRisk: string;
  realAgent: boolean;
}

/** A hedge policy proof as the generate route returned it; `verified` is the server-side verifier's verdict. */
export interface RealZKProof {
  commitment: string;
  verified: boolean;
  protocol: string;
  durationMs: number;
}

export interface AgentStatus {
  orchestrator: { initialized: boolean; signerAvailable: boolean };
  agents: Record<string, { available: boolean }>;
  integrations: Record<string, { enabled: boolean }>;
}

export interface PortfolioState {
  totalValue: number;
  cash: number;
  positions: {
    symbol: string;
    amount: number;
    value: number;
    price: number;
    pnl: number;
    pnlPercent: number;
  }[];
  riskScore: number;
  volatility: number;
}

export interface AgentAction {
  id: string;
  timestamp: Date;
  agent: 'Lead' | 'Risk' | 'Hedging' | 'Settlement' | 'Reporting';
  action: string;
  description: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  impact?: {
    metric: string;
    before: number;
    after: number;
  };
}

export interface SimulationScenario {
  id: string;
  name: string;
  description: string;
  type: 'crash' | 'volatility' | 'recovery' | 'stress' | 'tariff';
  duration: number;
  priceChanges: { symbol: string; change: number }[];
  eventData?: {
    date: string;
    headline: string;
    source: string;
    marketContext: string;
    liquidations: string;
    priceAtEvent: { symbol: string; price: number }[];
    predictionData?: {
      polymarket: { question: string; before: number; after: number; volume: number };
      kalshi: { question: string; before: number; after: number; volume: number };
      predictit: { question: string; before: number; after: number; volume: number };
      consensus: number;
    };
  };
}
