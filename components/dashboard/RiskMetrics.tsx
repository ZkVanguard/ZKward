'use client';

import { useMemo, memo } from 'react';
import { AlertTriangle, TrendingUp, Shield, Activity } from 'lucide-react';
import { usePositions } from '@/contexts/PositionsContext';
import { ConnectPromptButton } from '@/components/ui/ConnectPromptButton';

interface RiskMetric {
  label: string;
  value: string;
  status: 'low' | 'medium' | 'high';
  icon: React.ComponentType<{ className?: string }>;
}

export const RiskMetrics = memo(function RiskMetrics({ address }: { address?: string }) {
  const { positionsData, derived, loading } = usePositions();

  // Calculate metrics from context data - no fetching needed!
  const noData = !address || !positionsData || !derived;
  const metrics = useMemo<RiskMetric[]>(() => {
    if (noData) {
      // Placeholder shape is still returned so the layout doesn't
      // shift; the render branch below shows a single empty state
      // instead of 4 fake tinted cards with "--" that read as broken.
      return [];
    }

    const { weightedVolatility, sharpeRatio } = derived;
    const { totalValue } = positionsData;

    // VaR 95% (rough estimate: 1.645 * volatility * portfolio value)
    const varPercent = weightedVolatility * 1.645 * 100;

    // Risk score (0-100, based on volatility and concentration)
    const positions = positionsData.positions || [];
    const concentration = totalValue > 0 
      ? Math.max(...positions.map(p => parseFloat(p.balanceUSD || '0') / totalValue))
      : 0;
    const riskScore = Math.round((weightedVolatility * 50) + (concentration * 50));
    const riskStatus: 'low' | 'medium' | 'high' = 
      riskScore < 40 ? 'low' : riskScore < 70 ? 'medium' : 'high';

    return [
      { 
        label: 'VaR (95%)', 
        value: `${varPercent.toFixed(1)}%`,
        status: varPercent > 15 ? 'high' : varPercent > 8 ? 'medium' : 'low',
        icon: Shield 
      },
      { 
        label: 'Volatility', 
        value: `${(weightedVolatility * 100).toFixed(1)}%`,
        status: weightedVolatility > 0.4 ? 'high' : weightedVolatility > 0.2 ? 'medium' : 'low',
        icon: TrendingUp 
      },
      { 
        label: 'Risk Score', 
        value: `${riskScore}/100`,
        status: riskStatus,
        icon: AlertTriangle 
      },
      { 
        label: 'Sharpe Ratio', 
        value: sharpeRatio.toFixed(2),
        status: sharpeRatio < 0.5 ? 'low' : sharpeRatio < 1.5 ? 'medium' : 'high',
        icon: Activity 
      },
    ];
  }, [address, positionsData, derived]);

  if (loading) {
    return (
      <div className="px-4 sm:px-6 pb-4 sm:pb-6">
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 sm:h-24 animate-pulse bg-[#f5f5f7] rounded-[12px] sm:rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'low': return { bg: 'bg-[#34C759]/10', text: 'text-[#34C759]', dot: 'bg-[#34C759]' };
      case 'medium': return { bg: 'bg-[#FF9500]/10', text: 'text-[#FF9500]', dot: 'bg-[#FF9500]' };
      case 'high': return { bg: 'bg-[#FF3B30]/10', text: 'text-[#FF3B30]', dot: 'bg-[#FF3B30]' };
      default: return { bg: 'bg-[#8E8E93]/10', text: 'text-[#8E8E93]', dot: 'bg-[#8E8E93]' };
    }
  };

  // Empty state. Replaces the 4 tinted "--" placeholder cards that
  // read as broken widgets. Single clean message instead. Same
  // pattern the homepage uses for empty data (skeleton or absence,
  // never fake numbers).
  if (noData) {
    return (
      <div className="px-4 sm:px-6 pb-6 sm:pb-8 flex flex-col items-center justify-center min-h-[160px] gap-4">
        <p className="text-[13px] sm:text-caption-1 text-label-tertiary text-center max-w-[240px]">
          Connect a wallet to see VaR, volatility, risk score and Sharpe ratio computed live from your portfolio.
        </p>
        <ConnectPromptButton />
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 pb-4 sm:pb-6">
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        {metrics.map((metric, index) => {
          const Icon = metric.icon;
          const colors = getStatusColor(metric.status);
          
          return (
            <div key={index} className={`${colors.bg} rounded-[12px] sm:rounded-xl p-3 sm:p-4`}>
              <div className="flex items-center justify-between mb-1.5 sm:mb-2">
                <Icon className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${colors.text}`} aria-hidden="true" />
                <div className="flex items-center gap-1">
                  <span className="sr-only">{metric.status} risk</span>
                  <div className={`w-1.5 h-1.5 sm:w-2 sm:h-2 ${colors.dot} rounded-full`} aria-hidden="true" />
                </div>
              </div>
              <div className="text-[18px] sm:text-[22px] font-semibold text-[#1d1d1f] mb-0.5 leading-none">
                {metric.value}
              </div>
              <div className="text-[9px] sm:text-[11px] font-medium text-[#86868b] uppercase tracking-[0.04em]">
                {metric.label}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

RiskMetrics.displayName = 'RiskMetrics';
