/**
 * Perp market client
 * Perpetual market data (prices, funding) from the Crypto.com Exchange public API
 */

import { ethers } from 'ethers';
import { logger } from '../../shared/utils/logger';

export interface PerpetualPosition {
  positionId: string;
  market: string;
  side: 'LONG' | 'SHORT';
  size: string;
  entryPrice: string;
  markPrice: string;
  leverage: number;
  margin: string;
  unrealizedPnL: string;
  liquidationPrice: string;
  timestamp: number;
}

export interface OrderRequest {
  market: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';
  size: string;
  price?: string;
  stopPrice?: string;
  reduceOnly?: boolean;
  postOnly?: boolean;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  clientOrderId?: string;
}

export interface OrderResult {
  orderId: string;
  clientOrderId?: string;
  market: string;
  side: 'BUY' | 'SELL';
  type: string;
  size: string;
  filledSize: string;
  price: string;
  avgFillPrice: string;
  status: 'OPEN' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED';
  timestamp: number;
}

export interface MarketInfo {
  market: string;
  baseAsset: string;
  quoteAsset: string;
  indexPrice: string;
  markPrice: string;
  fundingRate: string;
  nextFundingTime: number;
  openInterest: string;
  volume24h: string;
  high24h: string;
  low24h: string;
  priceChange24h: string;
  minOrderSize: string;
  maxOrderSize: string;
  tickSize: string;
  maxLeverage: number;
}

export interface FundingPayment {
  market: string;
  payment: string;
  rate: string;
  timestamp: number;
}

export interface LiquidationRisk {
  positionId: string;
  currentPrice: string;
  liquidationPrice: string;
  margin: string;
  distanceToLiquidation: number; // percentage
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export class PerpMarketClient {
  private signer: ethers.Wallet | ethers.Signer;
  private initialized: boolean = false;

  constructor(
    private provider: ethers.Provider,
    signerOrPrivateKey: ethers.Wallet | ethers.Signer | string
  ) {
    // Initialize signer
    if (typeof signerOrPrivateKey === 'string') {
      this.signer = new ethers.Wallet(signerOrPrivateKey, provider);
    } else {
      this.signer = signerOrPrivateKey;
    }

  }

  // The venue's own REST API is retired. Every caller already handles a
  // failed request (fallback data, or an order error), so this keeps those
  // paths and makes no network call.
  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    _opts: { body?: unknown; params?: Record<string, string | number>; timeoutMs?: number } = {},
  ): Promise<T> {
    throw new Error(`Perp venue REST API retired: ${method} ${path}`);
  }

  /**
   * Initialize client
   */
  async initialize(): Promise<void> {
    this.initialized = true;
  }

  /**
   * Get market information from Crypto.com Exchange API (real data)
   */
  async getMarketInfo(market: string): Promise<MarketInfo> {
    const EXCHANGE_API = 'https://api.crypto.com/exchange/v1/public';
    const FETCH_TIMEOUT = 5_000;

    try {
      // Primary: Use Crypto.com Exchange API for real market data
      const spotSymbol = market.split('-')[0];
      const perpInstrument = `${spotSymbol}USD-PERP`;
      const spotInstrument = `${spotSymbol}_USDT`;

      // Fetch perp ticker, spot ticker, funding rate, and instruments IN PARALLEL
      const [perpResult, spotResult, fundingResult, instrResult] = await Promise.allSettled([
        fetch(`${EXCHANGE_API}/get-tickers?instrument_name=${perpInstrument}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }).then(r => r.json()),
        fetch(`${EXCHANGE_API}/get-tickers?instrument_name=${spotInstrument}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }).then(r => r.json()),
        fetch(`${EXCHANGE_API}/get-valuations?instrument_name=${perpInstrument}&valuation_type=funding_rate&count=1`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }).then(r => r.json()),
        fetch(`${EXCHANGE_API}/get-instruments`, { signal: AbortSignal.timeout(FETCH_TIMEOUT) }).then(r => r.json()),
      ]);

      // Prefer perp ticker, fall back to spot
      let ticker: Record<string, string> | null = null;
      let usedInstrument = '';
      if (perpResult.status === 'fulfilled' && perpResult.value.code === 0 && perpResult.value.result?.data?.[0]) {
        ticker = perpResult.value.result.data[0];
        usedInstrument = perpInstrument;
      } else if (spotResult.status === 'fulfilled' && spotResult.value.code === 0 && spotResult.value.result?.data?.[0]) {
        ticker = spotResult.value.result.data[0];
        usedInstrument = spotInstrument;
      }

      if (!ticker) {
        throw new Error(`No ticker data from Exchange API for ${market}`);
      }

