'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Wallet,
  Coins,
  RefreshCw,
  ArrowDownToLine,
  Sparkles,
  ExternalLink,
  Shield,
  Target,
  PieChart,
  Activity,
  Clock,
  Plus,
  Zap,
  BarChart2,
} from 'lucide-react';
import { useWallet } from '@/lib/hooks/useWallet';
import { useUserPortfolios } from '../../lib/contracts/hooks';
import { DepositModal } from './DepositModal';
import { WithdrawModal } from './WithdrawModal';
import PortfolioDetailModal from './PortfolioDetailModal';
import { PositionsLoadingSkeleton } from './positions-list/LoadingSkeleton';
import { TokenIcon } from './positions-list/TokenIcon';
import { AgentRecommendationModal } from './positions-list/AgentRecommendationModal';
import { NotConnectedState, NoPortfoliosEmptyState } from './positions-list/EmptyStates';
import {
  DelphiMarketService,
  type PredictionMarket,
} from '@/lib/services/market-data/DelphiMarketService';
import { usePositions } from '@/contexts/PositionsContext';
import { usePortfolioAction, type CustomActionPayload } from '@/contexts/AIDecisionsContext';
import { logger } from '@/lib/utils/logger';
import type {
  AgentRecommendation,
  SettlementBatch,
  PortfolioTransaction,
  PortfolioDetail,
  PositionsListProps,
  OnChainPortfolio,
} from './positions-types';

