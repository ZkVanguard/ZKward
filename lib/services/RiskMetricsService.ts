/**
 * Risk Metrics Service
 * 
 * Professional hedge fund-style risk analytics for CommunityPool
 * 
 * Metrics Implemented:
 * - Sharpe Ratio: Risk-adjusted returns (excess return / volatility)
 * - Sortino Ratio: Downside risk-adjusted returns
 * - Maximum Drawdown (MDD): Largest peak-to-trough decline
 * - Value at Risk (VaR): Maximum expected loss at confidence level
 * - Volatility: Standard deviation of returns
 * - Beta: Correlation with benchmark (BTC as proxy)
 * - Alpha: Excess return over benchmark
 * - Calmar Ratio: Annual return / Max drawdown
 * - Win Rate: Percentage of profitable periods
 * - Information Ratio: Excess return per unit tracking error
 */

import { logger } from '../utils/logger';
import { getPoolHistory } from '../storage/community-pool-storage';
import { getNavHistory } from '../db/community-pool';

// Risk-free rate (annualized) - using 5% for T-Bill proxy
const RISK_FREE_RATE = 0.05;

// Trading days per year for crypto (24/7 = 365)
const TRADING_DAYS_PER_YEAR = 365;

// Confidence level for VaR
const VAR_CONFIDENCE = 0.95;

export interface RiskMetrics {
  // Core Metrics
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownDate: string | null;
  currentDrawdown: number;
  
  // Volatility Metrics
  volatilityDaily: number;
  volatilityAnnualized: number;
  downsideVolatility: number;
  
  // Value at Risk
  var95Daily: number;      // 95% confidence, 1-day
  var95Weekly: number;     // 95% confidence, 7-day
  cvar95: number;          // Conditional VaR (Expected Shortfall)
  
  // Performance Attribution
  beta: number;            // vs BTC benchmark
  alpha: number;           // Jensen's Alpha
  treynorRatio: number;
  informationRatio: number;
  
  // Return Metrics
  calmarRatio: number;
  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  
  // Time Series — null when pool history is shorter than the requested period
  returns7d: number | null;
  returns30d: number | null;
  returns90d: number | null;
  returnsYTD: number | null;
  returnsSinceInception: number;
  
  // Meta
  dataPoints: number;
  lastCalculated: string;
  periodStart: string | null;
  periodEnd: string | null;
  
  // Data availability
  insufficientData: boolean;
  insufficientDataReason?: string;
  /** True when annualized metrics are based on < 30 days of NAV history. */
  preliminaryMetrics?: boolean;
  hasBenchmarkData: boolean;    // True if real BTC benchmark data was used
}

export interface NAVSnapshot {
  timestamp: number;
  nav: number;
  sharePrice: number;
}

/**
 * Calculate daily returns from NAV series
 * Normalizes returns to daily equivalents based on actual time span
 */
function calculateReturns(navSeries: NAVSnapshot[]): { returns: number[]; avgIntervalDays: number } {
  if (navSeries.length < 2) return { returns: [], avgIntervalDays: 1 };
  
  const returns: number[] = [];
  let totalIntervalMs = 0;
  
  for (let i = 1; i < navSeries.length; i++) {
    const prevNav = navSeries[i - 1].nav;
    const currNav = navSeries[i].nav;
    const intervalMs = navSeries[i].timestamp - navSeries[i - 1].timestamp;
    totalIntervalMs += intervalMs;
    
    if (prevNav > 0) {
      returns.push((currNav - prevNav) / prevNav);
    }
  }
  
  // Calculate average interval in days
  const avgIntervalDays = returns.length > 0 
    ? (totalIntervalMs / returns.length) / (24 * 60 * 60 * 1000)
    : 1;
  
  return { returns, avgIntervalDays };
}

/**
 * Calculate mean of array
 */
function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((sum, val) => sum + val, 0) / arr.length;
}

/**
 * Clamp value to range
 */
