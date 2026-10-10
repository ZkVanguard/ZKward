/**
 * Rule-based fallback responses for when no LLM provider is available.
 *
 * Extracted from LLMProvider.generateFallbackResponse (161 LOC keyword
 * switch → canned responses). Kept as a pure function so:
 *   - The switch/case body doesn't sit inside a class it doesn't need
 *   - Copy edits to the canned strings don't require touching the client
 *   - Unit-testable without instantiating the whole LLMProvider chain
 *
 * Only intent branches ("hedge", "risk", "market", …) live here; the
 * router lives in llm-provider.ts.
 */
import type { LLMResponse } from './llm-types';

export async function generateFallbackResponse(
  userMessage: string,
  context?: Record<string, unknown>,
  portfolioContext?: string,
): Promise<LLMResponse> {
  const lower = userMessage.toLowerCase();
  const pf = portfolioContext || '';

  // Buy / add position
  if (lower.match(/buy|purchase|get|add.*position/)) {
    return {
      content: `I can help you buy assets! 💰\n\nTo execute a trade, use this format:\n**"Buy [amount] [SYMBOL]"**\n\nFor example:\n• "Buy 100 CRO"\n• "Buy 50 USDC"\n• "Purchase 0.001 BTC"\n\n${pf}\n\n💡 **Tip**: I'll automatically execute the trade and update your portfolio using real market prices!`,
      model: 'rule-based-fallback',
      confidence: 0.9,
    };
  }

  // Sell / liquidate
  if (lower.match(/sell|liquidate|close.*position/)) {
    return {
      content: `I can help you sell assets! 📉\n\nTo execute a sale, use this format:\n**"Sell [amount] [SYMBOL]"**\n\nFor example:\n• "Sell 50 CRO"\n• "Liquidate all USDC"\n• "Sell 0.001 BTC"\n\n${pf}\n\n💡 **Tip**: I'll execute the sale at current market price and show you the P/L!`,
      model: 'rule-based-fallback',
      confidence: 0.9,
    };
  }

  // Rebalance
  if (lower.match(/rebalance|optimize|adjust allocation/)) {
    return {
      content: `Let's optimize your portfolio! ⚖️\n\n**Rebalancing Options:**\n• Target allocations (e.g., "60% CRO, 40% USDC")\n• Risk-based rebalancing\n• Automated portfolio optimization\n\n${pf}\n\n**Current Portfolio Analysis:**\nI can analyze your positions and suggest optimal rebalancing based on:\n✓ Risk tolerance\n✓ Market conditions\n✓ Diversification goals\n✓ Gas-efficient execution\n\nWould you like me to analyze your portfolio and suggest a rebalancing strategy?`,
      model: 'rule-based-fallback',
      confidence: 0.85,
    };
  }

  // Portfolio analysis
  if (lower.includes('portfolio') && (lower.includes('analyz') || lower.includes('overview') || lower.includes('show'))) {
    return {
      content: `I can analyze your portfolio comprehensively! 📊\n\n${pf}\n\n**Analysis Includes:**\n• Asset distribution and allocation\n• Risk scores (VaR, volatility, Sharpe ratio)\n• Performance metrics and P/L\n• Concentration risks\n• Diversification assessment\n• AI-powered recommendations\n\n**To get a full analysis, just say:**\n"Analyze my portfolio" or "Show portfolio analysis"\n\nI'll use real market data and AI agents to provide detailed insights with ZK-verified results!`,
      model: 'rule-based-fallback',
      confidence: 0.8,
    };
  }

  // Market analysis
  if (lower.match(/market|ecosystem|price|sentiment|conditions/)) {
    return {
      content: `I'll analyze the current market conditions for you! 📊\n\n**Market Intelligence:**\n• **Current Trends**: Institutional adoption increasing, TVL growing\n• **Risk Factors**: Market volatility, regulatory changes, macro conditions\n\n**Portfolio Recommendations:**\n✓ Consider your risk tolerance and time horizon\n✓ Diversify across multiple assets (BTC, ETH, SUI, stablecoins)\n✓ Use hedging strategies for downside protection\n✓ Monitor correlation with broader crypto markets\n\n**Data-Driven Insights:**\nI use real-time market data, on-chain analytics, and AI models to provide actionable recommendations. Would you like me to analyze your specific portfolio in the context of current market conditions?`,
      model: 'rule-based-fallback',
      confidence: 0.85,
    };
  }

  // Risk assessment
  if (lower.includes('risk') || lower.includes('var') || lower.includes('volatility')) {
    return {
      content: `Risk assessment is one of my core capabilities! 📈\n\n**I can evaluate:**\n• **Value at Risk (VaR)**: Maximum potential loss at 95% confidence\n• **Volatility**: Price fluctuation measurement\n• **Sharpe Ratio**: Risk-adjusted returns\n• **Correlation**: How assets move together\n• **Liquidation Risk**: Margin call probabilities\n\n**Methodology:**\nI use Monte Carlo simulations, historical data analysis, and correlation matrices to assess portfolio risk. Results are ZK-verified for accuracy.\n\nThe AI agents will analyze your positions using real market data and provide actionable insights. Want me to assess your current risk level?`,
      model: 'rule-based-fallback',
      confidence: 0.85,
    };
  }

  // Hedging
  if (lower.includes('hedge') || lower.includes('protect') || lower.includes('insurance')) {
    return {
      content: `**Hedging**\n\nHedge recommendations come from the risk and hedging agents, which need the AI provider, and it is not available right now. Open positions and their profit and loss are on the Hedges page. Please try again shortly.`,
      model: 'rule-based-fallback',
      confidence: 0.9,
    };
  }

  // ZK proofs
  if (lower.includes('zk') || lower.includes('zero knowledge') || lower.includes('proof') || lower.includes('privacy')) {
    return {
      content: `**Zero-knowledge proofs on ZKward**\n\nA zero-knowledge proof shows that a statement is true without revealing the data behind it.\n\n**What exists today:** a transparent ZK-STARK (hash-based, no trusted setup) that proves a set of private numbers is inside public limits, for example that a hedge's leverage and notional are within the vault's caps.\n\n**What does not:** the proof system has not been reviewed outside the project, and no live hedge carries a proof yet. The whitepaper's "Proofs" section has the current status.`,
      model: 'rule-based-fallback',
      confidence: 0.9,
    };
  }

  // Agent / platform overview
  if (lower.includes('agent') || lower.includes('how') || lower.includes('what can you')) {
    return {
      content: `I'm your AI-powered assistant orchestrating 5 specialized agents! 🤖\n\n**What I Can Do:**\n\n🎯 **Lead Agent (me!)**: Coordinate all other agents and provide conversational assistance\n\n📊 **Risk Agent**: Analyze portfolios, calculate VaR, assess volatility\n\n🛡️ **Hedging Agent**: Generate protection strategies on BlueFin perpetuals\n\n📈 **Reporting Agent**: Generate compliance reports with ZK proofs\n\n**Smart Features:**\n• Natural language understanding\n• Real-time market data integration\n• Multi-step workflow automation\n• Privacy-preserving computation\n• Institutional-grade security\n\nTry asking me something like:\n• "Analyze my portfolio"\n• "What's my risk level?"\n• "Hedge $5M against market crash"\n• "Execute a gasless settlement"`,
      model: 'rule-based-fallback',
      confidence: 0.75,
    };
  }

  // Default
  return {
    content: `I'm here to help with your DeFi portfolio management! 💼\n\nI can assist you with:\n• Portfolio analysis and risk assessment\n• Hedge strategy generation\n• Gasless transaction execution\n• Compliance reporting\n• Understanding Web3 concepts\n\nCould you rephrase your question or try one of these:\n• "Show me my portfolio risk"\n• "Generate a hedge strategy"\n• "What are ZK proofs?"\n\nOr click a quick action button above to get started!`,
    model: 'rule-based-fallback',
    confidence: 0.5,
  };
}
