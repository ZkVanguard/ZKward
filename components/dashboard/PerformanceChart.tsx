'use client';

import { useState, useEffect, useMemo } from 'react';
import { logger } from '@/lib/utils/logger';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ChartOptions,
  ChartData,
} from 'chart.js';
import { Line } from 'react-chartjs-2';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { SkeletonBox } from '@/components/dashboard/community-pool/Skeletons';

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface ChartDataPoint {
  timestamp: number;
  date: string;
  value: number;
  pnl: number;
  pnlPercentage: number;
  hedgePnL?: number;          // Real hedge PnL from HedgeExecutor
  verifiedOnchain?: boolean;  // True if data from blockchain
}

interface PerformanceMetrics {
  currentValue: number;
  initialValue: number;
  highestValue: number;
  lowestValue: number;
  totalPnL: number;
  totalPnLPercentage: number;
  dailyPnL: number;
  dailyPnLPercentage: number;
  weeklyPnL: number;
  weeklyPnLPercentage: number;
  monthlyPnL: number;
  monthlyPnLPercentage: number;
  volatility: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  // On-chain specific
  activeHedges?: number;
  totalHedgePnL?: number;
  verifiedOnchain?: boolean;
}

interface AssetWithChange {
  symbol: string;
  value: number;
  change24h: number;
}

interface PerformanceChartProps {
  walletAddress: string;
  currentValue?: number;
  assets?: AssetWithChange[];
  onMetricsLoaded?: (metrics: PerformanceMetrics) => void;
}

/**
 * Calculate estimated PnL metrics from asset 24h changes
 * Used when no historical data exists yet
 */
function calculateEstimatedMetrics(
  assets: AssetWithChange[],
  totalValue: number
): PerformanceMetrics {
  // Calculate weighted 24h PnL from assets
  const totalChange24h = assets.reduce((acc, asset) => {
    const weight = totalValue > 0 ? asset.value / totalValue : 0;
    return acc + (asset.change24h * weight);
  }, 0);

  // Estimate the value yesterday based on 24h change
  const valueYesterday = totalValue / (1 + totalChange24h / 100);
  const dailyPnL = totalValue - valueYesterday;

  return {
    currentValue: totalValue,
    initialValue: valueYesterday,
    highestValue: totalValue,
    lowestValue: Math.min(totalValue, valueYesterday),
    totalPnL: dailyPnL,
    totalPnLPercentage: totalChange24h,
    dailyPnL,
    dailyPnLPercentage: totalChange24h,
    weeklyPnL: dailyPnL, // Estimate weekly as same (no weekly data)
    weeklyPnLPercentage: totalChange24h,
    monthlyPnL: dailyPnL, 
    monthlyPnLPercentage: totalChange24h,
    volatility: 0,
    sharpeRatio: 0,
    maxDrawdown: 0,
    winRate: totalChange24h >= 0 ? 100 : 0,
    verifiedOnchain: false, // Estimated, not verified
  };
}

type TimeRange = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL';

