/**
 * Price Monitor Agent
 *
 * REAL autonomous agent that monitors cryptocurrency prices and triggers alerts/actions.
 * Emits `hedge_initiated` events to subscribers; actual hedge execution happens
 * downstream via HedgingAgent + BluefinService — this agent is observation-only.
 */

import { logger } from '../../lib/utils/logger';
import type { FiveMinBTCSignal, SignalEvent } from '../../lib/services/market-data/Polymarket5MinService';
import type { MarketSnapshot } from '../../lib/services/hedging/CentralizedHedgeManager';

// Price thresholds for different alert levels
export interface PriceAlert {
  id: string;
  symbol: string;
  type: 'above' | 'below' | 'change_percent';
  threshold: number;
  action: 'alert' | 'hedge' | 'rebalance';
  active: boolean;
  lastTriggered?: number;
  createdAt: number;
}

export interface PriceData {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  timestamp: number;
  source: string;
}

export interface MonitorConfig {
  pollingIntervalMs: number;
  alertWebhookUrl?: string;
}

/**
 * Crypto.com ticker URL for an asset symbol. Universe is composed at fetch
 * time from `resolveAgentUniverse()` (pool + trader + dynamic Polymarket)
 * — no hardcoded per-asset entries in this file.
 */
const cryptoComTickerUrl = (symbol: string): string =>
  `https://api.crypto.com/v2/public/get-ticker?instrument_name=${symbol}_USDT`;

/**
 * PriceMonitorAgent - Autonomous price monitoring.
 */
export class PriceMonitorAgent {
  private alerts: Map<string, PriceAlert> = new Map();
  private priceHistory: Map<string, PriceData[]> = new Map();
  private isRunning: boolean = false;
  private pollingInterval: NodeJS.Timeout | null = null;
  private config: MonitorConfig;
  private subscribers: Set<(event: MonitorEvent) => void> = new Set();

  // ── Proactive 5-min signal (pushed by ticker) ──────────
  private cachedFiveMinSignal: FiveMinBTCSignal | null = null;
  private fiveMinUnsubscribers: (() => void)[] = [];

  // ── Centralized market snapshot (pushed by CentralizedHedgeManager) ──────
  private centralizedSnapshot: MarketSnapshot | null = null;

  constructor(config: Partial<MonitorConfig> = {}) {
    this.config = {
      pollingIntervalMs: config.pollingIntervalMs || 10000, // 10 seconds default
      alertWebhookUrl: config.alertWebhookUrl,
    };
    logger.info('PriceMonitorAgent initialized', { config: this.config });
  }

  /**
   * Start the autonomous monitoring loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Price monitor already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting price monitor agent');
    this.emit({ type: 'agent_started', timestamp: Date.now() });

    // Subscribe to the proactive 5-min signal ticker — always fresh, zero fetch delay
    try {
      const { Polymarket5MinService } = await import('../../lib/services/market-data/Polymarket5MinService');
      this.fiveMinUnsubscribers.push(
        Polymarket5MinService.on('signal:update', (evt: SignalEvent) => {
          this.cachedFiveMinSignal = evt.signal;
        }),
        Polymarket5MinService.on('signal:strong-alert', (evt: SignalEvent) => {
          // Immediately process strong signals — don't wait for next poll
          const btcPrice = this.priceHistory.get('BTC')?.at(-1) ?? null;
          this.handleFiveMinSignal(evt.signal, btcPrice);
        }),
      );
      this.cachedFiveMinSignal = await Polymarket5MinService.getLatest5MinSignal();
      logger.info('PriceMonitorAgent subscribed to 5-min signal ticker');
    } catch {
      logger.debug('PriceMonitorAgent: 5-min signal ticker unavailable');
    }

    // Initial price fetch
    await this.fetchAllPrices();

    // Start polling loop
    this.pollingInterval = setInterval(async () => {
      try {
        await this.monitoringLoop();
      } catch (error) {
        logger.error('Monitoring loop error', { error });
        this.emit({ type: 'error', error: String(error), timestamp: Date.now() });
      }
    }, this.config.pollingIntervalMs);
  }

  /**
   * Stop the monitoring agent
   */
  stop(): void {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    // Unsubscribe from 5-min signal ticker
    for (const unsub of this.fiveMinUnsubscribers) unsub();
    this.fiveMinUnsubscribers = [];
    this.cachedFiveMinSignal = null;
    // Clear centralized snapshot to prevent stale data after restart
    this.centralizedSnapshot = null;
    logger.info('Price monitor agent stopped');
    this.emit({ type: 'agent_stopped', timestamp: Date.now() });
  }

