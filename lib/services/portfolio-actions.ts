/**
 * Smart Portfolio Actions Service
 * Enables LLM to execute real portfolio operations
 */

import { logger } from '../utils/logger';

export interface PortfolioAction {
  type: 'buy' | 'sell' | 'analyze' | 'assess-risk' | 'get-hedges' | 'execute-hedge' | 'rebalance' | 'snapshot';
  params: Record<string, unknown>;
  requiresSignature?: boolean;  // Manager approval required
  signatureMessage?: string;     // Message to sign for approval
  portfolioSettings?: {         // Portfolio configuration for auto-approval
    autoApprovalEnabled?: boolean;
    autoApprovalThreshold?: number;
  };
}

export interface ActionResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
  error?: string;
  requiresApproval?: boolean;    // Action needs manager signature
  approvalMessage?: string;       // Message for manager to sign
}

/**
 * Check if an action can be auto-approved based on portfolio settings
 */
export function checkAutoApproval(
  action: PortfolioAction,
  portfolioSettings?: { autoApprovalEnabled?: boolean; autoApprovalThreshold?: number }
): boolean {
  // Only hedge and rebalance actions support auto-approval
  if (!['execute-hedge', 'rebalance'].includes(action.type)) {
    return false;
  }

  // Check if auto-approval is enabled
  if (!portfolioSettings?.autoApprovalEnabled) {
    return false;
  }

  // Check if hedge value is within threshold
  const hedgeValue = Number(action.params?.hedgeValue || action.params?.notionalValue || 0);
  const threshold = Number(portfolioSettings.autoApprovalThreshold || 10000);

  return hedgeValue > 0 && hedgeValue <= threshold;
}

/**
 * Execute a portfolio action
 * Uses REAL on-chain data - no simulations
 */