export default function PerformanceChart({ 
  walletAddress, 
  currentValue,
  assets,
  onMetricsLoaded 
}: PerformanceChartProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>('1W');
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOnchainVerified, setIsOnchainVerified] = useState(false);

  // Fetch history data from PostgreSQL (on-chain verified)
  useEffect(() => {
    async function fetchHistory() {
      if (!walletAddress) return;
      
      setLoading(true);
      setError(null);
      
      try {
        // Fetch with realtime=true to get latest hedge PnL
        const response = await fetch(
          `/api/portfolio/history?address=${encodeURIComponent(walletAddress)}&range=${timeRange}&realtime=true`
        );
        
        if (!response.ok) {
          throw new Error('Failed to fetch history');
        }
        
        const data = await response.json();
        
        if (data.chartData?.length > 0) {
          setChartData(data.chartData);
          setIsOnchainVerified(data.verifiedOnchain || data.chartData.some((d: ChartDataPoint) => d.verifiedOnchain));
        } else {
          // No historical data yet - show empty state (no synthetic data)
          setChartData([]);
          setIsOnchainVerified(false);
        }
        
        // Check if metrics have meaningful data (not all zeros)
        const hasRealMetrics = data.metrics && (
          data.metrics.dailyPnL !== 0 ||
          data.metrics.weeklyPnL !== 0 ||
          data.metrics.monthlyPnL !== 0 ||
          data.metrics.totalPnL !== 0
        );
        
        if (hasRealMetrics) {
          setMetrics(data.metrics);
          setIsOnchainVerified(data.metrics.verifiedOnchain || false);
          onMetricsLoaded?.(data.metrics);
        } else if (assets && assets.length > 0 && currentValue && currentValue > 0) {
          // No meaningful metrics from API - calculate estimated PnL from asset 24h changes
          const estimatedMetrics = calculateEstimatedMetrics(assets, currentValue);
          setMetrics(estimatedMetrics);
          onMetricsLoaded?.(estimatedMetrics);
        } else if (data.metrics) {
          // Fallback to API metrics even if zeros
          setMetrics(data.metrics);
          onMetricsLoaded?.(data.metrics);
        }
      } catch (err) {
        logger.error('[PerformanceChart] Error', err instanceof Error ? err : undefined);
        setError(err instanceof Error ? err.message : 'Failed to load');
        setChartData([]);
      } finally {
        setLoading(false);
      }
    }
    
    fetchHistory();
  }, [walletAddress, timeRange]); // Only re-fetch when wallet or time range changes

  // Record snapshot removed - handled by PositionsContext

  // Chart configuration
  const chartOptions: ChartOptions<'line'> = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index' as const,
      intersect: false,
    },
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        titleColor: '#fff',
        bodyColor: '#fff',
        padding: 12,
        cornerRadius: 8,
        displayColors: false,
        callbacks: {
          title: (items) => {
            const point = chartData[items[0]?.dataIndex];
            if (!point) return '';
            return new Date(point.timestamp).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            });
          },
          label: (context) => {
            const point = chartData[context.dataIndex];
            if (!point) return '';
            
            const value = `$${point.value.toLocaleString('en-US', { 
              minimumFractionDigits: 2,
              maximumFractionDigits: 2 
            })}`;
            
            const pnlSign = point.pnl >= 0 ? '+' : '';
            const pnl = `${pnlSign}$${point.pnl.toLocaleString('en-US', { 
              minimumFractionDigits: 2,
              maximumFractionDigits: 2 
            })} (${pnlSign}${point.pnlPercentage.toFixed(2)}%)`;
            
            return [value, pnl];
          },
        },
      },
    },
    scales: {
      x: {
        display: true,
        grid: {
          display: false,
        },
        ticks: {
          color: '#86868b',
          font: { size: 10 },
          maxTicksLimit: 6,
          callback: function(value) {
            const point = chartData[value as number];
            if (!point) return '';
            const date = new Date(point.timestamp);
            if (timeRange === '1D') {
              return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            }
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          },
        },
      },
      y: {
        display: true,
        position: 'right' as const,
        grid: {
          color: 'rgba(0, 0, 0, 0.05)',
        },
        ticks: {
          color: '#86868b',
          font: { size: 10 },
          callback: (value) => {
            const num = value as number;
            if (num >= 1000000) return `$${(num / 1000000).toFixed(1)}M`;
            if (num >= 1000) return `$${(num / 1000).toFixed(0)}K`;
            return `$${num.toFixed(0)}`;
          },
        },
      },
    },
  }), [chartData, timeRange]);

  // Prepare chart data
  const chartDataset: ChartData<'line'> = useMemo(() => {
    if (chartData.length === 0) {
      return { labels: [], datasets: [] };
    }

    const isPositive = chartData.length > 1 
      ? chartData[chartData.length - 1].value >= chartData[0].value
      : true;
    
    const lineColor = isPositive ? '#34C759' : '#FF3B30';
    const gradientTop = isPositive ? 'rgba(52, 199, 89, 0.2)' : 'rgba(255, 59, 48, 0.2)';

    return {
      labels: chartData.map((_, i) => i.toString()),
      datasets: [
        {
          data: chartData.map(d => d.value),
          borderColor: lineColor,
          backgroundColor: (context) => {
            const ctx = context.chart.ctx;
            const gradient = ctx.createLinearGradient(0, 0, 0, context.chart.height);
            gradient.addColorStop(0, gradientTop);
            gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
            return gradient;
          },
          borderWidth: 2,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHoverBackgroundColor: lineColor,
          pointHoverBorderColor: '#fff',
          pointHoverBorderWidth: 2,
        },
      ],
    };
  }, [chartData]);

  // Calculate period PnL
  const periodPnL = useMemo(() => {
    if (chartData.length < 2) return { value: 0, percentage: 0 };
    const first = chartData[0];
    const last = chartData[chartData.length - 1];
    return {
      value: last.value - first.value,
      percentage: first.value > 0 ? ((last.value - first.value) / first.value) * 100 : 0,
    };
  }, [chartData]);

  const timeRangeButtons: { value: TimeRange; label: string }[] = [
    { value: '1D', label: '1D' },
    { value: '1W', label: '1W' },
    { value: '1M', label: '1M' },
    { value: '3M', label: '3M' },
    { value: '1Y', label: '1Y' },
    { value: 'ALL', label: 'All' },
  ];

  if (loading && chartData.length === 0) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="flex gap-2">{[0, 1, 2, 3, 4].map((i) => <SkeletonBox key={i} className="h-7 w-10 rounded-lg" />)}</div>
        <SkeletonBox className="h-56 rounded-xl" />
      </div>
    );
  }

  if (error && chartData.length === 0) {
    return (
      <div className="bg-[#f5f5f7] rounded-xl p-8 text-center">
        <TrendingUp className="w-12 h-12 text-[#86868b] mx-auto mb-3" />
        <p className="text-[#86868b]">Unable to load performance data</p>
        <p className="text-sm text-[#86868b] mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with PnL */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`flex items-center gap-1 px-3 py-1.5 rounded-full ${
            periodPnL.value >= 0 ? 'bg-[#34C759]/10' : 'bg-[#FF3B30]/10'
          }`}>
            {periodPnL.value >= 0 ? (
              <TrendingUp className="w-4 h-4 text-[#34C759]" />
            ) : (
              <TrendingDown className="w-4 h-4 text-[#FF3B30]" />
            )}
            <span className={`text-sm font-semibold ${
              periodPnL.value >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'
            }`}>
              {periodPnL.value >= 0 ? '+' : ''}
              {periodPnL.percentage.toFixed(2)}%
            </span>
          </div>
          <span className="text-sm text-[#86868b]">
            {periodPnL.value >= 0 ? '+' : ''}
            ${Math.abs(periodPnL.value).toLocaleString('en-US', { 
              minimumFractionDigits: 2,
              maximumFractionDigits: 2 
            })}
          </span>
          {isOnchainVerified && (
            <span className="text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded flex items-center gap-1">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              On-Chain
            </span>
          )}
        </div>
        
        {/* Time range selector */}
        <div className="flex gap-1 bg-[#f5f5f7] rounded-lg p-1">
          {timeRangeButtons.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setTimeRange(value)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${
                timeRange === value
                  ? 'bg-white text-[#1d1d1f] shadow-sm'
                  : 'text-[#86868b] hover:text-[#1d1d1f]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div className="h-[200px] w-full">
        <Line data={chartDataset} options={chartOptions} />
      </div>

      {/* Metrics summary — 2-col on mobile so PnL values don't crush */}
      {metrics && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-3 pt-2 min-w-0">
          <MetricCard 
            label="Daily" 
            value={metrics.dailyPnL}
            percentage={metrics.dailyPnLPercentage}
          />
          <MetricCard 
            label="Weekly" 
            value={metrics.weeklyPnL}
            percentage={metrics.weeklyPnLPercentage}
          />
          <MetricCard 
            label="Monthly" 
            value={metrics.monthlyPnL}
            percentage={metrics.monthlyPnLPercentage}
          />
          <MetricCard 
            label="All Time" 
            value={metrics.totalPnL}
            percentage={metrics.totalPnLPercentage}
          />
        </div>
      )}
    </div>
  );
}

function MetricCard({ 
  label, 
  value, 
  percentage 
}: { 
  label: string; 
  value: number; 
  percentage: number;
}) {
  const isPositive = value >= 0;
  
  return (
    <div className="bg-[#f5f5f7] rounded-lg p-3">
      <div className="text-[10px] font-medium text-[#86868b] uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className={`text-sm font-semibold ${
        isPositive ? 'text-[#34C759]' : 'text-[#FF3B30]'
      }`}>
        {isPositive ? '+' : ''}{percentage.toFixed(2)}%
      </div>
      <div className="text-xs text-[#86868b]">
        {isPositive ? '+' : ''}${Math.abs(value).toLocaleString('en-US', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        })}
      </div>
    </div>
  );
}