  /**
   * One-shot monitoring tick for serverless callers.
   *
   * The setInterval-driven monitoringLoop dies the moment the Lambda
   * suspends, so the autonomous LeadAgent cycle (every 30min) calls
   * this directly to get the same work done without a persistent loop.
   * Returns a structured summary instead of relying on event emission.
   */
  async tick(): Promise<{
    pricesFetched: number;
    alertsChecked: number;
    alertsTriggered: number;
    fiveMinProcessed: boolean;
    symbols: string[];
  }> {
    // Ensure we have a fresh 5-min signal cache even when start() never ran
    // (serverless: PriceMonitorAgent.start() launches the long-running loop
    // that subscribes to the ticker; if the loop never started or already
    // suspended, the cached signal is stale).
    if (!this.cachedFiveMinSignal) {
      try {
        const { Polymarket5MinService } = await import('../../lib/services/market-data/Polymarket5MinService');
        this.cachedFiveMinSignal = await Polymarket5MinService.getLatest5MinSignal();
      } catch { /* best-effort */ }
    }

    const prices = await this.fetchAllPrices();

    let alertsChecked = 0;
    let alertsTriggered = 0;
    const alertedSymbols = new Set<string>();
    for (const alert of this.alerts.values()) {
      if (!alert.active) continue;
      const priceData = prices.get(alert.symbol);
      if (!priceData) continue;
      alertsChecked++;
      if (this.checkAlertCondition(alert, priceData)) {
        alertsTriggered++;
        alertedSymbols.add(String(alert.symbol).toUpperCase());
        await this.handleAlertTriggered(alert, priceData);
      }
    }

    let fiveMinProcessed = false;
    const fiveMinSignal = this.cachedFiveMinSignal;
    if (fiveMinSignal && fiveMinSignal.signalStrength === 'STRONG') {
      const btcPrice = prices.get('BTC') || null;
      await this.handleFiveMinSignal(fiveMinSignal, btcPrice);
      fiveMinProcessed = true;
    }

    this.emit({
      type: 'price_update',
      prices: Object.fromEntries(prices),
      timestamp: Date.now(),
    });

    return {
      pricesFetched: prices.size,
      alertsChecked,
      alertsTriggered,
      fiveMinProcessed,
      // Only the symbols that actually crossed a threshold this tick.
      // Callers (e.g. agent-trade-guard) treat this as the block-list;
      // returning all monitored symbols here would gate every asset any
      // time a single alert fires anywhere.
      symbols: Array.from(alertedSymbols),
    };
  }

  /**
   * Main monitoring loop - runs every polling interval
   */
  private async monitoringLoop(): Promise<void> {
    // Fetch latest prices
    const prices = await this.fetchAllPrices();

    // Check all alerts
    for (const alert of this.alerts.values()) {
      if (!alert.active) continue;

      const priceData = prices.get(alert.symbol);
      if (!priceData) continue;

      const triggered = this.checkAlertCondition(alert, priceData);
      if (triggered) {
        await this.handleAlertTriggered(alert, priceData);
      }
    }

    // ⚡ 5-min signal from ticker (no fetch — already cached and fresh)
    const fiveMinSignal = this.cachedFiveMinSignal;
    if (fiveMinSignal && fiveMinSignal.signalStrength === 'STRONG') {
      const btcPrice = prices.get('BTC') || null;
      this.handleFiveMinSignal(fiveMinSignal, btcPrice);
    }

    // Emit price update event
    this.emit({
      type: 'price_update',
      prices: Object.fromEntries(prices),
      timestamp: Date.now(),
    });
  }