export function PositionsList({ address, onOpenHedge }: PositionsListProps) {
  const { isConnected, evmAddress } = useWallet();
  // Get only portfolios owned by the connected wallet (EVM-specific)
  const {
    data: userPortfolios,
    count: _userPortfolioCount,
    isLoading: portfolioLoading,
  } = useUserPortfolios(evmAddress as `0x${string}` | undefined);
  const {
    positionsData,
    derived,
    error: positionsError,
    refetch: refetchPositions,
  } = usePositions();
  const { requestCustomAction } = usePortfolioAction();
  const [onChainPortfolios, setOnChainPortfolios] = useState<OnChainPortfolio[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasInitiallyLoaded, setHasInitiallyLoaded] = useState(false);

  // Derived from context
  const positions = positionsData?.positions || [];
  const totalValue = positionsData?.totalValue || 0;
  const lastUpdated = positionsData ? new Date(positionsData.lastUpdated) : null;
  const _error = positionsError;

  // Deposit modal state
  const [depositModalOpen, setDepositModalOpen] = useState(false);
  const [selectedPortfolio, setSelectedPortfolio] = useState<OnChainPortfolio | null>(null);

  // Withdraw modal state
  const [withdrawModalOpen, setWithdrawModalOpen] = useState(false);
  const [selectedWithdrawPortfolio, setSelectedWithdrawPortfolio] =
    useState<OnChainPortfolio | null>(null);

  // Portfolio detail modal state
  const [portfolioDetailOpen, setPortfolioDetailOpen] = useState(false);
  const [selectedDetailPortfolio, setSelectedDetailPortfolio] = useState<PortfolioDetail | null>(
    null
  );

  // Agent recommendation state
  const [agentRecommendation, setAgentRecommendation] = useState<AgentRecommendation | null>(null);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [showRecommendationModal, setShowRecommendationModal] = useState(false);
  const [analyzedPortfolio, setAnalyzedPortfolio] = useState<OnChainPortfolio | null>(null);

  // Expanded predictions state (portfolio ID -> boolean)
  const [_expandedPredictions, _setExpandedPredictions] = useState<Record<number, boolean>>({});

  // Collapseable strategies section - default to expanded for quick view
  const [_strategiesCollapsed, _setStrategiesCollapsed] = useState(false);

  const openDepositModal = (portfolio: OnChainPortfolio) => {
    setSelectedPortfolio(portfolio);
    setDepositModalOpen(true);
  };

  const closeDepositModal = () => {
    setDepositModalOpen(false);
    setSelectedPortfolio(null);
  };

  const openWithdrawModal = (portfolio: OnChainPortfolio) => {
    setSelectedWithdrawPortfolio(portfolio);
    setWithdrawModalOpen(true);
  };

  // Fetch agent recommendation for portfolio action
  const fetchAgentRecommendation = async (portfolio: OnChainPortfolio) => {
    setRecommendationLoading(true);
    setAnalyzedPortfolio(portfolio);
    try {
      const portfolioAssets = portfolio.assets.map((asset) => {
        const addr = asset.toLowerCase();
        if (addr === '0xc01efaaf7c5c61bebfaeb358e1161b537b8bc0e0') return 'USDC';
        if (addr.includes('wcro')) return 'CRO';
        return asset.slice(0, 6);
      });

      // FETCH REAL PREDICTIONS from Polymarket/Delphi
      logger.info('Fetching real prediction market data for assets', {
        component: 'PositionsList',
        data: portfolioAssets,
      });
      let predictions: PredictionMarket[] = [];
      try {
        predictions = await DelphiMarketService.getRelevantMarkets(portfolioAssets);
        logger.info(`Got ${predictions.length} predictions from Polymarket/Delphi`, {
          component: 'PositionsList',
          data: predictions
            .slice(0, 3)
            .map((p) => ({
              q: p.question.slice(0, 50),
              prob: p.probability,
              rec: p.recommendation,
            })),
        });
      } catch (predError) {
        logger.warn('Failed to fetch predictions', {
          component: 'PositionsList',
          error: String(predError),
        });
        predictions = [];
      }

      // Calculate REAL metrics from positions context
      const realMetrics = derived
        ? {
            volatility: derived.weightedVolatility,
            sharpeRatio: derived.sharpeRatio,
            topAssets: derived.topAssets,
            totalChange24h: derived.totalChange24h,
          }
        : null;

      const riskScore = realMetrics
        ? Math.round(
            realMetrics.volatility * 50 +
              (positionsData?.totalValue && realMetrics.topAssets.length > 0
                ? (realMetrics.topAssets[0].value / positionsData.totalValue) * 50
                : 0)
          )
        : 50;

      // Count active hedge signals from localStorage
      let hedgeSignals = 0;
      if (typeof window !== 'undefined') {
        const settlements = localStorage.getItem('settlement_history');
        if (settlements) {
          const settlementData = JSON.parse(settlements);
          hedgeSignals = Object.values(settlementData).filter((batch) => {
            const b = batch as SettlementBatch;
            return b.type === 'hedge' && b.status !== 'closed';
          }).length;
        }
      }

      // Filter predictions that recommend HEDGE or have HIGH impact
      const highRiskPredictions = predictions.filter(
        (p) => p.recommendation === 'HEDGE' || (p.impact === 'HIGH' && p.probability > 60)
      );
      logger.info(`High risk predictions: ${highRiskPredictions.length}`, {
        component: 'PositionsList',
        data: highRiskPredictions.map((p) => ({ q: p.question.slice(0, 40), prob: p.probability })),
      });

      // Use centralized AI service with caching
      const actionPayload: CustomActionPayload = {
        portfolioId: portfolio.id,
        currentValue: parseFloat(portfolio.totalValue) / 1e6, // Assuming USDC 6 decimals
        targetYield: parseFloat(portfolio.targetYield) / 100,
        riskTolerance: parseFloat(portfolio.riskTolerance),
        assets: portfolioAssets,
        // Pass real calculated metrics
        realMetrics: {
          riskScore,
          volatility: realMetrics?.volatility || 0.3,
          sharpeRatio: realMetrics?.sharpeRatio || 0,
          hedgeSignals: hedgeSignals + highRiskPredictions.length, // Include prediction signals
          totalValue: positionsData?.totalValue || 0,
        },
        // Pass REAL predictions from Polymarket/Delphi
        predictions: predictions.map((p) => ({
          question: p.question,
          probability: p.probability,
          impact: p.impact,
          recommendation: p.recommendation || 'MONITOR',
          source: p.source || 'polymarket',
        })),
      };

      const result = await requestCustomAction(actionPayload, true);

      if (result) {
        // Map PortfolioAction to AgentRecommendation
        const mappedAction =
          result.action === 'SELL' || result.action === 'REBALANCE'
            ? 'WITHDRAW'
            : result.action === 'BUY'
              ? 'ADD_FUNDS'
              : result.action === 'HEDGE'
                ? 'HEDGE'
                : 'HOLD';

        const recommendation: AgentRecommendation = {
          action: mappedAction as AgentRecommendation['action'],
          confidence: result.confidence,
          reasoning: Array.isArray(result.reasoning) ? result.reasoning : [result.reasoning],
          riskScore: result.urgency === 'high' ? 75 : result.urgency === 'medium' ? 50 : 25,
          agentAnalysis: {
            riskAgent: `Risk assessment: ${result.urgency} urgency`,
            hedgingAgent: result.suggestedAssets?.length
              ? `Consider hedging: ${result.suggestedAssets.join(', ')}`
              : 'No hedge recommended',
            leadAgent: result.reasoning,
          },
          recommendations: result.suggestedAssets || [],
        };

        setAgentRecommendation(recommendation);
        setShowRecommendationModal(true);
      } else {
        logger.error('Failed to get agent recommendation', undefined, {
          component: 'PositionsList',
        });
      }
    } catch (error) {
      logger.error('Error fetching agent recommendation', error, { component: 'PositionsList' });
    } finally {
      setRecommendationLoading(false);
    }
  };

  const closeWithdrawModal = () => {
    setWithdrawModalOpen(false);
    setSelectedWithdrawPortfolio(null);
  };

  const handleDepositSuccess = () => {
    // Refresh data after successful deposit
    refetchPositions();
    fetchOnChainPortfolios();
  };

  const handleWithdrawSuccess = () => {
    // Refresh data after successful withdrawal
    refetchPositions();
    fetchOnChainPortfolios();
  };

  // Fetch on-chain portfolios from contract - OPTIMIZED with parallel fetching
  const fetchOnChainPortfolios = useCallback(async () => {
    if (!userPortfolios || userPortfolios.length === 0) {
      setOnChainPortfolios([]);
      return;
    }

    logger.info(`Processing ${userPortfolios.length} user portfolios (parallel)`, {
      component: 'PositionsList',
    });
    const startTime = Date.now();

    // PARALLEL: Fetch all portfolio assets simultaneously
    const portfolioPromises = userPortfolios
      .filter((p) => p.isActive)
      .map(async (p) => {
        const portfolio: OnChainPortfolio = {
          id: p.id,
          owner: p.owner,
          totalValue: p.totalValue.toString(),
          targetYield: p.targetYield.toString(),
          riskTolerance: p.riskTolerance.toString(),
          lastRebalance: p.lastRebalance.toString(),
          isActive: p.isActive,
          assets: [],
          assetBalances: [],
          calculatedValueUSD: 0,
          predictions: [], // Empty - fetch on-demand only
          txHash: p.txHash,
        };

        // Fetch assets and calculated value from API
        try {
          const assetsRes = await fetch(`/api/portfolio/${p.id}`);
          if (assetsRes.ok) {
            const data = await assetsRes.json();
            portfolio.assets = data.assets || [];
            portfolio.assetBalances = data.assetBalances || [];
            portfolio.calculatedValueUSD = data.calculatedValueUSD || 0;

            // Also update totalValue if API provides a better one
            if (data.totalValue) {
              portfolio.totalValue = data.totalValue;
            }
          }
        } catch (err) {
          logger.warn(`Failed to fetch assets for portfolio ${p.id}`, {
            component: 'PositionsList',
            error: String(err),
          });
        }

        return portfolio;
      });

    // Wait for all portfolios in parallel
    const portfolios = await Promise.all(portfolioPromises);
    setOnChainPortfolios(portfolios);
    logger.info(`Loaded ${portfolios.length} portfolios in ${Date.now() - startTime}ms`, {
      component: 'PositionsList',
    });
  }, [userPortfolios]);

  useEffect(() => {
    async function loadAll() {
      await fetchOnChainPortfolios();
      setHasInitiallyLoaded(true);
    }

    if (address && isConnected) {
      loadAll();
    }
  }, [address, isConnected, userPortfolios]); // Re-fetch when address or portfolios change (not positionsData. Avoids loop)

  // Only set loading to false when BOTH positions AND portfolios are ready
  useEffect(() => {
    if (positionsData && hasInitiallyLoaded && !portfolioLoading) {
      setLoading(false);
    }
  }, [positionsData, hasInitiallyLoaded, portfolioLoading]);

  // Safety timeout - force loading off after 10 seconds to prevent infinite loading
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (loading) {
        logger.warn('[PositionsList] Forcing loading=false after timeout');
        setLoading(false);
        setHasInitiallyLoaded(true);
      }
    }, 10000);
    return () => clearTimeout(timeoutId);
  }, [loading]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([refetchPositions(), fetchOnChainPortfolios()]);
    setRefreshing(false);
  }, [refetchPositions, fetchOnChainPortfolios]);

  // Calculate display values - use funded portfolio's calculated value if available
  const displayValues = useMemo(() => {
    // Find funded portfolio with virtual allocations (institutional portfolio)
    const fundedPortfolio = onChainPortfolios.find((p) => {
      const calcValue = p.calculatedValueUSD || 0;
      return calcValue > 1000000 && p.assetBalances && p.assetBalances.length > 0;
    });

    if (
      fundedPortfolio &&
      fundedPortfolio.calculatedValueUSD &&
      fundedPortfolio.calculatedValueUSD > 0
    ) {
      // Use portfolio's calculated value and PnL
      const calcValue = fundedPortfolio.calculatedValueUSD;

      // Calculate weighted PnL from virtual allocations
      const portfolioPnLPercent = (fundedPortfolio.assetBalances || []).reduce((acc, ab) => {
        const pnlPct = (ab as { pnlPercentage?: number }).pnlPercentage ?? 0;
        const percentage = (ab as { percentage?: number }).percentage ?? 25;
        return acc + (pnlPct * percentage) / 100;
      }, 0);

      return {
        totalValue: calcValue,
        change24h: portfolioPnLPercent,
        usingPortfolioValue: true,
      };
    }

    // Fallback to wallet balance total
    return {
      totalValue: totalValue,
      change24h: positions.reduce((acc, pos) => {
        const posValue = parseFloat(pos.balanceUSD || '0');
        const weight = totalValue > 0 ? posValue / totalValue : 0;
        return acc + pos.change24h * weight;
      }, 0),
      usingPortfolioValue: false,
    };
  }, [onChainPortfolios, totalValue, positions]);

  // Memoize weighted 24h change calculation (used for wallet balances section)
  const _weighted24hChange = useMemo(() => {
    if (totalValue === 0 || positions.length === 0) return 0;
    return positions.reduce((acc, pos) => {
      const posValue = parseFloat(pos.balanceUSD || '0');
      const weight = posValue / totalValue;
      return acc + pos.change24h * weight;
    }, 0);
  }, [positions, totalValue]);

  // First check if wallet is connected - before any loading checks
  if (!isConnected) {
    return <NotConnectedState />;
  }

  if (loading || !positionsData || portfolioLoading || !hasInitiallyLoaded) {
    return <PositionsLoadingSkeleton />;
  }

  return (
    <div className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-4">
      {/* Compact Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-black/5 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-4">
          {/* Left: Total Value */}
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-semibold text-[#86868b] uppercase tracking-wider">
                {displayValues.usingPortfolioValue ? 'Portfolio Value' : 'Total Value'}
              </span>
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-[#34C759]/10 rounded-full">
                <span className="w-1 h-1 bg-[#34C759] rounded-full animate-pulse" />
                <span className="text-[9px] font-bold text-[#34C759]">LIVE</span>
              </span>
            </div>
            <div className="text-[22px] xs:text-[28px] sm:text-[36px] font-bold text-[#1d1d1f] leading-none tracking-[-0.02em] tabular-nums break-all">
              $
              {displayValues.totalValue.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-[12px] text-[#86868b]">
              {/* Daily PnL (actual profit/loss) */}
              {derived?.pnl && derived.pnl.daily !== 0 && (
                <>
                  <span
                    className={`font-semibold flex items-center gap-1 ${derived.pnl.daily >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}
                  >
                    <BarChart2 className="w-3 h-3" />
                    {derived.pnl.daily >= 0 ? '+' : ''}$
                    {Math.abs(derived.pnl.daily).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}{' '}
                    PnL
                  </span>
                  <span className="text-[#86868b]/60">•</span>
                </>
              )}
              <span
                className={`font-semibold flex items-center gap-1 ${displayValues.change24h >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}
              >
                {displayValues.change24h >= 0 ? (
                  <TrendingUp className="w-3 h-3" />
                ) : (
                  <TrendingDown className="w-3 h-3" />
                )}
                {displayValues.change24h >= 0 ? '+' : ''}
                {displayValues.change24h.toFixed(2)}% 24h
              </span>
              <span className="text-[#86868b]/60">•</span>
              <span>
                {lastUpdated
                  ? `Synced ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'Syncing...'}
              </span>
            </div>
          </div>

          {/* Right: Refresh + Quick Stats */}
          <div className="flex items-center gap-3">
            {/* Quick Stats Pills */}
            <div className="hidden sm:flex items-center gap-2">
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#f5f5f7] rounded-lg">
                <Coins className="w-3.5 h-3.5 text-[#FF9500]" />
                <span className="text-[12px] font-semibold text-[#1d1d1f]">{positions.length}</span>
              </div>
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#f5f5f7] rounded-lg">
                <PieChart className="w-3.5 h-3.5 text-[#007AFF]" />
                <span className="text-[12px] font-semibold text-[#1d1d1f]">
                  {onChainPortfolios.length}
                </span>
              </div>
            </div>

            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="p-2.5 bg-[#f5f5f7] hover:bg-[#e8e8ed] rounded-xl transition-all disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 text-[#1d1d1f] ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Mobile Stats Row */}
        <div className="flex sm:hidden items-center gap-2 mt-3 pt-3 border-t border-black/5">
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#f5f5f7] rounded-lg">
            <Coins className="w-3 h-3 text-[#FF9500]" />
            <span className="text-[11px] font-semibold text-[#1d1d1f]">
              {positions.length} Tokens
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#f5f5f7] rounded-lg">
            <PieChart className="w-3 h-3 text-[#007AFF]" />
            <span className="text-[11px] font-semibold text-[#1d1d1f]">
              {onChainPortfolios.length} Portfolios
            </span>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#AF52DE]/10 rounded-lg">
            <Activity className="w-3 h-3 text-[#AF52DE]" />
            <span className="text-[11px] font-semibold text-[#AF52DE]">
              {
                onChainPortfolios.filter((p) => parseFloat(p.totalValue) > 0 || p.assets.length > 0)
                  .length
              }{' '}
              Active
            </span>
          </div>
        </div>
      </div>

      {/* Portfolio Positions - PRIMARY CONTENT */}
      {onChainPortfolios.length > 0 && (
        <div className="space-y-3">
          {/* Portfolio Section Header - Compact */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <PieChart className="w-4 h-4 text-[#007AFF]" />
              <h3 className="text-[15px] font-semibold text-[#1d1d1f]">Portfolios</h3>
              <span className="text-[12px] text-[#86868b]">({onChainPortfolios.length})</span>
            </div>
            <span className="px-2 py-1 bg-[#34C759]/10 text-[#34C759] text-[11px] font-semibold rounded-full">
              {
                onChainPortfolios.filter((p) => {
                  const calcValue = p.calculatedValueUSD || 0;
                  const rawValue = parseFloat(p.totalValue) || 0;
                  const valueUSD =
                    calcValue > 0 ? calcValue : rawValue > 1e12 ? rawValue / 1e18 : rawValue / 1e6;
                  return valueUSD > 0;
                }).length
              }{' '}
              Funded
            </span>
          </div>

          {/* Portfolio Cards Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {onChainPortfolios.map((portfolio) => {
              // Use calculatedValueUSD if available (from API), otherwise fall back to totalValue
              let valueUSD = portfolio.calculatedValueUSD || 0;

              // If no calculated value, try to parse from totalValue
              if (valueUSD === 0) {
                const rawValue = parseFloat(portfolio.totalValue) || 0;
                valueUSD = rawValue > 1e12 ? rawValue / 1e18 : rawValue / 1e6;
              }

              // Get deposited assets and their symbols
              const depositedAssets =
                portfolio.assetBalances?.map((ab) => ab.symbol) ||
                portfolio.assets.map((a) => {
                  const addr = a.toLowerCase();
                  if (addr === '0xc01efaaf7c5c61bebfaeb358e1161b537b8bc0e0') return 'USDC';
                  if (
                    addr.includes('wcro') ||
                    addr === '0x6a3173618859c7cd40faf6921b5e9eb6a76f1fd4'
                  )
                    return 'WCRO';
                  return a.slice(0, 6);
                });

              // If still no value but has assets, estimate from wallet positions (fallback)
              if (valueUSD === 0 && portfolio.assets.length > 0 && positions.length > 0) {
                let estimatedValue = 0;
                for (const assetSymbol of depositedAssets) {
                  const matchingPosition = positions.find(
                    (p) =>
                      p.symbol.toUpperCase() === assetSymbol.toUpperCase() ||
                      (assetSymbol.includes('USD') && p.symbol.toLowerCase().includes('usdc'))
                  );
                  if (matchingPosition) {
                    const posValue = parseFloat(matchingPosition.balanceUSD || '0');
                    estimatedValue += posValue > 0 ? posValue : 0;
                  }
                }
                if (estimatedValue > 0) {
                  valueUSD = estimatedValue;
                }
              }

              const yieldPercent = parseFloat(portfolio.targetYield) / 100;
              const riskValue = parseFloat(portfolio.riskTolerance) || 0;
              const riskLevel = riskValue <= 33 ? 'Low' : riskValue <= 66 ? 'Medium' : 'High';
              const riskColor =
                riskLevel === 'Low' ? '#34C759' : riskLevel === 'Medium' ? '#FF9500' : '#FF3B30';
              const riskBg =
                riskLevel === 'Low'
                  ? 'bg-[#34C759]/10'
                  : riskLevel === 'Medium'
                    ? 'bg-[#FF9500]/10'
                    : 'bg-[#FF3B30]/10';
              const isOwner = portfolio.owner.toLowerCase() === address.toLowerCase();

              // Portfolio has assets registered (even if balance is 0)
              const hasRegisteredAssets = portfolio.assets.length > 0;
              // Portfolio has actual funds (value > 0)
              const hasFunds = valueUSD > 0;
              // Show as active if has funds OR has registered assets
              const isActivePortfolio = hasFunds || hasRegisteredAssets;

              // Get all registered asset symbols - prefer assetBalances if they have symbols
              // For institutional portfolios with testnet USDC, use virtual allocation symbols (BTC, ETH, CRO, SUI)
              let registeredAssets: string[] = [];
              if (portfolio.assetBalances && portfolio.assetBalances.length > 0) {
                registeredAssets = portfolio.assetBalances.map((ab) => ab.symbol);
              } else if (valueUSD > 1000000) {
                // Large portfolio with USDC - show virtual allocations
                registeredAssets = ['BTC', 'ETH', 'CRO', 'SUI'];
              } else {
                registeredAssets = portfolio.assets.map((a) => {
                  const addr = a.toLowerCase();
                  if (addr === '0xc01efaaf7c5c61bebfaeb358e1161b537b8bc0e0') return 'devUSDC';
                  if (addr === '0x6a3173618859c7cd40faf6921b5e9eb6a76f1fd4') return 'WCRO';
                  if (addr === '0x28217daddc55e3c4831b4a48a00ce04880786967') return 'USDC';
                  return a.slice(0, 6);
                });
              }

              // Calculate weighted PnL from asset balances
              let portfolioPnL = 0;
              let portfolioPnLPercent = 0;
              if (portfolio.assetBalances && portfolio.assetBalances.length > 0 && valueUSD > 0) {
                // Weighted average of asset PnL percentages
                portfolioPnLPercent = portfolio.assetBalances.reduce((acc, ab) => {
                  const weight = ab.valueUSD / valueUSD;
                  const pnlPct = (ab as { pnlPercentage?: number }).pnlPercentage ?? 0;
                  return acc + pnlPct * weight;
                }, 0);
                // Estimate dollar PnL from percentage (using initial value estimate)
                const initialValue = valueUSD / (1 + portfolioPnLPercent / 100);
                portfolioPnL = valueUSD - initialValue;
              } else if (hasFunds && positions.length > 0) {
                // Fallback: use wallet position 24h changes as PnL estimate
                for (const assetSymbol of depositedAssets) {
                  const matchingPosition = positions.find(
                    (p) => p.symbol.toUpperCase() === assetSymbol.toUpperCase()
                  );
                  if (matchingPosition && matchingPosition.change24h) {
                    const posValue = parseFloat(matchingPosition.balanceUSD || '0');
                    portfolioPnL += (posValue * matchingPosition.change24h) / 100;
                    portfolioPnLPercent += (posValue / valueUSD) * matchingPosition.change24h;
                  }
                }
              }

              const lastRebalanceTime = parseInt(portfolio.lastRebalance) * 1000;
              const lastRebalanceDate = lastRebalanceTime > 0 ? new Date(lastRebalanceTime) : null;
              const daysSinceRebalance = lastRebalanceDate
                ? Math.floor((Date.now() - lastRebalanceTime) / (1000 * 60 * 60 * 24))
                : null;

              return (
                <div
                  key={portfolio.id}
                  className={`relative overflow-hidden rounded-2xl transition-all duration-300 hover:scale-[1.01] cursor-pointer ${
                    isActivePortfolio
                      ? 'bg-white shadow-sm hover:shadow-md border border-black/5'
                      : 'bg-[#f5f5f7] border-2 border-dashed border-[#d1d1d6]'
                  }`}
                  onClick={async () => {
                    logger.info(
                      `Opening portfolio #${portfolio.id} detail - Fetching fresh data...`,
                      { component: 'PositionsList' }
                    );
                    logger.debug(`Current portfolio.assets: ${JSON.stringify(portfolio.assets)}`, {
                      component: 'PositionsList',
                    });
                    logger.debug(
                      `Current portfolio.assetBalances: ${JSON.stringify(portfolio.assetBalances)}`,
                      { component: 'PositionsList' }
                    );

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
                    let assetsWithAllocation: Array<{
                      symbol: string;
                      address: string;
                      allocation: number;
                      value: number;
                      change24h: number;
                      price?: number;
                      chain?: string;
                    }> = [];

                    if (portfolio.assetBalances && portfolio.assetBalances.length > 0) {
                      // Use virtual allocations from API
                      assetsWithAllocation = portfolio.assetBalances.map((ab) => {
                        const assetAllocation =
                          (ab as { percentage?: number }).percentage ??
                          (totalPortfolioValue > 0
                            ? Math.round((ab.valueUSD / totalPortfolioValue) * 100)
                            : 0);
                        return {
                          symbol: ab.symbol,
                          address: ab.token,
                          allocation: assetAllocation,
                          value: ab.valueUSD,
                          change24h: (ab as { pnlPercentage?: number }).pnlPercentage ?? 0,
                          price: (ab as { price?: number }).price,
                          chain: (ab as { chain?: string }).chain,
                        };
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
                      }));
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
                      const autoHedgeRes = await fetch(
                        `/api/agents/auto-hedge?portfolioId=${portfolio.id}`
                      );

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
                      const totalHedgePnL = activeHedges.reduce(
                        (sum, h) => sum + (Number(h.current_pnl) || 0),
                        0
                      );
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
                          { symbol: '', allocation: 0 }
                        );
                        summaryParts.push(
                          `Portfolio allocation: ${topAsset.symbol} (${topAsset.allocation}%), diversified across ${assetsWithAllocation.length} assets.`
                        );
                      }

                      aiAnalysis.summary =
                        summaryParts.join(' ') || 'No active positions or hedges detected.';

                      // Generate dynamic recommendations
                      const recommendations: string[] = [];
                      if (activeHedges.length > 0) {
                        const profitableHedges = activeHedges.filter(
                          (h) => Number(h.current_pnl) > 0
                        );
                        const losingHedges = activeHedges.filter((h) => Number(h.current_pnl) < 0);
                        if (profitableHedges.length > 0) {
                          recommendations.push(
                            `Consider taking profits on ${profitableHedges.length} profitable hedge${profitableHedges.length > 1 ? 's' : ''}`
                          );
                        }
                        if (
                          losingHedges.length > 0 &&
                          Math.abs(totalHedgePnL) > totalHedgeNotional * 0.05
                        ) {
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
                        const decliningAssets = assetsWithAllocation.filter(
                          (a) => a.change24h < -3
                        );
                        recommendations.push(
                          `Monitor ${decliningAssets.map((a) => a.symbol).join(', ')} - down more than 3% in 24h`
                        );
                      }
                      if (recommendations.length === 0) {
                        recommendations.push(
                          'Portfolio is well-balanced with no immediate actions required'
                        );
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
                      aiAnalysis.riskAssessment = `Risk score: ${riskScore}/10 (${riskLabel}). This ${riskLevel.toLowerCase()} risk portfolio maintains diversification across ${registeredAssets.length} assets.${hedgeProtection}`;
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
                        riskAssessment: `This ${riskLevel.toLowerCase()} risk portfolio maintains diversification across ${registeredAssets.length} assets with automated rebalancing.`,
                      };
                    }

                    // Open detail modal with portfolio data
                    setSelectedDetailPortfolio({
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
                    });
                    setPortfolioDetailOpen(true);
                  }}
                >
                  {/* Subtle accent for active portfolios */}
                  {isActivePortfolio && (
                    <div
                      className={`absolute top-0 left-0 right-0 h-1 ${hasFunds ? 'bg-[#007AFF]' : 'bg-[#FF9500]'}`}
                    />
                  )}

                  <div className="p-4 sm:p-5">
                    {/* Card Header */}
                    <div className="flex items-start justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                            isActivePortfolio ? 'bg-[#007AFF]' : 'bg-[#e8e8ed]'
                          }`}
                        >
                          <span
                            className={`text-[18px] font-bold ${isActivePortfolio ? 'text-white' : 'text-[#86868b]'}`}
                          >
                            #{portfolio.id}
                          </span>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[15px] font-bold text-[#1d1d1f]">
                              Portfolio #{portfolio.id}
                            </span>
                            {hasFunds ? (
                              <span className="flex items-center gap-1 px-2 py-0.5 bg-[#34C759]/10 rounded-full">
                                <span className="w-1.5 h-1.5 bg-[#34C759] rounded-full animate-pulse" />
                                <span className="text-[10px] font-bold text-[#34C759]">FUNDED</span>
                              </span>
                            ) : hasRegisteredAssets ? (
                              <span className="px-2 py-0.5 bg-[#FF9500]/10 rounded-full text-[10px] font-bold text-[#FF9500]">
                                EMPTY
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 bg-[#86868b]/10 rounded-full text-[10px] font-bold text-[#86868b]">
                                NEW
                              </span>
                            )}
                          </div>
                          {portfolio.txHash && (
                            <a
                              href={`https://explorer.cronos.org/testnet/tx/${portfolio.txHash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-[#86868b] hover:text-[#007AFF] transition-colors flex items-center gap-1 mt-0.5"
                            >
                              <span className="font-mono">
                                {portfolio.txHash.slice(0, 8)}...{portfolio.txHash.slice(-6)}
                              </span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </div>
                      </div>

                      {/* Value Display */}
                      <div className="text-right">
                        <div className="text-[10px] font-semibold text-[#86868b] uppercase tracking-wider mb-0.5">
                          Value
                        </div>
                        <div
                          className={`text-[22px] font-black tracking-tight ${hasFunds ? 'text-[#1d1d1f]' : 'text-[#86868b]'}`}
                        >
                          $
                          {valueUSD.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </div>
                        {/* PnL Display */}
                        {hasFunds && (portfolioPnL !== 0 || portfolioPnLPercent !== 0) && (
                          <div
                            className={`text-[12px] font-semibold flex items-center justify-end gap-1 mt-0.5 ${portfolioPnL >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'}`}
                          >
                            {portfolioPnL >= 0 ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : (
                              <TrendingDown className="w-3 h-3" />
                            )}
                            {portfolioPnL >= 0 ? '+' : ''}$
                            {Math.abs(portfolioPnL).toLocaleString(undefined, {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}
                            <span className="text-[10px] opacity-75">
                              ({portfolioPnLPercent >= 0 ? '+' : ''}
                              {portfolioPnLPercent.toFixed(2)}%)
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Strategy Metrics Row — stacks on tiny mobile so cards don't crush */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 mb-4 min-w-0">
                      {/* Target Yield */}
                      <div className="bg-[#34C759]/5 rounded-xl p-3 border border-[#34C759]/10">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Target className="w-3.5 h-3.5 text-[#34C759]" />
                          <span className="text-[10px] font-semibold text-[#86868b] uppercase">
                            Yield
                          </span>
                        </div>
                        <div className="text-[18px] font-black text-[#34C759]">{yieldPercent}%</div>
                        <div className="text-[10px] text-[#86868b]">Target APY</div>
                      </div>

                      {/* Risk Level */}
                      <div
                        className={`${riskBg} rounded-xl p-3 border border-current/10`}
                        style={{ borderColor: `${riskColor}20` }}
                      >
                        <div className="flex items-center gap-1.5 mb-1">
                          <Shield className="w-3.5 h-3.5" style={{ color: riskColor }} />
                          <span className="text-[10px] font-semibold text-[#86868b] uppercase">
                            Risk
                          </span>
                        </div>
                        <div className="text-[18px] font-black" style={{ color: riskColor }}>
                          {riskLevel}
                        </div>
                        <div className="w-full bg-black/5 rounded-full h-1.5 mt-1">
                          <div
                            className="h-1.5 rounded-full transition-all"
                            style={{
                              width: `${riskValue}%`,
                              backgroundColor: riskColor,
                            }}
                          />
                        </div>
                      </div>

                      {/* Assets or Status */}
                      <div className="bg-[#007AFF]/5 rounded-xl p-3 border border-[#007AFF]/10">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Coins className="w-3.5 h-3.5 text-[#007AFF]" />
                          <span className="text-[10px] font-semibold text-[#86868b] uppercase">
                            Assets
                          </span>
                        </div>
                        {hasRegisteredAssets ? (
                          <>
                            <div className="text-[18px] font-black text-[#007AFF]">
                              {registeredAssets.length}
                            </div>
                            <div className="text-[10px] text-[#007AFF] truncate">
                              {registeredAssets.join(', ')}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-[18px] font-black text-[#86868b]">0</div>
                            <div className="text-[10px] text-[#86868b]">No assets yet</div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Last Activity */}
                    {lastRebalanceDate && (
                      <div className="flex items-center gap-2 px-3 py-2 bg-[#f5f5f7] rounded-lg mb-4">
                        <Clock className="w-3.5 h-3.5 text-[#86868b]" />
                        <span className="text-[11px] text-[#86868b]">
                          Last rebalanced{' '}
                          {daysSinceRebalance === 0
                            ? 'today'
                            : daysSinceRebalance === 1
                              ? 'yesterday'
                              : `${daysSinceRebalance} days ago`}
                        </span>
                        <span className="text-[11px] text-[#86868b]/60">
                          ({lastRebalanceDate.toLocaleDateString()})
                        </span>
                      </div>
                    )}

                    {/* Action Buttons */}
                    {isOwner && (
                      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                        {hasFunds ? (
                          <>
                            <button
                              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#007AFF] text-white rounded-xl text-[13px] font-semibold hover:bg-[#0066CC] transition-all active:scale-[0.98]"
                              onClick={() => fetchAgentRecommendation(portfolio)}
                              disabled={recommendationLoading}
                            >
                              <Sparkles className="w-4 h-4" />
                              AI Analysis
                            </button>
                            <button
                              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#FF3B30]/10 text-[#FF3B30] rounded-xl text-[13px] font-semibold hover:bg-[#FF3B30]/20 transition-all active:scale-[0.98]"
                              onClick={() => openWithdrawModal(portfolio)}
                            >
                              <ArrowDownToLine className="w-4 h-4" />
                              Withdraw
                            </button>
                            <button
                              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-[#34C759]/10 text-[#34C759] rounded-xl text-[13px] font-semibold hover:bg-[#34C759]/20 transition-all active:scale-[0.98]"
                              onClick={() => openDepositModal(portfolio)}
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          </>
                        ) : (
                          <button
                            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-[#34C759] text-white rounded-xl text-[14px] font-semibold hover:bg-[#30B855] transition-all active:scale-[0.98]"
                            onClick={() => openDepositModal(portfolio)}
                          >
                            <Zap className="w-4 h-4" />
                            {hasRegisteredAssets ? 'Deposit More Funds' : 'Fund This Portfolio'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty State - No Portfolios (show even if wallet has balances) */}
      {onChainPortfolios.length === 0 && (
        <NoPortfoliosEmptyState positionsCount={positions.length} totalValue={totalValue} />
      )}

      {/* Token Holdings - Wallet Balances - REDESIGNED */}
      {positions.length > 0 && positions.some((p) => parseFloat(p.balanceUSD || '0') > 0) && (
        <div className="space-y-3">
          {/* Wallet Section Header - Compact */}
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <Wallet className="w-4 h-4 text-[#FF9500]" />
              <h3 className="text-[15px] font-semibold text-[#1d1d1f]">Wallet Balances</h3>
              <span className="text-[12px] text-[#86868b]">
                ({positions.filter((p) => parseFloat(p.balanceUSD || '0') > 0).length})
              </span>
            </div>
            {/* Contextual hint when no portfolios exist */}
            {onChainPortfolios.length === 0 && (
              <span className="text-[11px] text-[#86868b] bg-[#f5f5f7] px-2 py-1 rounded-full">
                Available to fund portfolios
              </span>
            )}
          </div>

          {/* Token Cards */}
          <div className="bg-white rounded-xl shadow-sm border border-black/5 overflow-hidden">
            {positions
              .filter((p) => parseFloat(p.balanceUSD || '0') > 0)
              .map((position, idx, filteredPositions) => {
                const positionValue = parseFloat(position.balanceUSD || '0');
                const percentOfTotal = totalValue > 0 ? (positionValue / totalValue) * 100 : 0;

                return (
                  <div
                    key={`${position.symbol}-${idx}`}
                    className={`px-3 sm:px-4 py-3 hover:bg-[#f5f5f7]/50 transition-all ${
                      idx !== filteredPositions.length - 1 ? 'border-b border-black/5' : ''
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {/* Token Icon */}
                      <div
                        className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          position.symbol === 'CRO'
                            ? 'bg-[#007AFF]'
                            : position.symbol.includes('USD')
                              ? 'bg-[#34C759]'
                              : 'bg-[#FF9500]'
                        }`}
                      >
                        <TokenIcon symbol={position.symbol} />
                      </div>

                      {/* Token Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-[14px] sm:text-[15px] font-semibold text-[#1d1d1f]">
                            {position.symbol}
                          </span>
                          {position.change24h !== 0 && (
                            <span
                              className={`flex items-center gap-0.5 text-[10px] sm:text-[11px] font-semibold ${
                                position.change24h >= 0 ? 'text-[#34C759]' : 'text-[#FF3B30]'
                              }`}
                            >
                              {position.change24h >= 0 ? '+' : ''}
                              {Math.abs(position.change24h).toFixed(1)}%
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] sm:text-[12px] text-[#86868b]">
                          <span>
                            {parseFloat(position.balance).toLocaleString(undefined, {
                              maximumFractionDigits: 4,
                            })}
                          </span>
                          <span className="text-[#86868b]/50">
                            @${parseFloat(position.price || '0').toFixed(4)}
                          </span>
                        </div>
                      </div>

                      {/* Value + Allocation */}
                      <div className="text-right flex-shrink-0">
                        <div className="text-[16px] sm:text-[18px] font-bold text-[#1d1d1f]">
                          $
                          {positionValue.toLocaleString(undefined, {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </div>
                        <div className="text-[10px] font-medium text-[#86868b]">
                          {percentOfTotal.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* Deposit Modal */}
      {selectedPortfolio && (
        <DepositModal
          isOpen={depositModalOpen}
          onClose={closeDepositModal}
          portfolioId={selectedPortfolio.id}
          targetYield={parseFloat(selectedPortfolio.targetYield) / 100}
          riskTolerance={parseFloat(selectedPortfolio.riskTolerance)}
          onSuccess={handleDepositSuccess}
        />
      )}

      {/* Withdraw Modal */}
      {selectedWithdrawPortfolio && (
        <WithdrawModal
          isOpen={withdrawModalOpen}
          onClose={closeWithdrawModal}
          portfolioId={selectedWithdrawPortfolio.id}
          assets={selectedWithdrawPortfolio.assets}
          totalValue={parseFloat(selectedWithdrawPortfolio.totalValue)}
          onSuccess={handleWithdrawSuccess}
        />
      )}

      {/* Agent Recommendation Modal */}
      {showRecommendationModal && agentRecommendation && (
        <AgentRecommendationModal
          recommendation={agentRecommendation}
          analyzedPortfolio={analyzedPortfolio}
          onClose={() => setShowRecommendationModal(false)}
          onDeposit={openDepositModal}
          onWithdraw={openWithdrawModal}
          onOpenHedge={onOpenHedge}
        />
      )}

      {/* Portfolio Detail Modal */}
      {portfolioDetailOpen && selectedDetailPortfolio && (
        <PortfolioDetailModal
          portfolio={selectedDetailPortfolio}
          walletAddress={address}
          onClose={() => {
            setPortfolioDetailOpen(false);
            setSelectedDetailPortfolio(null);
          }}
        />
      )}
    </div>
  );
}
