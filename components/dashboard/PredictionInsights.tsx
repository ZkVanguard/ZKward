'use client';

import { useState, useCallback, useEffect, memo } from 'react';
import { logger } from '@/lib/utils/logger';
import { DelphiMarketService, PredictionMarket } from '@/lib/services/market-data/DelphiMarketService';
import { usePolling, useLoading } from '@/lib/hooks';
import { useMarketInsights } from '@/contexts/AIDecisionsContext';
import { 
  TrendingUp, 
  TrendingDown,
  AlertTriangle, 
  CheckCircle, 
  Eye,
  ExternalLink,
  RefreshCw,
  Activity,
  Shield,
  X,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Bot,
  Zap,
  ArrowRight
} from 'lucide-react';

interface TokenDirection {
  symbol: string;
  direction: 'up' | 'down' | 'sideways';
  confidence: number;
  shortTake: string;
}

interface LeverageRecommendation {
  symbol: string;
  direction: 'long' | 'short' | 'neutral';
  leverage: string;
  riskLevel: 'conservative' | 'moderate' | 'aggressive';
  rationale: string;
  confidence: number;
  allocation: number;
}

interface UnifiedSummary {
  overview: string;
  riskAgent: string;
  hedgingAgent: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  tokenDirections: TokenDirection[];
  leverageRecommendations: LeverageRecommendation[];
  hedgeAlerts: number;
  leadAgentApproved?: boolean;
  analyzedAt: number;
}

interface HedgeInitialValues {
  asset?: string;
  side?: 'LONG' | 'SHORT';
  leverage?: number;
  size?: number;
  reason?: string;
  entryPrice?: number;
  targetPrice?: number;
  stopLoss?: number;
}

interface PredictionInsightsProps {
  assets?: string[];
  showAll?: boolean;
  onOpenHedge?: (market: PredictionMarket) => void;
  onTriggerAgentAnalysis?: (market: PredictionMarket) => void;
  onCreateRecommendedHedge?: (values: HedgeInitialValues) => void;
}

