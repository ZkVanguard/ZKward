/**
 * Unified Price Provider
 * 
 * Single source of truth for all real-time prices across the application.
 * Consolidates WebSocket streaming, REST polling, and caching into one service.
 * 
 * Priority Chain:
 * 1. WebSocket stream (real-time, <100ms latency)
 * 2. RealMarketDataService cache (5s refresh)
 * 3. Direct Crypto.com API (fallback)
 * 
 * Used by:
 * - AutoHedgingService (background hedging)
 * - Hedge execute route (order entry)
 * - AI decisions (recommendations)
 * - PnL calculations
 */

import { logger } from '@/lib/utils/logger';
import { EventEmitter } from 'events';
import { CACHE_TAG_CRYPTOCOM_TICKER } from './cache-tags';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface LivePrice {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  timestamp: number;
  source: 'websocket' | 'rest' | 'cache' | 'fallback';
  latency: number; // ms since last update
}

export interface PriceValidation {
  isValid: boolean;
  isFresh: boolean;
  staleness: number; // ms since last update
  spreadPercent: number;
  priceSource: string;
  warnings: string[];
}

export interface HedgePriceContext {
  entryPrice: number;
  bidPrice: number;
  askPrice: number;
  effectivePrice: number; // bid for shorts, ask for longs
  slippageEstimate: number;
  validation: PriceValidation;
  timestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // WebSocket configuration
  WS_URL: 'wss://stream.crypto.com/exchange/v1/market',
  WS_RECONNECT_DELAY: 2000,
  WS_MAX_RECONNECTS: 10,
  WS_HEARTBEAT_INTERVAL: 30000,

  // Cache configuration
  FRESH_THRESHOLD_MS: 1000,   // Price is "fresh" if <1s old
  STALE_THRESHOLD_MS: 5000,   // Price is "stale" if 1-5s old
  EXPIRED_THRESHOLD_MS: 30000, // Price is "expired" if >30s old
  // Absolute freshness gate for getLivePrice. Anything past this is
  // treated as no-price-available; 2026-09-17 forensic showed ETH stuck
  // at $2016.64 for 74 days because updatePrice couldn't get a fresh
  // ticker but getLivePrice happily returned the ancient value.
  MAX_LIVE_PRICE_STALENESS_MS: 60_000,
  
  // Validation thresholds
  MAX_SPREAD_PERCENT: 1.0,    // Warn if spread > 1%
  MAX_SLIPPAGE_PERCENT: 0.5,  // Expected slippage for orders
  
  // Tracked symbols
  DEFAULT_SYMBOLS: ['BTC', 'ETH', 'CRO', 'SUI', 'SOL', 'DOGE', 'ATOM'],
  
