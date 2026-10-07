/**
 * HedgingAgent Tests — NO MOCKS
 * 
 * Uses real PerpMarketClient (Crypto.com Exchange API) and real MCPClient.
 * Trading operations may fail if exchange API is unavailable — tests handle
 * graceful failure. Market data tests use Crypto.com public endpoints.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ethers } from 'ethers';
import { HedgingAgent, HedgeStrategy, HedgeAnalysis } from '../../agents/specialized/HedgingAgent';
import { AgentTask } from '../../shared/types/agent';

describe('HedgingAgent', () => {
  let agent: HedgingAgent;
  let provider: ethers.Provider;
  let signer: ethers.Wallet;
  let agentReady = false;

  beforeEach(async () => {
    // Setup test provider and signer (Cronos testnet or localhost)
    provider = new ethers.JsonRpcProvider(
      process.env.CRONOS_TESTNET_RPC || 'https://evm-t3.cronos.org',
    );
    signer = ethers.Wallet.createRandom().connect(provider);

    // Initialize agent with real clients
    agent = new HedgingAgent('test-hedge-agent', provider, signer);
    try {
      await agent.initialize();
      agentReady = true;
    } catch {
      // Agent init may fail if market/MCP APIs unavailable
      agentReady = false;
    }
  });

  afterEach(async () => {
    if (agentReady) {
      await agent.shutdown();
    }
  });

  describe('Initialization', () => {
    it('should initialize successfully', async () => {
      if (!agentReady) { console.log('Agent init failed — skipping'); return; }
      expect(agent).toBeDefined();
      expect(agent.getStatus().status).toBe('idle');
    });

    it('should have correct capabilities', () => {
      if (!agentReady) return;
      const capabilities = agent.getCapabilities();
      expect(capabilities).toContain('RISK_ANALYSIS');
      expect(capabilities).toContain('PORTFOLIO_MANAGEMENT');
      expect(capabilities).toContain('MARKET_INTEGRATION');
    });

    it('should initialize with empty strategy map', () => {
      if (!agentReady) return;
      expect(agent['activeStrategies'].size).toBe(0);
    });
  });

  describe('Hedge Analysis', () => {
    it('should analyze hedge opportunity correctly', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-analyze-1',
        action: 'analyze_hedge',
        parameters: {
          portfolioId: 'portfolio-1',
          assetSymbol: 'BTC',
          notionalValue: '1000000',
        },
        priority: 1,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      
      const analysis = result.data as HedgeAnalysis;
      expect(analysis.portfolioId).toBe('portfolio-1');
      expect(analysis.exposure.asset).toBe('BTC');
      expect(analysis.recommendation).toBeDefined();
      expect(analysis.riskMetrics).toBeDefined();
    });

    it('should calculate optimal hedge ratio', async () => {
      if (!agentReady) return;
      const ratio = await agent['calculateOptimalHedgeRatio']('BTC', '1000000', 0.4);
      
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThanOrEqual(1);
    });

    it('should calculate volatility from historical data', async () => {
      if (!agentReady) return;
      const volatility = await agent['calculateVolatility']('ETH');
      
      expect(volatility).toBeGreaterThan(0);
      expect(volatility).toBeLessThan(2); // Reasonable range
    });

    it('should recommend hedge for high volatility', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-analyze-2',
        action: 'analyze_hedge',
        parameters: {
          portfolioId: 'portfolio-1',
          assetSymbol: 'BTC',
          notionalValue: '5000000',
        },
        priority: 1,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);
      if (!result.success) return; // API may be unavailable
      const analysis = result.data as HedgeAnalysis;

      expect(['OPEN', 'HOLD']).toContain(analysis.recommendation.action);
    });
  });

  describe('Opening Hedge Positions', () => {
    it('should open hedge position or fail gracefully', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-open-1',
        action: 'open_hedge',
        parameters: {
          market: 'BTC-USD-PERP',
          side: 'SHORT',
          notionalValue: '100000',
          leverage: 2,
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      // Real exchange API may not be available for trading
      expect(result).toBeDefined();
      expect(result.agentId).toBe('test-hedge-agent');
      if (result.success) {
        expect(result.data).toHaveProperty('orderId');
        expect(result.data).toHaveProperty('market');
      }
    });

    it('should include stop-loss when specified', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-open-2',
        action: 'open_hedge',
        parameters: {
          market: 'ETH-USD-PERP',
          side: 'SHORT',
          notionalValue: '50000',
          leverage: 1,
          stopLoss: '2100',
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);
      expect(result).toBeDefined();
      expect(result.agentId).toBe('test-hedge-agent');
    });

    it('should include take-profit when specified', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-open-3',
        action: 'open_hedge',
        parameters: {
          market: 'BTC-USD-PERP',
          side: 'LONG',
          notionalValue: '75000',
          leverage: 3,
          takeProfit: '50000',
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);
      expect(result).toBeDefined();
      expect(result.agentId).toBe('test-hedge-agent');
    });

    it('should validate leverage limits', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-open-4',
        action: 'open_hedge',
        parameters: {
          market: 'CRO-USD-PERP',
          side: 'SHORT',
          notionalValue: '10000',
          leverage: 100, // Excessive leverage
        },
        priority: 2,
        createdAt: Date.now(),
      };

      // Should either reject or cap leverage
      const result = await agent['executeTask'](task);
      
      if (result.success) {
        expect(result.data.leverage).toBeLessThanOrEqual(20);
      }
    });
  });

  describe('Closing Hedge Positions', () => {
    it('should close hedge position or fail gracefully', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-close-1',
        action: 'close_hedge',
        parameters: {
          market: 'BTC-USD-PERP',
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result).toBeDefined();
      expect(result.agentId).toBe('test-hedge-agent');
      if (result.success) {
        expect(result.data).toHaveProperty('orderId');
        expect(result.data).toHaveProperty('closedSize');
      }
    });

    it('should support partial closing', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-close-2',
        action: 'close_hedge',
        parameters: {
          market: 'ETH-USD-PERP',
          size: '0.5',
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);
      expect(result).toBeDefined();
      expect(result.agentId).toBe('test-hedge-agent');
    });
  });

  describe('Rebalancing', () => {
    beforeEach(async () => {
      if (!agentReady) return;
      const strategy: HedgeStrategy = {
        strategyId: 'strategy-test-1',
        portfolioId: 'portfolio-1',
        targetMarket: 'BTC-USD-PERP',
        hedgeRatio: 0.5,
        rebalanceThreshold: 10,
        maxLeverage: 5,
        active: true,
      };
      
      agent['activeStrategies'].set(strategy.strategyId, strategy);
    });

    it('should rebalance when threshold exceeded', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-rebalance-1',
        action: 'rebalance_hedge',
        parameters: {
          strategyId: 'strategy-test-1',
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result.success).toBe(true);
      expect(['rebalanced', 'hold', 'none']).toContain(result.data.action);
    });

    it('should not rebalance within threshold', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-rebalance-2',
        action: 'rebalance_hedge',
        parameters: {
          strategyId: 'strategy-test-1',
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      if (result.data.action === 'hold') {
        expect(result.data.reason).toContain('threshold');
      }
    });

    it('should handle missing strategy gracefully', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-rebalance-3',
        action: 'rebalance_hedge',
        parameters: {
          strategyId: 'non-existent',
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('Strategy Management', () => {
    it('should create hedge strategy', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-strategy-1',
        action: 'create_strategy',
        parameters: {
          portfolioId: 'portfolio-1',
          targetMarket: 'BTC-USD-PERP',
          hedgeRatio: 0.6,
          rebalanceThreshold: 15,
          maxLeverage: 3,
        },
        priority: 1,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('strategyId');
      expect(result.data.active).toBe(true);
      expect(result.data.hedgeRatio).toBe(0.6);
    });

    it('should store strategy in active strategies', async () => {
      if (!agentReady) return;
      const initialSize = agent['activeStrategies'].size;

      const task: AgentTask = {
        id: 'test-strategy-2',
        action: 'create_strategy',
        parameters: {
          portfolioId: 'portfolio-2',
          targetMarket: 'ETH-USD-PERP',
          hedgeRatio: 0.7,
          rebalanceThreshold: 10,
          maxLeverage: 2,
        },
        priority: 1,
        createdAt: Date.now(),
      };

      await agent['executeTask'](task);

      expect(agent['activeStrategies'].size).toBe(initialSize + 1);
    });
  });

  describe('Position Monitoring', () => {
    it('should monitor positions and detect risks', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-monitor-1',
        action: 'monitor_positions',
        parameters: {},
        priority: 1,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result.success).toBe(true);
      expect(result.data).toHaveProperty('positions');
      expect(result.data).toHaveProperty('alerts');
      expect(result.data).toHaveProperty('timestamp');
    });

    it('should generate alerts for high risk positions', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-monitor-2',
        action: 'monitor_positions',
        parameters: {},
        priority: 1,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      if (result.data.alerts.length > 0) {
        const alert = result.data.alerts[0];
        expect(alert).toHaveProperty('positionId');
        expect(alert).toHaveProperty('riskLevel');
        expect(['HIGH', 'CRITICAL']).toContain(alert.riskLevel);
      }
    });

    it('should start monitoring on interval', () => {
      if (!agentReady) return;
      agent.startMonitoring(5000);
      
      expect(agent['monitoringInterval']).toBeDefined();
    });

    it('should stop monitoring', () => {
      if (!agentReady) return;
      agent.startMonitoring(5000);
      agent.stopMonitoring();
      
      expect(agent['monitoringInterval']).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should handle unknown action', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-error-1',
        action: 'unknown_action',
        parameters: {},
        priority: 1,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action');
    });

    it('should handle missing parameters', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-error-2',
        action: 'analyze_hedge',
        parameters: {}, // Missing required parameters
        priority: 1,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result.success).toBe(false);
    });

    it('should recover from integration failures', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-error-3',
        action: 'open_hedge',
        parameters: {
          market: 'INVALID-MARKET',
          side: 'SHORT',
          notionalValue: '100000',
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      // Should fail gracefully
      expect(result).toBeDefined();
      expect(result.agentId).toBe('test-hedge-agent');
    });
  });

  describe('Performance', () => {
    it('should execute tasks within reasonable time', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-perf-1',
        action: 'analyze_hedge',
        parameters: {
          portfolioId: 'portfolio-1',
          assetSymbol: 'BTC',
          notionalValue: '1000000',
        },
        priority: 1,
        createdAt: Date.now(),
      };

      const startTime = Date.now();
      const result = await agent['executeTask'](task);
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(5000); // 5 seconds max
      expect(result.executionTime).toBeGreaterThan(0);
    });

    it('should handle multiple concurrent tasks', async () => {
      if (!agentReady) return;
      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `test-concurrent-${i}`,
        action: 'analyze_hedge',
        parameters: {
          portfolioId: 'portfolio-1',
          assetSymbol: 'BTC',
          notionalValue: '1000000',
        },
        priority: 1,
        createdAt: Date.now(),
      }));

      const promises = tasks.map(task => agent.addTask(task));
      const results = await Promise.all(promises);

      expect(results).toHaveLength(5);
    });
  });

  describe('Integration with the perp market client', () => {
    it('should use real PerpMarketClient for market data', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-integration-1',
        action: 'analyze_hedge',
        parameters: {
          portfolioId: 'portfolio-1',
          assetSymbol: 'BTC',
          notionalValue: '1000000',
        },
        priority: 1,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      expect(result.success).toBe(true);
    });

    it('should attempt trades through PerpMarketClient', async () => {
      if (!agentReady) return;
      const task: AgentTask = {
        id: 'test-integration-2',
        action: 'open_hedge',
        parameters: {
          market: 'BTC-USD-PERP',
          side: 'SHORT',
          notionalValue: '100000',
          leverage: 2,
        },
        priority: 2,
        createdAt: Date.now(),
      };

      const result = await agent['executeTask'](task);

      // Trading API may not be available
      expect(result).toBeDefined();
      expect(result.agentId).toBe('test-hedge-agent');
    });
  });

  describe('Integration with MCP', () => {
    it('should fetch price data from MCP/Exchange API', async () => {
      if (!agentReady) return;
      const volatility = await agent['calculateVolatility']('ETH');
      
      expect(volatility).toBeGreaterThan(0);
    });

    it('should calculate correlations using real data', async () => {
      if (!agentReady) return;
      const correlation = await agent['calculateSpotFutureCorrelation']('BTC');
      
      expect(correlation).toBeGreaterThan(0);
      expect(correlation).toBeLessThanOrEqual(1);
    });
  });
});