function clamp(value: number, min: number, max: number): number {
  if (!isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Calculate standard deviation
 */
function stdDev(arr: number[], avg?: number): number {
  if (arr.length < 2) return 0;
  const m = avg !== undefined ? avg : mean(arr);
  const squaredDiffs = arr.map(val => Math.pow(val - m, 2));
  return Math.sqrt(mean(squaredDiffs));
}

/**
 * Calculate downside deviation (only negative returns)
 */
function downsideDeviation(returns: number[], targetReturn: number = 0): number {
  const negativeReturns = returns.filter(r => r < targetReturn);
  if (negativeReturns.length < 2) return 0;
  const squaredDownside = negativeReturns.map(r => Math.pow(r - targetReturn, 2));
  return Math.sqrt(mean(squaredDownside));
}

/**
 * Calculate maximum drawdown
 */
function calculateMaxDrawdown(navSeries: NAVSnapshot[]): { maxDD: number; maxDDDate: string | null } {
  if (navSeries.length < 2) return { maxDD: 0, maxDDDate: null };
  
  let peak = navSeries[0].nav;
  let maxDD = 0;
  let maxDDDate: string | null = null;
  
  for (const point of navSeries) {
    if (point.nav > peak) {
      peak = point.nav;
    }
    const drawdown = (peak - point.nav) / peak;
    if (drawdown > maxDD) {
      maxDD = drawdown;
      maxDDDate = new Date(point.timestamp).toISOString();
    }
  }
  
  return { maxDD, maxDDDate };
}

/**
 * Calculate current drawdown from peak
 */
function calculateCurrentDrawdown(navSeries: NAVSnapshot[]): number {
  if (navSeries.length < 1) return 0;
  
  const peak = Math.max(...navSeries.map(s => s.nav));
  const current = navSeries[navSeries.length - 1].nav;
  
  return peak > 0 ? (peak - current) / peak : 0;
}

/**
 * Calculate Value at Risk.
 *
 * Hybrid: prefer historical simulation when the empirical 5th-percentile is
 * meaningfully non-zero. Fall back to a parametric estimate (mean - z·σ) when
 * the percentile snaps to zero because of many flat-NAV intervals — this
 * avoids the misleading "VaR = -0.0%" while CVaR is non-zero artifact.
 */
function calculateVaR(returns: number[], confidence: number = 0.95): number {
  if (returns.length < 10) return 0;

  const sorted = [...returns].sort((a, b) => a - b);
  const index = Math.floor((1 - confidence) * sorted.length);
  const historical = Math.abs(sorted[index] || 0);

  // If historical VaR collapsed to (near) zero due to flat returns, fall back
  // to a parametric Gaussian estimate using the *non-zero* return distribution.
  if (historical < 1e-6) {
    const m = mean(returns);
    const s = stdDev(returns, m);
    if (s > 0) {
      // 95% one-tailed z-score ≈ 1.6449
      const z = confidence >= 0.99 ? 2.3263 : confidence >= 0.95 ? 1.6449 : 1.2816;
      const parametric = z * s - m;
      return Math.abs(parametric);
    }
  }
  return historical;
}

/**
 * Calculate Conditional VaR (Expected Shortfall)
 * Average of returns below VaR threshold
 */
function calculateCVaR(returns: number[], confidence: number = 0.95): number {
  if (returns.length < 10) return 0;
  
  const sorted = [...returns].sort((a, b) => a - b);
  const cutoff = Math.floor((1 - confidence) * sorted.length);
  const tailReturns = sorted.slice(0, cutoff);
  
  return tailReturns.length > 0 ? Math.abs(mean(tailReturns)) : 0;
}

/**
 * Calculate Beta against benchmark (BTC)
 */
function calculateBeta(portfolioReturns: number[], benchmarkReturns: number[]): number {
  if (portfolioReturns.length < 3 || benchmarkReturns.length !== portfolioReturns.length) {
    return 1; // Default to market beta
  }
  
  const portfolioMean = mean(portfolioReturns);
  const benchmarkMean = mean(benchmarkReturns);
  
  let covariance = 0;
  let benchmarkVariance = 0;
  
  for (let i = 0; i < portfolioReturns.length; i++) {
    const portfolioDiff = portfolioReturns[i] - portfolioMean;
    const benchmarkDiff = benchmarkReturns[i] - benchmarkMean;
    covariance += portfolioDiff * benchmarkDiff;
    benchmarkVariance += benchmarkDiff * benchmarkDiff;
  }
  
  return benchmarkVariance > 0 ? covariance / benchmarkVariance : 1;
}

/**
 * Calculate period return
 */
function calculatePeriodReturn(navSeries: NAVSnapshot[], daysBack: number): number | null {
  if (navSeries.length < 2) return null;

  const now = Date.now();
  const cutoff = now - (daysBack * 24 * 60 * 60 * 1000);

  // If the pool's earliest snapshot is more recent than the cutoff, we don't
  // have a full `daysBack` window of history — return null instead of
  // silently anchoring to inception (which would just echo the total return).
  const earliestTs = navSeries[0].timestamp;
  if (earliestTs > cutoff) return null;

  const recentSeries = navSeries.filter(s => s.timestamp >= cutoff);
  if (recentSeries.length < 2) return null;

  const startNav = recentSeries[0].nav;
  const endNav = recentSeries[recentSeries.length - 1].nav;

  return startNav > 0 ? (endNav - startNav) / startNav : 0;
}

/**
 * Calculate YTD return
 */
function calculateYTDReturn(navSeries: NAVSnapshot[]): number | null {
  if (navSeries.length < 2) return null;

  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1).getTime();

  // If the pool started after Jan 1 of the current year, YTD is meaningless
  // (it would just equal returnsSinceInception). Surface that explicitly.
  if (navSeries[0].timestamp > yearStart) return null;

  const ytdSeries = navSeries.filter(s => s.timestamp >= yearStart);
  if (ytdSeries.length < 2) return null;

  const startNav = ytdSeries[0].nav;
  const endNav = ytdSeries[ytdSeries.length - 1].nav;

  return startNav > 0 ? (endNav - startNav) / startNav : 0;
}

/**
 * Calculate win rate and profit factor
 */
function calculateTradingMetrics(returns: number[]): { winRate: number; profitFactor: number; avgWin: number; avgLoss: number } {
  // Exclude flat intervals (r ≈ 0) — counting unchanged hours as "non-wins"
  // produces a misleading low win rate for early-stage pools whose NAV often
  // doesn't move between snapshots. Use a small epsilon to ignore floating
  // point dust.
  const EPS = 1e-9;
  const movingReturns = returns.filter(r => Math.abs(r) > EPS);
  const wins = movingReturns.filter(r => r > 0);
  const losses = movingReturns.filter(r => r < 0);
  
  const totalWins = wins.reduce((sum, r) => sum + r, 0);
  const totalLosses = Math.abs(losses.reduce((sum, r) => sum + r, 0));
  
  return {
    winRate: movingReturns.length > 0 ? (wins.length / movingReturns.length) * 100 : 0,
    profitFactor: totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0,
    avgWin: wins.length > 0 ? mean(wins) * 100 : 0,
    avgLoss: losses.length > 0 ? Math.abs(mean(losses)) * 100 : 0,
  };
}

/**
 * Generate NAV history from share price data
 * 
 * PRIORITY:
 * 1. Database NAV history (most accurate - recorded snapshots)
 * 2. Transaction history (fallback)
 * 
 * IMPORTANT: Risk metrics should be based on SHARE PRICE changes, not NAV.
 * NAV changes when users deposit/withdraw - that's not investment performance.
 * Share price changes reflect actual portfolio performance.
 * 
 * Returns empty array if no real performance data is available.
 */
async function getHistoricalNAV(chain?: string): Promise<NAVSnapshot[]> {
  // First try database NAV history (preferred source)
  try {
    const navHistory = await getNavHistory(365, chain);
    
    // If we have NAV history, trust it as the source of truth
    // Don't fall back to potentially corrupt transaction history
    if (navHistory.length >= 1) {
      const prices = navHistory.map(h => Number(h.share_price));
      
      // Need at least 2 points to calculate returns
      if (navHistory.length < 2) {
        logger.info('[RiskMetrics] NAV history has only 1 entry, insufficient for metrics', {
          dataPoints: navHistory.length,
          price: prices[0],
        });
        // Return the single point anyway - caller will handle insufficient data
        return navHistory.map(h => ({
          timestamp: h.timestamp.getTime(),
          nav: 10000 * Number(h.share_price),
          sharePrice: Number(h.share_price),
        }));
      }
      
      const uniquePrices = new Set(prices.map(p => p.toFixed(4)));
      // Has real data if: multiple different prices, OR single price that isn't ~1.0
      const hasRealPriceData = uniquePrices.size > 1 || 
        (uniquePrices.size === 1 && Math.abs(prices[0] - 1.0) > 0.001);
      
      if (hasRealPriceData) {
        logger.info('[RiskMetrics] Using database NAV history', {
          dataPoints: navHistory.length,
          uniquePrices: uniquePrices.size,
          priceRange: `${Math.min(...prices).toFixed(4)} - ${Math.max(...prices).toFixed(4)}`,
        });
      } else {
        logger.info('[RiskMetrics] NAV history has no price variation (early stage pool)', {
          dataPoints: navHistory.length,
          price: prices[0],
        });
      }
      
      const baseNAV = 10000; // Normalize to $10k base
      return navHistory.map(h => ({
        timestamp: h.timestamp.getTime(),
        nav: baseNAV * Number(h.share_price),
        sharePrice: Number(h.share_price),
      }));
    }
  } catch (err) {
    logger.warn('[RiskMetrics] Failed to fetch database NAV history, falling back to transactions', { err });
  }
  
  // Fallback to transaction history - ONLY if no NAV history exists at all
  const history = await getPoolHistory(365);
  
  // Need at least 2 data points to calculate returns
  if (history.length < 2) {
    logger.info('[RiskMetrics] Insufficient transaction history', {
      transactions: history.length,
    });
    return [];
  }
  
  const sortedHistory = [...history].sort((a, b) => a.timestamp - b.timestamp);
  
  // Get unique share prices (convert to numbers for comparison)
  const prices = sortedHistory
    .map(tx => tx.sharePrice)
    .filter(p => p !== undefined && p !== null)
    .map(p => Number(p));
  const uniquePrices = new Set(prices);
  
  // Has real data if: multiple different prices, OR single price that isn't ~1.0
  const hasRealPriceData = uniquePrices.size > 1 || 
    (uniquePrices.size === 1 && Math.abs([...uniquePrices][0] - 1.0) > 0.001);
  
  if (!hasRealPriceData) {
    logger.info('[RiskMetrics] No share price variation detected (all prices are ~1.0)', {
      transactions: history.length,
      uniquePrices: uniquePrices.size,
    });
    return [];
  }
  
  // Smart aggregation: use the finest granularity that shows price variation
  // 1. Try daily aggregation first (best for mature funds)
  // 2. Fall back to hourly if daily has no variation (early stage)
  // 3. Fall back to transaction-level if needed (demo/testing)
  
  const dailyPrices = aggregateToTimePeriod(sortedHistory, 'daily');
  const dailyUnique = new Set(dailyPrices.map(p => p.sharePrice.toFixed(4)));
  
  if (dailyPrices.length >= 2 && dailyUnique.size > 1) {
    logger.info('[RiskMetrics] Using daily-aggregated data', {
      rawTransactions: sortedHistory.length,
      dailyDataPoints: dailyPrices.length,
      priceRange: `${Math.min(...dailyPrices.map(p => p.sharePrice)).toFixed(4)} - ${Math.max(...dailyPrices.map(p => p.sharePrice)).toFixed(4)}`,
    });
    return dailyPrices.map(dp => ({
      timestamp: dp.timestamp,
      nav: 10000 * dp.sharePrice,
      sharePrice: dp.sharePrice,
    }));
  }
  
  // Try hourly aggregation for early-stage funds
  const hourlyPrices = aggregateToTimePeriod(sortedHistory, 'hourly');
  const hourlyUnique = new Set(hourlyPrices.map(p => p.sharePrice.toFixed(4)));
  
  if (hourlyPrices.length >= 2 && hourlyUnique.size > 1) {
    logger.info('[RiskMetrics] Using hourly-aggregated data (early stage)', {
      rawTransactions: sortedHistory.length,
      hourlyDataPoints: hourlyPrices.length,
      priceRange: `${Math.min(...hourlyPrices.map(p => p.sharePrice)).toFixed(4)} - ${Math.max(...hourlyPrices.map(p => p.sharePrice)).toFixed(4)}`,
    });
    return hourlyPrices.map(dp => ({
      timestamp: dp.timestamp,
      nav: 10000 * dp.sharePrice,
      sharePrice: dp.sharePrice,
    }));
  }
  
  // Fall back to transaction-level with sampling (demo/testing)
  // Sample every Nth transaction to reduce noise while preserving price journey
  const sampleRate = Math.max(1, Math.floor(sortedHistory.length / 20)); // Max ~20 data points
  const sampledTx = sortedHistory.filter((_, i) => i % sampleRate === 0 || i === sortedHistory.length - 1);
  
  logger.info('[RiskMetrics] Using sampled transaction data (demo mode)', {
    rawTransactions: sortedHistory.length,
    sampledDataPoints: sampledTx.length,
    sampleRate,
  });
  
  return sampledTx.map(tx => ({
    timestamp: tx.timestamp,
    nav: 10000 * Number(tx.sharePrice || 1),
    sharePrice: Number(tx.sharePrice || 1),
  }));
}

/**
 * Aggregate transactions to time periods (daily or hourly)
 * Takes the closing price of each period
 */
function aggregateToTimePeriod(
  transactions: Array<{ timestamp: number; sharePrice?: number }>,
  period: 'daily' | 'hourly'
): Array<{ timestamp: number; sharePrice: number }> {
  const periodMap = new Map<string, { timestamp: number; sharePrice: number }>();
  
  for (const tx of transactions) {
    if (!tx.sharePrice) continue;
    
    const date = new Date(tx.timestamp);
    let periodKey: string;
    
    if (period === 'daily') {
      periodKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    } else {
      periodKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}`;
    }
    
    // Keep the latest transaction of each period (closing price)
    const existing = periodMap.get(periodKey);
    if (!existing || tx.timestamp > existing.timestamp) {
      periodMap.set(periodKey, {
        timestamp: tx.timestamp,
        sharePrice: Number(tx.sharePrice),
      });
    }
  }
  
  return Array.from(periodMap.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Generate BTC benchmark returns for beta calculation
 * Fetches REAL BTC price history from Crypto.com Exchange API
 * Matches timestamps with NAV series for proper correlation calculation
 */
async function fetchBTCBenchmarkReturns(navSeries: NAVSnapshot[]): Promise<number[]> {
  if (navSeries.length < 2) return [];
  
  try {
    const EXCHANGE_API = 'https://api.crypto.com/exchange/v1/public';
    
    // Determine appropriate timeframe based on NAV observation frequency
    const totalPeriodMs = navSeries[navSeries.length - 1].timestamp - navSeries[0].timestamp;
    const avgIntervalMs = totalPeriodMs / (navSeries.length - 1);
    const avgIntervalHours = avgIntervalMs / (1000 * 60 * 60);
    
    // Choose timeframe: use 1D for periods > 12h, 1h for shorter
    const timeframe = avgIntervalHours >= 12 ? '1D' : '1h';
    const count = Math.min(navSeries.length + 10, 300); // Extra buffer for matching
    
    const url = `${EXCHANGE_API}/get-candlestick?instrument_name=BTC_USDT&timeframe=${timeframe}&count=${count}`;
    
    logger.info('[RiskMetrics] Fetching BTC benchmark data', { timeframe, count, avgIntervalHours: avgIntervalHours.toFixed(2) });
    
    const response = await fetch(url, { 
      signal: AbortSignal.timeout(10000) // 10 second timeout
    });
    
    if (!response.ok) {
      throw new Error(`Exchange API HTTP error: ${response.status}`);
    }
    
    const json = await response.json();
    
    if (json.code !== 0 || !json.result?.data || json.result.data.length === 0) {
      throw new Error(`Exchange API error: ${json.message || 'no data'}`);
    }
    
    const candles = json.result.data as Array<{ t: number; o: string; c: string }>;
    
    // Sort candles by timestamp ascending
    candles.sort((a, b) => a.t - b.t);
    
    logger.info('[RiskMetrics] Received BTC candlestick data', { count: candles.length });
    
    // Create price map for efficient timestamp matching
    const btcPriceMap = new Map<number, number>();
    for (const candle of candles) {
      btcPriceMap.set(candle.t, parseFloat(candle.c));
    }
    
    // Match BTC prices to NAV timestamps (find closest candle)
    const matchedBTCPrices: number[] = [];
    for (const nav of navSeries) {
      // Find candle closest to NAV timestamp
      let closestTimestamp = 0;
      let minDiff = Infinity;
      
      for (const candleTs of btcPriceMap.keys()) {
        const diff = Math.abs(candleTs - nav.timestamp);
        if (diff < minDiff) {
          minDiff = diff;
          closestTimestamp = candleTs;
        }
      }
      
      const price = btcPriceMap.get(closestTimestamp);
      if (price) {
        matchedBTCPrices.push(price);
      }
    }
    
    // Calculate BTC returns (same method as portfolio returns)
    const btcReturns: number[] = [];
    for (let i = 1; i < matchedBTCPrices.length; i++) {
      const prevPrice = matchedBTCPrices[i - 1];
      const currPrice = matchedBTCPrices[i];
      if (prevPrice > 0) {
        btcReturns.push((currPrice - prevPrice) / prevPrice);
      }
    }
    
    logger.info('[RiskMetrics] Calculated BTC benchmark returns', { 
      btcDataPoints: btcReturns.length,
      btcMeanReturn: (mean(btcReturns) * 100).toFixed(4) + '%',
    });
    
    return btcReturns;
    
  } catch (error) {
    logger.warn('[RiskMetrics] Failed to fetch BTC benchmark, using fallback', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Return empty array - caller will handle gracefully
    return [];
  }
}

/**
 * Calculate comprehensive risk metrics
 */
export async function calculateRiskMetrics(chain?: string): Promise<RiskMetrics> {
  const emptyMetrics: RiskMetrics = {
    sharpeRatio: 0,
    sortinoRatio: 0,
    maxDrawdown: 0,
    maxDrawdownDate: null,
    currentDrawdown: 0,
    volatilityDaily: 0,
    volatilityAnnualized: 0,
    downsideVolatility: 0,
    var95Daily: 0,
    var95Weekly: 0,
    cvar95: 0,
    beta: 0,
    alpha: 0,
    treynorRatio: 0,
    informationRatio: 0,
    calmarRatio: 0,
    winRate: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    returns7d: null,
    returns30d: null,
    returns90d: null,
    returnsYTD: null,
    returnsSinceInception: 0,
    dataPoints: 0,
    lastCalculated: new Date().toISOString(),
    periodStart: null,
    periodEnd: null,
    insufficientData: true,
    insufficientDataReason: 'No share price history available',
    hasBenchmarkData: false,
  };

  try {
    const navSeries = await getHistoricalNAV(chain);
    
    // Minimum data points for meaningful risk metrics
    // 7 points = 1 week of daily data, minimum for statistical significance
    const MIN_DATA_POINTS = 3;
    
    // Check for insufficient data
    if (navSeries.length < 2) {
      logger.info('[RiskMetrics] Insufficient data for risk calculation', {
        dataPoints: navSeries.length,
      });
      return {
        ...emptyMetrics,
        insufficientDataReason: navSeries.length === 0 
          ? 'No share price history available. Risk metrics require actual portfolio performance data.'
          : 'Only 1 data point available. Risk metrics require at least 2 data points.',
      };
    }
    
    const { returns, avgIntervalDays } = calculateReturns(navSeries);
    
    // Need at least 1 return to calculate anything meaningful
    if (returns.length < 1) {
      return {
        ...emptyMetrics,
        dataPoints: navSeries.length,
        insufficientDataReason: 'Unable to calculate returns from available data.',
      };
    }
    
    // Calculate actual observation period in days
    const totalPeriodMs = navSeries[navSeries.length - 1].timestamp - navSeries[0].timestamp;
    const totalPeriodDays = totalPeriodMs / (24 * 60 * 60 * 1000);
    
    // For annualization, use periods per year based on actual interval
    // E.g., if interval is 1 hour (1/24 day), periods_per_year = 365 * 24 = 8760
    const periodsPerYear = avgIntervalDays > 0 ? TRADING_DAYS_PER_YEAR / avgIntervalDays : TRADING_DAYS_PER_YEAR;
    
    logger.info('[RiskMetrics] Time-based calculation', {
      dataPoints: returns.length,
      avgIntervalDays: avgIntervalDays.toFixed(4),
      totalPeriodDays: totalPeriodDays.toFixed(2),
      periodsPerYear: periodsPerYear.toFixed(0),
    });
    
    // Check if we have enough data for statistically meaningful ANNUALIZED metrics
    // Annualized metrics require BOTH:
    // 1. Minimum data points (7) for statistical significance
    // 2. Minimum time span (0.9 days = ~22 hours) for meaningful annualization
    const hasMinimumPoints = navSeries.length >= MIN_DATA_POINTS;
    const hasMinimumTimeSpan = totalPeriodDays >= 0.08; // ~2 hours
    
    if (!hasMinimumPoints || !hasMinimumTimeSpan) {
      logger.info('[RiskMetrics] Insufficient data for annualized metrics', {
        dataPoints: navSeries.length,
        totalPeriodDays,
        minPointsRequired: MIN_DATA_POINTS,
        minDaysRequired: 0.9,
        hasMinimumPoints,
        hasMinimumTimeSpan,
      });
      
      // Calculate only basic metrics that are meaningful with limited data
      const { maxDD, maxDDDate } = calculateMaxDrawdown(navSeries);
      const currentDD = calculateCurrentDrawdown(navSeries);
      const returnsSinceInception = navSeries.length > 1 
        ? (navSeries[navSeries.length - 1].nav - navSeries[0].nav) / navSeries[0].nav 
        : 0;
      
      return {
        ...emptyMetrics,
        maxDrawdown: parseFloat(clamp(maxDD * 100, 0, 99.9).toFixed(2)),
        maxDrawdownDate: maxDDDate,
        currentDrawdown: parseFloat(clamp(currentDD * 100, 0, 99.9).toFixed(2)),
        returnsSinceInception: parseFloat(clamp(returnsSinceInception * 100, -99, 10000).toFixed(2)),
        dataPoints: returns.length,
        lastCalculated: new Date().toISOString(),
        periodStart: new Date(navSeries[0].timestamp).toISOString(),
        periodEnd: new Date(navSeries[navSeries.length - 1].timestamp).toISOString(),
        insufficientData: true,
        insufficientDataReason: !hasMinimumTimeSpan 
          ? `Only ${(totalPeriodDays * 24).toFixed(1)} hours of data. Annualized metrics require at least 2 hours.`
          : `Only ${navSeries.length} data points. At least ${MIN_DATA_POINTS} required for statistically meaningful metrics.`,
      };
    }
    
    // Interval-based stats (not assuming daily)
    const intervalMean = mean(returns);
    const intervalStdDev = stdDev(returns, intervalMean);
    const downsideVol = downsideDeviation(returns);
    
    // Convert to daily equivalents first (normalize by interval)
    // Daily return = interval return / interval_days (simple scaling for small intervals)
    const dailyMean = intervalMean / avgIntervalDays;
    const dailyStdDev = intervalStdDev / Math.sqrt(avgIntervalDays);
    const dailyDownsideVol = downsideVol / Math.sqrt(avgIntervalDays);
    
    // Now annualize from daily metrics
    const annualizedReturn = dailyMean * TRADING_DAYS_PER_YEAR;
    const annualizedVol = dailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR);
    const annualizedDownsideVol = dailyDownsideVol * Math.sqrt(TRADING_DAYS_PER_YEAR);
    
    // Daily risk-free rate
    const _dailyRiskFree = RISK_FREE_RATE / TRADING_DAYS_PER_YEAR;
    
    // Sharpe Ratio (annualized)
    const excessReturn = annualizedReturn - RISK_FREE_RATE;
    const sharpeRatio = annualizedVol > 0 ? excessReturn / annualizedVol : 0;
    
    // Sortino Ratio (annualized)
    const sortinoRatio = annualizedDownsideVol > 0 ? excessReturn / annualizedDownsideVol : 0;
    
    // Maximum Drawdown
    const { maxDD, maxDDDate } = calculateMaxDrawdown(navSeries);
    const currentDD = calculateCurrentDrawdown(navSeries);
    
    // Calmar Ratio
    const calmarRatio = maxDD > 0 ? annualizedReturn / maxDD : 0;
    
    // Value at Risk
    const var95Daily = calculateVaR(returns, VAR_CONFIDENCE);
    const var95Weekly = var95Daily * Math.sqrt(7);
    const cvar95 = calculateCVaR(returns, VAR_CONFIDENCE);
    
    // Beta and Alpha using REAL BTC benchmark data
    const benchmarkReturns = await fetchBTCBenchmarkReturns(navSeries);
    const hasBenchmarkData = benchmarkReturns.length === returns.length && benchmarkReturns.some(r => r !== 0);
    
    let beta = 1.0;  // Default to market beta if no data
    let benchmarkAnnualizedReturn = 0;
    let alpha = 0;
    let treynorRatio = 0;
    let informationRatio = 0;
    
    if (hasBenchmarkData) {
      beta = calculateBeta(returns, benchmarkReturns);
      // Normalize benchmark returns the same way (same time intervals as portfolio)
      const benchmarkIntervalMean = mean(benchmarkReturns);
      const benchmarkDailyMean = benchmarkIntervalMean / avgIntervalDays;
      benchmarkAnnualizedReturn = benchmarkDailyMean * TRADING_DAYS_PER_YEAR;
      // Jensen's Alpha: actual return - CAPM expected return
      alpha = annualizedReturn - (RISK_FREE_RATE + beta * (benchmarkAnnualizedReturn - RISK_FREE_RATE));
      
      // Treynor Ratio
      treynorRatio = beta !== 0 ? excessReturn / beta : 0;
      
      // Information Ratio - excess return per unit tracking error
      const trackingErrors = returns.map((r, i) => r - (benchmarkReturns[i] || 0));
      const trackingErrorIntervalStdDev = stdDev(trackingErrors);
      const trackingErrorDailyStdDev = trackingErrorIntervalStdDev / Math.sqrt(avgIntervalDays);
      const trackingErrorAnnualized = trackingErrorDailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR);
      informationRatio = trackingErrorAnnualized > 0 ? (annualizedReturn - benchmarkAnnualizedReturn) / trackingErrorAnnualized : 0;
      
      logger.info('[RiskMetrics] Calculated with real BTC benchmark', {
        beta: beta.toFixed(4),
        alpha: (alpha * 100).toFixed(2) + '%',
        benchmarkReturn: (benchmarkAnnualizedReturn * 100).toFixed(2) + '%',
      });
    } else {
      logger.warn('[RiskMetrics] No BTC benchmark data available, using defaults');
    }
    
    // Trading metrics
    const tradingMetrics = calculateTradingMetrics(returns);
    
    // Period returns
    const returns7d = calculatePeriodReturn(navSeries, 7);
    const returns30d = calculatePeriodReturn(navSeries, 30);
    const returns90d = calculatePeriodReturn(navSeries, 90);
    const returnsYTD = calculateYTDReturn(navSeries);
    const returnsSinceInception = navSeries.length > 1 
      ? (navSeries[navSeries.length - 1].nav - navSeries[0].nav) / navSeries[0].nav 
      : 0;
    
    const metrics: RiskMetrics = {
      // Core - clamp to reasonable ranges
      sharpeRatio: parseFloat(clamp(sharpeRatio, -10, 10).toFixed(2)),
      sortinoRatio: parseFloat(clamp(sortinoRatio, -10, 10).toFixed(2)),
      maxDrawdown: parseFloat(clamp(maxDD * 100, 0, 99.9).toFixed(2)),
      maxDrawdownDate: maxDDDate,
      currentDrawdown: parseFloat(clamp(currentDD * 100, 0, 99.9).toFixed(2)),
      
      // Volatility - clamp to reasonable daily max
      volatilityDaily: parseFloat(clamp(dailyStdDev * 100, 0, 50).toFixed(2)),
      volatilityAnnualized: parseFloat(clamp(annualizedVol * 100, 0, 500).toFixed(2)),
      downsideVolatility: parseFloat(clamp(annualizedDownsideVol * 100, 0, 500).toFixed(2)),
      
      // VaR - clamp to reasonable loss limits
      var95Daily: parseFloat(clamp(var95Daily * 100, 0, 50).toFixed(2)),
      var95Weekly: parseFloat(clamp(var95Weekly * 100, 0, 75).toFixed(2)),
      cvar95: parseFloat(clamp(cvar95 * 100, 0, 75).toFixed(2)),
      
      // Attribution - clamp beta/alpha
      beta: parseFloat(clamp(beta, -5, 5).toFixed(2)),
      alpha: parseFloat(clamp(alpha * 100, -500, 500).toFixed(2)),
      treynorRatio: parseFloat(clamp(treynorRatio, -100, 100).toFixed(2)),
      informationRatio: parseFloat(clamp(informationRatio, -10, 10).toFixed(2)),
      
      // Returns - clamp to reasonable bounds
      calmarRatio: parseFloat(clamp(calmarRatio, -100, 100).toFixed(2)),
      winRate: parseFloat(clamp(tradingMetrics.winRate, 0, 100).toFixed(1)),
      profitFactor: parseFloat(clamp(tradingMetrics.profitFactor, 0, 99.99).toFixed(2)),
      avgWin: parseFloat(clamp(tradingMetrics.avgWin, 0, 100).toFixed(2)),
      avgLoss: parseFloat(clamp(tradingMetrics.avgLoss, 0, 100).toFixed(2)),
      
      // Time Series - clamp extreme returns; preserve null when window > pool age
      returns7d: returns7d === null ? null : parseFloat(clamp(returns7d * 100, -99, 1000).toFixed(2)),
      returns30d: returns30d === null ? null : parseFloat(clamp(returns30d * 100, -99, 1000).toFixed(2)),
      returns90d: returns90d === null ? null : parseFloat(clamp(returns90d * 100, -99, 5000).toFixed(2)),
      returnsYTD: returnsYTD === null ? null : parseFloat(clamp(returnsYTD * 100, -99, 10000).toFixed(2)),
      returnsSinceInception: parseFloat(clamp(returnsSinceInception * 100, -99, 10000).toFixed(2)),
      
      // Meta
      dataPoints: returns.length,
      lastCalculated: new Date().toISOString(),
      periodStart: navSeries.length > 0 ? new Date(navSeries[0].timestamp).toISOString() : null,
      periodEnd: navSeries.length > 0 ? new Date(navSeries[navSeries.length - 1].timestamp).toISOString() : null,
      
      // Data is sufficient
      insufficientData: false,
      preliminaryMetrics: totalPeriodDays < 30,
      hasBenchmarkData,
    };
    
    logger.info('[RiskMetrics] Calculated risk metrics', { sharpeRatio, maxDrawdown: maxDD, beta });
    
    return metrics;
    
  } catch (error) {
    logger.error('[RiskMetrics] Failed to calculate metrics', error);
    
    // Return default metrics on error
    return {
      ...getDefaultMetrics(),
      insufficientData: true,
      insufficientDataReason: 'Error calculating metrics: ' + (error instanceof Error ? error.message : 'Unknown error'),
    };
  }
}

/**
 * Get default/placeholder metrics
 */
function getDefaultMetrics(): RiskMetrics {
  return {
    sharpeRatio: 0,
    sortinoRatio: 0,
    maxDrawdown: 0,
    maxDrawdownDate: null,
    currentDrawdown: 0,
    volatilityDaily: 0,
    volatilityAnnualized: 0,
    downsideVolatility: 0,
    var95Daily: 0,
    var95Weekly: 0,
    cvar95: 0,
    beta: 0,
    alpha: 0,
    treynorRatio: 0,
    informationRatio: 0,
    calmarRatio: 0,
    winRate: 0,
    profitFactor: 0,
    avgWin: 0,
    avgLoss: 0,
    returns7d: null,
    returns30d: null,
    returns90d: null,
    returnsYTD: null,
    returnsSinceInception: 0,
    dataPoints: 0,
    lastCalculated: new Date().toISOString(),
    periodStart: null,
    periodEnd: null,
    insufficientData: true,
    insufficientDataReason: 'No performance data available',
    hasBenchmarkData: false,
  };
}

/**
 * Get risk rating based on metrics
 */
export function getRiskRating(metrics: RiskMetrics): { rating: string; color: string; description: string } {
  const { sharpeRatio, maxDrawdown, volatilityAnnualized, var95Daily } = metrics;
  
  // Composite risk score
  let riskScore = 0;
  
  // Sharpe > 1.5 = low risk, < 0.5 = high risk
  if (sharpeRatio > 1.5) riskScore += 3;
  else if (sharpeRatio > 1.0) riskScore += 2;
  else if (sharpeRatio > 0.5) riskScore += 1;
  
  // Max DD < 10% = low risk, > 30% = high risk
  if (maxDrawdown < 10) riskScore += 3;
  else if (maxDrawdown < 20) riskScore += 2;
  else if (maxDrawdown < 30) riskScore += 1;
  
  // Volatility < 20% = low risk, > 50% = high risk
  if (volatilityAnnualized < 20) riskScore += 3;
  else if (volatilityAnnualized < 35) riskScore += 2;
  else if (volatilityAnnualized < 50) riskScore += 1;
  
  // VaR < 3% = low risk, > 7% = high risk
  if (var95Daily < 3) riskScore += 3;
  else if (var95Daily < 5) riskScore += 2;
  else if (var95Daily < 7) riskScore += 1;
  
  // Rating scale: 0-4 High, 5-8 Moderate, 9-12 Low
  if (riskScore >= 9) {
    return { rating: 'Low', color: 'text-green-500', description: 'Conservative risk profile with strong risk-adjusted returns' };
  } else if (riskScore >= 5) {
    return { rating: 'Moderate', color: 'text-yellow-500', description: 'Balanced risk-reward with typical crypto volatility' };
  } else {
    return { rating: 'High', color: 'text-red-500', description: 'Aggressive exposure with elevated volatility and drawdown risk' };
  }
}

/**
 * Calculate real-time volatility from live market data
 * Uses 24h high/low range to estimate intraday volatility, annualized
 * 
 * @param chain - 'sui' | 'all'
 * @returns Weighted volatility based on chain's typical portfolio allocation
 */
export async function calculateRealTimeVolatility(chain: string): Promise<{
  weightedVolatility: number;
  assets: Array<{ symbol: string; volatility: number; weight: number }>;
  source: string;
  timestamp: string;
}> {
  // Import dynamically to avoid circular dependencies
  const { getMarketDataService } = await import('./market-data/RealMarketDataService');
  
  // Chain-specific assets and target allocations
  const chainAssets: Record<string, { symbols: string[]; weights: number[] }> = {
    'sui': { 
      // SUI pool uses native SUI - no separate USDC stablecoin
      symbols: ['SUI', 'BTC', 'ETH'], 
      weights: [0.50, 0.30, 0.20] 
    },
    'all': { 
      symbols: ['BTC', 'ETH', 'SUI', 'CRO', 'USDC'], 
      weights: [0.30, 0.30, 0.20, 0.15, 0.05] 
    },
  };
  
  const config = chainAssets[chain] || chainAssets['all'];
  const { symbols, weights } = config;
  
  try {
    const marketData = getMarketDataService();
    const extendedPrices = await marketData.getExtendedPrices(symbols);
    
    let totalWeightedVol = 0;
    const assets: Array<{ symbol: string; volatility: number; weight: number }> = [];
    
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i];
      const weight = weights[i];
      const data = extendedPrices.get(symbol.toUpperCase());
      
      let vol = 0.30; // Default 30% if no data
      
      if (data && data.price > 0) {
        // Calculate volatility from 24h range: (high - low) / price
        // Then annualize: × √252 for crypto (or √365 for 24/7 markets)
        const range = data.high24h - data.low24h;
        const intradayVol = range / data.price;
        vol = intradayVol * Math.sqrt(365); // Annualized
        
        // Clamp to reasonable range (1% - 200% annualized)
        vol = Math.max(0.01, Math.min(2.0, vol));
      }
      
      totalWeightedVol += vol * weight;
      assets.push({ symbol, volatility: vol, weight });
    }
    
    logger.info('[RiskMetrics] Real-time volatility calculated', { 
      chain, 
      weightedVol: (totalWeightedVol * 100).toFixed(1) + '%',
      assetCount: assets.length,
    });
    
    return {
      weightedVolatility: totalWeightedVol,
      assets,
      source: 'live-market-data',
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    logger.error('[RiskMetrics] Failed to calculate real-time volatility', error);
    
    // Return fallback volatility based on typical crypto volatility
    const fallbackVol = chain === 'all' ? 0.45 : 0.50;
    return {
      weightedVolatility: fallbackVol,
      assets: symbols.map((sym, i) => ({ symbol: sym, volatility: 0.50, weight: weights[i] })),
      source: 'fallback',
      timestamp: new Date().toISOString(),
    };
  }
}
