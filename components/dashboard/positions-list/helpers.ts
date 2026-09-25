import { logger } from '@/lib/utils/logger';
import type {
  OnChainPortfolio,
  PortfolioDetail,
  PortfolioTransaction,
  PortfolioAssetDetail,
} from '../positions-types';

interface BuildPortfolioDetailArgs {
  portfolio: OnChainPortfolio;
  valueUSD: number;
  yieldPercent: number;
  riskLevel: 'Low' | 'Medium' | 'High';
  hasFunds: boolean;
  hasRegisteredAssets: boolean;
  registeredAssetsCount: number;
  lastRebalanceTime: number;
  address?: string;
}

/**
 * Fetches fresh portfolio data + transactions + AI analysis and assembles the
 * PortfolioDetail object shown in PortfolioDetailModal. Mutates the passed
 * `portfolio` reference with fresh API values (matching prior inline behavior).
 */
export async function buildPortfolioDetail({
  portfolio,
  valueUSD,
  yieldPercent,
  riskLevel,
  hasFunds,
  hasRegisteredAssets,
  registeredAssetsCount,
  lastRebalanceTime,
  address,
}: BuildPortfolioDetailArgs): Promise<PortfolioDetail> {
  logger.info(`Opening portfolio #${portfolio.id} detail - Fetching fresh data...`, {
    component: 'PositionsList',
  });
  logger.debug(`Current portfolio.assets: ${JSON.stringify(portfolio.assets)}`, {
    component: 'PositionsList',
  });
  logger.debug(`Current portfolio.assetBalances: ${JSON.stringify(portfolio.assetBalances)}`, {
    component: 'PositionsList',
  });

  // Force refresh portfolio data from API (bypass cache)
  try {
    const freshRes = await fetch(`/api/portfolio/${portfolio.id}?refresh=true`);
    if (freshRes.ok) {
      const freshData = await freshRes.json();
      logger.debug(`Fresh API data received for portfolio ${portfolio.id}`, {
        component: 'PositionsList',
      });
      portfolio.assets = freshData.assets || [];
      portfolio.assetBalances = freshData.assetBalances || [];
      portfolio.calculatedValueUSD = freshData.calculatedValueUSD || 0;
    }
  } catch (err) {
    logger.warn('Failed to fetch fresh portfolio data', {
      component: 'PositionsList',
      error: String(err),
    });
  }

  // Calculate real allocation percentages
  const totalPortfolioValue = portfolio.calculatedValueUSD || valueUSD;

  // Build assets with allocation from assetBalances
  let assetsWithAllocation: PortfolioAssetDetail[] = [];

  if (portfolio.assetBalances && portfolio.assetBalances.length > 0) {
    // Use virtual allocations from API
    assetsWithAllocation = portfolio.assetBalances.map((ab) => {
      const assetAllocation =
        (ab as { percentage?: number }).percentage ??
        (totalPortfolioValue > 0 ? Math.round((ab.valueUSD / totalPortfolioValue) * 100) : 0);
      return {
        symbol: ab.symbol,
        address: ab.token,
        allocation: assetAllocation,
        value: ab.valueUSD,
        change24h: (ab as { pnlPercentage?: number }).pnlPercentage ?? 0,
        price: (ab as { price?: number }).price,
        chain: (ab as { chain?: string }).chain,
      } as PortfolioAssetDetail;
    });
  } else if (totalPortfolioValue > 1000000) {
    // Institutional portfolio fallback - create virtual allocations
    logger.info(
      `Creating fallback virtual allocations for institutional portfolio #${portfolio.id}`,
      { component: 'PositionsList' }
    );
    const allocations = [
      { symbol: 'BTC', percentage: 35, chain: 'cronos' },
      { symbol: 'ETH', percentage: 30, chain: 'cronos' },
      { symbol: 'CRO', percentage: 20, chain: 'cronos' },
      { symbol: 'SUI', percentage: 15, chain: 'sui' },
    ];
    assetsWithAllocation = allocations.map((alloc) => ({
      symbol: alloc.symbol,
      address: alloc.symbol,
      allocation: alloc.percentage,
      value: totalPortfolioValue * (alloc.percentage / 100),
      change24h: 0,
      chain: alloc.chain,
    })) as PortfolioAssetDetail[];
  }

  logger.debug(`Assets with allocation for portfolio ${portfolio.id}`, {
    component: 'PositionsList',
    data: assetsWithAllocation,
  });

  // Fetch real transaction history (include wallet address for ERC20 transfer scanning)
  let transactions: PortfolioTransaction[] = [];
  try {
    const txUrl = address
      ? `/api/portfolio/${portfolio.id}/transactions?address=${encodeURIComponent(address)}`
      : `/api/portfolio/${portfolio.id}/transactions`;
    const txRes = await fetch(txUrl);
    if (txRes.ok) {
      const txData = await txRes.json();
      transactions = txData.transactions || [];
      logger.debug(
        `Fetched ${transactions.length} transactions for portfolio ${portfolio.id}`,
        { component: 'PositionsList' }
      );
    }
  } catch (err) {
    logger.warn('Failed to fetch transactions', {
      component: 'PositionsList',
      error: String(err),
    });
  }

  // Fetch real AI analysis from auto-hedging service and hedges
  let aiAnalysis = {
    summary: 'Analyzing portfolio...',
    recommendations: [] as string[],
    riskAssessment: '',
  };
  try {
    // Fetch active hedges for this portfolio
    const hedgesRes = await fetch(`/api/portfolio/${portfolio.id}/hedges`);
    const autoHedgeRes = await fetch(`/api/agents/auto-hedge?portfolioId=${portfolio.id}`);

    let activeHedges: {
      asset: string;
      side: string;
      current_pnl: number;
      notional_value: number;
    }[] = [];
    let autoHedgeStatus = {
      isRunning: false,
      riskAssessment: null as {
        riskScore: number;
        drawdownPercent: number;
        recommendations: { asset: string; reason: string }[];
      } | null,
    };

    if (hedgesRes.ok) {
      const hedgesData = await hedgesRes.json();
      activeHedges = hedgesData.hedges || [];
    }
    if (autoHedgeRes.ok) {
      autoHedgeStatus = await autoHedgeRes.json();
    }

    // Calculate total hedge PnL
    const totalHedgePnL = activeHedges.reduce((sum, h) => sum + (Number(h.current_pnl) || 0), 0);
    const totalHedgeNotional = activeHedges.reduce(
      (sum, h) => sum + (Number(h.notional_value) || 0),
      0
    );

    // Generate dynamic summary
    const summaryParts: string[] = [];
    if (activeHedges.length > 0) {
      const hedgePnLStr =
        totalHedgePnL >= 0
          ? `+$${totalHedgePnL.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
          : `-$${Math.abs(totalHedgePnL).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
      summaryParts.push(
        `${activeHedges.length} active hedge${activeHedges.length > 1 ? 's' : ''} protecting $${totalHedgeNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })} with ${hedgePnLStr} unrealized PnL.`
      );
    }
    if (autoHedgeStatus.isRunning) {
      summaryParts.push('Auto-hedging service is active and monitoring risk.');
    }
    if (hasFunds) {
      const topAsset = assetsWithAllocation.reduce(
        (max, a) => (a.allocation > max.allocation ? a : max),
        { symbol: '', allocation: 0 } as PortfolioAssetDetail | { symbol: string; allocation: number }
      );
      summaryParts.push(
        `Portfolio allocation: ${topAsset.symbol} (${topAsset.allocation}%), diversified across ${assetsWithAllocation.length} assets.`
      );
    }

    aiAnalysis.summary = summaryParts.join(' ') || 'No active positions or hedges detected.';

    // Generate dynamic recommendations
    const recommendations: string[] = [];
    if (activeHedges.length > 0) {
      const profitableHedges = activeHedges.filter((h) => Number(h.current_pnl) > 0);
      const losingHedges = activeHedges.filter((h) => Number(h.current_pnl) < 0);
      if (profitableHedges.length > 0) {
        recommendations.push(
          `Consider taking profits on ${profitableHedges.length} profitable hedge${profitableHedges.length > 1 ? 's' : ''}`
        );
      }
      if (losingHedges.length > 0 && Math.abs(totalHedgePnL) > totalHedgeNotional * 0.05) {
        recommendations.push(
          `Review losing hedges - current drawdown exceeds 5% of hedge value`
        );
      }
    }
    if (autoHedgeStatus.riskAssessment?.recommendations) {
      autoHedgeStatus.riskAssessment.recommendations.forEach(
        (rec: { asset: string; reason: string }) => {
          recommendations.push(`${rec.asset}: ${rec.reason}`);
        }
      );
    }
    if (!autoHedgeStatus.isRunning && hasFunds) {
      recommendations.push('Enable auto-hedging for continuous risk monitoring');
    }
    if (hasFunds && assetsWithAllocation.some((a) => a.change24h < -3)) {
      const decliningAssets = assetsWithAllocation.filter((a) => a.change24h < -3);
      recommendations.push(
        `Monitor ${decliningAssets.map((a) => a.symbol).join(', ')} - down more than 3% in 24h`
      );
    }
    if (recommendations.length === 0) {
      recommendations.push('Portfolio is well-balanced with no immediate actions required');
      recommendations.push('Continue monitoring market conditions');
    }
    aiAnalysis.recommendations = recommendations.slice(0, 4);

    // Generate dynamic risk assessment
    const riskScore = autoHedgeStatus.riskAssessment?.riskScore || 1;
    const riskLabel = riskScore <= 3 ? 'low' : riskScore <= 6 ? 'medium' : 'high';
    const hedgeProtection =
      activeHedges.length > 0
        ? ` Protected by ${activeHedges.length} active hedge${activeHedges.length > 1 ? 's' : ''} with ${activeHedges.filter((h) => h.side === 'SHORT').length} SHORT and ${activeHedges.filter((h) => h.side === 'LONG').length} LONG positions.`
        : '';
    aiAnalysis.riskAssessment = `Risk score: ${riskScore}/10 (${riskLabel}). This ${riskLevel.toLowerCase()} risk portfolio maintains diversification across ${registeredAssetsCount} assets.${hedgeProtection}`;
  } catch (err) {
    logger.warn('Failed to fetch AI analysis data', {
      component: 'PositionsList',
      error: String(err),
    });
    // Fallback to static analysis
    aiAnalysis = {
      summary:
        'Your portfolio is performing well with balanced asset allocation across stable and growth assets.',
      recommendations: [
        'Consider rebalancing if market volatility increases',
        'Current asset mix aligns with your risk tolerance',
        'Monitor yield performance against target APY',
      ],
      riskAssessment: `This ${riskLevel.toLowerCase()} risk portfolio maintains diversification across ${registeredAssetsCount} assets with automated rebalancing.`,
    };
  }

  return {
    id: portfolio.id,
    name: `Portfolio #${portfolio.id}`,
    totalValue: totalPortfolioValue,
    status: hasFunds ? 'FUNDED' : hasRegisteredAssets ? 'EMPTY' : 'NEW',
    targetAPY: yieldPercent,
    riskLevel,
    currentYield: yieldPercent, // Use same for now
    assets: assetsWithAllocation,
    lastRebalanced: lastRebalanceTime,
    transactions,
    aiAnalysis,
  };
}
