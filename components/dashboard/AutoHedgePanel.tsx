'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { logger } from '@/lib/utils/logger';
import { 
  Shield, 
  Brain, 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  AlertTriangle,
  CheckCircle,
  Clock,
  Zap,
  Settings,
  RefreshCw,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface ActiveHedge {
  id: number | string;
  asset: string;
  side: 'LONG' | 'SHORT';
  size: number;
  notionalValue: number;
  entryPrice: number;
  currentPrice: number;
  pnl: number;
  pnlPercent: number;
  createdAt: string;
}

interface AIDecision {
  id: string;
  action: string;
  reasoning: string;
  riskScore: number;
  executed: boolean;
  timestamp: string;
}

interface PredictionSource {
  name: string;
  available: boolean;
  weight: number;
  direction?: string;
  confidence?: number;
}

interface AggregatedPrediction {
  direction: string;
  confidence: number;
  consensus: number;
  recommendation: string;
  sizeMultiplier: number;
  sources: PredictionSource[];
}

interface RiskAssessment {
  riskScore: number;
  drawdownPercent: number;
  volatility: number;
  recommendations: number;
  lastUpdated: string;
  aggregatedPrediction?: AggregatedPrediction | null;
}

interface AutoHedgeData {
  enabled: boolean;
  config: {
    riskThreshold: number;
    maxLeverage: number;
    allowedAssets: string[];
  } | null;
  activeHedges: ActiveHedge[];
  recentDecisions: AIDecision[];
  riskAssessment: RiskAssessment | null;
  stats: {
    totalHedgeValue: number;
    totalPnL: number;
    hedgeCount: number;
    decisionsToday: number;
  };
}

const RISK_COLORS = {
  low: 'text-green-400',
  medium: 'text-yellow-400',
  high: 'text-orange-400',
  critical: 'text-red-400',
};

const getRiskLevel = (score: number): keyof typeof RISK_COLORS => {
  if (score <= 2) return 'low';
  if (score <= 4) return 'medium';
  if (score <= 6) return 'high';
  return 'critical';
};

interface AutoHedgePanelProps {
  chain?: string;
}

export function AutoHedgePanel({ chain }: AutoHedgePanelProps = {}) {
  // Expanded by default on desktop, collapsed on mobile — reduces the pool
  // page's vertical noise. Set client-side after mount to avoid SSR jump.
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setExpanded(!window.matchMedia('(max-width: 639px)').matches);
  }, []);
  const queryClient = useQueryClient();

  const autoHedgeKey = ['auto-hedge', chain ?? 'default'];

  // react-query pauses refetchInterval when the tab is hidden by default,
  // so we get the old visibility-based pause behavior for free.
  const {
    data,
    isPending: loading,
    error: queryError,
  } = useQuery<AutoHedgeData>({
    queryKey: autoHedgeKey,
    queryFn: async () => {
      const params = chain ? `?chain=${chain}` : '';
      const res = await fetch(`/api/community-pool/auto-hedge${params}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'Failed to fetch');
      return json as AutoHedgeData;
    },
    refetchInterval: 30_000,
    staleTime: 30_000,
  });
  const error = queryError ? (queryError instanceof Error ? queryError.message : 'Network error') : null;

  // Poll operator gas status (SUI only) so the UI can warn when the cron
  // has paused trading due to a low operator balance.
  const { data: gasStatus } = useQuery<{
    configured: boolean;
    address?: string;
    suiBalance?: string;
    hasGas: boolean;
    gasFloorSui?: number;
  }>({
    queryKey: ['sui-admin-wallet'],
    queryFn: async () => {
      const res = await fetch('/api/sui/community-pool?action=admin-wallet');
      const json = await res.json();
      if (!json?.success || !json?.data) throw new Error('gas status unavailable');
      return json.data;
    },
    enabled: chain === 'sui',
    refetchInterval: 60_000,
    staleTime: 60_000,
  });

  const toggleMutation = useMutation({
    mutationFn: async (nextEnabled: boolean) => {
      const res = await fetch('/api/community-pool/auto-hedge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'toggle failed');
      return json;
    },
    onSuccess: (json) => {
      // Optimistic-adjacent: patch cache directly so the UI flips without
      // waiting for the refetch; invalidate to reconcile with server truth.
      queryClient.setQueryData<AutoHedgeData>(autoHedgeKey, (prev) =>
        prev ? { ...prev, enabled: json.config.enabled } : prev
      );
      queryClient.invalidateQueries({ queryKey: autoHedgeKey });
    },
    onError: (err) => {
      logger.error('Failed to toggle auto-hedge', err instanceof Error ? err : undefined);
    },
  });
  const updating = toggleMutation.isPending;

  const toggleAutoHedge = () => {
    if (!data) return;
    toggleMutation.mutate(!data.enabled);
  };

  if (loading) {
    return (
      <div className="bg-slate-800/50 rounded-2xl sm:rounded-xl p-3 sm:p-6 border border-slate-700/50 overflow-hidden min-w-0 max-w-full">
        <div className="flex items-center gap-2 sm:gap-3 mb-4 min-w-0">
          <Shield className="w-5 h-5 sm:w-6 sm:h-6 text-cyan-400 animate-pulse flex-shrink-0" />
          <h3 className="text-sm sm:text-lg font-semibold text-white truncate">Community Pool Auto-Hedge</h3>
        </div>
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-slate-700 rounded w-3/4"></div>
          <div className="h-4 bg-slate-700 rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-slate-800/50 rounded-2xl sm:rounded-xl p-3 sm:p-6 border border-red-700/50 overflow-hidden min-w-0 max-w-full">
        <div className="flex items-center gap-2 sm:gap-3 text-red-400 min-w-0">
          <AlertTriangle className="w-4 h-4 sm:w-5 sm:h-5 flex-shrink-0" />
          <span className="text-xs sm:text-sm break-words min-w-0">{error || 'Failed to load auto-hedge status'}</span>
        </div>
      </div>
    );
  }

  const riskLevel = data.riskAssessment ? getRiskLevel(data.riskAssessment.riskScore) : 'low';

  return (
    <div className="bg-gradient-to-br from-slate-800/80 to-slate-900/80 rounded-2xl sm:rounded-xl border border-slate-700/50 overflow-hidden min-w-0 max-w-full">
      {/* Header — title/subtitle can wrap, controls stay compact on mobile */}
      <div
        className="p-3 sm:p-4 flex items-center justify-between gap-2 cursor-pointer hover:bg-slate-700/20 transition-colors min-w-0"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className={`p-1.5 sm:p-2 rounded-lg flex-shrink-0 ${data.enabled ? 'bg-cyan-500/20' : 'bg-slate-700/50'}`}>
            <Brain className={`w-4 h-4 sm:w-5 sm:h-5 ${data.enabled ? 'text-cyan-400' : 'text-slate-400'}`} />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm sm:text-lg font-semibold text-white flex items-center gap-2 flex-wrap">
              <span className="truncate">Community Pool Auto-Hedge</span>
              {data.enabled && (
                <span className="px-2 py-0.5 text-[10px] sm:text-xs bg-green-500/20 text-green-400 rounded-full flex-shrink-0">
                  Active
                </span>
              )}
            </h3>
            <p className="text-[11px] sm:text-sm text-slate-400 leading-relaxed tabular-nums line-clamp-2">
              AI-managed hedges protecting pool assets • {data.stats.hedgeCount} positions • {data.stats.decisionsToday} decisions today
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); queryClient.invalidateQueries({ queryKey: autoHedgeKey }); }}
            className="p-1.5 sm:p-2 hover:bg-slate-700/50 rounded-lg transition-colors active:scale-[0.96]"
            aria-label="Refresh"
          >
            <RefreshCw className="w-4 h-4 text-slate-400" />
          </button>
          {expanded ? (
            <ChevronUp className="w-5 h-5 text-slate-400" />
          ) : (
            <ChevronDown className="w-5 h-5 text-slate-400" />
          )}
        </div>
      </div>

      {/* Operator gas-low banner (SUI only) — surfaces the cron's paused state */}
      {chain === 'sui' && gasStatus && gasStatus.configured && !gasStatus.hasGas && (
        <div className="px-4 pb-3">
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
            <AlertTriangle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-amber-100">
              <div className="font-semibold text-amber-300">
                Rebalancing paused. Operator wallet low on SUI gas
              </div>
              <div className="mt-1 text-amber-100/80">
                Operator has <span className="font-mono">{gasStatus.suiBalance ?? '0'} SUI</span>
                {gasStatus.gasFloorSui != null && (
                  <> (floor: <span className="font-mono">{gasStatus.gasFloorSui} SUI</span>)</>
                )}.
                The cron will skip swaps and hedge open/close until the wallet is topped up.
              </div>
              {gasStatus.address && (
                <div className="mt-1 font-mono text-xs text-amber-100/60 break-all">
                  Top up: {gasStatus.address}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="px-3 sm:px-4 pb-3 sm:pb-4 space-y-3 sm:space-y-4 min-w-0">
              {/* Toggle and Stats Row — stack on mobile so config chips don't overflow */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-slate-900/50 rounded-xl sm:rounded-lg p-3 sm:p-4 min-w-0">
                <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                  <button
                    onClick={toggleAutoHedge}
                    disabled={updating}
                    className={`relative w-14 h-7 rounded-full transition-colors flex-shrink-0 ${
                      data.enabled ? 'bg-cyan-500' : 'bg-slate-600'
                    }`}
                    aria-label={`${data.enabled ? 'Disable' : 'Enable'} auto-hedging`}
                  >
                    <motion.div
                      className="absolute top-1 w-5 h-5 bg-white rounded-full shadow"
                      animate={{ left: data.enabled ? '32px' : '4px' }}
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    />
                  </button>
                  <span className="text-xs sm:text-sm text-slate-300 truncate">
                    Auto-hedging {data.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>

                {data.config && (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:gap-4 text-[11px] sm:text-sm">
                    <div className="flex items-center gap-1 sm:gap-1.5">
                      <Settings className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500 flex-shrink-0" />
                      <span className="text-slate-400">Threshold:</span>
                      <span className="text-white font-medium tabular-nums">{data.config.riskThreshold}/10</span>
                    </div>
                    <div className="flex items-center gap-1 sm:gap-1.5">
                      <Zap className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-500 flex-shrink-0" />
                      <span className="text-slate-400">Max Lev:</span>
                      <span className="text-white font-medium tabular-nums">{data.config.maxLeverage}x</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Risk Assessment */}
              {data.riskAssessment && (
                <div className="bg-slate-900/50 rounded-xl sm:rounded-lg p-3 sm:p-4 min-w-0">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mb-3">
                    <h4 className="text-xs sm:text-sm font-medium text-slate-300 flex items-center gap-2">
                      <Activity className="w-4 h-4 flex-shrink-0" />
                      Pool Risk Assessment
                    </h4>
                    <span className="text-[10px] sm:text-xs text-slate-500 tabular-nums">
                      Updated {new Date(data.riskAssessment.lastUpdated).toLocaleTimeString()}
                    </span>
                  </div>
                  {/* Quad grid stays 4-col but text scales down + break-all so it can't burst */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                    <div className="text-center min-w-0">
                      <div className={`text-lg sm:text-2xl font-bold tabular-nums break-all ${RISK_COLORS[riskLevel]}`}>
                        {data.riskAssessment.riskScore}/10
                      </div>
                      <div className="text-[10px] sm:text-xs text-slate-500 truncate">Risk Score</div>
                    </div>
                    <div className="text-center min-w-0">
                      <div className="text-lg sm:text-2xl font-bold text-white tabular-nums break-all">
                        {data.riskAssessment.drawdownPercent.toFixed(2)}%
                      </div>
                      <div className="text-[10px] sm:text-xs text-slate-500 truncate">Drawdown</div>
                    </div>
                    <div className="text-center min-w-0">
                      <div className="text-lg sm:text-2xl font-bold text-white tabular-nums break-all">
                        {data.riskAssessment.volatility.toFixed(1)}%
                      </div>
                      <div className="text-[10px] sm:text-xs text-slate-500 truncate">Volatility</div>
                    </div>
                    <div className="text-center min-w-0">
                      <div className="text-lg sm:text-2xl font-bold text-cyan-400 tabular-nums break-all">
                        {data.riskAssessment.recommendations}
                      </div>
                      <div className="text-[10px] sm:text-xs text-slate-500 truncate">Recommendations</div>
                    </div>
                  </div>
                  
                  {/* Multi-Source Prediction Aggregation */}
                  {data.riskAssessment.aggregatedPrediction && (
                    <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t border-slate-700/50 min-w-0">
                      <h5 className="text-[11px] sm:text-xs font-medium text-slate-400 mb-2 sm:mb-3 flex items-center gap-2">
                        <Brain className="w-3.5 h-3.5 flex-shrink-0" />
                        Multi-Source AI Prediction
                      </h5>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 mb-3 min-w-0">
                        <div className="bg-slate-800/50 rounded-lg p-2.5 sm:p-3 min-w-0">
                          <div className="flex items-center justify-between gap-2 mb-1 min-w-0">
                            <span className="text-[11px] sm:text-xs text-slate-500 truncate">Direction</span>
                            <span className={`flex items-center gap-1 font-medium text-xs sm:text-sm flex-shrink-0 ${
                              data.riskAssessment.aggregatedPrediction.direction === 'UP'
                                ? 'text-green-400'
                                : data.riskAssessment.aggregatedPrediction.direction === 'DOWN'
                                ? 'text-red-400'
                                : 'text-slate-400'
                            }`}>
                              {data.riskAssessment.aggregatedPrediction.direction === 'UP' && <TrendingUp className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
                              {data.riskAssessment.aggregatedPrediction.direction === 'DOWN' && <TrendingDown className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
                              {data.riskAssessment.aggregatedPrediction.direction}
                            </span>
                          </div>
                          <div className="text-base sm:text-lg font-bold text-white tabular-nums break-all">
                            {data.riskAssessment.aggregatedPrediction.confidence.toFixed(1)}%
                            <span className="text-[10px] sm:text-xs text-slate-500 ml-1 font-normal">confidence</span>
                          </div>
                        </div>
                        <div className="bg-slate-800/50 rounded-lg p-2.5 sm:p-3 min-w-0">
                          <div className="flex items-center justify-between gap-2 mb-1 min-w-0">
                            <span className="text-[11px] sm:text-xs text-slate-500 truncate">Consensus</span>
                            <span className="text-[11px] sm:text-xs text-slate-400 flex-shrink-0 tabular-nums">
                              {data.riskAssessment.aggregatedPrediction.sources.filter(s => s.available).length} sources
                            </span>
                          </div>
                          <div className="text-base sm:text-lg font-bold text-white tabular-nums break-all">
                            {data.riskAssessment.aggregatedPrediction.consensus.toFixed(1)}%
                            <span className="text-[10px] sm:text-xs text-slate-500 ml-1 font-normal">agreement</span>
                          </div>
                        </div>
                      </div>

                      {/* Recommendation Badge — wraps content on tiny screens */}
                      <div className={`inline-flex flex-wrap items-center gap-1.5 sm:gap-2 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs sm:text-sm font-medium max-w-full ${
                        data.riskAssessment.aggregatedPrediction.recommendation.includes('STRONG')
                          ? data.riskAssessment.aggregatedPrediction.recommendation.includes('SHORT')
                            ? 'bg-red-500/20 text-red-400'
                            : 'bg-green-500/20 text-green-400'
                          : data.riskAssessment.aggregatedPrediction.recommendation.includes('SHORT')
                            ? 'bg-orange-500/20 text-orange-400'
                            : data.riskAssessment.aggregatedPrediction.recommendation.includes('LONG')
                              ? 'bg-emerald-500/20 text-emerald-400'
                              : 'bg-slate-500/20 text-slate-400'
                      }`}>
                        <Zap className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="break-words">{data.riskAssessment.aggregatedPrediction.recommendation.replace(/_/g, ' ')}</span>
                        <span className="text-[10px] sm:text-xs opacity-70 tabular-nums">
                          ({data.riskAssessment.aggregatedPrediction.sizeMultiplier}x size)
                        </span>
                      </div>

                      {/* Source Breakdown */}
                      <div className="mt-2 sm:mt-3 flex flex-wrap gap-1.5 sm:gap-2">
                        {data.riskAssessment.aggregatedPrediction.sources.map((source) => (
                          <div
                            key={source.name}
                            className={`flex items-center gap-1 sm:gap-1.5 px-2 py-1 rounded text-[10px] sm:text-xs ${
                              source.available
                                ? 'bg-slate-700/50 text-slate-300'
                                : 'bg-slate-800/30 text-slate-500'
                            }`}
                          >
                            {source.available ? (
                              <CheckCircle className="w-3 h-3 text-green-400 flex-shrink-0" />
                            ) : (
                              <Clock className="w-3 h-3 text-slate-600 flex-shrink-0" />
                            )}
                            <span className="truncate max-w-[100px]">{source.name}</span>
                            {source.available && source.direction && (
                              <span className={`font-medium flex-shrink-0 ${
                                source.direction === 'UP' ? 'text-green-400' :
                                source.direction === 'DOWN' ? 'text-red-400' : 'text-slate-400'
                              }`}>
                                {source.direction === 'UP' ? '↑' : source.direction === 'DOWN' ? '↓' : '-'}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Active Hedges. Row layout collapses so long PnL values don't burst */}
              {data.activeHedges.length > 0 && (
                <div className="bg-slate-900/50 rounded-xl sm:rounded-lg p-3 sm:p-4 min-w-0">
                  <h4 className="text-xs sm:text-sm font-medium text-slate-300 flex items-center gap-2 mb-3 flex-wrap">
                    <Shield className="w-4 h-4 flex-shrink-0" />
                    <span>Pool Hedge Positions ({data.activeHedges.length})</span>
                  </h4>
                  <div className="space-y-2">
                    {data.activeHedges.map((hedge) => (
                      <div
                        key={hedge.id}
                        className="flex items-center justify-between gap-2 sm:gap-3 bg-slate-800/50 rounded-lg p-2.5 sm:p-3 min-w-0"
                      >
                        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 flex-wrap">
                          <span className={`px-2 py-1 rounded text-[10px] sm:text-xs font-medium flex-shrink-0 ${
                            hedge.side === 'LONG'
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-red-500/20 text-red-400'
                          }`}>
                            {hedge.side}
                          </span>
                          <span className="text-white font-medium text-xs sm:text-sm truncate">{hedge.asset}</span>
                          <span className="text-slate-400 text-[11px] sm:text-sm tabular-nums truncate">
                            ${hedge.notionalValue.toLocaleString()}
                          </span>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <div className={`font-medium text-xs sm:text-sm tabular-nums ${
                            hedge.pnl >= 0 ? 'text-green-400' : 'text-red-400'
                          }`}>
                            {hedge.pnl >= 0 ? '+' : ''}${hedge.pnl.toFixed(2)}
                          </div>
                          <div className="text-[10px] sm:text-xs text-slate-500 tabular-nums">
                            {hedge.pnlPercent >= 0 ? '+' : ''}{hedge.pnlPercent.toFixed(2)}%
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-700 flex justify-between gap-2 text-xs sm:text-sm">
                    <span className="text-slate-400 truncate">Total Hedge Value</span>
                    <span className="text-white font-medium tabular-nums flex-shrink-0">
                      ${data.stats.totalHedgeValue.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2 text-xs sm:text-sm">
                    <span className="text-slate-400 truncate">Total P&L</span>
                    <span className={`font-medium tabular-nums flex-shrink-0 ${
                      data.stats.totalPnL >= 0 ? 'text-green-400' : 'text-red-400'
                    }`}>
                      {data.stats.totalPnL >= 0 ? '+' : ''}${data.stats.totalPnL.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}

              {/* No Hedges State */}
              {data.activeHedges.length === 0 && (
                <div className="bg-slate-900/50 rounded-xl sm:rounded-lg p-4 sm:p-6 text-center">
                  <Shield className="w-8 h-8 sm:w-10 sm:h-10 text-slate-600 mx-auto mb-2" />
                  <p className="text-slate-400 text-xs sm:text-sm">No active pool hedges</p>
                  <p className="text-slate-500 text-[11px] sm:text-xs leading-relaxed">
                    AI agents will open hedges when pool risk exceeds threshold
                  </p>
                </div>
              )}

              {/* Recent AI Decisions */}
              {data.recentDecisions.length > 0 && (
                <div className="bg-slate-900/50 rounded-xl sm:rounded-lg p-3 sm:p-4 min-w-0">
                  <h4 className="text-xs sm:text-sm font-medium text-slate-300 flex items-center gap-2 mb-3 flex-wrap">
                    <Brain className="w-4 h-4 flex-shrink-0" />
                    <span>Pool AI Decisions</span>
                    {data.recentDecisions.length > 5 && (
                      <span className="text-[10px] sm:text-xs text-slate-500 font-normal tabular-nums">
                        (showing latest {Math.min(data.recentDecisions.length, 25)} of {data.stats.decisionsToday} today)
                      </span>
                    )}
                  </h4>
                  <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                    {data.recentDecisions.slice(0, 25).map((decision) => (
                      <div
                        key={decision.id}
                        className="flex items-start gap-2 sm:gap-3 bg-slate-800/50 rounded-lg p-2.5 sm:p-3 min-w-0"
                      >
                        <div className={`p-1.5 rounded-full flex-shrink-0 ${
                          decision.action === 'REBALANCE' || decision.action === 'HEDGE'
                            ? 'bg-cyan-500/20'
                            : 'bg-slate-700'
                        }`}>
                          {decision.executed ? (
                            <CheckCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-green-400" />
                          ) : (
                            <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`px-2 py-0.5 rounded text-[10px] sm:text-xs font-medium flex-shrink-0 ${
                              decision.action === 'HOLD'
                                ? 'bg-slate-600 text-slate-300'
                                : decision.action === 'REBALANCE'
                                ? 'bg-cyan-500/20 text-cyan-400'
                                : 'bg-yellow-500/20 text-yellow-400'
                            }`}>
                              {decision.action}
                            </span>
                            <span className={`text-[10px] sm:text-xs tabular-nums ${RISK_COLORS[getRiskLevel(decision.riskScore)]}`}>
                              Risk: {decision.riskScore}/10
                            </span>
                          </div>
                          <p className="text-xs sm:text-sm text-slate-300 mt-1 line-clamp-2 break-words leading-relaxed">
                            {decision.reasoning}
                          </p>
                          <p className="text-[10px] sm:text-xs text-slate-500 mt-1 tabular-nums">
                            {new Date(decision.timestamp).toLocaleString()}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* No Decisions State */}
              {data.recentDecisions.length === 0 && (
                <div className="bg-slate-900/50 rounded-xl sm:rounded-lg p-4 sm:p-6 text-center">
                  <Brain className="w-8 h-8 sm:w-10 sm:h-10 text-slate-600 mx-auto mb-2" />
                  <p className="text-slate-400 text-xs sm:text-sm">No AI decisions yet</p>
                  <p className="text-slate-500 text-[11px] sm:text-xs leading-relaxed">
                    AI evaluates pool risk every 5 minutes
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