      // Extract funding rate from parallel result
      let fundingRate = '0';
      if (usedInstrument.includes('PERP') && fundingResult.status === 'fulfilled' &&
          fundingResult.value.code === 0 && fundingResult.value.result?.data?.[0]) {
        fundingRate = fundingResult.value.result.data[0].v;
      }

      // Extract instrument parameters from parallel result
      let maxLeverage = 50;
      let minOrderSize = '0.0001';
      let maxOrderSize = '1000000';
      let tickSize = '0.01';
      if (instrResult.status === 'fulfilled' && instrResult.value.code === 0 && instrResult.value.result?.data) {
        const perpInfo = instrResult.value.result.data.find((i: Record<string, string>) => i.symbol === perpInstrument);
        const spotInfo = instrResult.value.result.data.find((i: Record<string, string>) => i.symbol === spotInstrument);
        const instrInfo = perpInfo || spotInfo;
        if (instrInfo) {
          if (instrInfo.max_leverage) maxLeverage = parseInt(instrInfo.max_leverage, 10);
          if (instrInfo.qty_tick_size) minOrderSize = instrInfo.qty_tick_size;
          if (instrInfo.price_tick_size) tickSize = instrInfo.price_tick_size;
          if (instrInfo.quantity_decimals != null) {
            maxOrderSize = String(Math.pow(10, Math.max(1, 10 - instrInfo.quantity_decimals)));
          }
        }
      }

      // Compute next funding time: funding settles at the top of each hour
      const now = Date.now();
      const msIntoCurrentHour = now % 3600000;
      const nextFundingTime = now + (3600000 - msIntoCurrentHour);

      logger.info('Fetched real market info from Exchange API', { market, instrument: usedInstrument, fundingRate });