export async function executePortfolioAction(action: PortfolioAction): Promise<ActionResult> {
  try {
    logger.info('Executing portfolio action (REAL ON-CHAIN)', { type: action.type, params: action.params });

    const baseUrl = typeof window !== 'undefined' 
      ? '' 
      : (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000');

    // For analysis actions, use on-chain data directly
    if (['analyze', 'assess-risk', 'get-hedges'].includes(action.type)) {
      const portfolioData = await getPortfolioData();
      
      if (!portfolioData?.portfolio) {
        return {
          success: false,
          message: 'No on-chain portfolio data available',
          error: 'Connect wallet or ensure SERVER_WALLET_PRIVATE_KEY is set',
        };
      }

      // Generate analysis result from real on-chain data
      const result = await generateAnalysisFromOnChainData(action.type, portfolioData);
      
      return {
        success: true,
        message: `${action.type} completed with real on-chain data`,
        data: { result, portfolio: portfolioData.portfolio },
      };
    }

    // For trade actions (buy/sell), use the on-chain trading endpoint
    const response = await fetch(`${baseUrl}/api/portfolio/onchain/trade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: action.type,
        ...action.params,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      return {
        success: false,
        message: `Failed to execute ${action.type}`,
        error: error.details || error.error || 'On-chain transaction failed',
      };
    }

    const result = await response.json();
    
    return {
      success: true,
      message: `Successfully executed ${action.type}`,
      data: result,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('Portfolio action error:', { 
      error: errorMsg, 
      action: action.type,
    });
    return {
      success: false,
      message: `Unable to execute on-chain action. Please check your connection.`,
      error: errorMsg,
    };
  }
}

/**
 * Generate analysis results from real on-chain portfolio data
 */
async function generateAnalysisFromOnChainData(
  actionType: string,
  portfolioData: Record<string, unknown>
): Promise<Record<string, unknown> | Array<Record<string, unknown>>> {
  const portfolio = portfolioData.portfolio as Record<string, unknown>;
  const positions = (portfolio.positions || []) as Array<{ symbol: string; value: number }>;
  const totalValue = (portfolio.totalValue || 0) as number;

  switch (actionType) {
    case 'analyze': {
      // Calculate real metrics from on-chain positions
      const topPositions = positions
        .sort((a, b) => b.value - a.value)
        .slice(0, 3);
      
      return {
        summary: `Portfolio Value: $${totalValue.toFixed(2)} across ${positions.length} assets`,
        totalValue,
        positions,
        healthScore: positions.length > 1 ? 70 : 40, // Diversification bonus
        riskScore: positions.some(p => p.symbol !== 'USDC' && p.symbol !== 'devUSDC') ? 55 : 15,
        strengths: positions.length > 0 
          ? topPositions.map(p => `${p.symbol}: $${p.value.toFixed(2)} (${((p.value/totalValue)*100).toFixed(1)}%)`)
          : ['No positions yet'],
        risks: positions.length < 3 
          ? ['Low diversification - consider adding more assets']
          : [],
        recommendations: positions.length === 0
          ? ['Start by buying some CRO or ETH']
          : positions.length < 3
            ? ['Consider diversifying into more assets']
            : ['Portfolio is well diversified'],
      };
    }

    case 'assess-risk': {
      // Calculate risk metrics from real positions
      const hasVolatileAssets = positions.some(p => 
        !['USDC', 'USDT', 'devUSDC', 'DAI'].includes(p.symbol)
      );
      const volatileWeight = positions
        .filter(p => !['USDC', 'USDT', 'devUSDC', 'DAI'].includes(p.symbol))
        .reduce((sum: number, p) => sum + (p.value / totalValue), 0);
      
      const volatility = hasVolatileAssets ? 0.25 + (volatileWeight * 0.15) : 0.02;
      const var95 = volatility * 1.65; // 95% VaR approximation
      const riskScore = Math.min(100, volatileWeight * 80 + 10);
      
      return {
        riskScore,
        volatility,
        var95,
        sharpeRatio: volatility > 0.1 ? 0.8 : 1.5,
        overallRisk: riskScore > 70 ? 'High' : riskScore > 40 ? 'Moderate' : 'Low',
        exposures: positions.map(p => ({
          asset: p.symbol,
          exposure: ((p.value / totalValue) * 100).toFixed(1),
          contribution: ['USDC', 'USDT', 'devUSDC'].includes(p.symbol) ? 0 : ((p.value / totalValue) * 50).toFixed(1),
        })),
      };
    }

    case 'get-hedges': {
      // Generate hedge recommendations based on real positions
      const cryptoPositions = positions.filter(p => 
        !['USDC', 'USDT', 'devUSDC', 'DAI'].includes(p.symbol)
      );
      
      if (cryptoPositions.length === 0) {
        return [];
      }
      
      return cryptoPositions.map(p => ({
        type: 'protective-put',
        asset: p.symbol,
        market: `${p.symbol}-USD`,
        action: 'Buy put options',
        reason: `Protect $${p.value.toFixed(2)} ${p.symbol} position`,
        effectiveness: 0.85,
        cost: p.value * 0.02, // ~2% premium
      }));
    }

    default:
      return { message: 'Unknown action type' };
  }
}

/**
 * Get current portfolio data from on-chain sources ONLY.
 * Pass `walletAddress` to fetch a specific address's holdings; omit to
 * fall back to the server-configured wallet (agent context).
 *
 * Prior to the walletAddress overload, this function derived the address
 * exclusively from SERVER_WALLET_PRIVATE_KEY, so any caller that meant to
 * report on a *user's* portfolio (chat context in llm-provider.ts, the
 * old reporting endpoint) silently got the server wallet's balances
 * instead — same output for every caller.
 */
export async function getPortfolioData(
  walletAddress?: string,
): Promise<Record<string, unknown> | null> {
  try {
    // Import directly to avoid circular fetch issues
    const { getMarketDataService } = await import('./market-data/RealMarketDataService');
    const { ethers } = await import('ethers');

    let address = walletAddress;
    if (!address) {
      // Fall back to server wallet for agent-context callers (no user address).
      const pk = process.env.PRIVATE_KEY ||
                 process.env.AGENT_PRIVATE_KEY ||
                 process.env.SERVER_WALLET_PRIVATE_KEY;
      if (!pk) {
        logger.warn('No wallet address supplied and no server key configured for on-chain portfolio');
        return null;
      }
      address = new ethers.Wallet(pk).address;
    }

    // Fetch real on-chain data directly
    const marketData = getMarketDataService();
    const portfolioData = await marketData.getPortfolioData(address);

    // Transform to standard portfolio format
    const positions = portfolioData.tokens.map((token: { symbol: string; balance: string; usdValue: number }) => ({
      symbol: token.symbol,
      amount: parseFloat(token.balance),
      currentPrice: token.usdValue / parseFloat(token.balance),
      value: token.usdValue,
      averageCost: token.usdValue / parseFloat(token.balance),
      pnl: 0,
      pnlPercentage: 0,
      lastUpdated: portfolioData.lastUpdated,
    }));

    logger.info('Using REAL on-chain portfolio data', { 
      address: address.slice(0, 10),
      positions: positions.length,
      totalValue: portfolioData.totalValue
    });

    return {
      success: true,
      portfolio: {
        address,
        totalValue: portfolioData.totalValue,
        cash: 0,
        positions,
        totalPnl: 0,
        totalPnlPercentage: 0,
      },
      source: 'onchain',
      network: 'cronos-testnet',
      lastUpdated: portfolioData.lastUpdated,
    };
  } catch (error) {
    logger.error('Failed to get on-chain portfolio data', error);
    return null;
  }
}

/**
 * Parse natural language into portfolio actions
 */
export function parseActionIntent(text: string): PortfolioAction | null {
  const lower = text.toLowerCase();

  // Skip action parsing for general knowledge questions (let LLM handle these)
  // These patterns indicate the user wants information, not portfolio actions
  const knowledgePatterns = [
    /what (is|are|does|do)/,
    /how (does|do|to|can|should)/,
    /explain|tell me about|describe/,
    /why (is|are|does|do|should)/,
    /can you (explain|tell|describe)/,
    /\?$/,  // Questions ending with ?
  ];
  
  const isKnowledgeQuestion = knowledgePatterns.some(pattern => pattern.test(lower));
  
  // Don't trigger actions for knowledge questions about crypto concepts
  if (isKnowledgeQuestion && !lower.includes('my portfolio') && !lower.includes('my position')) {
    return null;
  }

  // BUY actions - require explicit intent
  const buyMatch = lower.match(/\b(buy|purchase|get|acquire)\b/);
  const symbolMatch = text.match(/\b([A-Z]{2,5})\b/); // Match uppercase symbols
  const amountMatch = text.match(/(\d+\.?\d*)\s*(?:dollars?|\$|usd)?/i);

  if (buyMatch && symbolMatch) {
    return {
      type: 'buy',
      params: {
        symbol: symbolMatch[1],
        amount: amountMatch ? parseFloat(amountMatch[1]) : 100,
        reason: 'User requested via chat',
      },
    };
  }

  // SELL actions
  const sellMatch = lower.match(/sell|liquidate|close|exit/);
  if (sellMatch && symbolMatch) {
    return {
      type: 'sell',
      params: {
        symbol: symbolMatch[1],
        amount: amountMatch ? parseFloat(amountMatch[1]) : 0,
        reason: 'User requested via chat',
      },
    };
  }

  // ANALYZE
  if (lower.match(/analyz|overview|summary|show.*portfolio/)) {
    return {
      type: 'analyze',
      params: {},
    };
  }

  // RISK ASSESSMENT
  if (lower.match(/risk|var|volatility|assess/)) {
    return {
      type: 'assess-risk',
      params: {},
    };
  }

  // HEDGE RECOMMENDATIONS
  if (lower.match(/hedge|protect|insurance|safe/)) {
    return {
      type: 'get-hedges',
      params: {
      },
      requiresSignature: false, // Just recommendations, no execution
    };
  }

  // EXECUTE HEDGE (Requires Manager Approval unless auto-approved)
  if (lower.match(/execute.*hedge|apply.*hedge|implement.*hedge/)) {
    // Check if hedge value is provided in the query for auto-approval logic
    const hedgeValueMatch = lower.match(/\$(\d+[,\d]*)|value[:\s]+(\d+)/i);
    const hedgeValue = hedgeValueMatch ? parseFloat((hedgeValueMatch[1] || hedgeValueMatch[2]).replace(/,/g, '')) : 0;
    
    return {
      type: 'execute-hedge',
      params: { hedgeValue },
      requiresSignature: true, // Will be checked against auto-approval in execution
      signatureMessage: `Approve hedge execution on portfolio`,
    };
  }

  // REBALANCE (Requires Manager Approval)
  if (lower.match(/rebalance|optimize|adjust.*allocation/)) {
    return {
      type: 'rebalance',
      params: {},
      requiresSignature: true, // CRITICAL: Manager must sign
      signatureMessage: `Approve portfolio rebalancing`,
    };
  }

  return null;
}

/**
 * Format action result for display
 */
export function formatActionResult(action: PortfolioAction, result: ActionResult): string {
  if (!result.success) {
    return `❌ **Action Failed**: ${result.message}\n${result.error || ''}`;
  }

  const data = result.data;
  switch (action.type) {
    case 'buy': {
      const buyResult = data?.result as Record<string, number> | undefined;
      const buyPortfolio = data?.portfolio as Record<string, number> | undefined;
      return `✅ **Purchase Completed**\n\n` +
        `• Bought ${action.params.amount} ${action.params.symbol}\n` +
        `• Price: $${buyResult?.price?.toFixed(4) || 'N/A'}\n` +
        `• Total Cost: $${buyResult?.total?.toFixed(2) || 'N/A'}\n` +
        `• New Portfolio Value: $${buyPortfolio?.totalValue?.toFixed(2) || 'N/A'}`;
    }

    case 'sell': {
      const sellResult = data?.result as Record<string, number> | undefined;
      return `✅ **Sale Completed**\n\n` +
        `• Sold ${action.params.amount} ${action.params.symbol}\n` +
        `• Price: $${sellResult?.price?.toFixed(4) || 'N/A'}\n` +
        `• Total Received: $${sellResult?.total?.toFixed(2) || 'N/A'}\n` +
        `• P/L: $${sellResult?.pnl?.toFixed(2) || 'N/A'}`;
    }

    case 'analyze': {
      const analysis = (data?.result ?? data ?? {}) as Record<string, unknown>;
      const portfolioInfo = (analysis.portfolioData ?? analysis) as Record<string, unknown>;
      const totalValue = (portfolioInfo.totalValue ?? analysis.totalValue ?? 0) as number;
      const positions = (portfolioInfo.positions ?? analysis.positions ?? []) as unknown[];
      const pnl = (portfolioInfo.totalPnl ?? analysis.totalPnl ?? 0) as number;
      const pnlPct = (portfolioInfo.totalPnlPercentage ?? analysis.totalPnlPercentage ?? 0) as number;
      
      // Build summary from available data
      const summaryText = (analysis.summary as string) || 
        `Portfolio Value: $${totalValue.toFixed(2)} | P/L: $${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) | ${positions.length} positions`;
      
      // Extract insights
      const topAssets = analysis.topAssets as Array<{ symbol: string; value?: number }> | undefined;
      const strengths = (analysis.strengths as string[]) || topAssets?.map(a => `${a.symbol}: $${a.value?.toFixed(2)}`) || [];
      const risks = (analysis.risks as string[]) || ((analysis.riskScore as number) > 60 ? ['High risk exposure detected'] : []);
      const recommendations = (analysis.recommendations as string[]) || [];
      
      return `📊 **Portfolio Analysis**\n\n` +
        `${summaryText}\n\n` +
        `**Health Score:** ${analysis.healthScore || 50}/100\n` +
        `**Risk Score:** ${analysis.riskScore || 50}/100\n\n` +
        `**Strengths:**\n${strengths.length > 0 ? strengths.map((s: string) => `• ${s}`).join('\n') : '• Portfolio is diversified'}\n\n` +
        `**Risks:**\n${risks.length > 0 ? risks.map((r: string) => `• ${r}`).join('\n') : '• Risk within acceptable levels'}\n\n` +
        `**Recommendations:**\n${recommendations.length > 0 ? recommendations.map((r: string) => `• ${r}`).join('\n') : '• Continue monitoring market conditions'}`;
    }

    case 'assess-risk': {
      const risk = (data?.result ?? data ?? {}) as Record<string, unknown>;
      const riskScore = (risk.riskScore ?? risk.risk_score ?? 50) as number;
      const volatility = (risk.volatility ?? risk.portfolioVolatility ?? 0.15) as number;
      const var95 = (risk.var95 ?? risk.valueAtRisk ?? 0.05) as number;
      const sharpe = (risk.sharpeRatio ?? risk.sharpe ?? null) as number | null;
      
      // Determine risk level
      let riskLevel = 'Moderate';
      if (riskScore < 30) riskLevel = 'Low';
      else if (riskScore > 70) riskLevel = 'High';
      else if (riskScore > 85) riskLevel = 'Critical';
      
      return `⚠️ **Risk Assessment**\n\n` +
        `• Overall Risk: **${riskLevel}**\n` +
        `• Risk Score: ${riskScore}/100\n` +
        `• Volatility: ${(volatility * 100).toFixed(1)}%\n` +
        `• VaR (95%): ${(var95 * 100).toFixed(1)}%\n` +
        `• Sharpe Ratio: ${sharpe !== null ? sharpe.toFixed(2) : 'N/A'}`;
    }

    case 'get-hedges': {
      const hedges = data?.result as Array<Record<string, unknown>> | undefined;
      if (!hedges || hedges.length === 0) {
        return `🛡️ **No hedge recommendations available**\n\nYour portfolio may not require hedging at this time.`;
      }
      
      return `🛡️ **Hedge Recommendations**\n\n` +
        hedges.map((h: Record<string, unknown>, i: number) =>
          `${i + 1}. **${h.type}** ${h.market}\n` +
          `   • Action: ${h.action}\n` +
          `   • Reason: ${h.reason}\n` +
          `   • Effectiveness: ${((h.effectiveness as number) * 100).toFixed(0)}%`
        ).join('\n\n');
    }

    default:
      return `✅ ${result.message}`;
  }
}
