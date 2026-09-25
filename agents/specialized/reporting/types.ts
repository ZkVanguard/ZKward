/**
 * Shared types for the reporting subsystem. Extracted from the
 * ReportingAgent monolith so per-report generators can import just what
 * they need. External consumers keep importing from ReportingAgent for
 * backward compat (types are re-exported there).
 */

export interface PortfolioPosition {
  symbol?: string;
  amount?: number;
  entryPrice?: number;
  currentPrice?: number;
  avgPrice?: number;
  value: number;
  pnl?: number;
  pnlPercentage?: number;
  lastUpdated?: number;
}

export interface ReportRequest {
  reportId: string;
  type: 'RISK' | 'PERFORMANCE' | 'SETTLEMENT' | 'PORTFOLIO' | 'AUDIT' | 'COMPREHENSIVE';
  portfolioId?: string;
  period: {
    start: number;
    end: number;
  };
  format: 'JSON' | 'PDF' | 'HTML' | 'CSV';
  includeCharts: boolean;
  includeZKProofs: boolean;
  status: 'PENDING' | 'GENERATING' | 'COMPLETED' | 'FAILED';
  createdAt: number;
  completedAt?: number;
}

export interface RiskReport {
  portfolioId: string;
  period: { start: number; end: number };
  summary: {
    totalValue: string;
    totalRisk: number;
    riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    var95: number;
    cvar95: number;
    sharpeRatio: number;
  };
  assetRisks: {
    asset: string;
    allocation: number;
    volatility: number;
    var: number;
    contribution: number;
  }[];
  hedges: {
    market: string;
    effectiveness: number;
    cost: number;
  }[];
  zkProofs: string[];
  timestamp: number;
}

export interface PerformanceReport {
  portfolioId: string;
  period: { start: number; end: number };
  summary: {
    startValue: string;
    endValue: string;
    absoluteReturn: string;
    percentageReturn: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
  };
  trades: {
    date: number;
    type: 'BUY' | 'SELL' | 'HEDGE';
    asset: string;
    amount: string;
    price: string;
    pnl: string;
  }[];
  dailyReturns: {
    date: number;
    value: string;
    return: number;
  }[];
  benchmarkComparison?: {
    benchmark: string;
    portfolioReturn: number;
    benchmarkReturn: number;
    alpha: number;
    beta: number;
  };
  timestamp: number;
}

export interface SettlementReport {
  period: { start: number; end: number };
  summary: {
    totalSettlements: number;
    totalVolume: string;
    successRate: number;
    avgProcessingTime: number;
    gasSaved: string;
  };
  settlements: {
    id: string;
    date: number;
    amount: string;
    beneficiary: string;
    status: string;
    gasless: boolean;
  }[];
  batches: {
    batchId: string;
    date: number;
    count: number;
    totalAmount: string;
  }[];
  timestamp: number;
}

export interface PortfolioReport {
  portfolioId: string;
  timestamp: number;
  overview: {
    totalValue: string;
    assetCount: number;
    activeStrategies: number;
    performance30d: number;
  };
  allocation: {
    asset: string;
    amount: string;
    value: string;
    percentage: number;
  }[];
  strategies: {
    strategyId: string;
    type: string;
    status: string;
    performance: number;
  }[];
  recentActivity: {
    date: number;
    type: string;
    description: string;
  }[];
}

export interface AuditReport {
  period: { start: number; end: number };
  agentActivity: {
    agentId: string;
    agentType: string;
    tasksExecuted: number;
    successRate: number;
    avgExecutionTime: number;
  }[];
  transactions: {
    txHash: string;
    date: number;
    type: string;
    from: string;
    to: string;
    amount: string;
    gasUsed: string;
  }[];
  zkVerifications: {
    proofHash: string;
    date: number;
    proofType: string;
    verified: boolean;
  }[];
  anomalies: {
    date: number;
    type: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    description: string;
  }[];
  timestamp: number;
}

export interface ComprehensiveReport {
  reportId: string;
  generatedAt: number;
  period: { start: number; end: number };
  executiveSummary: {
    totalPortfolios: number;
    totalValue: string;
    overallReturn: number;
    totalSettlements: number;
    systemHealth: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  };
  riskReport: RiskReport;
  performanceReport: PerformanceReport;
  settlementReport: SettlementReport;
  portfolioReports: PortfolioReport[];
  auditReport: AuditReport;
  recommendations: {
    priority: 'HIGH' | 'MEDIUM' | 'LOW';
    category: string;
    recommendation: string;
    rationale: string;
  }[];
}