  /**
   * Process a STRONG 5-min signal — emit event + auto-hedge on STRONG DOWN.
   * Called both from the monitoring loop and from the ticker's strong-alert event.
   */
  private async handleFiveMinSignal(signal: FiveMinBTCSignal, btcPrice: PriceData | null): Promise<void> {
    // Emit a special 5-min signal event that the dashboard can subscribe to
    this.emit({
      type: 'five_min_signal',
      signal,
      price: btcPrice,
      timestamp: Date.now(),
    } as MonitorEvent);

    // Auto-trigger hedge alert if signal is STRONG DOWN
    if (signal.recommendation === 'HEDGE_SHORT' && btcPrice) {
      logger.info('⚡ 5-Min STRONG DOWN signal — triggering auto-hedge alert', {
        direction: signal.direction,
        probability: signal.probability,
        confidence: signal.confidence,
        btcPrice: btcPrice.price,
      });
      
      await this.handleAlertTriggered(
        {
          id: `5min-auto-${Date.now()}`,
          symbol: 'BTC',
          type: 'change_percent',
          threshold: 0,
          action: 'hedge',
          active: true,
          createdAt: Date.now(),
        },
        btcPrice
      );
    }
  }

  /**
   * Ingest centralized market prices from CentralizedHedgeManager.
   * When a fresh snapshot is available, the agent uses it instead of
   * independently calling the Crypto.com API — eliminating redundant fetches.
   */
  ingestCentralizedPrices(snapshot: MarketSnapshot): void {
    this.centralizedSnapshot = snapshot;

    // Convert snapshot into PriceData and store in history — no per-symbol
    // filter: any asset the centralized manager sends is worth remembering.
    // The read paths (getPriceHistory, alerts) key by symbol so unwanted
    // entries are inert.
    for (const [symbol, assetPrice] of snapshot.prices) {

      const priceData: PriceData = {
        symbol,
        price: assetPrice.price,
        change24h: assetPrice.change24h,
        volume24h: assetPrice.volume24h,
        timestamp: snapshot.timestamp,
        source: `centralized:${snapshot.source}`,
      };

      const history = this.priceHistory.get(symbol) || [];
      history.push(priceData);
      if (history.length > 1000) history.shift();
      this.priceHistory.set(symbol, history);
    }

    logger.debug('[PriceMonitor] Ingested centralized snapshot', {
      symbols: snapshot.prices.size,
      age: Date.now() - snapshot.timestamp,
    });
  }

  /**
   * Fetch prices from all configured feeds.
   * Uses centralized snapshot if fresh (< 15s), otherwise falls back to independent fetch.
   */
  private async fetchAllPrices(): Promise<Map<string, PriceData>> {
    // Use centralized snapshot if fresh
    if (this.centralizedSnapshot && (Date.now() - this.centralizedSnapshot.timestamp) < 15_000) {
      const prices = new Map<string, PriceData>();
      for (const [symbol, assetPrice] of this.centralizedSnapshot.prices) {
        prices.set(symbol, {
          symbol,
          price: assetPrice.price,
          change24h: assetPrice.change24h,
          volume24h: assetPrice.volume24h,
          timestamp: this.centralizedSnapshot.timestamp,
          source: `centralized:${this.centralizedSnapshot.source}`,
        });
      }
      logger.debug('[PriceMonitor] Using centralized snapshot prices', { symbols: prices.size });
      return prices;
    }

    // Fallback: independent fetch across the composed agent universe
    // (pool + trader + dynamic Polymarket).
    const prices = new Map<string, PriceData>();
    const { resolveAgentUniverse } = await import('@/lib/config/agent-universe');
    const symbols = await resolveAgentUniverse();

    for (const symbol of symbols) {
      try {
        const priceData = await this.fetchPrice(symbol, cryptoComTickerUrl(symbol));
        if (priceData) {
          prices.set(symbol, priceData);

          // Store in history
          const history = this.priceHistory.get(symbol) || [];
          history.push(priceData);
          // Keep last 1000 data points
          if (history.length > 1000) history.shift();
          this.priceHistory.set(symbol, history);
        }
      } catch (error) {
        logger.error(`Failed to fetch ${symbol} price`, { error });
      }
    }

    return prices;
  }

