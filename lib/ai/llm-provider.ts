
/**
 * Advanced LLM Provider for ZKward
 * Integrates Crypto.com AI SDK with streaming, context management, and RAG capabilities
 */

import { logger } from '../utils/logger';
import { 
  executePortfolioAction, 
  getPortfolioData, 
  parseActionIntent,
  formatActionResult
} from '../services/portfolio-actions';
// Re-export public types for consumers
export type { ChatMessage, LLMResponse, StreamChunk } from './llm-types';
import type { ChatMessage, LLMResponse, StreamChunk, ChatClient, AnthropicClient } from './llm-types';
import { SYSTEM_CONTEXT } from './llm-system-prompt';
import { hashPrompt, shouldCacheQuery, getCachedLLMResponse, setCachedLLMResponse } from './llm-cache';
import { generateFallbackResponse as generateFallbackResponseImpl } from './fallback-responses';

class LLMProvider {
  private aiClient: ChatClient | null = null;
  private openAIClient: ChatClient | null = null;
  private anthropicClient: AnthropicClient | null = null;
  private asiApiKey: string | null = null;
  private asiApiUrl: string = 'https://api.asi1.ai/v1';
  private asiAvailable: boolean = false;
  private ollamaAvailable: boolean = false;
  private ollamaBaseUrl: string = 'http://localhost:11434';
  private activeProvider: string = 'none';
  private conversationHistory: Map<string, ChatMessage[]> = new Map();
  private maxHistoryLength = 20;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.initPromise = this.initializeClient();
  }

  private async initializeClient() {
    try {
      // Configuration — API keys are server-only (never NEXT_PUBLIC_)
      const cryptocomKey = process.env.CRYPTOCOM_DEVELOPER_API_KEY || 
                           process.env.CRYPTOCOM_AI_API_KEY;
      
      const openaiKey = process.env.OPENAI_API_KEY;
      
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      
      // ASI API key for production AI (Fetch.ai's ASI:One platform)
      const asiApiKey = (process.env.ASI_API_KEY ||
                        process.env.ASI_ONE_API_KEY || '').trim() || null;
      
      this.ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
      this.asiApiKey = asiApiKey;

      // PRIORITY 1: Crypto.com AI Agent SDK + Ollama (HACKATHON + LOCAL AI)
      // The Crypto.com SDK uses OpenAI-compatible API, and Ollama provides one at /v1
      // This gives us: Crypto.com ecosystem tools + Ollama/Qwen AI (FREE, LOCAL, CUDA)
      const ollamaOpenAIUrl = `${this.ollamaBaseUrl}/v1`;
      const ollamaModel = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
      
      // First check if Ollama is running
      let ollamaRunning = false;
      try {
        const ollamaCheck = await fetch(`${this.ollamaBaseUrl}/api/tags`, {
          method: 'GET',
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);
        
        if (ollamaCheck && ollamaCheck.ok) {
          const models = await ollamaCheck.json();
          if (models.models && models.models.length > 0) {
            ollamaRunning = true;
            logger.info('✅ Ollama detected with models:', models.models.map((m: { name: string }) => m.name).join(', '));
          }
        }
      } catch (e) {
        logger.warn('Ollama check failed');
      }

      // Try Crypto.com SDK with Ollama as backend
      if (cryptocomKey && ollamaRunning) {
        try {
          // Use Function constructor to avoid Next.js static analysis
          const dynamicImport = new Function('modulePath', 'return import(modulePath)');
          const module = await dynamicImport('@crypto.com/ai-agent-client').catch(() => null);
          
          if (module && module.createClient) {
            // Configure Crypto.com SDK to use Ollama's OpenAI-compatible endpoint
            const client = module.createClient({
              openAI: {
                apiKey: 'ollama-local', // Ollama doesn't need real key
                model: ollamaModel,
                baseURL: ollamaOpenAIUrl, // Point to Ollama's OpenAI-compatible API
              },
              chainId: 240, // Cronos zkEVM Testnet
            } as Record<string, unknown>);
            
            if (client) {
              this.aiClient = client;
              this.ollamaAvailable = true; // Mark Ollama as available too
              this.activeProvider = 'cryptocom-ollama';
              logger.info('✅ Crypto.com AI SDK + Ollama/Qwen initialized - HACKATHON + LOCAL AI');
              logger.info(`   Using model: ${ollamaModel} via Ollama OpenAI-compatible API`);
              return;
            }
          }
        } catch (sdkError) {
          logger.warn('Crypto.com AI SDK + Ollama integration failed - trying alternatives');
        }
      }

      // PRIORITY 1A.5: Crypto.com AI SDK with ASI API (if Ollama not available but ASI is)
      if (cryptocomKey && this.asiApiKey) {
        try {
          const dynamicImport = new Function('modulePath', 'return import(modulePath)');
          const module = await dynamicImport('@crypto.com/ai-agent-client').catch(() => null);
          
          if (module && module.createClient) {
            // Configure Crypto.com SDK to use ASI API's OpenAI-compatible endpoint
            const client = module.createClient({
              openAI: {
                apiKey: this.asiApiKey,
                model: process.env.ASI_MODEL || 'asi1-mini',
                baseURL: this.asiApiUrl, // ASI API is OpenAI-compatible
              },
              chainId: 240, // Cronos zkEVM Testnet
            } as Record<string, unknown>);
            
            if (client) {
              this.aiClient = client;
              this.asiAvailable = true; // Mark ASI as available too
              this.activeProvider = 'cryptocom-asi';
              logger.info('✅ Crypto.com AI SDK + ASI API initialized - HACKATHON + PRODUCTION AI');
              logger.info(`   Using ASI model: ${process.env.ASI_MODEL || 'asi1-mini'} via ASI:One API`);
              return;
            }
          }
        } catch (sdkError) {
          logger.warn('Crypto.com AI SDK + ASI integration failed - trying alternatives');
        }
      }

      // PRIORITY 1B: Crypto.com AI SDK with OpenAI (if Ollama not available)
      if (cryptocomKey && openaiKey) {
        try {
          const dynamicImport = new Function('modulePath', 'return import(modulePath)');
          const module = await dynamicImport('@crypto.com/ai-agent-client').catch(() => null);
          
          if (module && module.createClient) {
            const client = module.createClient({
              openAI: {
                apiKey: openaiKey,
                model: 'gpt-4o',
              },
              chainId: 240, // Cronos zkEVM Testnet
            } as Record<string, unknown>);
            
            if (client) {
              this.aiClient = client;
              this.activeProvider = 'cryptocom-openai';
              logger.info('✅ Crypto.com AI SDK + OpenAI initialized - HACKATHON MODE');
              return;
            }
          }
        } catch (sdkError) {
          logger.warn('Crypto.com AI SDK + OpenAI failed - trying alternatives');
        }
      }

      // PRIORITY 2: Ollama standalone (if Crypto.com SDK not available)
      if (ollamaRunning) {
        this.ollamaAvailable = true;
        this.activeProvider = 'ollama';
        logger.info('✅ Using Ollama/Qwen standalone as AI provider');
        return;
      }
      
      // Check Ollama again if we didn't check before
      if (!ollamaRunning) {
        try {
          const ollamaCheck = await fetch(`${this.ollamaBaseUrl}/api/tags`, {
            method: 'GET',
            signal: AbortSignal.timeout(3000),
          }).catch(() => null);
          
          if (ollamaCheck && ollamaCheck.ok) {
            const models = await ollamaCheck.json();
            if (models.models && models.models.length > 0) {
              this.ollamaAvailable = true;
              this.activeProvider = 'ollama';
              logger.info('✅ Ollama detected:', models.models.map((m: { name: string }) => m.name).join(', '));
              return;
            }
          }
        } catch (ollamaError) {
          logger.warn('Ollama not available');
        }
      }

      // Priority 2.5: ASI API (Fetch.ai's ASI:One - Production AI when Ollama unavailable)
      if (this.asiApiKey) {
        try {
          // Test ASI API connectivity
          const testResponse = await fetch(`${this.asiApiUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.asiApiKey}`,
            },
            body: JSON.stringify({
              model: 'asi1-mini',
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 5,
            }),
            signal: AbortSignal.timeout(10000),
          });
          
          if (testResponse.ok) {
            this.asiAvailable = true;
            this.activeProvider = 'asi';
            logger.info('✅ ASI API (Fetch.ai ASI:One) initialized - PRODUCTION AI ENABLED');
            logger.info('   Using model: asi1-mini for balanced performance');
            return;
          } else {
            const errorData = await testResponse.json().catch(() => ({}));
            logger.warn(`ASI API test failed: ${testResponse.status} ${JSON.stringify(errorData)}`);
          }
        } catch (asiError) {
          logger.warn(`ASI API not available: ${String(asiError)}`);
        }
      }

      // Priority 3: OpenAI (enterprise-grade, scalable)
      if (openaiKey) {
        try {
          // Use Function constructor to avoid Next.js static analysis
          const dynamicImport = new Function('modulePath', 'return import(modulePath)');
          const openaiModule = await dynamicImport('openai').catch(() => null);
          if (openaiModule && openaiModule.default) {
            this.openAIClient = new openaiModule.default({ apiKey: openaiKey });
            this.activeProvider = 'openai';
            logger.info('✅ OpenAI client initialized - REAL AI ENABLED');
            return;
          }
        } catch (openaiError) {
          logger.warn('OpenAI module not installed (optional) - trying alternatives');
        }
      }

      // Priority 4: Anthropic Claude (safety-focused, enterprise-grade)
      // Note: Only enabled if @anthropic-ai/sdk is installed
      if (anthropicKey) {
        try {
          // Use Function constructor to avoid Next.js static analysis
          const dynamicImport = new Function('modulePath', 'return import(modulePath)');
          const anthropicModule = await dynamicImport('@anthropic-ai/sdk').catch(() => null);
          if (anthropicModule && anthropicModule.default) {
            this.anthropicClient = new anthropicModule.default({ apiKey: anthropicKey });
            this.activeProvider = 'anthropic';
            logger.info('✅ Anthropic Claude initialized - REAL AI ENABLED');
            return;
          }
        } catch (anthropicError) {
          logger.warn('Anthropic SDK not installed (optional) - skipping');
        }
      }

      // No AI provider available
      logger.error('❌ NO AI PROVIDER AVAILABLE');
      logger.error('Options to enable AI:');
      logger.error('  1. FREE & SECURE: Install Ollama (ollama.ai) and run: ollama pull llama3.2');
      logger.error('  2. PAID: Set OPENAI_API_KEY or ANTHROPIC_API_KEY');
      logger.error('  3. NATIVE: Set CRYPTOCOM_DEVELOPER_API_KEY for Crypto.com AI');
      this.activeProvider = 'fallback';
    } catch (error) {
      logger.error('Failed to initialize any AI provider', { error: String(error) });
      this.activeProvider = 'fallback';
    }
  }

  /**
   * Get the active AI provider name
   */
  getActiveProvider(): string {
    return this.activeProvider;
  }

  /**
   * Check if real AI is available (not just rule-based fallback)
   */
  isAvailable(): boolean {
    return this.aiClient !== null || this.openAIClient !== null || 
           this.anthropicClient !== null || this.ollamaAvailable || this.asiAvailable;
  }

  /**
   * Wait for initialization to complete
   */
  async waitForInit(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  /**
   * Generate a conversational response with full context
   */
  async generateResponse(
    userMessage: string,
    conversationId: string = 'default',
    context?: Record<string, unknown>
  ): Promise<LLMResponse> {
    try {
      // Get or initialize conversation history
      let history = this.conversationHistory.get(conversationId) || [];
      
      // Add system context if this is a new conversation
      if (history.length === 0) {
        history.push({
          role: 'system',
          content: SYSTEM_CONTEXT,
          timestamp: Date.now(),
        });
      }

      // SMART FEATURE: Fetch real portfolio data for context-aware responses.
      // Use the caller's wallet from `context.address` when available so the
      // LLM sees THEIR portfolio, not the server wallet. Chat callers
      // (ChatInterface, EnhancedChat, simulator) always pass address in
      // context; falls back to server wallet for agent-flow callers.
      let portfolioContext = '';
      let portfolioAssets: string[] = [];
      try {
        const callerAddress = typeof context?.address === 'string' ? context.address : undefined;
        const portfolioData = await getPortfolioData(callerAddress);
        if (portfolioData && portfolioData.portfolio) {
          const p = portfolioData.portfolio as Record<string, unknown> & {
            totalValue?: number;
            cash?: number;
            positions?: Array<{ symbol?: string; value?: number; pnlPercentage?: number }>;
            totalPnl?: number;
            totalPnlPercentage?: number;
          };
          portfolioContext = `\n\nCurrent Portfolio:\n` +
            `• Total Value: $${p.totalValue?.toFixed(2) || 'N/A'}\n` +
            `• Cash: $${p.cash?.toFixed(2) || 'N/A'}\n` +
            `• Positions: ${p.positions?.length || 0}\n` +
            `• Total P/L: $${p.totalPnl?.toFixed(2) || 'N/A'} (${p.totalPnlPercentage?.toFixed(2) || 'N/A'}%)`;
          
          if (p.positions && p.positions.length > 0) {
            portfolioContext += '\n• Holdings: ' + p.positions.map((pos: { symbol?: string; value?: number; pnlPercentage?: number }) => 
              `${pos.symbol} ($${pos.value?.toFixed(2)}, ${pos.pnlPercentage?.toFixed(1)}%)`
            ).join(', ');
            // Extract asset symbols for prediction market lookup
            portfolioAssets = p.positions.map((pos: { symbol?: string }) => pos.symbol?.toUpperCase()).filter((s): s is string => Boolean(s));
          }
        }
      } catch (error) {
        logger.warn('Could not fetch portfolio data for context');
      }

      // 🔮 SMART FEATURE: Fetch Polymarket prediction insights for context
      let predictionContext = '';
      try {
        // Dynamic import to avoid circular dependencies
        const { DelphiMarketService } = await import('../services/market-data/DelphiMarketService');
        
        // Get relevant predictions for portfolio assets (or default to major crypto)
        const assets = portfolioAssets.length > 0 ? portfolioAssets : ['BTC', 'ETH', 'CRO'];
        const predictions = await DelphiMarketService.getRelevantMarkets(assets);
        
        // Filter to HIGH impact predictions with strong signals
        const significantPredictions = predictions
          .filter(p => p.impact === 'HIGH' || (p.probability > 70 || p.probability < 30))
          .slice(0, 5);
        
        if (significantPredictions.length > 0) {
          predictionContext = '\n\n🔮 Polymarket Prediction Insights:\n';
          for (const pred of significantPredictions) {
            const signal = pred.probability > 70 ? '📈' : pred.probability < 30 ? '📉' : '⚖️';
            predictionContext += `${signal} ${pred.question} (${pred.probability}% prob, ${pred.impact} impact)\n`;
            if (pred.recommendation === 'HEDGE') {
              predictionContext += `   ⚠️ Recommendation: HEDGE\n`;
            }
          }
          logger.info('🔮 Added Polymarket context', { predictions: significantPredictions.length });
        }
      } catch (error) {
        logger.warn('Could not fetch Polymarket predictions for context');
      }

      // SMART FEATURE: Detect if user wants to execute an action
      let actionIntent = parseActionIntent(userMessage);
      let actionResult = null;
      let _actionExecuted = false;

      // For analysis actions without portfolio data, let the LLM respond intelligently
      if (actionIntent) {
        const isAnalysisAction = ['analyze', 'assess-risk', 'get-hedges'].includes(actionIntent.type);
        const hasPortfolioData = portfolioContext.length > 50 && portfolioContext.includes('Total Value');
        
        if (isAnalysisAction && !hasPortfolioData) {
          // No portfolio data - Qwen can give a much better response than empty metrics!
          logger.info('📝 No portfolio data - letting LLM handle this intelligently');
          actionIntent = null; // Clear to fall through to LLM
        }
      }

      // Only execute action if we still have a valid intent (not cleared above)
      if (actionIntent) {
        // Execute the action
        actionResult = await executePortfolioAction(actionIntent);
        _actionExecuted = true;
        
        // Format action result with better error messages
        let formattedResult: string;
        if (!actionResult.success) {
          formattedResult = `⚠️ **Action Failed**: ${actionResult.message}\n\n${actionResult.error || 'Please ensure you\'re connected to the network and try again.'}`;
        } else {
          formattedResult = formatActionResult(actionIntent, actionResult);
        }
        
        // Return the action result directly with ZK proof
        history.push({
          role: 'user',
          content: userMessage,
          timestamp: Date.now(),
        });

        history.push({
          role: 'assistant',
          content: formattedResult,
          timestamp: Date.now(),
          metadata: { 
            actionExecuted: true, 
            action: actionIntent.type,
            zkProof: actionResult.zkProof,
          },
        });

        this.conversationHistory.set(conversationId, history);

        return {
          content: formattedResult,
          model: 'action-executor',
          confidence: 1.0,
          actionExecuted: true,
          actionResult: actionResult.data,
          zkProof: actionResult.zkProof,
        };
      }

      // Add user message to history with portfolio context and prediction insights
      const enrichedMessage = userMessage + portfolioContext + predictionContext;
      
      // Check LLM response cache for non-action queries
      const promptHash = hashPrompt(userMessage);
      if (shouldCacheQuery(userMessage)) {
        const cachedResponse = getCachedLLMResponse(promptHash);
        if (cachedResponse) {
          // Add to history even for cached response
          history.push({
            role: 'user',
            content: enrichedMessage,
            timestamp: Date.now(),
          });
          history.push({
            role: 'assistant',
            content: cachedResponse.content,
            timestamp: Date.now(),
            metadata: { model: cachedResponse.model, cached: true },
          });
          this.conversationHistory.set(conversationId, history);
          logger.info('[LLM] Using cached response (saved API call)');
          return cachedResponse;
        }
      }
      
      history.push({
        role: 'user',
        content: enrichedMessage,
        timestamp: Date.now(),
      });

      // Trim history if too long (keep system message + recent messages)
      if (history.length > this.maxHistoryLength) {
        history = [
          history[0], // Keep system message
          ...history.slice(-(this.maxHistoryLength - 1))
        ];
      }

      let response: LLMResponse;

      // Ensure initialization is complete
      await this.waitForInit();

      // Use the active provider that was determined during initialization
      // Priority order: Ollama (free, local) > ASI API > Crypto.com AI > OpenAI > Anthropic
      if (this.ollamaAvailable) {
        // Priority 1: Use Ollama (FREE, LOCAL, SECURE)
        logger.info('Using Ollama (FREE LOCAL AI) for response generation');
        response = await this.generateWithOllama(history, context);
      } else if (this.asiAvailable) {
        // Priority 2: Use ASI API (Fetch.ai production AI)
        logger.info('Using ASI API (Fetch.ai ASI:One) for response generation');
        response = await this.generateWithASI(history, context);
      } else if (this.aiClient) {
        // Priority 3: Use Crypto.com AI
        logger.info('Using Crypto.com AI for response generation');
        response = await this.generateWithCryptocomAI(history, context);
      } else if (this.openAIClient) {
        // Priority 3: Use direct OpenAI
        logger.info('Using OpenAI for response generation');
        response = await this.generateWithOpenAI(history, context);
      } else if (this.anthropicClient) {
        // Priority 4: Use Anthropic Claude
        logger.info('Using Anthropic Claude for response generation');
        response = await this.generateWithAnthropic(history, context);
      } else {
        // Last resort: Use rule-based fallback (clearly marked)
        logger.warn('NO REAL AI AVAILABLE - Using rule-based fallback');
        response = await this.generateFallbackResponse(userMessage, context, portfolioContext);
      }

      // Add assistant response to history
      history.push({
        role: 'assistant',
        content: response.content,
        timestamp: Date.now(),
        metadata: { model: response.model, confidence: response.confidence },
      });

      // Save updated history
      this.conversationHistory.set(conversationId, history);
      
      // Cache the response for non-action queries (reduces future API calls)
      if (shouldCacheQuery(userMessage)) {
        setCachedLLMResponse(promptHash, response);
        logger.debug('[LLM] Cached response for potential reuse');
      }

      return response;
    } catch (error) {
      logger.error('Error generating LLM response:', error);
      return {
        content: "I apologize, but I encountered an error processing your request. Please try rephrasing or contact support if the issue persists.",
        confidence: 0,
      };
    }
  }

  /**
   * Generate response using Crypto.com AI SDK
   */
  private async generateWithCryptocomAI(
    history: ChatMessage[],
    context?: Record<string, unknown>
  ): Promise<LLMResponse> {
    try {
      // Format messages for the AI
      const messages = history.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      // Add context if provided
      if (context) {
        const contextStr = Object.entries(context)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n');
        messages[messages.length - 1].content += `\n\nContext:\n${contextStr}`;
      }

      // Call Crypto.com AI
      const result = await this.aiClient!.chat.completions.create({
        model: 'gpt-4',
        messages,
        temperature: 0.7,
        max_tokens: 800,
      });

      logger.info('Crypto.com AI response generated successfully');
      return {
        content: result.choices[0].message.content,
        tokensUsed: result.usage?.total_tokens,
        model: 'gpt-4-via-cryptocom',
        confidence: 0.95,
      };
    } catch (error) {
      logger.error('Crypto.com AI call failed, trying fallbacks:', error);
      
      // Try ASI API as primary fallback (production AI)
      if (this.asiAvailable) {
        return this.generateWithASI(history, context);
      }
      
      // Try OpenAI as fallback if available
      if (this.openAIClient) {
        return this.generateWithOpenAI(history, context);
      }
      
      // Try Anthropic as fallback
      if (this.anthropicClient) {
        return this.generateWithAnthropic(history, context);
      }
      
      // Try Ollama as fallback
      if (this.ollamaAvailable) {
        return this.generateWithOllama(history, context);
      }
      
      // Last resort: rule-based fallback
      return this.generateFallbackResponse(
        history[history.length - 1].content,
        context
      );
    }
  }

  /**
   * Generate response using ASI API (Fetch.ai's ASI:One - Production AI)
   * Use this when Ollama is not available but you need real AI responses
   * API docs: https://docs.asi1.ai/
   */
  private async generateWithASI(
    history: ChatMessage[],
    context?: Record<string, unknown>
  ): Promise<LLMResponse> {
    try {
      if (!this.asiApiKey) {
        throw new Error('ASI API key not configured');
      }

      // Format messages for ASI API (OpenAI-compatible format)
      const messages = history.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      // Add context if provided
      if (context && messages.length > 0) {
        const contextStr = Object.entries(context)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n');
        messages[messages.length - 1].content += `\n\nContext:\n${contextStr}`;
      }

      // Use asi1-mini for balanced performance and speed
      // Other models available: asi1-fast, asi1-extended, asi1-agentic
      const model = process.env.ASI_MODEL || 'asi1-mini';

      // Call ASI API
      const response = await fetch(`${this.asiApiUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.asiApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(60000), // 60s timeout
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`ASI API returned ${response.status}: ${JSON.stringify(errorData)}`);
      }

      const result = await response.json();
      const content = result.choices?.[0]?.message?.content || '';

      logger.info(`ASI API (${model}) response generated successfully - PRODUCTION AI`);
      return {
        content,
        tokensUsed: result.usage?.total_tokens || 0,
        model: `asi-${model}`,
        confidence: 0.92,
      };
    } catch (error) {
      logger.error('ASI API call failed:', error);
      
      // Fallback chain: Anthropic → Ollama → rule-based
      // NOTE: Do NOT fall back to OpenAI here — OpenAI falls back to ASI,
      // creating a circular chain (ASI → OpenAI → ASI → stack overflow).
      if (this.anthropicClient) {
        return this.generateWithAnthropic(history, context);
      }
      if (this.ollamaAvailable) {
        return this.generateWithOllama(history, context);
      }
      // Last resort: rule-based fallback
      return this.generateFallbackResponse(
        history[history.length - 1].content,
        context
      );
    }
  }

  /**
   * Generate response using direct OpenAI API
   */
  private async generateWithOpenAI(
    history: ChatMessage[],
    context?: Record<string, unknown>
  ): Promise<LLMResponse> {
    try {
      // Format messages for OpenAI
      const messages = history.map(msg => ({
        role: msg.role as 'system' | 'user' | 'assistant',
        content: msg.content,
      }));

      // Add context if provided
      if (context) {
        const contextStr = Object.entries(context)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n');
        messages[messages.length - 1].content += `\n\nContext:\n${contextStr}`;
      }

      // Call OpenAI directly
      const result = await this.openAIClient!.chat.completions.create({
        model: 'gpt-4o-mini', // Cost-effective model
        messages,
        temperature: 0.7,
        max_tokens: 800,
      });

      logger.info('OpenAI response generated successfully');
      return {
        content: result.choices[0].message.content || '',
        tokensUsed: result.usage?.total_tokens,
        model: 'gpt-4o-mini-direct',
        confidence: 0.90,
      };
    } catch (error) {
      logger.error('OpenAI call failed:', error);
      // Fallback chain: Anthropic → Ollama → rule-based
      // NOTE: Do NOT fall back to ASI here — ASI falls back to Anthropic/Ollama,
      // and CryptocomAI already tries ASI before OpenAI, avoiding circular chains.
      if (this.anthropicClient) {
        return this.generateWithAnthropic(history, context);
      }
      if (this.ollamaAvailable) {
        return this.generateWithOllama(history, context);
      }
      // Last resort: rule-based fallback
      return this.generateFallbackResponse(
        history[history.length - 1].content,
        context
      );
    }
  }

  /**
   * Generate response using Anthropic Claude API (enterprise-grade, safety-focused)
   */
  private async generateWithAnthropic(
    history: ChatMessage[],
    context?: Record<string, unknown>
  ): Promise<LLMResponse> {
    try {
      // Extract system message and format for Anthropic
      const systemMessage = history.find(m => m.role === 'system')?.content || SYSTEM_CONTEXT;
      const messages = history
        .filter(m => m.role !== 'system')
        .map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        }));

      // Add context if provided
      if (context && messages.length > 0) {
        const contextStr = Object.entries(context)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n');
        messages[messages.length - 1].content += `\n\nContext:\n${contextStr}`;
      }

      // Call Anthropic Claude
      const result = await this.anthropicClient!.messages.create({
        model: 'claude-3-haiku-20240307', // Cost-effective model
        max_tokens: 800,
        system: systemMessage,
        messages,
      });

      const content = result.content[0]?.type === 'text' ? result.content[0].text : '';
      
      logger.info('Anthropic Claude response generated successfully');
      return {
        content,
        tokensUsed: (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0),
        model: 'claude-3-haiku',
        confidence: 0.92,
      };
    } catch (error) {
      logger.error('Anthropic Claude call failed:', error);
      // Fallback chain: Ollama → rule-based
      // NOTE: Do NOT fall back to ASI/OpenAI here — they already fall back
      // to Anthropic, which would create circular chains.
      if (this.ollamaAvailable) {
        return this.generateWithOllama(history, context);
      }
      // Last resort: rule-based fallback
      return this.generateFallbackResponse(
        history[history.length - 1].content,
        context
      );
    }
  }

  /**
   * Generate response using Ollama (FREE, LOCAL, SECURE - no data leaves your server)
   * Install from https://ollama.ai and run: ollama pull qwen2.5:7b
   */
  private async generateWithOllama(
    history: ChatMessage[],
    context?: Record<string, unknown>
  ): Promise<LLMResponse> {
    try {
      // Use qwen2.5:7b which is already installed and optimized for CUDA
      const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
      
      // Format messages for Ollama
      const messages = history.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      // Add context if provided
      if (context && messages.length > 0) {
        const contextStr = Object.entries(context)
          .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
          .join('\n');
        messages[messages.length - 1].content += `\n\nContext:\n${contextStr}`;
      }

      // Call Ollama local API
      const response = await fetch(`${this.ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: {
            temperature: 0.7,
            num_predict: 800,
          },
        }),
        signal: AbortSignal.timeout(60000), // 60s timeout for local inference
      });

      if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}: ${response.statusText}`);
      }

      const result = await response.json();
      const content = result.message?.content || '';

      logger.info(`Ollama (${model}) response generated successfully - FREE LOCAL AI`);
      return {
        content,
        tokensUsed: result.eval_count || 0,
        model: `ollama-${model}`,
        confidence: 0.88,
      };
    } catch (error) {
      logger.error('Ollama call failed:', error);
      // Last resort: rule-based fallback
      // NOTE: Do NOT fall back to ASI/OpenAI/Anthropic here — they already
      // fall back to Ollama at the end of their chains.
      return this.generateFallbackResponse(
        history[history.length - 1].content,
        context
      );
    }
  }

  /**
   * Generate rule-based fallback response (clearly marked as non-AI)
   */
  /**
   * Rule-based fallback when no LLM provider is available. Delegates to
   * ../ai/fallback-responses so the ~160-LOC keyword switch lives outside
   * this class.
   */
  private async generateFallbackResponse(
    userMessage: string,
    context?: Record<string, unknown>,
    portfolioContext?: string,
  ): Promise<LLMResponse> {
    return generateFallbackResponseImpl(userMessage, context, portfolioContext);
  }

  /**
   * Stream response token by token (for better UX)
   */
  async* streamResponse(
    userMessage: string,
    conversationId: string = 'default',
    context?: Record<string, unknown>
  ): AsyncGenerator<StreamChunk> {
    // For now, generate full response and stream it
    // In production, this would use proper streaming APIs
    const response = await this.generateResponse(userMessage, conversationId, context);
    
    const words = response.content.split(' ');
    for (let i = 0; i < words.length; i++) {
      yield {
        delta: words[i] + (i < words.length - 1 ? ' ' : ''),
        done: i === words.length - 1,
      };
      // Simulate streaming delay
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }

  /**
   * Clear conversation history
   */
  clearHistory(conversationId: string = 'default'): void {
    this.conversationHistory.delete(conversationId);
  }

  /**
   * Get conversation history
   */
  getHistory(conversationId: string = 'default'): ChatMessage[] {
    return this.conversationHistory.get(conversationId) || [];
  }

  /**
   * Direct AI call for agents - bypasses portfolio context and action parsing
   * Use this for agent-based analysis that needs clean, focused responses
   */
  async generateDirectResponse(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    await this.waitForInit();
    
    if (!this.ollamaAvailable && !this.asiAvailable && !this.openAIClient && !this.anthropicClient) {
      throw new Error('No AI provider available');
    }

    const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';
    
    const messages = [
      {
        role: 'system',
        content: systemPrompt || 'You are an expert AI assistant. Be concise and direct in your responses.',
      },
      {
        role: 'user',
        content: prompt,
      }
    ];

    // Use Ollama if available (preferred - free and local)
    if (this.ollamaAvailable) {
      try {
        const response = await fetch(`${this.ollamaBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages,
            stream: false,
            options: {
              temperature: 0.5, // Lower temperature for more focused responses
              num_predict: 500,
            },
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          throw new Error(`Ollama returned ${response.status}`);
        }

        const result = await response.json();
        return {
          content: result.message?.content || '',
          tokensUsed: result.eval_count || 0,
          model: `ollama-${model}`,
          confidence: 0.88,
        };
      } catch (error) {
        logger.error('Direct Ollama call failed, trying ASI API:', error);
        // Fall through to ASI API
      }
    }

    // Use ASI API if available (production AI - Fetch.ai)
    if (this.asiAvailable && this.asiApiKey) {
      try {
        const asiModel = process.env.ASI_MODEL || 'asi1-mini';
        const response = await fetch(`${this.asiApiUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.asiApiKey}`,
          },
          body: JSON.stringify({
            model: asiModel,
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            temperature: 0.5,
            max_tokens: 500,
          }),
          signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
          throw new Error(`ASI API returned ${response.status}`);
        }

        const result = await response.json();
        return {
          content: result.choices?.[0]?.message?.content || '',
          tokensUsed: result.usage?.total_tokens || 0,
          model: `asi-${asiModel}-direct`,
          confidence: 0.92,
        };
      } catch (error) {
        logger.error('Direct ASI API call failed:', error);
        // Fall through to OpenAI/Anthropic
      }
    }

    // Fallback to OpenAI
    if (this.openAIClient) {
      const result = await this.openAIClient!.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages.map(m => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
        temperature: 0.5,
        max_tokens: 500,
      });
      return {
        content: result.choices[0].message.content || '',
        tokensUsed: result.usage?.total_tokens,
        model: 'gpt-4o-mini-direct',
        confidence: 0.90,
      };
    }

    // Fallback to Anthropic
    if (this.anthropicClient) {
      const result = await this.anthropicClient!.messages.create({
        model: 'claude-3-haiku-20240307',
        max_tokens: 500,
        system: messages[0].content,
        messages: [{ role: 'user', content: messages[1].content }],
      });
      return {
        content: result.content[0]?.type === 'text' ? result.content[0].text : '',
        tokensUsed: (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0),
        model: 'claude-3-haiku-direct',
        confidence: 0.92,
      };
    }

    throw new Error('No AI provider available for direct call');
  }
}

// Export singleton instance
export const llmProvider = new LLMProvider();
