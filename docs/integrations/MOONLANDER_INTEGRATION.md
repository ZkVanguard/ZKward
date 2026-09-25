# Moonlander Integration Guide

## Overview

ZKward integrates with [Moonlander.trade](https://moonlander.trade) to provide **automated perpetual futures hedging** on Cronos EVM. When the AI agents detect high-risk market conditions, they can automatically open SHORT or LONG positions to protect your portfolio.

## What is Moonlander?

Moonlander is a decentralized perpetual trading platform on Cronos EVM that offers:
- **Up to 1000x leverage** on perpetual futures
- **Low fees** and fast execution on Cronos
- **Wide range of markets**: BTC, ETH, CRO, and 100+ assets
- **Advanced features**: Stop-loss, take-profit, reduce-only orders

## How ZKward Uses Moonlander

### 1. AI-Driven Hedge Recommendations

When you click **"Open Hedge"** in the dashboard:

1. **Risk Agent** analyzes your portfolio and market predictions
2. **Hedging Agent** calculates optimal hedge size and leverage
3. **Settlement Agent** executes the hedge on Moonlander via x402

### 2. Automatic Position Management

```typescript
// Example: Hedge against BTC crash
{
  asset: 'BTC',
  side: 'SHORT',
  notionalValue: 850,  // $850 hedge
  leverage: 5,          // 5x leverage
  stopLoss: 45000,     // Close if BTC goes to $45k
  takeProfit: 40000    // Take profit at $40k
}
```

### 3. Risk-Based Position Sizing

The system automatically calculates hedge size based on:
- **Prediction probability**: Higher probability = larger hedge
- **Portfolio exposure**: Matches your actual risk
- **Leverage optimization**: Uses 2-10x leverage based on risk tolerance

## Setup Instructions

### For Demo/Testing (No Keys Required)

The integration works in **simulation mode** by default:

```bash
bun run dev
```

Navigate to Dashboard → Predictions → Click "Open Hedge"

You'll see simulated hedge execution with realistic market data.

### For Live Trading on Cronos Testnet

#### Step 1: Get Test Funds

```bash
# Get TCRO from faucet
https://cronos.org/faucet

# Fund your wallet with 10-20 TCRO for trading
```

#### Step 2: Configure Environment

Add to `.env.local`:

```bash
# Cronos Testnet RPC
NEXT_PUBLIC_CRONOS_TESTNET_RPC=https://evm-t3.cronos.org

# Your trading wallet (with TCRO)
MOONLANDER_PRIVATE_KEY=your_private_key_here

# Moonlander API (optional - works without)
NEXT_PUBLIC_MOONLANDER_API=https://api.moonlander.io
NEXT_PUBLIC_MOONLANDER_API_KEY=your_moonlander_api_key
NEXT_PUBLIC_MOONLANDER_API_SECRET=your_moonlander_secret
```

#### Step 3: Test the Integration

```bash
# Run the test script
node test-moonlander-hedge.mjs

# Expected output:
# ✅ HEDGE EXECUTION RESULT:
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#    Status: ✅ SUCCESS
#    Order ID: hedge-1234567890
#    Market: BTC-USD-PERP
#    Side: SHORT
#    Position Size: 0.0197
#    Entry Price: $43000
#    Leverage: 5x
#    Liquidation Price: $47300
#    Mode: 🔴 LIVE TRADING
```

## API Endpoints

### Execute Hedge Position

**POST** `/api/agents/hedging/execute`

```typescript
// Request
{
  portfolioId: 1,
  asset: "BTC",           // BTC, ETH, CRO, etc.
  side: "SHORT",          // LONG or SHORT
  notionalValue: 850,     // USD value to hedge
  leverage: 5,            // 1-100x
  stopLoss: 45000,        // Optional: Stop loss price
  takeProfit: 40000,      // Optional: Take profit price
  reason: "Market crash hedge (85% probability)"
}

// Response
{
  success: true,
  orderId: "hedge-123",
  market: "BTC-USD-PERP",
  side: "SHORT",
  size: "0.0197",
  entryPrice: "43000",
  leverage: 5,
  estimatedLiquidationPrice: "47300",
  simulationMode: false
}
```

### Get Hedge Recommendations

**POST** `/api/agents/hedging/recommend`

```typescript
// Request
{
  address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
  positions: [...]
}

// Response
{
  recommendations: [
    {
      action: "SHORT",
      asset: "BTC-PERP",
      size: 0.007,
      leverage: 10,
      reason: "Protect $600 leveraged position from >10% drawdown",
      capitalRequired: 15,
      expectedGasSavings: 2.50
    }
  ]
}
```

## Frontend Integration

### Dashboard Button Click

When clicking "Open Hedge" in `PredictionInsights.tsx`:

```typescript
const handleOpenHedge = async (market: PredictionMarket) => {
  const response = await fetch('/api/agents/hedging/execute', {
    method: 'POST',
    body: JSON.stringify({
      asset: market.relatedAssets[0], // e.g., "BTC"
      side: 'SHORT',
      notionalValue: 1000 * (market.probability / 100),
      leverage: 5,
      reason: market.question
    })
  });
  
  const result = await response.json();
  // Show success/error notification
};
```

## Risk Management

### Liquidation Protection

The system automatically calculates liquidation prices:

```typescript
// For SHORT position
liquidationPrice = entryPrice × (1 + 0.8 / leverage)

// For LONG position  
liquidationPrice = entryPrice × (1 - 0.8 / leverage)
```

Example with 5x leverage on BTC SHORT at $43,000:
```
liquidationPrice = $43,000 × (1 + 0.8/5) = $43,000 × 1.16 = $49,880
```

### Automatic Stop-Loss

When opening a hedge, you can set:
- **Stop-Loss**: Automatically close if market moves against you
- **Take-Profit**: Lock in profits at target price

```typescript
{
  stopLoss: 45000,    // Close SHORT if BTC hits $45k (limits loss)
  takeProfit: 40000   // Close SHORT if BTC drops to $40k (locks profit)
}
```

## Testing Scenarios

### 1. High Risk Crash Scenario

```bash
curl -X POST http://localhost:3000/api/agents/hedging/execute \
  -H "Content-Type: application/json" \
  -d '{
    "asset": "BTC",
    "side": "SHORT",
    "notionalValue": 2000,
    "leverage": 10,
    "reason": "90% crash probability detected"
  }'
```

### 2. Balanced Portfolio Hedge

```bash
curl -X POST http://localhost:3000/api/agents/hedging/execute \
  -H "Content-Type: application/json" \
  -d '{
    "asset": "ETH",
    "side": "SHORT",
    "notionalValue": 500,
    "leverage": 5,
    "reason": "Medium risk market conditions"
  }'
```

### 3. Conservative Protection

```bash
curl -X POST http://localhost:3000/api/agents/hedging/execute \
  -H "Content-Type: application/json" \
  -d '{
    "asset": "CRO",
    "side": "SHORT",
    "notionalValue": 100,
    "leverage": 2,
    "reason": "Low risk precautionary hedge"
  }'
```

## Hackathon Demo Flow

### For Live Demo Without Real Funds

1. **Start the dev server**: `bun run dev`
2. **Open Dashboard**: Navigate to Predictions
3. **Click "Open Hedge"** on high-risk prediction
4. **Show simulation output**:
   ```
   ✅ Hedge Opened on Moonlander
   
   Market: BTC-USD-PERP
   Side: SHORT
   Size: 0.0197
   Entry: $43000
   Leverage: 5x
   
   ⚠️ SIMULATION MODE (add keys for live)
   ```

### For Live Demo With Testnet

1. **Fund wallet**: Get 10 TCRO from faucet
2. **Set `MOONLANDER_PRIVATE_KEY`** in `.env.local`
3. **Restart server**: `bun run dev`
4. **Execute live hedge**: Same button, but now trades on testnet
5. **Verify on Moonlander**: Check https://moonlander.trade portfolio

## Architecture

```
┌─────────────────┐
│  Dashboard UI   │  User clicks "Open Hedge"
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│  /api/agents/hedging/execute    │  Calculate hedge parameters
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  MoonlanderClient.openHedge()   │  Execute on perpetuals DEX
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Moonlander Smart Contracts     │  On-chain execution
│  (Cronos EVM Testnet)           │
└─────────────────────────────────┘
```

## Key Files

| File | Purpose |
|------|---------|
| [`integrations/moonlander/MoonlanderClient.ts`](../integrations/moonlander/MoonlanderClient.ts) | Core Moonlander SDK |
| [`app/api/agents/hedging/execute/route.ts`](../app/api/agents/hedging/execute/route.ts) | API endpoint for hedge execution |
| [`app/dashboard/page.tsx`](../app/dashboard/page.tsx) | Frontend integration (handleOpenHedge) |
| [`agents/specialized/HedgingAgent.ts`](../agents/specialized/HedgingAgent.ts) | AI agent logic |
| [`test-moonlander-hedge.mjs`](../test-moonlander-hedge.mjs) | Test script |

## Troubleshooting

### "Insufficient Balance"

- **Testnet**: Get TCRO from https://cronos.org/faucet
- **Mainnet**: Ensure wallet has CRO for gas + margin

### "API Key Invalid"

- API keys are **optional** for testnet
- System works in simulation mode without keys
- Get keys from https://moonlander.trade/settings

### "Position Liquidated"

- Reduce leverage (use 2-5x instead of 10x+)
- Set stop-loss closer to entry price
- Increase margin size

## Next Steps

- [ ] Add support for LONG hedges (bullish protection)
- [ ] Implement dynamic leverage based on volatility
- [ ] Add portfolio-wide hedge rebalancing
- [ ] Integrate funding rate arbitrage
- [ ] Support multi-leg hedge strategies

## Resources

- **Moonlander Docs**: https://docs.moonlander.trade
- **Cronos Faucet**: https://cronos.org/faucet
- **VVS Finance**: https://vvs.finance (for swaps before hedging)
- **Test Report**: [`MOONLANDER_TEST_REPORT.md`](MOONLANDER_TEST_REPORT.md)
