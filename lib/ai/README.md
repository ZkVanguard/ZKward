# Crypto.com AI Integration

## Overview

ZKward now integrates **Crypto.com AI Agent Client** for intelligent portfolio analysis, risk assessment, and natural language intent parsing. This enhances the multi-agent system with advanced AI capabilities.

## Features

### 🤖 AI-Powered Components

1. **Portfolio Analysis**
   - Automatic asset valuation
   - Health score calculation
   - Top asset identification
   - AI-generated recommendations

2. **Risk Assessment**
   - Value at Risk (VaR) calculation
   - Volatility analysis
   - Sharpe ratio computation
   - Risk factor identification
   - Overall risk scoring (0-100)

3. **Intent Parsing**
   - Natural language understanding
   - Command routing to specialized agents
   - Entity extraction
   - Confidence scoring

4. **Hedge Generation**
   - Strategy recommendations
   - Action planning
   - Risk reduction estimates
   - Confidence scoring

## Setup

### 1. Install Dependencies

```bash
npm install @crypto.com/ai-agent-client openai
```

### 2. Configure API Key

Add to your `.env.local`:

```env
# Crypto.com AI SDK
CRYPTOCOM_AI_API_KEY=your_api_key_here
```

Get your API key from: https://crypto.com/developers

### 3. AI Service is Ready!

The AI service automatically:
- Initializes with your API key
- Falls back to rule-based logic if unavailable
- Provides seamless degradation

## Usage

### In Components

```typescript
import { getCryptocomAIService } from '@/lib/ai/cryptocom-service';

// Get AI service instance
const aiService = getCryptocomAIService();

// Check availability
if (aiService.isAvailable()) {
  console.log('AI service is ready!');
}

// Analyze portfolio
const analysis = await aiService.analyzePortfolio(address, portfolioData);

// Assess risk
const risk = await aiService.assessRisk(portfolioData);

// Parse intent
const intent = await aiService.parseIntent('Analyze my portfolio risk');

// Generate hedges
const hedges = await aiService.generateHedgeRecommendations(portfolio, riskProfile);
```

### API Routes

#### Risk Assessment
```bash
POST /api/agents/risk/assess
{
  "address": "0x...",
  "portfolioData": { ... }
}
```

#### Hedge Recommendations
```bash
POST /api/agents/hedging/recommend
{
  "address": "0x...",
  "portfolioData": { ... },
  "riskProfile": { ... }
}
```

## AI-Enhanced Features

### Dashboard Components

1. **PortfolioOverview** (`components/dashboard/PortfolioOverview.tsx`)
   - Shows AI-powered total value
   - Displays health score
   - Lists top assets with percentages
   - Shows AI badge when active

2. **RiskMetrics** (`components/dashboard/RiskMetrics.tsx`)
   - VaR (95%) calculation
   - Volatility percentage
   - Risk score (0-100)
   - Sharpe ratio
   - AI analysis badge

3. **ChatInterface** (`components/dashboard/ChatInterface.tsx`)
   - Natural language understanding
   - Intent-based routing
   - AI-powered responses
   - Crypto.com AI badge on messages

### Agent API Routes

1. **Risk Agent** (`app/api/agents/risk/assess/route.ts`)
   - AI-driven risk assessment
   - Factor analysis
   - Recommendations

2. **Hedging Agent** (`app/api/agents/hedging/recommend/route.ts`)
   - AI-generated strategies
   - Action planning
   - Expected reduction estimates

## Fallback Logic

If the AI service is unavailable (no API key or service down), the system automatically falls back to:

- **Rule-based intent parsing**: Keyword matching for common intents
- **Statistical risk assessment**: Mathematical formulas for VaR, volatility, Sharpe ratio
- **Mock portfolio analysis**: Demo data with realistic values
- **Template hedge recommendations**: Pre-configured strategies

This ensures the system remains functional even without AI connectivity.

## AI Service Architecture

```
lib/ai/cryptocom-service.ts
├── CryptocomAIService (Singleton)
│   ├── AIAgentClient (Crypto.com SDK)
│   ├── parseIntent()
│   ├── analyzePortfolio()
│   ├── assessRisk()
│   ├── generateHedgeRecommendations()
│   └── Fallback methods (rule-based)
└── getCryptocomAIService() (Factory)
```

## Intent Types

The AI service recognizes these intents:

- `analyze_portfolio` - Portfolio overview and analysis
- `assess_risk` - Risk metrics and assessment
- `generate_hedge` - Hedging strategies
- `execute_settlement` - Settlement operations
- `generate_report` - Reporting and summaries
- `unknown` - Unrecognized intent

## Response Format

### Portfolio Analysis
```typescript
{
  totalValue: number,
  positions: number,
  riskScore: number,
  healthScore: number,
  recommendations: string[],
  topAssets: [
    { symbol: string, value: number, percentage: number }
  ]
}
```

### Risk Assessment
```typescript
{
  overallRisk: 'low' | 'medium' | 'high',
  riskScore: number,
  volatility: number,
  var95: number,
  sharpeRatio: number,
  factors: [
    { factor: string, impact: string, description: string }
  ]
}
```

### Hedge Recommendation
```typescript
{
  strategy: string,
  confidence: number,
  expectedReduction: number,
  description: string,
  actions: [
    { action: string, asset: string, amount: number }
  ]
}
```

## Best Practices

1. **Always check availability**: Use `isAvailable()` before relying on AI features
2. **Handle errors gracefully**: Fallback logic is automatic but log errors
3. **Cache results**: AI calls can be expensive, cache when appropriate
4. **Provide context**: More context = better AI results
5. **Monitor usage**: Track AI API usage for cost optimization

## Troubleshooting

### AI Service Not Initializing
- Check if `CRYPTOCOM_AI_API_KEY` is set
- Verify API key is valid
- Check console for initialization errors

### Fallback Always Used
- API key not configured
- Network connectivity issues
- API service downtime
- Check logs for specific error

### Poor Intent Recognition
- Provide more specific queries
- Add domain context
- Consider training custom models

## Next Steps

- [ ] Add custom AI model training
- [ ] Implement caching layer
- [ ] Add A/B testing for AI vs. rule-based
- [ ] Create AI analytics dashboard
- [ ] Optimize API call patterns

## Support

For Crypto.com AI SDK support:
- Documentation: https://crypto.com/developers/docs
- Support: support@crypto.com
- Community: https://discord.gg/cryptocom