export const PredictionInsights = memo(function PredictionInsights({ 
  assets = ['BTC', 'ETH', 'CRO', 'USDC'], 
  showAll = false, 
  onOpenHedge, 
  onTriggerAgentAnalysis,
  onCreateRecommendedHedge,
}: PredictionInsightsProps) {
  // Use centralized AI context for insights
  const { insights: contextInsights, loading: contextLoading, refresh: refreshInsights } = useMarketInsights();
  
  const [predictions, setPredictions] = useState<PredictionMarket[]>([]);
  const { isLoading: loading, error, setError, startLoading: _startLoading, stopLoading } = useLoading(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'HIGH' | 'MODERATE' | 'LOW'>('all');
  const [selectedPrediction, setSelectedPrediction] = useState<PredictionMarket | null>(null);
  const [actionFeedback, setActionFeedback] = useState<{ id: string; action: string } | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [showAllPredictions, setShowAllPredictions] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  // Use context insights with UnifiedSummary type mapping
  const agentSummary: UnifiedSummary | null = contextInsights ? {
    overview: contextInsights.overview,
    riskAgent: contextInsights.riskAgent,
    hedgingAgent: contextInsights.hedgingAgent,
    sentiment: contextInsights.sentiment,
    tokenDirections: contextInsights.tokenDirections,
    leverageRecommendations: contextInsights.leverageRecommendations,
    hedgeAlerts: contextInsights.hedgeAlerts,
    leadAgentApproved: contextInsights.leadAgentApproved,
    analyzedAt: contextInsights.analyzedAt,
  } : null;
  const summaryLoading = contextLoading;

  const fetchPredictions = useCallback(async (showRefreshIndicator = false) => {
    if (showRefreshIndicator) setRefreshing(true);

    try {
      const markets = showAll 
        ? await DelphiMarketService.getTopMarkets(20)
        : await DelphiMarketService.getRelevantMarkets(assets);
      
      // 'crypto-analysis' entries are questions generated from a price ticker
      // with invented odds — not prediction markets.
      setPredictions(markets.filter((m) => m.source !== 'crypto-analysis'));
      stopLoading();
    } catch (err) {
      logger.error('Error fetching Delphi predictions', err instanceof Error ? err : undefined);
      setError('Failed to fetch predictions');
    } finally {
      setRefreshing(false);
    }
  }, [showAll, assets, setError, stopLoading]);

  usePolling(fetchPredictions, 60000);

  // Trigger AI context refresh when predictions change
  const triggerInsightsRefresh = useCallback((preds: PredictionMarket[], force = false) => {
    if (preds.length === 0) return;
    
    // Convert to the format expected by the context
    const predictionData = preds.map(p => ({
      id: p.id,
      probability: p.probability,
      question: p.question,
      relatedAssets: p.relatedAssets,
      impact: p.impact,
      recommendation: p.recommendation,
      source: p.source,
    }));
    
    logger.debug('[PredictionInsights] Refreshing insights via context');
    refreshInsights(predictionData, force);
  }, [refreshInsights]);

  // Trigger refresh when predictions change
  useEffect(() => {
    if (predictions.length > 0) {
      triggerInsightsRefresh(predictions);
    }
  }, [predictions, triggerInsightsRefresh]);

  const filteredPredictions = predictions.filter(p => {
    if (filter === 'all') return true;
    return p.impact === filter;
  });

  const getImpactStyles = (impact: PredictionMarket['impact']) => {
    switch (impact) {
      case 'HIGH': return { text: 'text-[#FF3B30]', bg: 'bg-[#FF3B30]/10', border: 'border-[#FF3B30]/20' };
      case 'MODERATE': return { text: 'text-[#FF9500]', bg: 'bg-[#FF9500]/10', border: 'border-[#FF9500]/20' };
      case 'LOW': return { text: 'text-[#86868b]', bg: 'bg-[#f5f5f7]', border: 'border-[#e8e8ed]' };
    }
  };

  const getCategoryIcon = (category: PredictionMarket['category']) => {
    switch (category) {
      case 'volatility': return <Activity className="w-3.5 h-3.5" />;
      case 'price': return <TrendingUp className="w-3.5 h-3.5" />;
      case 'event': return <AlertTriangle className="w-3.5 h-3.5" />;
      case 'protocol': return <CheckCircle className="w-3.5 h-3.5" />;
    }
  };

  const handleAction = (prediction: PredictionMarket, action: 'hedge' | 'monitor' | 'dismiss') => {
    if (onTriggerAgentAnalysis) {
      onTriggerAgentAnalysis(prediction);
    }
    
    setActionFeedback({ id: prediction.id, action });
    setTimeout(() => setActionFeedback(null), 3000);
    
    if (action === 'hedge' && onOpenHedge) {
      onOpenHedge(prediction);
    }
    
    setSelectedPrediction(null);
  };

  const hedgeCount = predictions.filter(p => p.recommendation === 'HEDGE').length;

  // Loading state
  if (loading) {
    return (
      <div className="bg-white rounded-[16px] sm:rounded-[20px] shadow-sm border border-black/5 p-6">
        <div className="flex items-center justify-center py-8">
          <div className="w-7 h-7 border-2 border-[#AF52DE] border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="bg-white rounded-[16px] sm:rounded-[20px] shadow-sm border border-black/5 p-6">
        <div className="text-center py-6">
          <div className="w-12 h-12 bg-[#FF3B30]/10 rounded-[14px] flex items-center justify-center mx-auto mb-3">
            <AlertTriangle className="w-6 h-6 text-[#FF3B30]" />
          </div>
          <p className="text-[15px] text-[#1d1d1f] mb-2">{error}</p>
          <button
            onClick={() => fetchPredictions(true)}
            className="text-[13px] text-[#007AFF] font-medium"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-[16px] sm:rounded-[20px] shadow-sm border border-black/5 overflow-hidden">
      {/* Header - Collapseable */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setIsCollapsed(!isCollapsed)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setIsCollapsed(!isCollapsed); } }}
        className="w-full px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between active:bg-[#f9f9f9] sm:hover:bg-[#f9f9f9] transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="w-9 h-9 sm:w-10 sm:h-10 bg-ios-blue rounded-[10px] sm:rounded-[12px] flex items-center justify-center">
            <Sparkles className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
          </div>
          <div className="text-left">
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] sm:text-[17px] font-semibold text-[#1d1d1f]">Insights</h3>
              <span className="px-1.5 py-0.5 bg-ios-blue/10 text-ios-blue text-[10px] font-bold rounded-full">
                {predictions.length}
              </span>
              {hedgeCount > 0 && (
                <span className="px-1.5 py-0.5 bg-[#FF3B30]/10 text-[#FF3B30] text-[10px] font-bold rounded-full">
                  {hedgeCount} alerts
                </span>
              )}
            </div>
            <p className="text-[11px] sm:text-[12px] text-[#86868b]">Delphi & Polymarket predictions</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={async (e) => {
              e.stopPropagation();
              await fetchPredictions(true);
              // Force refresh AI insights via context
              if (predictions.length > 0) {
                triggerInsightsRefresh(predictions, true);
              }
            }}
            disabled={refreshing || summaryLoading}
            className="w-8 h-8 flex items-center justify-center bg-[#f5f5f7] rounded-full"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-[#86868b] ${refreshing || summaryLoading ? 'animate-spin' : ''}`} />
          </button>
          {isCollapsed ? (
            <ChevronDown className="w-5 h-5 text-[#86868b]" />
          ) : (
            <ChevronUp className="w-5 h-5 text-[#86868b]" />
          )}
        </div>
      </div>

      {!isCollapsed && (
        <>
          {/* Filter Pills */}
          <div className="px-4 sm:px-6 pb-3">
            <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
              {(['all', 'HIGH', 'MODERATE', 'LOW'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-all whitespace-nowrap ${
                    filter === f
                      ? 'bg-ios-blue text-white'
                      : 'bg-[#f5f5f7] text-[#86868b] active:bg-[#e8e8ed]'
                  }`}
                >
                  {f === 'all' ? 'All' : f.charAt(0) + f.slice(1).toLowerCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Unified AI Agent Summary */}
          {(agentSummary || summaryLoading) && (
            <div className="px-4 sm:px-6 pb-3">
              <div className="bg-ios-blue/5 border border-ios-blue/15 rounded-[14px] overflow-hidden">
                {/* Summary Header */}
                <button
                  onClick={() => setSummaryExpanded(!summaryExpanded)}
                  className="w-full px-4 py-3 flex items-start gap-3 text-left"
                >
                  <div className="w-8 h-8 bg-ios-blue rounded-[10px] flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Bot className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[13px] font-bold text-[#1d1d1f]">Agent Analysis</span>
                      {agentSummary?.sentiment && (
                        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${
                          agentSummary.sentiment === 'bullish'
                            ? 'bg-[#34C759]/15 text-[#34C759]'
                            : agentSummary.sentiment === 'bearish'
                            ? 'bg-[#FF3B30]/15 text-[#FF3B30]'
                            : 'bg-[#86868b]/10 text-[#86868b]'
                        }`}>
                          {agentSummary.sentiment.toUpperCase()}
                        </span>
                      )}
                      {agentSummary && agentSummary.hedgeAlerts > 0 && (
                        <span className="px-1.5 py-0.5 bg-[#FF3B30]/10 text-[#FF3B30] rounded-full text-[9px] font-bold">
                          {agentSummary.hedgeAlerts} HEDGE
                        </span>
                      )}
                      {agentSummary?.leadAgentApproved !== undefined && (
                        <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold ${
                          agentSummary.leadAgentApproved
                            ? 'bg-[#34C759]/15 text-[#34C759]'
                            : 'bg-[#FF9500]/15 text-[#FF9500]'
                        }`}>
                          {agentSummary.leadAgentApproved ? '✅ LEAD APPROVED' : '⏳ PENDING'}
                        </span>
                      )}
                    </div>
                    {summaryLoading && !agentSummary ? (
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 border-[1.5px] border-[#AF52DE] border-t-transparent rounded-full animate-spin" />
                        <span className="text-[12px] text-[#86868b] italic">Agents analyzing market data...</span>
                      </div>
                    ) : agentSummary ? (
                      <p className="text-[12px] sm:text-[13px] text-[#1d1d1f] leading-snug line-clamp-5">
                        {agentSummary.overview}
                      </p>
                    ) : null}
                  </div>
                  <ChevronDown className={`w-4 h-4 text-[#86868b] flex-shrink-0 mt-1 transition-transform ${
                    summaryExpanded ? 'rotate-180' : ''
                  }`} />
                </button>

                {/* Token Directions - always visible */}
                {agentSummary?.tokenDirections && agentSummary.tokenDirections.length > 0 && (
                  <div className="px-4 pb-3">
                    <div className="grid grid-cols-2 gap-2">
                      {agentSummary.tokenDirections.map((td) => (
                        <div
                          key={td.symbol}
                          className={`p-3 rounded-[12px] border ${
                            td.direction === 'up'
                              ? 'bg-[#34C759]/5 border-[#34C759]/15'
                              : td.direction === 'down'
                              ? 'bg-[#FF3B30]/5 border-[#FF3B30]/15'
                              : 'bg-[#FF9500]/5 border-[#FF9500]/15'
                          }`}
                        >
                          {/* Token header row */}
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-1.5">
                              {td.direction === 'up' ? (
                                <TrendingUp className="w-4 h-4 text-[#34C759]" />
                              ) : td.direction === 'down' ? (
                                <TrendingDown className="w-4 h-4 text-[#FF3B30]" />
                              ) : (
                                <ArrowRight className="w-4 h-4 text-[#FF9500]" />
                              )}
                              <span className="text-[13px] font-bold text-[#1d1d1f]">{td.symbol}</span>
                            </div>
                            <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-bold ${
                              td.direction === 'up'
                                ? 'bg-[#34C759]/15 text-[#34C759]'
                                : td.direction === 'down'
                                ? 'bg-[#FF3B30]/15 text-[#FF3B30]'
                                : 'bg-[#FF9500]/15 text-[#FF9500]'
                            }`}>
                              {td.direction === 'up' ? '↑ BULLISH' : td.direction === 'down' ? '↓ BEARISH' : '→ NEUTRAL'}
                            </span>
                          </div>
                          {/* Confidence bar */}
                          <div className="mb-1.5">
                            <div className="flex items-center justify-between mb-0.5">
                              <span className="text-[9px] font-semibold text-[#86868b] uppercase tracking-wide">Confidence</span>
                              <span className={`text-[10px] font-bold ${
                                td.confidence >= 70 ? 'text-[#34C759]'
                                  : td.confidence >= 50 ? 'text-[#FF9500]'
                                  : 'text-[#FF3B30]'
                              }`}>{td.confidence}%</span>
                            </div>
                            <div className="w-full h-1.5 bg-black/5 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  td.direction === 'up' ? 'bg-[#34C759]'
                                    : td.direction === 'down' ? 'bg-[#FF3B30]'
                                    : 'bg-[#FF9500]'
                                }`}
                                style={{ width: `${Math.min(td.confidence, 100)}%` }}
                              />
                            </div>
                          </div>
                          {/* Short take */}
                          <p className="text-[10px] text-[#6e6e73] leading-snug">
                            {td.shortTake}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Agent Leverage Recommendations */}
                {agentSummary?.leverageRecommendations && agentSummary.leverageRecommendations.length > 0 && (
                  <div className="px-4 pb-3">
                    <div className="p-3 bg-[#007AFF]/5 border border-[#007AFF]/12 rounded-[12px]">
                      <div className="flex items-center gap-2 mb-2.5">
                        <div className="w-5 h-5 bg-[#007AFF] rounded-[6px] flex items-center justify-center">
                          <Zap className="w-3 h-3 text-white" />
                        </div>
                        <span className="text-[11px] font-bold text-[#007AFF] uppercase tracking-wide">Agent Recommendations</span>
                      </div>

                      <div className="space-y-2">
                        {agentSummary.leverageRecommendations.map((lr) => (
                          <div key={lr.symbol} className={`p-2.5 rounded-[10px] border ${
                            lr.direction === 'long'
                              ? 'bg-[#34C759]/5 border-[#34C759]/12'
                              : lr.direction === 'short'
                              ? 'bg-[#FF3B30]/5 border-[#FF3B30]/12'
                              : 'bg-[#FF9500]/5 border-[#FF9500]/12'
                          }`}>
                            {/* Top row: symbol + direction badges */}
                            <div className="flex items-center gap-2 flex-wrap">
                              {lr.direction === 'long' ? (
                                <TrendingUp className="w-4 h-4 text-[#34C759] flex-shrink-0" />
                              ) : lr.direction === 'short' ? (
                                <TrendingDown className="w-4 h-4 text-[#FF3B30] flex-shrink-0" />
                              ) : (
                                <ArrowRight className="w-4 h-4 text-[#FF9500] flex-shrink-0" />
                              )}
                              <span className="text-[13px] font-bold text-[#1d1d1f]">{lr.symbol}</span>
                              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                                lr.direction === 'long'
                                  ? 'bg-[#34C759]/15 text-[#34C759]'
                                  : lr.direction === 'short'
                                  ? 'bg-[#FF3B30]/15 text-[#FF3B30]'
                                  : 'bg-[#FF9500]/15 text-[#FF9500]'
                              }`}>
                                {lr.direction.toUpperCase()}
                              </span>
                              <span className="px-2 py-0.5 bg-[#007AFF]/12 text-[#007AFF] rounded-full text-[10px] font-bold">
                                {lr.leverage}
                              </span>
                              <span className={`px-2 py-0.5 rounded-full text-[9px] font-semibold ${
                                lr.riskLevel === 'aggressive'
                                  ? 'bg-[#FF3B30]/12 text-[#FF3B30]'
                                  : lr.riskLevel === 'moderate'
                                  ? 'bg-[#FF9500]/12 text-[#FF9500]'
                                  : 'bg-[#34C759]/12 text-[#34C759]'
                              }`}>
                                {lr.riskLevel.charAt(0).toUpperCase() + lr.riskLevel.slice(1)}
                              </span>
                            </div>
                            {/* Bottom row: confidence + rationale */}
                            <div className="mt-1.5 ml-6">
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-[9px] font-semibold text-[#86868b] uppercase tracking-wide">
                                  {lr.confidence}% confidence
                                </span>
                              </div>
                              <p className="text-[11px] text-[#6e6e73] leading-snug">
                                {lr.rationale}
                              </p>
                              {/* Create Hedge Button */}
                              {onCreateRecommendedHedge && lr.direction !== 'neutral' && (
                                <button
                                  onClick={() => {
                                    // Parse leverage properly (handle decimals like "1.5x")
                                    const leverageMatch = lr.leverage.match(/([\d.]+)/);
                                    const leverageNum = leverageMatch ? Math.max(1, Math.round(parseFloat(leverageMatch[1]))) : 2;
                                    
                                    // Extract price from rationale (e.g., "Price: $2,092.11")
                                    const priceMatch = lr.rationale.match(/Price:\s*\$?([\d,]+\.?\d*)/i);
                                    const entryPrice = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : undefined;
                                    
                                    // Calculate target and stop loss based on direction
                                    let targetPrice: number | undefined;
                                    let stopLoss: number | undefined;
                                    if (entryPrice) {
                                      if (lr.direction === 'long') {
                                        targetPrice = Math.round(entryPrice * 1.05 * 100) / 100; // +5% target
                                        stopLoss = Math.round(entryPrice * 0.97 * 100) / 100;    // -3% stop
                                      } else {
                                        targetPrice = Math.round(entryPrice * 0.95 * 100) / 100; // -5% target
                                        stopLoss = Math.round(entryPrice * 1.03 * 100) / 100;    // +3% stop
                                      }
                                    }
                                    
                                    onCreateRecommendedHedge({
                                      asset: lr.symbol,
                                      side: lr.direction.toUpperCase() as 'LONG' | 'SHORT',
                                      leverage: leverageNum,
                                      size: 100, // Default $100 collateral
                                      reason: `AI Recommendation: ${lr.rationale}`,
                                      entryPrice,
                                      targetPrice,
                                      stopLoss,
                                    });
                                  }}
                                  className={`mt-2 w-full py-1.5 px-3 rounded-lg text-[11px] font-semibold transition-all duration-200 flex items-center justify-center gap-1.5 ${
                                    lr.direction === 'long'
                                      ? 'bg-[#34C759] hover:bg-[#2fb350] text-white'
                                      : 'bg-[#FF3B30] hover:bg-[#e6342b] text-white'
                                  }`}
                                >
                                  <Shield className="w-3 h-3" />
                                  Create {lr.direction.toUpperCase()} Hedge
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Expanded: Full Agent Breakdown */}
                {summaryExpanded && agentSummary && (
                  <div className="px-4 pb-4 space-y-2.5 border-t border-[#AF52DE]/10 pt-3">
                    {/* Full overview */}
                    <p className="text-[12px] sm:text-[13px] text-[#1d1d1f] leading-relaxed">
                      {agentSummary.overview}
                    </p>

                    {/* Risk Agent */}
                    <div className="p-3 bg-white/60 rounded-[10px] border border-[#AF52DE]/10">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <Zap className="w-3 h-3 text-ios-blue" />
                        <span className="text-[10px] font-bold text-ios-blue uppercase tracking-wide">Risk Agent</span>
                      </div>
                      <p className="text-[12px] text-[#1d1d1f] leading-relaxed">
                        {agentSummary.riskAgent}
                      </p>
                    </div>

                    {/* Hedging Agent */}
                    <div className="p-3 bg-white/60 rounded-[10px] border border-[#007AFF]/10">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <Shield className="w-3 h-3 text-[#007AFF]" />
                        <span className="text-[10px] font-bold text-[#007AFF] uppercase tracking-wide">Hedging Agent</span>
                      </div>
                      <p className="text-[12px] text-[#1d1d1f] leading-relaxed">
                        {agentSummary.hedgingAgent}
                      </p>
                    </div>

                    {/* Agent attribution */}
                    <div className="flex items-center gap-1.5 pt-1 flex-wrap">
                      <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-ios-blue/10 text-ios-blue rounded text-[9px] font-semibold">
                        <Bot className="w-2.5 h-2.5" /> Lead Agent
                      </span>
                      <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-ios-blue/10 text-ios-blue rounded text-[9px] font-semibold">
                        <Zap className="w-2.5 h-2.5" /> Risk Agent
                      </span>
                      <span className="flex items-center gap-0.5 px-1.5 py-0.5 bg-[#007AFF]/10 text-[#007AFF] rounded text-[9px] font-semibold">
                        <Shield className="w-2.5 h-2.5" /> Hedging Agent
                      </span>
                      {agentSummary.leadAgentApproved && (
                        <span className="ml-auto text-[9px] font-bold text-[#34C759]">
                          ✅ All agents executed &middot; Lead Agent approved
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Predictions List */}
          {filteredPredictions.length === 0 ? (
            <div className="px-4 sm:px-6 pb-6">
              <div className="text-center py-8 bg-[#f5f5f7] rounded-[14px]">
                <Eye className="w-8 h-8 text-[#86868b] mx-auto mb-2 opacity-50" />
                <p className="text-[14px] text-[#86868b]">No predictions match your filter</p>
              </div>
            </div>
          ) : (
            <div className="divide-y divide-black/5">
              {filteredPredictions.slice(0, showAllPredictions ? undefined : 5).map((prediction) => {
                const impactStyles = getImpactStyles(prediction.impact);
                const showFeedback = actionFeedback?.id === prediction.id;
                
                return (
                  <div
                    key={prediction.id}
                    className="px-4 sm:px-6 py-3 sm:py-4 active:bg-[#f9f9f9] sm:hover:bg-[#f9f9f9] transition-colors"
                  >
                    {/* Top Row: Question & Probability */}
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className={`${impactStyles.text}`}>
                            {getCategoryIcon(prediction.category)}
                          </span>
                          <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold ${impactStyles.bg} ${impactStyles.text}`}>
                            {prediction.impact}
                          </span>
                        </div>
                        <h4 className="text-[13px] sm:text-[14px] font-medium text-[#1d1d1f] line-clamp-2 leading-snug">
                          {prediction.question}
                        </h4>
                      </div>
                      
                      {/* Probability Badge — neutral: probability magnitude
                          is data, not alarm. The HIGH/MODERATE/LOW confidence
                          chip already carries the "how much to weight this"
                          signal; coloring the number red at 70% made a
                          benign "75% chance ETH yields stay >4%" read like
                          an alert. */}
                      <div className="flex-shrink-0 text-right">
                        <div className="text-[20px] sm:text-[24px] font-bold leading-none text-label-primary tabular-nums">
                          {prediction.probability}%
                        </div>
                        <div className="text-[10px] text-label-tertiary">probability</div>
                      </div>
                    </div>

                    {/* Progress Bar — same neutral principle: bar length
                        already conveys magnitude, blue accent keeps it
                        info-not-alarm. */}
                    <div className="h-1 bg-[#f5f5f7] rounded-full overflow-hidden mb-2">
                      <div
                        className="h-full rounded-full transition-all bg-ios-blue"
                        style={{ width: `${prediction.probability}%` }}
                      />
                    </div>

                    {/* Bottom Row: Assets & Action */}
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {prediction.relatedAssets.slice(0, 3).map(asset => (
                          <span key={asset} className="px-1.5 py-0.5 bg-[#007AFF]/10 text-[#007AFF] rounded text-[10px] font-medium">
                            {asset}
                          </span>
                        ))}
                        <span className="text-[10px] text-[#86868b]">
                          {DelphiMarketService.formatTimeAgo(prediction.lastUpdate)}
                        </span>
                      </div>
                      
                      {prediction.recommendation !== 'IGNORE' && (
                        showFeedback ? (
                          <span className="flex items-center gap-1 px-2 py-1 bg-[#34C759]/10 text-[#34C759] rounded-full text-[11px] font-medium">
                            <CheckCircle className="w-3 h-3" />
                            Done
                          </span>
                        ) : (
                          <button
                            onClick={() => setSelectedPrediction(prediction)}
                            className={`flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-semibold transition-all ${
                              prediction.recommendation === 'HEDGE'
                                ? 'bg-[#FF3B30]/10 text-[#FF3B30] active:bg-[#FF3B30]/20'
                                : 'bg-[#FF9500]/10 text-[#FF9500] active:bg-[#FF9500]/20'
                            }`}
                          >
                            {prediction.recommendation === 'HEDGE' ? (
                              <><Shield className="w-3 h-3" /> Hedge</>
                            ) : (
                              <><Eye className="w-3 h-3" /> Watch</>
                            )}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer */}
          {filteredPredictions.length > 5 && (
            <div className="px-4 sm:px-6 py-3 border-t border-black/5">
              <button 
                onClick={() => setShowAllPredictions(!showAllPredictions)}
                className="w-full py-2 text-[13px] font-medium text-[#007AFF] active:text-[#0051D5]"
              >
                {showAllPredictions ? 'Show less' : `View all ${filteredPredictions.length} predictions`}
              </button>
            </div>
          )}

          {filteredPredictions.length > 0 && filteredPredictions.length <= 5 && (
            <div className="px-4 sm:px-6 py-3 border-t border-black/5 flex items-center justify-between">
              <span className="text-[11px] text-[#86868b]">
                {hedgeCount > 0 ? `${hedgeCount} require action` : 'No immediate actions needed'}
              </span>
              <div className="flex items-center gap-3">
                <a
                  href="https://polymarket.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] text-[#007AFF] font-medium"
                >
                  Polymarket <ExternalLink className="w-3 h-3" />
                </a>
                <a
                  href="https://delphi.markets"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[11px] text-ios-blue font-medium"
                >
                  Delphi <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          )}
        </>
      )}

      {/* Action Modal */}
      {selectedPrediction && (
        <div 
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" 
          onClick={() => setSelectedPrediction(null)}
        >
          <div 
            className="bg-white w-full sm:max-w-md sm:rounded-[20px] rounded-t-[20px] shadow-2xl" 
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-5 py-4 border-b border-black/5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 rounded-[12px] flex items-center justify-center ${
                  selectedPrediction.recommendation === 'HEDGE' 
                    ? 'bg-[#FF3B30]' 
                    : 'bg-[#FF9500]'
                }`}>
                  {selectedPrediction.recommendation === 'HEDGE' ? (
                    <Shield className="w-5 h-5 text-white" />
                  ) : (
                    <Eye className="w-5 h-5 text-white" />
                  )}
                </div>
                <div>
                  <h3 className="text-[17px] font-semibold text-[#1d1d1f]">
                    {selectedPrediction.recommendation === 'HEDGE' ? 'Open Hedge' : 'Add to Watchlist'}
                  </h3>
                  <p className="text-[12px] text-[#86868b]">AI Recommendation</p>
                </div>
              </div>
              <button
                onClick={() => setSelectedPrediction(null)}
                className="w-8 h-8 flex items-center justify-center bg-[#f5f5f7] rounded-full"
              >
                <X className="w-4 h-4 text-[#86868b]" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-5">
              {/* Prediction Summary */}
              <div className="p-4 bg-[#f5f5f7] rounded-[14px] mb-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <p className="text-[14px] font-medium text-[#1d1d1f] leading-snug flex-1">
                    {selectedPrediction.question}
                  </p>
                  <div className="text-[28px] font-bold text-label-primary tabular-nums">
                    {selectedPrediction.probability}%
                  </div>
                </div>
                
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] text-[#86868b] uppercase tracking-wide mb-1">Impact</div>
                    <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold ${getImpactStyles(selectedPrediction.impact).bg} ${getImpactStyles(selectedPrediction.impact).text}`}>
                      {selectedPrediction.impact}
                    </span>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#86868b] uppercase tracking-wide mb-1">Confidence</div>
                    <span className="text-[14px] font-semibold text-[#1d1d1f]">{selectedPrediction.confidence}%</span>
                  </div>
                  <div className="col-span-2">
                    <div className="text-[10px] text-[#86868b] uppercase tracking-wide mb-1">Assets</div>
                    <div className="flex gap-1">
                      {selectedPrediction.relatedAssets.map(asset => (
                        <span key={asset} className="px-2 py-0.5 bg-[#007AFF]/10 text-[#007AFF] rounded text-[11px] font-medium">
                          {asset}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Recommendation */}
              <div className="p-3 bg-ios-blue/5 border border-[#AF52DE]/10 rounded-[12px] mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <Bot className="w-4 h-4 text-ios-blue" />
                  <span className="text-[12px] font-bold text-ios-blue uppercase tracking-wide">Agent Recommendation</span>
                </div>
                <p className="text-[13px] text-[#1d1d1f] leading-relaxed">
                  {selectedPrediction.recommendation === 'HEDGE' ? (
                    <>This prediction has <strong>{selectedPrediction.probability}%</strong> probability with <strong>{selectedPrediction.impact}</strong> impact. Consider opening a hedge position to protect your <strong>{selectedPrediction.relatedAssets.join(', ')}</strong> holdings.</>
                  ) : (
                    <>This prediction has <strong>{selectedPrediction.probability}%</strong> probability. Monitor price action for <strong>{selectedPrediction.relatedAssets.join(', ')}</strong> closely.</>
                  )}
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-3">
                <button
                  onClick={() => handleAction(
                    selectedPrediction, 
                    selectedPrediction.recommendation === 'HEDGE' ? 'hedge' : 'monitor'
                  )}
                  className={`flex-1 py-3 rounded-[12px] text-[15px] font-semibold text-white transition-all active:scale-[0.98] ${
                    selectedPrediction.recommendation === 'HEDGE'
                      ? 'bg-[#FF3B30] active:bg-[#E0342B]'
                      : 'bg-[#FF9500] active:bg-[#E08600]'
                  }`}
                >
                  {selectedPrediction.recommendation === 'HEDGE' ? 'Open Hedge' : 'Add to Watchlist'}
                </button>
                <button
                  onClick={() => setSelectedPrediction(null)}
                  className="px-5 py-3 bg-[#f5f5f7] rounded-[12px] text-[15px] font-semibold text-[#1d1d1f] active:bg-[#e8e8ed] transition-all active:scale-[0.98]"
                >
                  Later
                </button>
              </div>
            </div>

            {/* Safe area for mobile */}
            <div className="h-6 sm:hidden" />
          </div>
        </div>
      )}
    </div>
  );
});