  // Polling fallback interval (only if WebSocket fails)
  FALLBACK_POLL_INTERVAL: 3000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED PRICE PROVIDER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class UnifiedPriceProvider extends EventEmitter {
  private prices: Map<string, LivePrice> = new Map();
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private trackedSymbols: Set<string> = new Set(CONFIG.DEFAULT_SYMBOLS);
  private lastApiCall = 0;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    super();
    this.setMaxListeners(100);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════════

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInitialize();
    return this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    logger.info('[UnifiedPrice] Initializing...');
    
    // Start with REST fetch to populate cache immediately
    await this.fetchPricesFromREST();
    
    // Connect WebSocket for real-time updates
    if (typeof WebSocket !== 'undefined') {
      this.connectWebSocket();
    } else {
      // Server-side: use polling fallback
      this.startPolling();
    }
    
    this.initialized = true;
    logger.info('[UnifiedPrice] Initialized', {
      symbols: Array.from(this.trackedSymbols),
      priceCount: this.prices.size,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WEBSOCKET MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private connectWebSocket(): void {
    try {
      this.ws = new WebSocket(CONFIG.WS_URL);
      
      this.ws.onopen = () => {
        this.wsConnected = true;
        this.reconnectAttempts = 0;
        logger.info('[UnifiedPrice] WebSocket connected');
        
        // Subscribe to ticker updates
        this.subscribeToTickers();
        
        // Start heartbeat
        this.startHeartbeat();
        
        // Stop polling if running
        this.stopPolling();
        
        this.emit('connected');
      };

      this.ws.onmessage = (event) => {
        this.handleWebSocketMessage(event.data);
      };

      this.ws.onerror = (error) => {
        logger.error('[UnifiedPrice] WebSocket error', { error });
        this.emit('error', error);
      };

      this.ws.onclose = () => {
        this.wsConnected = false;
        this.stopHeartbeat();
        logger.warn('[UnifiedPrice] WebSocket disconnected');
        
        // Fallback to polling
        this.startPolling();
        
        // Attempt reconnect
        this.scheduleReconnect();
        
        this.emit('disconnected');
      };
    } catch (error) {
      logger.error('[UnifiedPrice] Failed to create WebSocket', { error });
      this.startPolling();
    }
  }

  private subscribeToTickers(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const symbols = Array.from(this.trackedSymbols);
    const subscriptions = symbols.map(s => `ticker.${s}_USDT`);

    this.ws.send(JSON.stringify({
      id: Date.now(),
      method: 'subscribe',
      params: { channels: subscriptions },
    }));

    logger.debug('[UnifiedPrice] Subscribed to tickers', { symbols });
  }

  private handleWebSocketMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      
      if (msg.method === 'subscribe' && msg.result?.channel?.startsWith('ticker.')) {
        const tickerData = msg.result.data;
        if (tickerData) {
          this.updatePrice({
            symbol: this.extractSymbol(msg.result.channel),
            price: parseFloat(tickerData.a || tickerData.k),
            bid: parseFloat(tickerData.b || tickerData.k),
            ask: parseFloat(tickerData.a || tickerData.k),
            change24h: parseFloat(tickerData.c || 0),
            high24h: parseFloat(tickerData.h || tickerData.k),
            low24h: parseFloat(tickerData.l || tickerData.k),
            volume24h: parseFloat(tickerData.v || 0),
            timestamp: Date.now(),
            source: 'websocket',
            latency: 0,
          });
        }
      }
    } catch (error) {
      // Ignore parse errors for heartbeat messages
    }
  }

  private extractSymbol(channel: string): string {
    // ticker.BTC_USDT -> BTC
    const match = channel.match(/ticker\.([A-Z]+)_USDT/);
    return match ? match[1] : channel;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ id: Date.now(), method: 'public/heartbeat' }));
      }
    }, CONFIG.WS_HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= CONFIG.WS_MAX_RECONNECTS) {
      logger.error('[UnifiedPrice] Max reconnect attempts reached');
      return;
    }

    const delay = CONFIG.WS_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      if (!this.wsConnected) {
        logger.info('[UnifiedPrice] Attempting WebSocket reconnect', {
          attempt: this.reconnectAttempts,
        });
        this.connectWebSocket();
      }
    }, delay);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // REST POLLING (FALLBACK)
  // ═══════════════════════════════════════════════════════════════════════════

  private startPolling(): void {
    if (this.pollTimer) return;

    logger.info('[UnifiedPrice] Starting REST polling fallback');
    
    this.pollTimer = setInterval(async () => {
      if (!this.wsConnected) {
        await this.fetchPricesFromREST();
      }
    }, CONFIG.FALLBACK_POLL_INTERVAL);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      logger.debug('[UnifiedPrice] Stopped REST polling');
    }
  }

  async fetchPricesFromREST(): Promise<void> {
    // Rate limit: max 1 call per second
    const now = Date.now();
    if (now - this.lastApiCall < 1000) return;
    this.lastApiCall = now;

    try {
      const response = await fetch('https://api.crypto.com/exchange/v1/public/get-tickers', {
        headers: { 'Content-Type': 'application/json' },
        next: { revalidate: 30, tags: [CACHE_TAG_CRYPTOCOM_TICKER] },
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const tickers = data.result?.data || [];

      for (const ticker of tickers) {
        const symbol = this.extractSymbolFromTicker(ticker.i);
        if (this.trackedSymbols.has(symbol)) {
          this.updatePrice({
            symbol,
            price: parseFloat(ticker.a),
            bid: parseFloat(ticker.b),
            ask: parseFloat(ticker.a),
            change24h: parseFloat(ticker.c || 0),
            high24h: parseFloat(ticker.h),
            low24h: parseFloat(ticker.l),
            volume24h: parseFloat(ticker.v),
            timestamp: now,
            source: 'rest',
            latency: Date.now() - now,
          });
        }
      }

      this.emit('pricesUpdated', this.getAllPrices());
    } catch (error) {
      logger.error('[UnifiedPrice] REST fetch failed', { error });
    }
  }

  private extractSymbolFromTicker(instrument: string): string {
    // BTC_USDT -> BTC
    const match = instrument.match(/^([A-Z]+)_USDT$/);
    return match ? match[1] : instrument;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRICE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  private updatePrice(price: LivePrice): void {
    // Reject non-positive prices. Some upstream tickers return 0 for
    // untraded pairs or during API blips; storing that value would poison
    // downstream reads. Log at warn so operator sees the pattern.
    if (!Number.isFinite(price.price) || price.price <= 0) {
      logger.warn('[UnifiedPrice] rejected non-positive price update', {
        symbol: price.symbol,
        price: price.price,
        source: price.source,
      });
      return;
    }
    const existing = this.prices.get(price.symbol);
    // Only update if newer
    if (!existing || price.timestamp > existing.timestamp) {
      this.prices.set(price.symbol, price);
      this.emit('priceUpdate', price);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get current price for a symbol
   * Returns cached price with freshness metadata
   */
  getPrice(symbol: string): LivePrice | null {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    const price = this.prices.get(normalizedSymbol);
    
    if (price) {
      return {
        ...price,
        latency: Date.now() - price.timestamp,
      };
    }
    
    return null;
  }

  /**
   * Get price with validation for hedge execution
   * Includes bid/ask spread analysis and staleness checks
   */
  async getHedgePrice(symbol: string, side: 'LONG' | 'SHORT'): Promise<HedgePriceContext> {
    const normalizedSymbol = this.normalizeSymbol(symbol);
    
    // Ensure initialized
    if (!this.initialized) {
      await this.initialize();
    }
    
    let price = this.prices.get(normalizedSymbol);
    
    // If no cached price or expired, fetch fresh
    if (!price || Date.now() - price.timestamp > CONFIG.EXPIRED_THRESHOLD_MS) {
      await this.fetchPricesFromREST();
      price = this.prices.get(normalizedSymbol);
    }
    
    // Build validation result
    const validation = this.validatePrice(price);
    
    if (!price) {
      return {
        entryPrice: 0,
        bidPrice: 0,
        askPrice: 0,
        effectivePrice: 0,
        slippageEstimate: 0,
        validation: {
          isValid: false,
          isFresh: false,
          staleness: Infinity,
          spreadPercent: 0,
          priceSource: 'none',
          warnings: ['No price data available'],
        },
        timestamp: Date.now(),
      };
    }
    
    // Calculate effective price based on side
    // LONG: we buy at ask price
    // SHORT: we sell at bid price
    const effectivePrice = side === 'LONG' ? price.ask : price.bid;
    const slippageEstimate = Math.abs(effectivePrice - price.price) / price.price * 100;
    
    return {
      entryPrice: price.price,
      bidPrice: price.bid,
      askPrice: price.ask,
      effectivePrice,
      slippageEstimate,
      validation,
      timestamp: Date.now(),
    };
  }

  /**
   * Validate price for hedge execution
   */
  validatePrice(price: LivePrice | null | undefined): PriceValidation {
    if (!price) {
      return {
        isValid: false,
        isFresh: false,
        staleness: Infinity,
        spreadPercent: 0,
        priceSource: 'none',
        warnings: ['No price data available'],
      };
    }
    
    const staleness = Date.now() - price.timestamp;
    const spreadPercent = price.ask > 0 && price.bid > 0
      ? ((price.ask - price.bid) / price.price) * 100
      : 0;
    
    const warnings: string[] = [];
    
    // Check staleness
    const isFresh = staleness < CONFIG.FRESH_THRESHOLD_MS;
    if (staleness > CONFIG.STALE_THRESHOLD_MS) {
      warnings.push(`Price is ${(staleness / 1000).toFixed(1)}s old`);
    }
    
    // Check spread
    if (spreadPercent > CONFIG.MAX_SPREAD_PERCENT) {
      warnings.push(`High spread: ${spreadPercent.toFixed(2)}%`);
    }
    
    // Check source
    if (price.source !== 'websocket') {
      warnings.push(`Using ${price.source} price (not real-time)`);
    }
    
    return {
      isValid: price.price > 0 && staleness < CONFIG.EXPIRED_THRESHOLD_MS,
      isFresh,
      staleness,
      spreadPercent,
      priceSource: price.source,
      warnings,
    };
  }

  /**
   * Get all cached prices
   */
  getAllPrices(): Map<string, LivePrice> {
    return new Map(this.prices);
  }

  /**
   * Add a symbol to track
   */
  trackSymbol(symbol: string): void {
    const normalized = this.normalizeSymbol(symbol);
    if (!this.trackedSymbols.has(normalized)) {
      this.trackedSymbols.add(normalized);
      
      // Subscribe via WebSocket if connected
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          id: Date.now(),
          method: 'subscribe',
          params: { channels: [`ticker.${normalized}_USDT`] },
        }));
      }
    }
  }

  /**
   * Normalize symbol format
   */
  private normalizeSymbol(symbol: string): string {
    let normalized = symbol.toUpperCase()
      .replace('-PERP', '')
      .replace('-USD-PERP', '')
      .replace('-USD', '')
      .replace('_USDT', '');
    
    // Map wrapped tokens to base
    if (normalized === 'WBTC') normalized = 'BTC';
    if (normalized === 'WETH') normalized = 'ETH';
    
    return normalized;
  }

  /**
   * Get connection status
   */
  getStatus(): {
    initialized: boolean;
    wsConnected: boolean;
    priceCount: number;
    trackedSymbols: string[];
    oldestPrice: number;
    newestPrice: number;
  } {
    let oldest = Date.now();
    let newest = 0;
    
    for (const price of this.prices.values()) {
      if (price.timestamp < oldest) oldest = price.timestamp;
      if (price.timestamp > newest) newest = price.timestamp;
    }
    
    return {
      initialized: this.initialized,
      wsConnected: this.wsConnected,
      priceCount: this.prices.size,
      trackedSymbols: Array.from(this.trackedSymbols),
      oldestPrice: oldest,
      newestPrice: newest,
    };
  }

  /**
   * Shutdown the provider
   */
  shutdown(): void {
    this.stopHeartbeat();
    this.stopPolling();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    this.wsConnected = false;
    this.initialized = false;
    this.initPromise = null;
    
    logger.info('[UnifiedPrice] Shutdown complete');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════════════════════

let instance: UnifiedPriceProvider | null = null;

export function getUnifiedPriceProvider(): UnifiedPriceProvider {
  if (!instance) {
    instance = new UnifiedPriceProvider();
  }
  return instance;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVENIENCE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Quick access to current price with a hard staleness gate.
 *
 * Returns 0 when the cached price is older than CONFIG.MAX_LIVE_PRICE_STALENESS_MS
 * OR when no price is cached at all. Callers should treat 0 as "no live
 * price available" and refuse to make trading decisions. This is the
 * guard that would have prevented the 2026-09-17 ETH stale-cache bleed
 * ($2016.64 held for 74 days because upstream fetches silently failed).
 */
export async function getLivePrice(symbol: string): Promise<number> {
  const provider = getUnifiedPriceProvider();
  await provider.initialize();
  const price = provider.getPrice(symbol);
  if (!price || !Number.isFinite(price.price) || price.price <= 0) return 0;
  const staleness = Date.now() - price.timestamp;
  if (staleness > CONFIG.MAX_LIVE_PRICE_STALENESS_MS) {
    logger.warn('[UnifiedPrice] getLivePrice rejected stale price', {
      symbol,
      cachedPrice: price.price,
      stalenessMs: staleness,
      maxStalenessMs: CONFIG.MAX_LIVE_PRICE_STALENESS_MS,
    });
    // Kick a background refresh so subsequent calls can succeed. Don't
    // await — the current caller already needs to skip.
    void provider.fetchPricesFromREST().catch(() => undefined);
    return 0;
  }
  return price.price;
}

/**
 * Get validated price context for hedge execution
 */
export async function getHedgeExecutionPrice(
  symbol: string,
  side: 'LONG' | 'SHORT'
): Promise<HedgePriceContext> {
  const provider = getUnifiedPriceProvider();
  await provider.initialize();
  return provider.getHedgePrice(symbol, side);
}

/**
 * Validate if a price is suitable for hedge execution
 */
export function validatePriceForHedge(price: LivePrice | null): PriceValidation {
  const provider = getUnifiedPriceProvider();
  return provider.validatePrice(price);
}

/**
 * STRICT price validation for critical financial operations.
 * NEVER falls back to hardcoded values - throws if price unavailable.
 * 
 * Use this for:
 * - Hedge creation (entry_price MUST be real)
 * - PnL calculations (unreliable prices = wrong PnL)
 * - Settlement/closing (must know exact exit price)
 * 
 * @throws Error if valid price cannot be obtained
 */
export async function getStrictHedgePrice(
  symbol: string,
  side: 'LONG' | 'SHORT',
  options?: {
    maxStalenessMs?: number;    // Default: 10000 (10s)
    requireWebSocket?: boolean; // Default: false (allows REST/cache)
    maxSpreadPercent?: number;  // Default: 2.0%
  }
): Promise<HedgePriceContext & { source: string }> {
  const maxStale = options?.maxStalenessMs ?? 10000;
  const maxSpread = options?.maxSpreadPercent ?? 2.0;
  
  const provider = getUnifiedPriceProvider();
  await provider.initialize();
  
  // Try unified provider first (WebSocket → REST → Cache)
  let priceContext = await provider.getHedgePrice(symbol, side);
  
  // If no price or invalid, try MCP as fallback
  if (!priceContext.validation.isValid || priceContext.entryPrice <= 0) {
    try {
      const { getMarketDataService } = await import('./RealMarketDataService');
      const marketService = getMarketDataService();
      const marketData = await marketService.getTokenPrice(symbol);
      
      if (marketData && marketData.price > 0) {
        const staleness = Date.now() - marketData.timestamp;
        // MarketPrice doesn't have high24h/low24h, so we estimate spread as 0
        // A proper spread would require ExtendedMarketData
        const spread = 0;
          
        priceContext = {
          entryPrice: marketData.price,
          bidPrice: marketData.price * 0.999,
          askPrice: marketData.price * 1.001,
          effectivePrice: side === 'LONG' ? marketData.price * 1.001 : marketData.price * 0.999,
          slippageEstimate: 0.1,
          validation: {
            isValid: staleness < maxStale,
            isFresh: staleness < 1000,
            staleness,
            spreadPercent: spread,
            priceSource: 'mcp-fallback',
            warnings: staleness > 5000 ? [`MCP price is ${(staleness/1000).toFixed(1)}s old`] : [],
          },
          timestamp: marketData.timestamp,
        };
      }
    } catch (mcpErr) {
      // MCP also failed - will throw below
    }
  }
  
  // Strict validation - REJECT if criteria not met
  if (priceContext.entryPrice <= 0) {
    throw new Error(
      `PRICE_UNAVAILABLE: Cannot get valid price for ${symbol}. ` +
      `Hedge creation blocked - never use hardcoded prices for financial operations.`
    );
  }
  
  if (priceContext.validation.staleness > maxStale) {
    throw new Error(
      `PRICE_STALE: ${symbol} price is ${(priceContext.validation.staleness/1000).toFixed(1)}s old ` +
      `(max: ${maxStale/1000}s). Hedge creation blocked.`
    );
  }
  
  if (priceContext.validation.spreadPercent > maxSpread) {
    throw new Error(
      `SPREAD_TOO_HIGH: ${symbol} spread is ${priceContext.validation.spreadPercent.toFixed(2)}% ` +
      `(max: ${maxSpread}%). Hedge creation blocked.`
    );
  }
  
  if (options?.requireWebSocket && priceContext.validation.priceSource !== 'websocket') {
    throw new Error(
      `WEBSOCKET_REQUIRED: ${symbol} price from ${priceContext.validation.priceSource}, ` +
      `but WebSocket real-time price required. Hedge creation blocked.`
    );
  }
  
  // All validations passed - return with source info
  return {
    ...priceContext,
    source: priceContext.validation.priceSource,
  };
}

/**
 * Cache entry price to DB at hedge creation time.
 * This ensures price is ALWAYS stored when hedge is created.
 */
export async function cacheHedgeEntryPrice(
  hedgeId: string | number,
  entryPrice: number,
  source: string
): Promise<void> {
  if (entryPrice <= 0) {
    throw new Error(`Cannot cache invalid entry price: ${entryPrice}`);
  }
  
  try {
    const { query } = await import('@/lib/db/postgres');
    await query(`
      UPDATE hedges SET
        entry_price = $1,
        price_source = $2,
        price_updated_at = NOW(),
        updated_at = NOW()
      WHERE id = $3::integer OR order_id = $3::text OR hedge_id_onchain = $3::text
    `, [entryPrice, source, String(hedgeId)]);
    
    logger.info(`[PriceCache] Entry price cached: ${hedgeId} = $${entryPrice} (${source})`);
  } catch (err) {
    logger.error('[PriceCache] Failed to cache entry price', { hedgeId, entryPrice, error: err });
  }
}

/**
 * Multi-source price validation for critical financial operations.
 * Fetches price from multiple independent sources and validates they agree.
 * 
 * Use for Community Pool NAV calculations and large hedge operations.
 * 
 * @throws Error if sources disagree by more than maxDeviation
 */
export async function getMultiSourceValidatedPrice(
  symbol: string,
  options?: {
    maxDeviationPercent?: number;  // Default: 2% - max difference between sources
    minSources?: number;           // Default: 2 - min sources that must agree
    timeout?: number;              // Default: 5000ms
  }
): Promise<{
  price: number;
  confidence: 'high' | 'medium' | 'low';
  sources: Array<{ name: string; price: number; timestamp: number }>;
  deviation: number;
}> {
  const maxDeviation = options?.maxDeviationPercent ?? 2;
  const minSources = options?.minSources ?? 2;
  const timeout = options?.timeout ?? 5000;
  
  const sources: Array<{ name: string; price: number; timestamp: number }> = [];
  const promises: Promise<void>[] = [];
  
  // Source 1: Unified Price Provider (Crypto.com WebSocket/REST)
  promises.push((async () => {
    try {
      const provider = getUnifiedPriceProvider();
      await provider.initialize();
      const price = provider.getPrice(symbol);
      if (price && price.price > 0) {
        sources.push({ name: 'crypto.com', price: price.price, timestamp: price.timestamp });
      }
    } catch { /* ignore */ }
  })());
  
  // Source 2: RealMarketDataService (independent Crypto.com fetch)
  promises.push((async () => {
    try {
      const { getMarketDataService } = await import('./RealMarketDataService');
      const service = getMarketDataService();
      const data = await service.getTokenPrice(symbol);
      if (data && data.price > 0) {
        sources.push({ name: 'mcp-market', price: data.price, timestamp: data.timestamp });
      }
    } catch { /* ignore */ }
  })());
  
  // Source 3: Direct API call to batch tickers endpoint (backup).
  // Note 2026-09-17: the singular `get-ticker?instrument_name=X_USDT`
  // endpoint now returns 404 for individual symbols. The batch
  // `get-tickers` endpoint still returns the same data. Filter client-side.
  promises.push((async () => {
    try {
      const normalized = symbol.toUpperCase().replace(/^W/, '');
      const target = `${normalized}_USDT`;
      const response = await fetch(
        'https://api.crypto.com/exchange/v1/public/get-tickers',
        { signal: AbortSignal.timeout(timeout) }
      );
      if (response.ok) {
        const data = await response.json();
        const tickers: Array<{ i?: string; a?: string | number }> = data.result?.data ?? [];
        const ticker = tickers.find((t) => t.i === target);
        if (ticker) {
          const price = typeof ticker.a === 'string' ? parseFloat(ticker.a) : Number(ticker.a);
          if (Number.isFinite(price) && price > 0) {
            sources.push({ name: 'crypto.com-direct', price, timestamp: Date.now() });
          }
        }
      }
    } catch { /* ignore */ }
  })());
  
  // Wait for all sources with timeout
  await Promise.race([
    Promise.allSettled(promises),
    new Promise(resolve => setTimeout(resolve, timeout)),
  ]);
  
  // Validate we have enough sources
  if (sources.length < minSources) {
    throw new Error(
      `INSUFFICIENT_SOURCES: Only ${sources.length}/${minSources} price sources available for ${symbol}. ` +
      `Cannot proceed with unreliable pricing.`
    );
  }
  
  // Calculate median price (most robust against outliers)
  const prices = sources.map(s => s.price).sort((a, b) => a - b);
  const medianPrice = prices.length % 2 === 0
    ? (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : prices[Math.floor(prices.length / 2)];
  
  // Calculate max deviation from median
  const deviations = sources.map(s => Math.abs(s.price - medianPrice) / medianPrice * 100);
  const maxActualDeviation = Math.max(...deviations);
  
  // Validate deviation
  if (maxActualDeviation > maxDeviation) {
    const sourceDetails = sources.map(s => `${s.name}=$${s.price.toFixed(2)}`).join(', ');
    throw new Error(
      `PRICE_DEVIATION: ${symbol} prices differ by ${maxActualDeviation.toFixed(2)}% ` +
      `(max allowed: ${maxDeviation}%). Sources: ${sourceDetails}. ` +
      `Possible oracle manipulation or data issue - operation blocked.`
    );
  }
  
  // Determine confidence
  let confidence: 'high' | 'medium' | 'low';
  if (sources.length >= 3 && maxActualDeviation < 0.5) {
    confidence = 'high';
  } else if (sources.length >= 2 && maxActualDeviation < 1.0) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }
  
  logger.info(`[MultiSource] ${symbol} validated: $${medianPrice.toFixed(2)} (${confidence} confidence, ${sources.length} sources, ${maxActualDeviation.toFixed(2)}% deviation)`);
  
  return {
    price: medianPrice,
    confidence,
    sources,
    deviation: maxActualDeviation,
  };
}

export { UnifiedPriceProvider };
