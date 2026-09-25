/**
 * PositionsList Types
 * Type definitions extracted from PositionsList.tsx
 */

import type { PredictionMarket } from '@/lib/services/market-data/DelphiMarketService';

export interface Position {
  symbol: string;
  balance: string;
  balanceUSD: string;
  price: string;
  change24h: number;
}

export interface AgentRecommendation {
  action: 'WITHDRAW' | 'HEDGE' | 'ADD_FUNDS' | 'HOLD';
  confidence: number;
  reasoning: string[];
  riskScore: number;
  agentAnalysis: {
    riskAgent: string;
    hedgingAgent: string;
    leadAgent: string;
  };
  recommendations: string[];
}

export interface SettlementBatch {
  type: string;
  status: string;
}

export interface PortfolioAssetDetail {
  symbol: string;
  address: string;
  allocation: number;
  value: number;
  change24h: number;
  price?: number;
  chain?: string;
}

export interface PortfolioTransaction {
  type: 'deposit' | 'withdraw' | 'rebalance';
  timestamp: number;
  amount?: number;
  token?: string;
  changes?: { from: number; to: number; asset: string }[];
  txHash: string;
}

export interface PortfolioDetail {
  id: number;
  name: string;
  totalValue: number;
  status: 'FUNDED' | 'EMPTY' | 'NEW';
  targetAPY: number;
  riskLevel: 'Low' | 'Medium' | 'High';
  currentYield: number;
  assets: PortfolioAssetDetail[];
  lastRebalanced: number;
  transactions: PortfolioTransaction[];
  aiAnalysis: {
    summary: string;
    recommendations: string[];
    riskAssessment: string;
  };
}

export interface PositionsListProps {
  address: string;
  onOpenHedge?: (market: PredictionMarket) => void;
}

export interface AssetBalance {
  token: string;
  symbol: string;
  balance: string;
  valueUSD: number;
}

export interface OnChainPortfolio {
  id: number;
  owner: string;
  totalValue: string;
  calculatedValueUSD?: number;
  targetYield: string;
  riskTolerance: string;
  lastRebalance: string;
  isActive: boolean;
  assets: string[];
  assetBalances?: AssetBalance[];
  predictions?: PredictionMarket[];
  txHash?: string | null;
}
