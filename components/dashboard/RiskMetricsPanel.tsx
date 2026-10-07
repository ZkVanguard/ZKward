'use client';

import { useState, useEffect, useCallback, memo, useRef } from 'react';
import { 
  Shield, 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  AlertTriangle,
  BarChart2,
  Target,
  Zap,
  Info,
  RefreshCw,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { usePolling } from '@/lib/hooks';
import { logger } from '@/lib/utils/logger';

interface RiskMetrics {
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownDate: string | null;
  currentDrawdown: number;
  volatilityDaily: number;
  volatilityAnnualized: number;
  downsideVolatility: number;
  var95Daily: number;
  var95Weekly: number;
  cvar95: number;
  beta: number;
  alpha: number;
  treynorRatio: number;
  informationRatio: number;
  calmarRatio: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  returns7d: number | null;
  returns30d: number | null;
  returns90d: number | null;
  returnsYTD: number | null;
  returnsSinceInception: number;
  dataPoints: number;
  lastCalculated: string;
  periodStart: string | null;
  periodEnd: string | null;
  insufficientData?: boolean;
  insufficientDataReason?: string;
  preliminaryMetrics?: boolean;
}

interface RiskRating {
  rating: string;
  color: string;
  description: string;
}

interface RiskMetricsPanelProps {
  compact?: boolean;
  chain?: 'hedera' | 'sui' | 'all';
}

// Color classes for metric values
const getMetricColor = (value: number, thresholds: { good: number; warning: number }, inverse = false) => {
  if (inverse) {
    if (value <= thresholds.good) return 'text-green-600 dark:text-green-400';
    if (value <= thresholds.warning) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-red-600 dark:text-red-400';
  }
  if (value >= thresholds.good) return 'text-green-600 dark:text-green-400';
  if (value >= thresholds.warning) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
};

// Format percentage with sign
const formatPct = (value: number, showSign = true) => {
  const sign = showSign && value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
};

// Render a period return cell that gracefully handles "insufficient history"
const renderPeriodReturn = (value: number | null) => {
  if (value === null || value === undefined) {
    return <span className="font-bold text-gray-400 dark:text-gray-500" title="Insufficient history for this period">—</span>;
  }
  return (
    <span className={`font-bold ${value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
      {formatPct(value)}
    </span>
  );
};

// Metric card component
const MetricCard = memo(function MetricCard({ 
  label, 
  value, 
  tooltip, 
  icon: Icon,
  color = 'text-gray-900 dark:text-white',
  subValue,
}: { 
  label: string; 
  value: string | number; 
  tooltip?: string;
  icon?: any;
  color?: string;
  subValue?: string;
}) {
  const [showTooltip, setShowTooltip] = useState(false);
  
  return (
    <div
      className="relative p-2.5 sm:p-3 bg-gray-50 dark:bg-gray-800/50 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors min-w-0"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div className="flex items-center justify-between gap-1 min-w-0">
        <div className="flex items-center gap-1.5 sm:gap-2 min-w-0">
          {Icon && <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-gray-400 flex-shrink-0" />}
          <span className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 truncate">{label}</span>
          {tooltip && (
            <Info className="w-3 h-3 text-gray-400 cursor-help flex-shrink-0" />
          )}
        </div>
      </div>
      <p className={`text-base sm:text-lg font-bold mt-1 tabular-nums break-all ${color}`}>{value}</p>
      {subValue && (
        <p className="text-[10px] sm:text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{subValue}</p>
      )}
      
      {/* Tooltip */}
      <AnimatePresence>
        {showTooltip && tooltip && (
          <motion.div
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 5 }}
            className="absolute z-50 bottom-full left-0 mb-2 p-2 bg-gray-900 text-white text-xs rounded-lg shadow-lg max-w-xs"
          >
            {tooltip}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

export const RiskMetricsPanel = memo(function RiskMetricsPanel({ compact = false, chain = 'all' }: RiskMetricsPanelProps) {
  const [metrics, setMetrics] = useState<RiskMetrics | null>(null);
  const [riskRating, setRiskRating] = useState<RiskRating | null>(null);
  const [loading, setLoading] = useState(true);
  // Expanded by default on desktop, collapsed on mobile so the pool page
  // isn't a wall of stat cards. useEffect updates once the media query
  // resolves client-side; SSR gets desktop-default to avoid layout shift.
  const [expanded, setExpanded] = useState(!compact);
  useEffect(() => {
    if (typeof window === 'undefined' || compact) return;
    setExpanded(!window.matchMedia('(max-width: 639px)').matches);
  }, [compact]);
  const [error, setError] = useState<string | null>(null);
  const lastFetchRef = useRef<number>(0);
  
  const fetchMetrics = useCallback(async (force = false) => {
    // OPTIMIZATION: Client-side debounce - skip if fetched within last 30s
    const now = Date.now();
    if (!force && now - lastFetchRef.current < 30000) {
      return;
    }
    lastFetchRef.current = now;
    
    try {
      const res = await fetch(`/api/community-pool/risk-metrics?chain=${chain}`);
      const json = await res.json();
      
      if (json.success) {
        setMetrics(json.metrics);
        setRiskRating(json.riskRating);
        setError(null);
      } else {
        setError(json.error);
      }
    } catch (err: any) {
      logger.error('[RiskMetrics] Fetch error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [chain]);
  
  useEffect(() => {
    setLoading(true);
    fetchMetrics(true); // Force fetch when chain changes
  }, [fetchMetrics, chain]);
  
  // Refresh every 5 minutes
  usePolling(fetchMetrics, 5 * 60 * 1000);
  
  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl sm:rounded-xl shadow-lg p-3 sm:p-4 animate-pulse overflow-hidden min-w-0 max-w-full">
        <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-4"></div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="h-20 bg-gray-200 dark:bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl sm:rounded-xl shadow-lg p-3 sm:p-4 overflow-hidden min-w-0 max-w-full">
        <p className="text-red-500 text-sm">Failed to load risk metrics</p>
      </div>
    );
  }

  // Show message when insufficient data
  if (metrics.insufficientData) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl sm:rounded-xl shadow-lg overflow-hidden min-w-0 max-w-full">
        <div className="bg-gradient-to-r from-slate-700 to-slate-900 p-3 sm:p-4">
          <div className="flex items-center justify-between gap-2 min-w-0">
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <Shield className="w-5 h-5 sm:w-6 sm:h-6 text-white flex-shrink-0" />
              <div className="min-w-0">
                <h3 className="text-white font-semibold text-sm sm:text-base truncate">Risk Analytics</h3>
                <p className="text-slate-300 text-[11px] sm:text-xs truncate">Institutional-grade risk metrics</p>
              </div>
            </div>
          </div>
        </div>
        <div className="p-4 sm:p-6 text-center">
          <AlertTriangle className="w-10 h-10 sm:w-12 sm:h-12 text-yellow-500 mx-auto mb-3" />
          <h4 className="text-base sm:text-lg font-semibold text-gray-800 dark:text-white mb-2">
            Insufficient Performance Data
          </h4>
          <p className="text-gray-600 dark:text-gray-400 text-xs sm:text-sm mb-4 leading-relaxed">
            {metrics.insufficientDataReason || 'Risk metrics require historical share price data to calculate.'}
          </p>
          <div className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-500 leading-relaxed">
            Risk metrics will become available as the pool accumulates performance history with actual share price changes.
          </div>
        </div>
      </div>
    );
  }
  
  const riskColorClass = riskRating?.rating === 'Low' ? 'text-green-500' 
    : riskRating?.rating === 'Moderate' ? 'text-yellow-500' 
    : 'text-red-500';
  
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl sm:rounded-xl shadow-lg overflow-hidden min-w-0 max-w-full">
      {/* Header — controls wrap onto a second line on narrow screens */}
      <div
        className="bg-gradient-to-r from-slate-700 to-slate-900 p-3 sm:p-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div className="p-1.5 sm:p-2 bg-white/10 rounded-lg flex-shrink-0">
              <Shield className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-bold text-white truncate">Risk Analytics</h2>
              <p className="text-[11px] sm:text-xs text-gray-300 truncate">Institutional-grade risk metrics</p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-4 flex-shrink-0">
            {/* Risk Rating Badge — compact on mobile */}
            <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1 sm:py-1.5 bg-white/10 rounded-lg">
              <AlertTriangle className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${riskColorClass}`} />
              <span className={`font-semibold text-xs sm:text-sm ${riskColorClass}`}>
                <span className="hidden sm:inline">{riskRating?.rating} Risk</span>
                <span className="sm:hidden">{riskRating?.rating}</span>
              </span>
            </div>

            <button
              onClick={(e) => { e.stopPropagation(); fetchMetrics(); }}
              className="p-1.5 sm:p-2 hover:bg-white/20 rounded-lg transition-colors active:scale-[0.96]"
              title="Refresh metrics"
              aria-label="Refresh metrics"
            >
              <RefreshCw className="w-4 h-4 text-white" />
            </button>

            {expanded ? (
              <ChevronUp className="w-5 h-5 text-white" />
            ) : (
              <ChevronDown className="w-5 h-5 text-white" />
            )}
          </div>
        </div>
      </div>

      {/* Preliminary metrics banner — annualized values from < 30 days of history */}
      {metrics.preliminaryMetrics && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border-b border-amber-200 dark:border-amber-700 px-4 py-2 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-amber-800 dark:text-amber-200">
            <span className="font-semibold">Preliminary metrics:</span>{' '}
            annualized values (volatility, alpha, Sharpe) are extrapolated from less than 30 days of NAV history and may be highly unstable. Treat with caution until more history accumulates.
          </p>
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
            {/* Key Metrics Row — text scales down on mobile */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-0.5 p-0.5 bg-gray-100 dark:bg-gray-900">
              <div className="bg-white dark:bg-gray-800 p-3 sm:p-4 text-center min-w-0">
                <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mb-1 truncate">Sharpe Ratio</p>
                <p className={`text-lg sm:text-2xl font-bold tabular-nums break-all ${getMetricColor(metrics.sharpeRatio, { good: 1.0, warning: 0.5 })}`}>
                  {metrics.sharpeRatio.toFixed(2)}
                </p>
                <p className="text-[10px] sm:text-xs text-gray-400 mt-1 truncate">Risk-adjusted</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-3 sm:p-4 text-center min-w-0">
                <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mb-1 truncate">Max Drawdown</p>
                <p className={`text-lg sm:text-2xl font-bold tabular-nums break-all ${getMetricColor(metrics.maxDrawdown, { good: 10, warning: 25 }, true)}`}>
                  -{metrics.maxDrawdown.toFixed(1)}%
                </p>
                <p className="text-[10px] sm:text-xs text-gray-400 mt-1 truncate">Peak to trough</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-3 sm:p-4 text-center min-w-0">
                <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mb-1 truncate">VaR (95%)</p>
                <p className={`text-lg sm:text-2xl font-bold tabular-nums break-all ${getMetricColor(metrics.var95Daily, { good: 3, warning: 5 }, true)}`}>
                  -{metrics.var95Daily.toFixed(1)}%
                </p>
                <p className="text-[10px] sm:text-xs text-gray-400 mt-1 truncate">Daily max loss</p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-3 sm:p-4 text-center min-w-0">
                <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 mb-1 truncate">Win Rate</p>
                <p className={`text-lg sm:text-2xl font-bold tabular-nums break-all ${getMetricColor(metrics.winRate, { good: 55, warning: 45 })}`}>
                  {metrics.winRate.toFixed(1)}%
                </p>
                <p className="text-[10px] sm:text-xs text-gray-400 mt-1 truncate">Daily returns</p>
              </div>
            </div>

            {/* Performance Returns — 5-col grid busts mobile; use 3-col on <sm */}
            <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700 min-w-0">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 flex-shrink-0" />
                Performance Returns
              </h3>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                <div className="text-center p-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg min-w-0">
                  <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">7D</p>
                  <p className="text-xs sm:text-sm tabular-nums break-all">{renderPeriodReturn(metrics.returns7d)}</p>
                </div>
                <div className="text-center p-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg min-w-0">
                  <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">30D</p>
                  <p className="text-xs sm:text-sm tabular-nums break-all">{renderPeriodReturn(metrics.returns30d)}</p>
                </div>
                <div className="text-center p-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg min-w-0">
                  <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">90D</p>
                  <p className="text-xs sm:text-sm tabular-nums break-all">{renderPeriodReturn(metrics.returns90d)}</p>
                </div>
                <div className="text-center p-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg min-w-0">
                  <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">YTD</p>
                  <p className="text-xs sm:text-sm tabular-nums break-all">{renderPeriodReturn(metrics.returnsYTD)}</p>
                </div>
                <div className="text-center p-2 bg-gray-50 dark:bg-gray-800/50 rounded-lg min-w-0 col-span-3 sm:col-span-1">
                  <p className="text-[11px] sm:text-xs text-gray-500 dark:text-gray-400">
                    {metrics.periodStart ? (
                      (() => {
                        const start = new Date(metrics.periodStart);
                        const now = new Date();
                        const hoursDiff = Math.floor((now.getTime() - start.getTime()) / (1000 * 60 * 60));
                        if (hoursDiff < 48) return `${hoursDiff}h`;
                        const daysDiff = Math.floor(hoursDiff / 24);
                        return `${daysDiff}d`;
                      })()
                    ) : 'Since Start'}
                  </p>
                  <p className={`text-xs sm:text-sm font-bold tabular-nums break-all ${metrics.returnsSinceInception >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {formatPct(metrics.returnsSinceInception)}
                  </p>
                </div>
              </div>
            </div>
            
            {/* Risk Metrics Grid */}
            <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700 min-w-0">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <Activity className="w-4 h-4 flex-shrink-0" />
                Risk Metrics
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3 min-w-0">
                <MetricCard 
                  label="Sortino Ratio"
                  value={metrics.sortinoRatio.toFixed(2)}
                  tooltip="Risk-adjusted return using only downside volatility. Higher is better."
                  icon={Target}
                  color={getMetricColor(metrics.sortinoRatio, { good: 1.5, warning: 0.8 })}
                />
                <MetricCard 
                  label="Volatility (Ann.)"
                  value={`${metrics.volatilityAnnualized.toFixed(1)}%`}
                  tooltip="Annualized standard deviation of daily returns. Lower indicates more stable returns."
                  icon={Activity}
                  color={getMetricColor(metrics.volatilityAnnualized, { good: 25, warning: 40 }, true)}
                />
                <MetricCard 
                  label="Current Drawdown"
                  value={`-${metrics.currentDrawdown.toFixed(1)}%`}
                  tooltip="Current distance from all-time high NAV."
                  icon={TrendingDown}
                  color={getMetricColor(metrics.currentDrawdown, { good: 5, warning: 15 }, true)}
                />
                <MetricCard 
                  label="CVaR (95%)"
                  value={`-${metrics.cvar95.toFixed(1)}%`}
                  tooltip="Expected Shortfall - average loss when losses exceed VaR threshold."
                  icon={AlertTriangle}
                  color={getMetricColor(metrics.cvar95, { good: 4, warning: 7 }, true)}
                />
              </div>
            </div>
            
            {/* Market Exposure */}
            <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700 min-w-0">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <BarChart2 className="w-4 h-4 flex-shrink-0" />
                <span className="truncate">Market Exposure (vs BTC Benchmark)</span>
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3 min-w-0">
                <MetricCard 
                  label="Beta"
                  value={metrics.beta.toFixed(2)}
                  tooltip="Sensitivity to benchmark movements. 1.0 = same as benchmark. <1 = lower volatility."
                  icon={Activity}
                  subValue={metrics.beta < 0.8 ? 'Defensive' : metrics.beta > 1.2 ? 'Aggressive' : 'Neutral'}
                />
                <MetricCard 
                  label="Alpha (Ann.)"
                  value={`${metrics.alpha >= 0 ? '+' : ''}${metrics.alpha.toFixed(1)}%`}
                  tooltip="Jensen's Alpha - excess return over CAPM expected return. Positive = outperforming."
                  icon={Zap}
                  color={metrics.alpha >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}
                />
                <MetricCard 
                  label="Treynor Ratio"
                  value={metrics.treynorRatio.toFixed(2)}
                  tooltip="Excess return per unit of systematic risk (beta). Higher is better."
                  icon={Target}
                  color={getMetricColor(metrics.treynorRatio, { good: 0.1, warning: 0.05 })}
                />
                <MetricCard 
                  label="Information Ratio"
                  value={metrics.informationRatio.toFixed(2)}
                  tooltip="Excess return per unit of tracking error vs benchmark. Higher shows better active management."
                  icon={BarChart2}
                  color={getMetricColor(metrics.informationRatio, { good: 0.5, warning: 0.2 })}
                />
              </div>
            </div>
            
            {/* Trading Statistics */}
            <div className="p-3 sm:p-4 min-w-0">
              <h3 className="text-xs sm:text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 flex-shrink-0" />
                Trading Statistics
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3 min-w-0">
                <MetricCard 
                  label="Calmar Ratio"
                  value={metrics.calmarRatio.toFixed(2)}
                  tooltip="Annual return divided by max drawdown. Higher indicates better risk-adjusted performance."
                  icon={Target}
                  color={getMetricColor(metrics.calmarRatio, { good: 1.0, warning: 0.5 })}
                />
                <MetricCard 
                  label="Profit Factor"
                  value={metrics.profitFactor.toFixed(2)}
                  tooltip="Ratio of gross profits to gross losses. >1.5 is good, >2 is excellent."
                  icon={TrendingUp}
                  color={getMetricColor(metrics.profitFactor, { good: 1.5, warning: 1.0 })}
                />
                <MetricCard 
                  label="Avg Win"
                  value={`+${metrics.avgWin.toFixed(2)}%`}
                  tooltip="Average return on profitable days."
                  icon={TrendingUp}
                  color="text-green-600 dark:text-green-400"
                />
                <MetricCard 
                  label="Avg Loss"
                  value={`-${metrics.avgLoss.toFixed(2)}%`}
                  tooltip="Average return on losing days."
                  icon={TrendingDown}
                  color="text-red-600 dark:text-red-400"
                />
              </div>
            </div>
            
            {/* Footer — stacks on mobile so text lines don't get clipped */}
            <div className="px-3 sm:px-4 py-3 bg-gray-50 dark:bg-gray-800/50 text-[11px] sm:text-xs text-gray-500 dark:text-gray-400 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2 min-w-0">
              <span className="break-words leading-relaxed">
                Based on {metrics.dataPoints} data points • Risk-free rate: 5.0% • Benchmark: BTC
              </span>
              <span className="break-words tabular-nums flex-shrink-0">
                Updated: {new Date(metrics.lastCalculated).toLocaleString()}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