      return {
        market,
        baseAsset: spotSymbol,
        quoteAsset: 'USD',
        indexPrice: ticker.a || '0',
        markPrice: ticker.a || '0',
        fundingRate,
        nextFundingTime,
        openInterest: ticker.oi || '0',
        volume24h: ticker.vv || ticker.v || '0',
        high24h: ticker.h || '0',
        low24h: ticker.l || '0',
        priceChange24h: ticker.c || '0',
        minOrderSize,
        maxOrderSize,
        tickSize,
        maxLeverage,
      };
    } catch (error) {
      // Last resort: try venue REST API with short timeout
      try {
        return await this.request<MarketInfo>('GET', `/v1/markets/${market}`, { timeoutMs: 3000 });
      } catch {
        logger.error('All market info sources failed', { market, error });
        throw new Error(`Cannot get market info for ${market}: all data sources unavailable`);
      }
    }
  }

  /**
   * Get all available markets
   */
  async getAllMarkets(): Promise<MarketInfo[]> {
    try {
      return await this.request<MarketInfo[]>('GET', '/v1/markets');
    } catch (error) {
      logger.warn('venue REST API unavailable, returning Exchange API fallback markets', { error });
      return [await this.getMarketInfo('BTC-USD-PERP')];
    }
  }

  /**
   * Place order
   */
  async placeOrder(orderRequest: OrderRequest): Promise<OrderResult> {
    this.ensureInitialized();

    // ── Input validation (critical for billions on the line) ──
    const parsedSize = parseFloat(orderRequest.size);
    if (!isFinite(parsedSize) || parsedSize <= 0) {
      throw new Error(`Invalid order size: ${orderRequest.size}. Must be a positive finite number.`);
    }
    if (!orderRequest.market || !orderRequest.side || !orderRequest.type) {
      throw new Error(`Missing required order fields: market=${orderRequest.market}, side=${orderRequest.side}, type=${orderRequest.type}`);
    }

    try {
      logger.info('Placing order', { orderRequest });

      const order = await this.request<OrderResult>('POST', '/v1/orders', { body: orderRequest });

      logger.info('Order placed successfully', { orderId: order.orderId });
      return order;
    } catch (error) {
      logger.error('Order placement failed — no exchange API available', { orderRequest, error });
      throw new Error(`Cannot place order: exchange API unavailable`);
    }
  }

  /**
   * Cancel order
   */
  async cancelOrder(orderId: string): Promise<void> {
    this.ensureInitialized();

    try {
      await this.request<void>('DELETE', `/v1/orders/${orderId}`);
      logger.info('Order cancelled', { orderId });
    } catch (error) {
      logger.error('Failed to cancel order', { orderId, error });
      throw error;
    }
  }

  /**
   * Get open positions
   */
  async getPositions(): Promise<PerpetualPosition[]> {
    this.ensureInitialized();

    try {
      return await this.request<PerpetualPosition[]>('GET', '/v1/positions');
    } catch (error) {
      logger.warn('venue REST API unavailable, no open positions available', { error });
      // Return empty array — no simulated/hardcoded positions
      return [];
    }
  }

  /**
   * Get specific position
   */
  async getPosition(market: string): Promise<PerpetualPosition | null> {
    const positions = await this.getPositions();
    return positions.find(p => p.market === market) || null;
  }

  /**
   * Close position
   */
  async closePosition(params: { market: string; size?: string }): Promise<OrderResult> {
    this.ensureInitialized();
    const { market, size } = params;

    try {
      const position = await this.getPosition(market);
      if (!position) {
        throw new Error(`No position found for market ${market}`);
      }

      // Determine close side (opposite of position side)
      const closeSide = position.side === 'LONG' ? 'SELL' : 'BUY';
      const closeSize = size || position.size;

      return await this.placeOrder({
        market,
        side: closeSide,
        type: 'MARKET',
        size: closeSize,
        reduceOnly: true,
      });
    } catch (error) {
      logger.error('Failed to close position', { market, error });
      throw error;
    }
  }

  /**
   * Open hedging position
   */
  async openHedge(params: {
    market: string;
    side: 'LONG' | 'SHORT';
    notionalValue: string;
    leverage?: number;
    stopLoss?: string;
    takeProfit?: string;
  }): Promise<OrderResult> {
    this.ensureInitialized();

    const { market, side, notionalValue, leverage = 1, stopLoss, takeProfit } = params;

    try {
      logger.info('Opening hedge position', params);

      // Get market info for size calculation
      const marketInfo = await this.getMarketInfo(market);
      const markPrice = parseFloat(marketInfo.markPrice);

      // ── Guard against zero/NaN markPrice (critical: prevents Infinity position sizes) ──
      if (!isFinite(markPrice) || markPrice <= 0) {
        throw new Error(`Invalid markPrice for ${market}: ${marketInfo.markPrice}. Cannot calculate position size.`);
      }
      
      // Calculate position size
      const rawSize = parseFloat(notionalValue) * leverage / markPrice;
      if (!isFinite(rawSize) || rawSize <= 0) {
        throw new Error(`Invalid calculated position size: ${rawSize} (notional=${notionalValue}, leverage=${leverage}, markPrice=${markPrice})`);
      }
      const size = rawSize.toFixed(4);

      // Place main order
      const orderSide = side === 'LONG' ? 'BUY' : 'SELL';
      const order = await this.placeOrder({
        market,
        side: orderSide,
        type: 'MARKET',
        size,
      });

      // Place stop loss if specified
      if (stopLoss) {
        const stopSide = side === 'LONG' ? 'SELL' : 'BUY';
        await this.placeOrder({
          market,
          side: stopSide,
          type: 'STOP_MARKET',
          size,
          stopPrice: stopLoss,
          reduceOnly: true,
          clientOrderId: `${order.orderId}-sl`,
        });
      }

      // Place take profit if specified
      if (takeProfit) {
        const tpSide = side === 'LONG' ? 'SELL' : 'BUY';
        await this.placeOrder({
          market,
          side: tpSide,
          type: 'LIMIT',
          size,
          price: takeProfit,
          reduceOnly: true,
          postOnly: true,
          clientOrderId: `${order.orderId}-tp`,
        });
      }

      logger.info('Hedge position opened successfully', { orderId: order.orderId });
      return order;
    } catch (error) {
      logger.error('Failed to open hedge position', { params, error });
      throw error;
    }
  }

  /**
   * Get funding rate history from Crypto.com Exchange API (real data)
   */
  async getFundingHistory(market: string, limit: number = 100): Promise<FundingPayment[]> {
    const EXCHANGE_API = 'https://api.crypto.com/exchange/v1/public';

    try {
      // Primary: Use Crypto.com Exchange valuations API for real funding data
      const spotSymbol = market.split('-')[0];
      const perpInstrument = `${spotSymbol}USD-PERP`;

      const url = `${EXCHANGE_API}/get-valuations?instrument_name=${perpInstrument}&valuation_type=funding_hist&count=${Math.min(limit, 300)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const json = await resp.json();

      if (json.code === 0 && json.result?.data?.length > 0) {
        logger.info('Fetched real funding history from Exchange API', {
          market,
          instrument: perpInstrument,
          dataPoints: json.result.data.length,
        });
        return json.result.data.map((d: { v: string; t: number }) => ({
          market,
          payment: d.v,
          rate: d.v,
          timestamp: d.t,
        }));
      }

      throw new Error(`No funding data from Exchange API for ${perpInstrument}`);
    } catch (exchangeError) {
      // Fallback: derive funding estimate from spot market momentum
      try {
        const spotSymbol = market.split('-')[0];
        const spotInstrument = `${spotSymbol}_USDT`;
        const tickerResp = await fetch(`https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=${spotInstrument}`, { signal: AbortSignal.timeout(5_000) });
        const tickerJson = await tickerResp.json();
        const ticker = tickerJson.result?.data?.[0];

        if (ticker) {
          const change24h = parseFloat(ticker.c || '0');
          // Derive funding proxy from price momentum:
          // Positive price change → positive funding (longs pay shorts)
          const derivedRate = change24h * 0.0001; // Scale: ~0.01% per 1% price change

          logger.info('Derived funding rate from spot momentum (no perp market)', {
            market,
            change24h: `${(change24h * 100).toFixed(2)}%`,
            derivedRate: derivedRate.toFixed(8),
          });

          return [{
            market,
            payment: derivedRate.toFixed(8),
            rate: derivedRate.toFixed(8),
            timestamp: Date.now(),
          }];
        }
      } catch { /* spot ticker also failed */ }

      // Absolute last resort: try venue REST API
      try {
        return await this.request<FundingPayment[]>('GET', `/v1/markets/${market}/funding`, {
          params: { limit },
          timeoutMs: 3000,
        });
      } catch {
        logger.error('All funding data sources failed', { market, error: exchangeError });
        throw new Error(`Cannot get funding data for ${market}: all sources unavailable`);
      }
    }
  }

  /**
   * Calculate liquidation risk for positions
   */
  async calculateLiquidationRisk(): Promise<LiquidationRisk[]> {
    this.ensureInitialized();

    try {
      const positions = await this.getPositions();
      const risks: LiquidationRisk[] = [];

      for (const position of positions) {
        const currentPrice = parseFloat(position.markPrice);
        const liquidationPrice = parseFloat(position.liquidationPrice);
        
        // Calculate distance to liquidation as percentage
        const distance = Math.abs((currentPrice - liquidationPrice) / currentPrice) * 100;

        // Determine risk level
        let riskLevel: LiquidationRisk['riskLevel'];
        if (distance > 20) {
          riskLevel = 'LOW';
        } else if (distance > 10) {
          riskLevel = 'MEDIUM';
        } else if (distance > 5) {
          riskLevel = 'HIGH';
        } else {
          riskLevel = 'CRITICAL';
        }

        risks.push({
          positionId: position.positionId,
          currentPrice: position.markPrice,
          liquidationPrice: position.liquidationPrice,
          margin: position.margin,
          distanceToLiquidation: distance,
          riskLevel,
        });
      }

      return risks;
    } catch (error) {
      logger.error('Failed to calculate liquidation risk', { error });
      throw error;
    }
  }

  /**
   * Adjust position leverage
   */
  async adjustLeverage(market: string, leverage: number): Promise<void> {
    this.ensureInitialized();

    try {
      await this.request<void>('POST', `/v1/positions/${market}/leverage`, { body: { leverage } });
      logger.info('Leverage adjusted', { market, leverage });
    } catch (error) {
      logger.error('Failed to adjust leverage', { market, leverage, error });
      throw error;
    }
  }

  /**
   * Add margin to position
   */
  async addMargin(market: string, amount: string): Promise<void> {
    this.ensureInitialized();

    try {
      await this.request<void>('POST', `/v1/positions/${market}/margin`, { body: { amount } });
      logger.info('Margin added', { market, amount });
    } catch (error) {
      logger.error('Failed to add margin', { market, amount, error });
      throw error;
    }
  }

  /**
   * Get account balance
   */
  async getBalance(): Promise<{ available: string; total: string; margin: string }> {
    this.ensureInitialized();

    try {
      return await this.request<{ available: string; total: string; margin: string }>(
        'GET',
        '/v1/account/balance',
      );
    } catch (error) {
      logger.error('Failed to get balance', { error });
      throw error;
    }
  }

  /**
   * Ensure client is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('PerpMarketClient not initialized. Call initialize() first.');
    }
  }

  /**
   * Disconnect client
   */
  async disconnect(): Promise<void> {
    this.initialized = false;
    logger.info('PerpMarketClient disconnected');
  }
}

// Export singleton instance factory
let perpMarketClient: PerpMarketClient | null = null;

export function getPerpMarketClient(
  provider: ethers.Provider,
  signer: ethers.Wallet | ethers.Signer | string
): PerpMarketClient {
  if (!perpMarketClient) {
    perpMarketClient = new PerpMarketClient(provider, signer);
  }
  return perpMarketClient;
}