  /**
   * Fetch single price from Crypto.com API with fallback to RealMarketDataService
   */
  private async fetchPrice(symbol: string, url: string): Promise<PriceData | null> {
    // Try primary Crypto.com API first
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      
      // Crypto.com /v2/public/get-ticker now returns result.data as an
      // ARRAY (the underlying endpoint is get-tickers in disguise).
      // Tolerate both shapes — older single-object form and the current
      // array form — so we don't silently fall back to 0 prices.
      const ticker = Array.isArray(data.result?.data)
        ? data.result.data[0]
        : data.result?.data;
      if (ticker) {
        // `c` on v2 is daily-change-PERCENT-as-decimal (e.g. 0.0049 = 0.49%).
        // Convert to percent for downstream change24h consumers.
        const changePctRaw = parseFloat(ticker.c || '0');
        return {
          symbol,
          price: parseFloat(ticker.a || ticker.k) || 0,
          change24h: Number.isFinite(changePctRaw) ? changePctRaw * 100 : 0,
          volume24h: parseFloat(ticker.v || '0') || 0,
          timestamp: Date.now(),
          source: 'crypto.com',
        };
      }

      throw new Error('Invalid API response format');
    } catch (primaryError) {
      logger.warn(`Primary Crypto.com API failed for ${symbol}, trying RealMarketDataService`, { error: primaryError });
      
      // Fallback to RealMarketDataService which uses Crypto.com Exchange API
      try {
        const { getMarketDataService } = await import('../../lib/services/market-data/RealMarketDataService');
        const marketDataService = getMarketDataService();
        const marketData = await marketDataService.getTokenPrice(symbol);
        
        return {
          symbol,
          price: marketData.price,
          change24h: marketData.change24h || 0,
          volume24h: marketData.volume24h || 0,
          timestamp: Date.now(),
          source: marketData.source || 'cryptocom-exchange',
        };
      } catch (fallbackError) {
        logger.error(`All price sources failed for ${symbol}`, { primaryError, fallbackError });
        // Return null instead of mock data - let caller handle missing price
        return null;
      }
    }
  }

  /**
   * Check if alert condition is met
   */
  private checkAlertCondition(alert: PriceAlert, price: PriceData): boolean {
    switch (alert.type) {
      case 'above':
        return price.price > alert.threshold;
      case 'below':
        return price.price < alert.threshold;
      case 'change_percent':
        return Math.abs(price.change24h) > alert.threshold;
      default:
        return false;
    }
  }

  /**
   * Handle triggered alert - execute action
   */
  private async handleAlertTriggered(alert: PriceAlert, price: PriceData): Promise<void> {
    // Cooldown: don't trigger same alert within 5 minutes
    if (alert.lastTriggered && Date.now() - alert.lastTriggered < 300000) {
      return;
    }

    alert.lastTriggered = Date.now();
    this.alerts.set(alert.id, alert);

    logger.info('Alert triggered', { alert, price });
    this.emit({
      type: 'alert_triggered',
      alert,
      price,
      timestamp: Date.now(),
    });

    // Execute action
    switch (alert.action) {
      case 'hedge':
        await this.executeHedgeAction(alert, price);
        break;
      case 'rebalance':
        await this.executeRebalanceAction(alert, price);
        break;
      case 'alert':
      default:
        // Just emit notification
        break;
    }
  }

  /**
   * Emit a hedge-initiated event for downstream subscribers (HedgingAgent,
   * webhook consumers). Observation-only — this agent does not open trades
   * directly.
   */
  private async executeHedgeAction(alert: PriceAlert, price: PriceData): Promise<void> {
    this.emit({
      type: 'hedge_initiated',
      alert,
      price,
      timestamp: Date.now(),
    });
    logger.info('Hedge alert emitted', { symbol: alert.symbol, price: price.price });
  }

  /**
   * Execute rebalance action
   */
  private async executeRebalanceAction(alert: PriceAlert, price: PriceData): Promise<void> {
    logger.info('Rebalance action triggered', { alert, price });
    this.emit({
      type: 'rebalance_initiated',
      alert,
      price,
      timestamp: Date.now(),
    });
  }

  /**
   * Add a price alert
   */
  addAlert(alert: Omit<PriceAlert, 'id' | 'createdAt'>): string {
    const { generateSecureId } = require('@shared/utils/crypto-id');
    const id = generateSecureId('alert');
    const fullAlert: PriceAlert = {
      ...alert,
      id,
      createdAt: Date.now(),
    };
    this.alerts.set(id, fullAlert);
    logger.info('Alert added', { alert: fullAlert });
    return id;
  }

  /**
   * Remove a price alert
   */
  removeAlert(id: string): boolean {
    return this.alerts.delete(id);
  }

  /**
   * Get all alerts
   */
  getAlerts(): PriceAlert[] {
    return Array.from(this.alerts.values());
  }

  /**
   * Get price history for a symbol
   */
  getPriceHistory(symbol: string, limit: number = 100): PriceData[] {
    const history = this.priceHistory.get(symbol) || [];
    return history.slice(-limit);
  }

  /**
   * Get current price for a symbol
   */
  getCurrentPrice(symbol: string): PriceData | undefined {
    const history = this.priceHistory.get(symbol);
    return history?.[history.length - 1];
  }

  /**
   * Subscribe to monitor events
   */
  subscribe(callback: (event: MonitorEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /**
   * Emit event to all subscribers
   */
  private emit(event: MonitorEvent): void {
    this.subscribers.forEach(callback => {
      try {
        callback(event);
      } catch (error) {
        logger.error('Subscriber error', { error });
      }
    });
  }

  /**
   * Get agent status
   */
  getStatus(): AgentStatus {
    // Tracked symbols reflect the priceHistory keys populated by the most
    // recent tick — that's the live universe, not a hardcoded declaration.
    return {
      isRunning: this.isRunning,
      alertCount: this.alerts.size,
      trackedSymbols: Array.from(this.priceHistory.keys()),
      pollingIntervalMs: this.config.pollingIntervalMs,
    };
  }
}

// Event types
export type MonitorEvent =
  | { type: 'agent_started'; timestamp: number }
  | { type: 'agent_stopped'; timestamp: number }
  | { type: 'price_update'; prices: Record<string, PriceData>; timestamp: number }
  | { type: 'alert_triggered'; alert: PriceAlert; price: PriceData; timestamp: number }
  | { type: 'hedge_initiated'; alert: PriceAlert; price: PriceData; timestamp: number }
  | { type: 'rebalance_initiated'; alert: PriceAlert; price: PriceData; timestamp: number }
  | { type: 'five_min_signal'; signal: import('../../lib/services/market-data/Polymarket5MinService').FiveMinBTCSignal; price: PriceData | null; timestamp: number }
  | { type: 'error'; error: string; timestamp: number };

export interface AgentStatus {
  isRunning: boolean;
  alertCount: number;
  trackedSymbols: string[];
  pollingIntervalMs: number;
}

// NOTE: Do NOT export a module-level singleton here.
// The orchestrator creates and manages the PriceMonitorAgent instance.
// A rogue singleton would bypass centralized price sharing.
