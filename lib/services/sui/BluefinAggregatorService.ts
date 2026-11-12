/**
 * BlueFin 7k Aggregator Service — Multi-DEX Swap Routing for SUI
 *
 * Uses @bluefin-exchange/bluefin7k-aggregator-sdk to route USDC swaps across
 * multiple DEXs (BlueFin, Cetus, DeepBook, Turbos, FlowX, Aftermath, etc.)
 * for optimal pricing when rebalancing the 4-asset SUI community pool.
 *
 * Pool Assets: BTC (wBTC), ETH (wETH), SUI, CRO
 * Deposit Token: USDC on SUI
 *
 * This service is used by:
 * - QStash cron (/api/cron/sui-community-pool) for AI-driven rebalancing
 * - API routes for swap quotes
 *
 * @see https://www.npmjs.com/package/@bluefin-exchange/bluefin7k-aggregator-sdk
 */

import { logger } from '@/lib/utils/logger';
import { normalizePriceImpact } from '@/lib/services/sui/bluefin-order-size';
import {
  Config as BluefinConfig,
  getQuote as bluefinGetQuote,
  buildTx as bluefinBuildTx,
  isSuiTransaction,
  DEFAULT_SOURCES as SDK_DEFAULT_SOURCES,
  type SourceDex,
} from '@bluefin-exchange/bluefin7k-aggregator-sdk';
import {
  initQuoteCache,
  stopQuoteCache,
  getQuoteCacheKey,
  getCachedQuote,
  setCachedQuote,
} from '@/lib/services/sui/bluefin/quote-cache';

// STEAMM banks + springsui routes silently deliver $0 on-chain despite
// non-zero quotes — 2026-08-08 bleed root cause. SDK's own buildTx.js
// comment: "STEAMM banks, dynamic fields can shift between simulation
// and execution". Filtering costs ~0.1-0.6% of quoted output but kills
// the silent-zero pattern; override with AGG_INCLUDE_RISKY_SOURCES=1.
const RISKY_SOURCES = new Set<SourceDex>([
  'steamm', 'steamm_oracle_quoter', 'steamm_oracle_quoter_v2', 'springsui',
]);
const SAFE_QUOTE_SOURCES: SourceDex[] = SDK_DEFAULT_SOURCES.filter((s) => !RISKY_SOURCES.has(s));
function quoteSources(): SourceDex[] | undefined {
  return (process.env.AGG_INCLUDE_RISKY_SOURCES || '').trim() === '1'
    ? undefined
    : SAFE_QUOTE_SOURCES;
}

// Kept as a thin alias for callers importing the old name.
export const stopQuoteCacheCleanup = stopQuoteCache;

// Dynamic imports for SUI SDK (avoids type conflicts at module level)
async function getSuiSdk() {
  const { Ed25519Keypair } = await import('@mysten/sui/keypairs/ed25519');
  const { Transaction } = await import('@mysten/sui/transactions');
  const { SuiClient, getFullnodeUrl } = await import('@mysten/sui/client');
  return { Ed25519Keypair, Transaction, SuiClient, getFullnodeUrl };
}

// Re-export all types and configs from the dedicated types module
export {
  SUI_COIN_TYPES,
  ASSET_DECIMALS,
  ASSET_TO_COIN_KEY,
  MAINNET_COIN_TYPES,
  MAX_SWAP_SIZE_USD,
  MAX_SLIPPAGE,
  GAS_BUDGET,
  MIN_GAS_RESERVE_MIST,
  type NetworkType,
  type PoolAsset,
  type SwapQuoteResult,
  type RebalanceSwapPlan,
  type SwapExecutionResult,
} from '@/lib/types/bluefin-types';

import {
  SUI_COIN_TYPES,
  ASSET_DECIMALS,
  ASSET_TO_COIN_KEY,
  MAINNET_COIN_TYPES,
  MAX_SWAP_SIZE_USD,
  MAX_SLIPPAGE,
  GAS_BUDGET,
  MIN_GAS_RESERVE_MIST,
  type NetworkType,
  type PoolAsset,
  type SwapQuoteResult,
  type RebalanceSwapPlan,
  type SwapExecutionResult,
} from '@/lib/types/bluefin-types';

// ============================================
// BLUEFIN 7K AGGREGATOR SERVICE
// ============================================
// Quote cache extracted to ./bluefin/quote-cache.ts (2026-08-30)

export class BluefinAggregatorService {
  private network: NetworkType;
  private coinTypes: Record<string, string>;
  private suiClient: any | null = null;

  constructor(network: NetworkType = 'mainnet') {
    this.network = network;
    this.coinTypes = SUI_COIN_TYPES[network] || SUI_COIN_TYPES.mainnet;

    initQuoteCache();
    logger.info('[BluefinAggregator] Initialized', { network });
  }

  /**
   * Ensure the global BlueFin SDK config has a SUI client set.
   * Required before calling buildTx() (for on-chain swap construction).
   */
  private async ensureSuiClient(): Promise<any> {
    if (this.suiClient) {
      BluefinConfig.setSuiClient(this.suiClient);
      return this.suiClient;
    }

    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
    const { suiGrpcUrl } = await import('@/lib/services/sui/sui-grpc-bridge');
    this.suiClient = createFailoverSuiClient(this.network);
    const rpcUrl = suiGrpcUrl(this.network);

    // H3: Verify RPC is reachable before using it for swaps (with timeout)
    try {
      const healthCheck = this.suiClient.getChainIdentifier();
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('RPC health check timed out after 8s')), 8000)
      );
      await Promise.race([healthCheck, timeout]);
      logger.info('[BluefinAggregator] RPC health check passed', {
        rpcUrl: rpcUrl.replace(/\/\/.*@/, '//***@'),
      });
    } catch (rpcErr) {
      this.suiClient = null;
      throw new Error(
        `SUI RPC health check failed (${rpcUrl}): ${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)}`
      );
    }

    BluefinConfig.setSuiClient(this.suiClient);

    // Set up Pyth oracle client for oracle-based DEX routing
    try {
      const { SuiPythClient, SuiPriceServiceConnection } = await import('@pythnetwork/pyth-sui-js');
      const pythClient = new SuiPythClient(
        this.suiClient,
        '0x1f9310238ee9298fb703c3419030b35b22bb1cc37113e3bb5007c99aec79e5b8',
        '0xaeab97b96cf236ad2c9be2cff9aafea9783ee88e93e46f246ed3fa2bae0a8e17'
      );
      const pythConnection = new SuiPriceServiceConnection('https://hermes.pyth.network');
      BluefinConfig.setPythClient(pythClient);
      BluefinConfig.setPythConnection(pythConnection);
    } catch {
      // Oracle-based DEX sources may be unavailable — standard DEXs still work
    }

    return this.suiClient;
  }

  /**
   * Estimate expected output from market price when DEX has no liquidity.
   * Used on testnet or when aggregator returns 0.
   */
  private async estimateOutputFromPrice(
    asset: PoolAsset,
    usdcAmount: number
  ): Promise<{ estimatedOut: string; price: number } | null> {
    try {
      // Dynamic import to avoid circular dependency
      const { getMarketDataService } =
        await import('@/lib/services/market-data/RealMarketDataService');
      const mds = getMarketDataService();
      const data = await mds.getTokenPrice(asset);
      if (!data.price || data.price <= 0) return null;

      const coinKey = ASSET_TO_COIN_KEY[asset];
      const decimals = ASSET_DECIMALS[coinKey] || ASSET_DECIMALS[asset] || 8;
      const assetAmount = usdcAmount / data.price;
      const rawAmount = Math.floor(assetAmount * Math.pow(10, decimals));

      return { estimatedOut: rawAmount.toString(), price: data.price };
    } catch {
      return null;
    }
  }

  /**
   * Get a real DEX swap quote from BlueFin 7k mainnet aggregator for price discovery.
   * Uses mainnet coin types to get accurate pricing from real liquidity pools,
   * even when running on testnet.
   */
  private async getMainnetPriceQuote(
    asset: PoolAsset,
    usdcAmount: number
  ): Promise<{ estimatedOut: string; price: number; route: string } | null> {
    const coinKey = ASSET_TO_COIN_KEY[asset];
    const toCoinType = MAINNET_COIN_TYPES[coinKey] || '';
    const fromCoinType = MAINNET_COIN_TYPES.USDC;

    if (!toCoinType) return null;

    try {
      const amountInRaw = Math.floor(usdcAmount * 1e6).toString();
      const quoteResponse = await bluefinGetQuote({
        tokenIn: fromCoinType,
        tokenOut: toCoinType,
        amountIn: amountInRaw,
        sources: quoteSources(),
      });

      if (!quoteResponse || quoteResponse.returnAmount === '0') return null;

      const expectedOut = quoteResponse.returnAmount;
      const routes = quoteResponse.routes || [];
      const routeDesc =
        routes.length > 0
          ? routes.map((r) => r.hops.map((h) => h.pool.type).join('→')).join(', ')
          : 'BlueFin7k';

      // Derive price from DEX output
      const decimals = ASSET_DECIMALS[coinKey] || ASSET_DECIMALS[asset] || 8;
      const assetAmount = Number(expectedOut) / Math.pow(10, decimals);
      const effectivePrice = assetAmount > 0 ? usdcAmount / assetAmount : 0;

      logger.info(`[BluefinAggregator] Mainnet price quote for ${asset}`, {
        usdcAmount,
        expectedOut,
        effectivePrice: effectivePrice.toFixed(2),
        route: routeDesc,
      });

      return { estimatedOut: expectedOut, price: effectivePrice, route: routeDesc };
    } catch (err) {
      logger.debug(`[BluefinAggregator] Mainnet price query failed for ${asset}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ============================================
  // SWAP QUOTES
  // ============================================

  /**
   * Get a swap quote for USDC → target asset via BlueFin 7k aggregator.
   *
   * On MAINNET: Routes across multiple DEXs for optimal pricing + on-chain execution.
   * On TESTNET: Uses mainnet aggregator for real DEX price discovery,
   *   then routes positions via BlueFin perps hedging (testnet has no DEX liquidity).
   *   This is NOT simulated — prices come from real mainnet DEX pools.
   */
  async getSwapQuote(asset: PoolAsset, usdcAmount: number): Promise<SwapQuoteResult> {
    const cacheKey = getQuoteCacheKey(this.network, asset, usdcAmount, 'forward');
    const cached = getCachedQuote(cacheKey);
    if (cached) return cached;

    const result = await this._getSwapQuoteUncached(asset, usdcAmount);
    setCachedQuote(cacheKey, result);
    return result;
  }

  private async _getSwapQuoteUncached(
    asset: PoolAsset,
    usdcAmount: number
  ): Promise<SwapQuoteResult> {
    const coinKey = ASSET_TO_COIN_KEY[asset];
    const toCoinType = this.coinTypes[coinKey] || '';
    const fromCoinType = this.coinTypes.USDC;

    // ── TESTNET MODE: Use mainnet BlueFin for price discovery, BlueFin perps for execution ──
    if (this.network === 'testnet') {
      return this.getTestnetQuote(asset, usdcAmount, fromCoinType, toCoinType);
    }

    // ── MAINNET MODE: Real on-chain swaps via BlueFin 7k aggregator ──

    // CRO has no on-chain liquidity on SUI — hedge via perps
    if (!toCoinType || asset === 'CRO') {
      const estimate = await this.estimateOutputFromPrice(asset, usdcAmount);
      return {
        asset,
        fromCoinType,
        toCoinType: toCoinType || '',
        amountIn: Math.floor(usdcAmount * 1e6).toString(),
        expectedAmountOut: estimate?.estimatedOut || '0',
        priceImpact: 0,
        route: `USDC → ${asset} (hedged via BlueFin perps)`,
        routerData: null,
        canSwapOnChain: false,
        isSimulated: false,
        hedgeVia: 'bluefin',
      };
    }

    const amountInRaw = Math.floor(usdcAmount * 1e6).toString();

    try {
      const quoteResponse = await bluefinGetQuote({
        tokenIn: fromCoinType,
        tokenOut: toCoinType,
        amountIn: amountInRaw,
        sources: quoteSources(),
      });

      if (!quoteResponse) {
        logger.warn(`[BluefinAggregator] No route found for USDC → ${asset}`);
        const estimate = await this.estimateOutputFromPrice(asset, usdcAmount);
        return {
          asset,
          fromCoinType,
          toCoinType,
          amountIn: amountInRaw,
          expectedAmountOut: estimate?.estimatedOut || '0',
          priceImpact: 0,
          route: estimate
            ? `USDC → ${asset} (hedged via BlueFin perps)`
            : `No route found for USDC → ${asset}`,
          routerData: null,
          canSwapOnChain: false,
          isSimulated: false,
          hedgeVia: estimate ? 'bluefin' : undefined,
        };
      }

      const expectedOut = quoteResponse.returnAmount;
      const routes = quoteResponse.routes || [];
      const routeDesc =
        routes.length > 0
          ? routes.map((r) => r.hops.map((h) => h.pool.type).join('→')).join(', ')
          : 'direct';

      // BlueFin SDK returns priceImpact as "price ratio remaining" (0.9999 = <0.01% slippage)
      // OR a direct impact fraction — normalize (see lib/services/sui/bluefin-order-size.ts).
      const priceImpact = normalizePriceImpact(quoteResponse.priceImpact);

      // If aggregator returned 0 output, fall back to BlueFin hedging
      if (expectedOut === '0' || expectedOut === '') {
        const estimate = await this.estimateOutputFromPrice(asset, usdcAmount);
        if (estimate) {
          logger.info(`[BluefinAggregator] Quote returned 0 for ${asset}, hedging via BlueFin`, {
            price: estimate.price,
          });
          return {
            asset,
            fromCoinType,
            toCoinType,
            amountIn: amountInRaw,
            expectedAmountOut: estimate.estimatedOut,
            priceImpact: 0,
            route: `USDC → ${asset} (hedged via BlueFin perps)`,
            routerData: null,
            canSwapOnChain: false,
            isSimulated: false,
            hedgeVia: 'bluefin',
          };
        }
      }

      logger.info(`[BluefinAggregator] Quote USDC → ${asset}`, {
        amountIn: usdcAmount,
        expectedOut,
        route: routeDesc,
        priceImpact,
      });

      return {
        asset,
        fromCoinType,
        toCoinType,
        amountIn: amountInRaw,
        expectedAmountOut: expectedOut,
        priceImpact,
        route: `USDC → ${asset} via ${routeDesc}`,
        routerData: quoteResponse,
        canSwapOnChain: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[BluefinAggregator] Quote failed for USDC → ${asset}`, { error: message });
      const estimate = await this.estimateOutputFromPrice(asset, usdcAmount);
      return {
        asset,
        fromCoinType,
        toCoinType,
        amountIn: amountInRaw,
        expectedAmountOut: estimate?.estimatedOut || '0',
        priceImpact: 0,
        route: estimate ? `USDC → ${asset} (hedged via BlueFin perps)` : `Quote failed: ${message}`,
        routerData: null,
        canSwapOnChain: false,
        isSimulated: false,
        hedgeVia: estimate ? 'bluefin' : undefined,
      };
    }
  }

  /**
   * Testnet quote: Uses mainnet BlueFin 7k aggregator for real DEX price discovery,
   * then marks positions for BlueFin perps hedging.
   *
   * The aggregator API only indexes mainnet pools.
   * We query mainnet DEX routing for accurate pricing, then execute via BlueFin testnet.
   */
  private async getTestnetQuote(
    asset: PoolAsset,
    usdcAmount: number,
    fromCoinType: string,
    toCoinType: string
  ): Promise<SwapQuoteResult> {
    // Try mainnet BlueFin 7k aggregator for real DEX pricing first
    const bluefinQuote = await this.getMainnetPriceQuote(asset, usdcAmount);
    if (bluefinQuote) {
      return {
        asset,
        fromCoinType,
        toCoinType: toCoinType || MAINNET_COIN_TYPES[ASSET_TO_COIN_KEY[asset]] || '',
        amountIn: Math.floor(usdcAmount * 1e6).toString(),
        expectedAmountOut: bluefinQuote.estimatedOut,
        priceImpact: 0,
        route: `USDC → ${asset} via BlueFin DEX (${bluefinQuote.route}) → BlueFin hedge`,
        routerData: null,
        canSwapOnChain: false, // Testnet: execute via BlueFin, not on-chain swap
        isSimulated: false, // NOT simulated — real DEX prices from mainnet
        hedgeVia: 'bluefin',
      };
    }

    // Fallback: use market price API if BlueFin aggregator is unreachable
    const estimate = await this.estimateOutputFromPrice(asset, usdcAmount);
    if (estimate) {
      return {
        asset,
        fromCoinType,
        toCoinType: toCoinType || '',
        amountIn: Math.floor(usdcAmount * 1e6).toString(),
        expectedAmountOut: estimate.estimatedOut,
        priceImpact: 0,
        route: `USDC → ${asset} via market-price ($${estimate.price.toFixed(2)}) → BlueFin hedge`,
        routerData: null,
        canSwapOnChain: false,
        isSimulated: false, // BlueFin hedging is real, not simulated
        hedgeVia: 'bluefin',
      };
    }

    // Last resort: no price data available
    return {
      asset,
      fromCoinType,
      toCoinType: toCoinType || '',
      amountIn: Math.floor(usdcAmount * 1e6).toString(),
      expectedAmountOut: '0',
      priceImpact: 0,
      route: `USDC → ${asset} (no price data available)`,
      routerData: null,
      canSwapOnChain: false,
      isSimulated: true,
      hedgeVia: 'virtual',
    };
  }

  /**
   * Get swap quotes for all 4 assets based on allocation percentages.
   * This is used by the AI cron to plan rebalancing.
   * Includes both on-chain swappable and simulated (price-tracked) positions.
   */
  async planRebalanceSwaps(
    totalUsdcAvailable: number,
    allocations: Record<PoolAsset, number>
  ): Promise<RebalanceSwapPlan> {
    const swaps: SwapQuoteResult[] = [];

    // Get quotes in parallel for each asset allocation (with per-quote 15s timeout)
    const QUOTE_TIMEOUT_MS = 15_000;
    const quotePromises = (Object.keys(allocations) as PoolAsset[]).map(async (asset) => {
      const pct = allocations[asset] || 0;
      if (pct <= 0) return null;

      const usdcForAsset = totalUsdcAvailable * (pct / 100);
      if (usdcForAsset < 0.1) return null; // Skip if less than $0.10

      const quotePromise = this.getSwapQuote(asset, usdcForAsset);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Quote timeout for ${asset} after ${QUOTE_TIMEOUT_MS}ms`)),
          QUOTE_TIMEOUT_MS
        )
      );
      return Promise.race([quotePromise, timeoutPromise]);
    });

    const results = await Promise.allSettled(quotePromises);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        swaps.push(r.value);
      }
    }

    return {
      totalUsdcToSwap: totalUsdcAvailable,
      swaps,
      timestamp: Date.now(),
    };
  }

  // ============================================
  // SWAP EXECUTION (builds Transaction for signing)
  // ============================================

  /**
   * Build a Transaction that swaps USDC → target asset via BlueFin 7k aggregator.
   * The caller must sign and execute the transaction.
   */
  async buildSwapTransaction(
    quote: SwapQuoteResult,
    senderAddress: string,
    slippage: number = 0.01 // 1% default
  ): Promise<unknown | null> {
    if (!quote.routerData || !quote.canSwapOnChain) {
      logger.warn(`[BluefinAggregator] Cannot build swap tx for ${quote.asset} — no route`);
      return null;
    }

    try {
      await this.ensureSuiClient();

      const { tx } = await bluefinBuildTx({
        quoteResponse: quote.routerData,
        accountAddress: senderAddress,
        slippage,
        commission: { partner: senderAddress, commissionBps: 0 },
      });

      logger.info(`[BluefinAggregator] Built swap tx: USDC → ${quote.asset}`, {
        amountIn: quote.amountIn,
        expectedOut: quote.expectedAmountOut,
      });

      return tx;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[BluefinAggregator] Failed to build swap tx for ${quote.asset}`, {
        error: message,
      });
      return null;
    }
  }

  /**
   * Build a single Transaction that executes all rebalance swaps.
   * Each USDC → asset swap is added to the same PTB (Programmable Transaction Block).
   */
  async buildRebalanceTransaction(
    plan: RebalanceSwapPlan,
    senderAddress: string,
    slippage: number = 0.01
  ): Promise<unknown | null> {
    const swappableQuotes = plan.swaps.filter((s) => s.canSwapOnChain && s.routerData);
    if (swappableQuotes.length === 0) {
      logger.warn('[BluefinAggregator] No on-chain swaps to execute in rebalance plan');
      return null;
    }

    try {
      await this.ensureSuiClient();
      const { Transaction } = await import('@mysten/sui/transactions');
      const tx = new Transaction();
      tx.setSender(senderAddress);

      for (const quote of swappableQuotes) {
        await bluefinBuildTx({
          quoteResponse: quote.routerData!,
          accountAddress: senderAddress,
          slippage,
          commission: { partner: senderAddress, commissionBps: 0 },
          extendTx: { tx },
        });
      }

      logger.info('[BluefinAggregator] Built rebalance tx', {
        swapCount: swappableQuotes.length,
        assets: swappableQuotes.map((s) => s.asset),
        totalUsdc: plan.totalUsdcToSwap,
      });

      return tx;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[BluefinAggregator] Failed to build rebalance tx', { error: message });
      return null;
    }
  }

  // ============================================
  // SWAP EXECUTION — Sign + Submit On-Chain
  // ============================================

  /**
   * Execute a single swap: sign + submit using admin keypair.
   * Requires SUI_POOL_ADMIN_KEY env var (base64 or hex encoded private key).
   *
   * Safety checks (mainnet):
   * - Max swap size per transaction
   * - Slippage bounds enforcement
   * - Gas reserve validation (prevents wallet drain)
   */
  /**
   * Split a large USDC → asset swap into smaller chunks when the single-tx
   * price impact exceeds MAX_SWAP_PRICE_IMPACT_BPS (default 50 bps = 0.5%).
   * Sized for scale: at $100k+ swap sizes on SUI DEXs the single-tx
   * slippage is catastrophic without splitting.
   *
   * Algorithm:
   *   1. Quote the full amount
   *   2. If priceImpact within budget → execute as one swap
   *   3. Otherwise recursively halve the amount and re-quote until within
   *      budget OR chunk < MIN_SWAP_CHUNK_USD (then bail out — too small
   *      to be worth the per-tx gas overhead)
   *   4. Execute each chunk sequentially; aggregate results
   *
   * Returns the combined result (sum of all chunks' amountOut, count of
   * sub-swaps, and the FIRST chunk's tx digest as a primary reference).
   *
   * Env overrides:
   *   MAX_SWAP_PRICE_IMPACT_BPS  default 50    (0.5% per chunk ceiling)
   *   MIN_SWAP_CHUNK_USD         default 25    (below this, give up splitting)
   *   MAX_SWAP_CHUNK_COUNT       default 16    (hard cap, refuse to split more)
   *   SWAP_CHUNK_INTERVAL_MS     default 1500  (delay between chunks)
   */
  async executeSplitSwap(
    asset: PoolAsset,
    totalUsdcAmount: number,
    slippage: number = 0.01
  ): Promise<
    SwapExecutionResult & {
      subSwaps: number;
      chunks: Array<{
        usdc: number;
        amountOut?: string;
        success: boolean;
        error?: string;
        txDigest?: string;
      }>;
    }
  > {
    const maxImpactBps = Math.max(5, Number(process.env.MAX_SWAP_PRICE_IMPACT_BPS) || 50);
    const minChunkUsd = Math.max(1, Number(process.env.MIN_SWAP_CHUNK_USD) || 25);
    const maxChunkCount = Math.max(2, Number(process.env.MAX_SWAP_CHUNK_COUNT) || 16);
    const intervalMs = Math.max(0, Number(process.env.SWAP_CHUNK_INTERVAL_MS) || 1500);

    // Greedy chunking: try full size, halve until impact within budget or
    // chunk too small. Repeat sized chunks until totalUsdcAmount consumed.
    const chunks: Array<{
      usdc: number;
      amountOut?: string;
      success: boolean;
      error?: string;
      txDigest?: string;
    }> = [];
    let remaining = totalUsdcAmount;
    let totalOut = 0;
    let firstDigest: string | undefined;
    let anySuccess = false;
    let firstError: string | undefined;

    while (remaining >= minChunkUsd && chunks.length < maxChunkCount) {
      // Find a chunk size that quotes under maxImpactBps
      let chunk = remaining;
      let quote = await this.getSwapQuote(asset, chunk);
      let impactBps = (quote.priceImpact || 0) * 10000;
      while (impactBps > maxImpactBps && chunk > minChunkUsd) {
        chunk = chunk / 2;
        quote = await this.getSwapQuote(asset, chunk);
        impactBps = (quote.priceImpact || 0) * 10000;
      }
      if (impactBps > maxImpactBps) {
        // Even minimum chunk would exceed impact — bail
        chunks.push({
          usdc: chunk,
          success: false,
          error: `min chunk $${chunk.toFixed(2)} still ${impactBps.toFixed(1)}bps over ${maxImpactBps}bps cap`,
        });
        break;
      }
      const res = await this.executeSwap(quote, slippage);
      const usdcChunk = Number(quote.amountIn) / 1e6;
      const outChunk = Number(res.amountOut || '0');
      chunks.push({
        usdc: usdcChunk,
        success: !!res.success,
        amountOut: res.amountOut,
        error: res.error,
        txDigest: res.txDigest,
      });
      if (res.success) {
        anySuccess = true;
        totalOut += outChunk;
        remaining -= usdcChunk;
        if (!firstDigest) firstDigest = res.txDigest;
        if (remaining > 0 && intervalMs > 0) await new Promise((r) => setTimeout(r, intervalMs));
      } else {
        if (!firstError) firstError = res.error;
        break; // Don't retry endlessly — let operator triage
      }
    }

    return {
      asset,
      success: anySuccess && remaining < minChunkUsd,
      amountIn: ((totalUsdcAmount - remaining) * 1e6).toString(),
      amountOut: totalOut.toString(),
      txDigest: firstDigest,
      error: anySuccess ? undefined : firstError,
      subSwaps: chunks.length,
      chunks,
    };
  }

  async executeSwap(quote: SwapQuoteResult, slippage: number = 0.01): Promise<SwapExecutionResult> {
    if (!quote.routerData || !quote.canSwapOnChain) {
      return {
        asset: quote.asset,
        success: false,
        amountIn: quote.amountIn,
        error: `Cannot swap ${quote.asset} on-chain (no route or hedged via perps)`,
      };
    }

    const adminKey = (
      process.env.SUI_POOL_ADMIN_KEY ||
      process.env.BLUEFIN_PRIVATE_KEY ||
      ''
    ).trim();
    if (!adminKey) {
      return {
        asset: quote.asset,
        success: false,
        amountIn: quote.amountIn,
        error: 'SUI_POOL_ADMIN_KEY not configured',
      };
    }

    // Safety: enforce slippage bounds
    const maxSlippage = MAX_SLIPPAGE[this.network];
    const safeSlippage = Math.min(slippage, maxSlippage);

    // Safety: enforce max swap size
    const swapUsdcAmount = Number(quote.amountIn) / 1e6;
    const maxSwap = MAX_SWAP_SIZE_USD[this.network];
    if (swapUsdcAmount > maxSwap) {
      return {
        asset: quote.asset,
        success: false,
        amountIn: quote.amountIn,
        error: `Swap size $${swapUsdcAmount.toFixed(2)} exceeds max $${maxSwap} on ${this.network}`,
      };
    }

    // Safety: oracle price deviation check (mainnet only)
    // Reject if DEX effective price deviates >3% from oracle price.
    // Must handle BOTH directions:
    //   Forward (USDC → asset): quote.amountIn is USDC, expectedAmountOut is asset
    //   Reverse (asset → USDC): quote.amountIn is asset, expectedAmountOut is USDC
    if (this.network === 'mainnet' && quote.expectedAmountOut && quote.expectedAmountOut !== '0') {
      // Tightened from 3% → 1.5%. Override via BLUEFIN_MAX_ORACLE_DEVIATION (decimal).
      const MAX_ORACLE_DEVIATION =
        Number(process.env.BLUEFIN_MAX_ORACLE_DEVIATION) > 0
          ? Number(process.env.BLUEFIN_MAX_ORACLE_DEVIATION)
          : 0.015;
      try {
        const usdcType = this.coinTypes.USDC || MAINNET_COIN_TYPES.USDC;
        const isReverseSwap = quote.toCoinType === usdcType;
        const coinKey = ASSET_TO_COIN_KEY[quote.asset];
        const decimals = ASSET_DECIMALS[coinKey] || ASSET_DECIMALS[quote.asset] || 8;

        if (isReverseSwap) {
          // Reverse swap: asset → USDC
          // quote.amountIn = asset raw amount, quote.expectedAmountOut = USDC amount (decimal string from Bluefin SDK)
          const { getMarketDataService } =
            await import('@/lib/services/market-data/RealMarketDataService');
          const mds = getMarketDataService();
          const priceData = await mds.getTokenPrice(quote.asset);
          if (priceData.price > 0) {
            const assetAmount = Number(quote.amountIn) / Math.pow(10, decimals);
            const oracleUsdcOut = assetAmount * priceData.price; // expected USDC in decimal
            const dexUsdcOut = Number(quote.expectedAmountOut); // Bluefin returns decimal
            if (oracleUsdcOut > 0 && dexUsdcOut > 0) {
              const deviation = Math.abs(dexUsdcOut - oracleUsdcOut) / oracleUsdcOut;
              if (deviation > MAX_ORACLE_DEVIATION) {
                logger.error(
                  `[BluefinAggregator] Oracle deviation too high for reverse ${quote.asset} → USDC`,
                  {
                    dexUsdcOut,
                    oracleUsdcOut,
                    assetAmount,
                    price: priceData.price,
                    deviation: (deviation * 100).toFixed(2) + '%',
                  }
                );
                return {
                  asset: quote.asset,
                  success: false,
                  amountIn: quote.amountIn,
                  error: `DEX price deviates ${(deviation * 100).toFixed(1)}% from oracle — swap blocked for safety`,
                };
              }
            }
          }
        } else {
          // Forward swap: USDC → asset
          const oracleEstimate = await this.estimateOutputFromPrice(quote.asset, swapUsdcAmount);
          if (oracleEstimate && oracleEstimate.estimatedOut !== '0') {
            const oracleOutRaw = Number(oracleEstimate.estimatedOut);
            const dexOut = Number(quote.expectedAmountOut);
            const oracleOutDecimal = oracleOutRaw / Math.pow(10, decimals);
            // Use whichever oracle form is closest in magnitude to dexOut
            const oracleOut =
              Math.abs(dexOut - oracleOutDecimal) < Math.abs(dexOut - oracleOutRaw)
                ? oracleOutDecimal
                : oracleOutRaw;
            if (oracleOut > 0 && dexOut > 0) {
              const deviation = Math.abs(dexOut - oracleOut) / oracleOut;
              if (deviation > MAX_ORACLE_DEVIATION) {
                logger.error(`[BluefinAggregator] Oracle deviation too high for ${quote.asset}`, {
                  dexOut,
                  oracleOut,
                  oracleOutRaw,
                  oracleOutDecimal,
                  deviation: (deviation * 100).toFixed(2) + '%',
                });
                return {
                  asset: quote.asset,
                  success: false,
                  amountIn: quote.amountIn,
                  error: `DEX price deviates ${(deviation * 100).toFixed(1)}% from oracle — swap blocked for safety`,
                };
              }
            }
          }
        }
      } catch {
        // Oracle check failed — proceed with DEX price (non-blocking)
        logger.debug(`[BluefinAggregator] Oracle check unavailable for ${quote.asset}, proceeding`);
      }
    }

    try {
      const { Ed25519Keypair } = await getSuiSdk();
      const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

      // Derive keypair from env (supports suiprivkey bech32 or hex)
      let keypair: InstanceType<typeof Ed25519Keypair>;
      try {
        keypair = adminKey.startsWith('suiprivkey')
          ? Ed25519Keypair.fromSecretKey(adminKey)
          : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
      } catch (keyErr) {
        const msg = keyErr instanceof Error ? keyErr.message : String(keyErr);
        logger.error('[BluefinAggregator] Invalid admin key format', { error: msg });
        return {
          asset: quote.asset,
          success: false,
          amountIn: quote.amountIn,
          error: `Invalid SUI_POOL_ADMIN_KEY format: ${msg}`,
        };
      }
      const senderAddress = keypair.getPublicKey().toSuiAddress();

      // Safety: check gas reserve before executing (failover-aware)
      const suiClient = createFailoverSuiClient(this.network);

      const balance = await suiClient.getBalance({ owner: senderAddress });
      const balanceMist = BigInt(balance.totalBalance);
      const gasBudget = GAS_BUDGET[this.network];
      if (balanceMist < BigInt(MIN_GAS_RESERVE_MIST) + BigInt(gasBudget)) {
        return {
          asset: quote.asset,
          success: false,
          amountIn: quote.amountIn,
          error: `Insufficient gas: ${Number(balanceMist) / 1e9} SUI available, need at least ${(MIN_GAS_RESERVE_MIST + gasBudget) / 1e9} SUI`,
        };
      }

      // Build unsigned PTB via BlueFin 7k
      BluefinConfig.setSuiClient(suiClient);
      this.suiClient = suiClient;

      const { tx } = await bluefinBuildTx({
        quoteResponse: quote.routerData,
        accountAddress: senderAddress,
        slippage: safeSlippage,
        commission: { partner: senderAddress, commissionBps: 0 },
      });

      if (!isSuiTransaction(tx)) {
        return {
          asset: quote.asset,
          success: false,
          amountIn: quote.amountIn,
          error: 'Unexpected BluefinX routing — only standard SUI transactions supported',
        };
      }

      // Estimate gas via dry run, fall back to static budget
      let finalGasBudget = gasBudget;
      try {
        tx.setGasBudget(gasBudget);
        tx.setSender(senderAddress);
        const dryRun = await suiClient.dryRunTransactionBlock({
          transactionBlock: await tx.build({ client: suiClient }),
        });
        const gasUsed = dryRun.effects?.gasUsed;
        if (gasUsed) {
          const totalGas =
            Number(gasUsed.computationCost) +
            Number(gasUsed.storageCost) -
            Number(gasUsed.storageRebate);
          // Add 20% buffer on top of dry-run estimate
          finalGasBudget = Math.max(Math.ceil(totalGas * 1.2), gasBudget);
        }
      } catch {
        // Dry run failed — use static budget with 50% safety buffer
        finalGasBudget = Math.ceil(gasBudget * 1.5);
        logger.debug(
          `[BluefinAggregator] Gas dry-run failed for ${quote.asset}, using buffered static budget: ${finalGasBudget}`
        );
      }
      tx.setGasBudget(finalGasBudget);

      // Sign + execute
      const result = await suiClient.signAndExecuteTransaction({
        transaction: tx,
        signer: keypair,
        options: { showEffects: true, showEvents: true, showBalanceChanges: true },
      });

      const success = result.effects?.status?.status === 'success';

      // Read the ACTUAL delivered amount from balance changes rather than
      // trusting quote.expectedAmountOut. Root cause of the 2026-08-08 bleed:
      // some 7k routes returned success=true with the underlying router
      // delivering $0 of the destination token. Previously we reported the
      // QUOTED amount as if it were the fill, so admin USDC accounting
      // silently drifted (thought it swapped $4.36, real balance $0).
      let actualAmountOut = quote.expectedAmountOut;
      let deliveredZero = false;
      if (success) {
        const changes = (result as unknown as {
          balanceChanges?: Array<{
            coinType: string;
            amount: string;
            owner: { AddressOwner?: string } | string;
          }>;
        }).balanceChanges;
        if (Array.isArray(changes)) {
          const received = changes.find(c => {
            const ownerAddr = typeof c.owner === 'object' && c.owner?.AddressOwner
              ? c.owner.AddressOwner : null;
            return c.coinType === quote.toCoinType && ownerAddr === senderAddress;
          });
          if (received && !received.amount.startsWith('-')) {
            actualAmountOut = received.amount;
          } else {
            // Tx succeeded but no positive balance change for toCoinType —
            // the router delivered nothing. Treat as a swap failure.
            actualAmountOut = '0';
            deliveredZero = true;
          }
        }
      }

      logger.info(`[BluefinAggregator] Swap executed: USDC → ${quote.asset}`, {
        txDigest: result.digest,
        success,
        amountIn: quote.amountIn,
        expectedOut: quote.expectedAmountOut,
        actualOut: actualAmountOut,
        deliveredZero,
      });

      return {
        asset: quote.asset,
        success: success && !deliveredZero,
        txDigest: result.digest,
        amountIn: quote.amountIn,
        amountOut: actualAmountOut,
        error: !success
          ? result.effects?.status?.error
          : deliveredZero
            ? `Tx success but router delivered 0 ${quote.toCoinType} (quote said ${quote.expectedAmountOut})`
            : undefined,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[BluefinAggregator] Swap execution failed for ${quote.asset}`, {
        error: message,
      });
      return {
        asset: quote.asset,
        success: false,
        amountIn: quote.amountIn,
        error: message,
      };
    }
  }

  /**
   * Execute a full rebalance: swap USDC → each asset according to plan.
   * Executes each swap as a separate transaction (atomic per-swap, not all-or-nothing).
   *
   * Why separate txs instead of one PTB:
   * - If BTC swap fails, ETH/SUI swaps can still succeed
   * - Each swap can have different slippage
   * - Easier to debug per-asset
   */
  async executeRebalance(
    plan: RebalanceSwapPlan,
    slippage: number = 0.01,
    options?: { dryRun?: boolean }
  ): Promise<{
    success: boolean;
    results: SwapExecutionResult[];
    totalExecuted: number;
    totalFailed: number;
    dryRunDetails?: Array<{
      asset: string;
      steps: Array<{ step: string; passed: boolean; detail: string }>;
      order?: Record<string, unknown>;
    }>;
  }> {
    if (!process.env.SUI_POOL_ADMIN_KEY && !process.env.BLUEFIN_PRIVATE_KEY) {
      return {
        success: false,
        results: [
          {
            asset: 'BTC' as PoolAsset,
            success: false,
            amountIn: '0',
            error: 'SUI_POOL_ADMIN_KEY not configured — swaps disabled',
          },
        ],
        totalExecuted: 0,
        totalFailed: 1,
      };
    }

    const swappable = plan.swaps.filter((s) => s.canSwapOnChain && s.routerData);
    const hedgeable = plan.swaps.filter((s) => !s.canSwapOnChain && s.hedgeVia === 'bluefin');

    if (swappable.length === 0 && hedgeable.length === 0) {
      logger.info('[BluefinAggregator] No on-chain swaps or hedges to execute');
      return { success: true, results: [], totalExecuted: 0, totalFailed: 0 };
    }

    logger.info('[BluefinAggregator] Executing rebalance', {
      onChainSwaps: swappable.length,
      hedgedSwaps: hedgeable.length,
      assets: plan.swaps.map((s) => s.asset),
      totalUsdc: plan.totalUsdcToSwap,
    });

    const results: SwapExecutionResult[] = [];

    // Execute sequentially to avoid nonce issues
    for (const quote of swappable) {
      const result = await this.executeSwap(quote, slippage);
      results.push(result);

      // Delay between ALL swaps (not just successful) to let object versions propagate
      if (swappable.indexOf(quote) < swappable.length - 1) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // Also include non-swappable (hedged via BlueFin perps) — execute real hedges or dry-run
    const dryRunDetails: Array<{
      asset: string;
      steps: Array<{ step: string; passed: boolean; detail: string }>;
      order?: Record<string, unknown>;
    }> = [];
    if (hedgeable.length > 0) {
      const { bluefinService, BluefinService } = await import('./BluefinService');
      const privateKey = (
        process.env.SUI_POOL_ADMIN_KEY ||
        process.env.BLUEFIN_PRIVATE_KEY ||
        ''
      ).trim();
      const network = this.network;

      if (!privateKey) {
        for (const s of hedgeable) {
          results.push({
            asset: s.asset,
            success: false,
            amountIn: s.amountIn,
            error: 'BLUEFIN_PRIVATE_KEY not configured — cannot open hedge',
          });
        }
      } else {
        await bluefinService.initialize(privateKey, network);

        for (const s of hedgeable) {
          const symbol = BluefinService.assetToPair(s.asset);
          if (!symbol) {
            results.push({
              asset: s.asset,
              success: false,
              amountIn: s.amountIn,
              error: `No BlueFin pair for ${s.asset}`,
            });
            continue;
          }

          // Calculate position size in asset units from expected output
          const decimals = ASSET_DECIMALS[ASSET_TO_COIN_KEY[s.asset]] || 8;
          const assetSize = Number(s.expectedAmountOut || '0') / Math.pow(10, decimals);
          if (assetSize <= 0) {
            results.push({
              asset: s.asset,
              success: false,
              amountIn: s.amountIn,
              error: `Cannot determine position size for ${s.asset}`,
            });
            continue;
          }

          if (options?.dryRun) {
            // Dry-run: validate everything except actual order submission
            const dryResult = await bluefinService.dryRunHedge({
              symbol,
              side: 'LONG',
              size: assetSize,
              leverage: 1,
            });
            dryRunDetails.push({ asset: s.asset, steps: dryResult.steps, order: dryResult.order });
            results.push({
              asset: s.asset,
              success: dryResult.success,
              amountIn: s.amountIn,
              amountOut: s.expectedAmountOut || '0',
              error: dryResult.success
                ? `DRY-RUN OK: ${symbol} LONG ${assetSize.toFixed(6)} — all steps passed`
                : `DRY-RUN: ${dryResult.steps
                    .filter((st) => !st.passed)
                    .map((st) => `${st.step}: ${st.detail}`)
                    .join('; ')}`,
            });
          } else {
            const hedgeResult = await bluefinService.openHedge({
              symbol,
              side: 'LONG', // Deposit = go long the asset
              size: assetSize,
              leverage: 1, // 1x leverage = synthetic spot exposure
              reason: `Pool rebalance deposit: USDC → ${s.asset}`,
            });

            results.push({
              asset: s.asset,
              success: hedgeResult.success,
              amountIn: s.amountIn,
              amountOut: s.expectedAmountOut || '0',
              txDigest: hedgeResult.txDigest,
              error: hedgeResult.success
                ? `Hedged via BlueFin: ${symbol} LONG ${assetSize.toFixed(6)}`
                : `BlueFin hedge failed: ${hedgeResult.error}`,
            });

            if (hedgeResult.success) {
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
        }
      }
    }

    // Include non-swappable, non-hedgeable (virtual/no pair) assets
    for (const s of plan.swaps) {
      if (!s.canSwapOnChain && s.hedgeVia !== 'bluefin') {
        results.push({
          asset: s.asset,
          success: false,
          amountIn: s.amountIn,
          amountOut: s.expectedAmountOut || '0',
          error: `No swap route or hedge available for ${s.asset}`,
        });
      }
    }

    const totalExecuted = results.filter((r) => r.success).length;
    const totalFailed = results.filter((r) => !r.success).length;

    logger.info('[BluefinAggregator] Rebalance complete', {
      totalExecuted,
      totalFailed,
      digests: results.filter((r) => r.txDigest).map((r) => `${r.asset}:${r.txDigest}`),
    });

    return {
      success: totalFailed === 0,
      results,
      totalExecuted,
      totalFailed,
      ...(dryRunDetails.length > 0 ? { dryRunDetails } : {}),
    };
  }

  /**
   * Get a reverse swap quote: target asset → USDC.
   * Used for withdrawals (converting assets back to USDC).
   * On testnet: uses mainnet aggregator for price discovery.
   */
  async getReverseSwapQuote(asset: PoolAsset, assetAmount: number): Promise<SwapQuoteResult> {
    const cacheKey = getQuoteCacheKey(this.network, asset, assetAmount, 'reverse');
    const cached = getCachedQuote(cacheKey);
    if (cached) return cached;

    const result = await this._getReverseSwapQuoteUncached(asset, assetAmount);
    setCachedQuote(cacheKey, result);
    return result;
  }

  private async _getReverseSwapQuoteUncached(
    asset: PoolAsset,
    assetAmount: number
  ): Promise<SwapQuoteResult> {
    const coinKey = ASSET_TO_COIN_KEY[asset];
    const fromCoinType = this.coinTypes[coinKey] || '';
    const toCoinType = this.coinTypes.USDC;
    const decimals = ASSET_DECIMALS[coinKey] || 8;
    const amountInStr = Math.floor(assetAmount * Math.pow(10, decimals)).toString();

    // Testnet: use mainnet price discovery for reverse quotes too
    if (this.network === 'testnet') {
      const mainnetFrom = MAINNET_COIN_TYPES[coinKey] || '';
      const mainnetTo = MAINNET_COIN_TYPES.USDC;

      if (mainnetFrom) {
        try {
          const quoteResponse = await bluefinGetQuote({
            tokenIn: mainnetFrom,
            tokenOut: mainnetTo,
            amountIn: amountInStr,
            sources: quoteSources(),
          });

          if (quoteResponse && quoteResponse.returnAmount !== '0') {
            const routes = quoteResponse.routes || [];
            const routeDesc =
              routes.length > 0
                ? routes.map((r) => r.hops.map((h) => h.pool.type).join('→')).join(', ')
                : 'BlueFin7k';
            return {
              asset,
              fromCoinType: fromCoinType || mainnetFrom,
              toCoinType: toCoinType || mainnetTo,
              amountIn: amountInStr,
              expectedAmountOut: quoteResponse.returnAmount,
              priceImpact: (() => {
                const r = Math.abs(quoteResponse.priceImpact || 0);
                return r > 0.5 ? 1 - r : r;
              })(),
              route: `${asset} → USDC via BlueFin DEX (${routeDesc}) → close BlueFin hedge`,
              routerData: null, // Don't pass mainnet routerData for testnet execution
              canSwapOnChain: false,
              isSimulated: false,
              hedgeVia: 'bluefin',
            };
          }
        } catch (err) {
          logger.debug(`[BluefinAggregator] Mainnet reverse price query failed for ${asset}`, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Fallback: estimate from market price using the actual asset
      try {
        const { getMarketDataService } =
          await import('@/lib/services/market-data/RealMarketDataService');
        const mds = getMarketDataService();
        const data = await mds.getTokenPrice(asset);
        if (data.price > 0) {
          const usdcOut = assetAmount * data.price;
          const usdcOutRaw = Math.floor(usdcOut * 1e6).toString();
          return {
            asset,
            fromCoinType: fromCoinType || '',
            toCoinType: toCoinType || '',
            amountIn: amountInStr,
            expectedAmountOut: usdcOutRaw,
            priceImpact: 0,
            route: `${asset} → USDC via market-price ($${data.price.toFixed(2)}) → close BlueFin hedge`,
            routerData: null,
            canSwapOnChain: false,
            isSimulated: false,
            hedgeVia: 'bluefin',
          };
        }
      } catch {
        /* continue to fallback */
      }

      return {
        asset,
        fromCoinType: fromCoinType || '',
        toCoinType,
        amountIn: amountInStr,
        expectedAmountOut: '0',
        priceImpact: 0,
        route: `${asset} → USDC (close BlueFin perps position)`,
        routerData: null,
        canSwapOnChain: false,
      };
    }

    // Mainnet: CRO and assets without coin types use BlueFin perps hedging
    if (!fromCoinType || asset === 'CRO') {
      // Get market price for accurate expectedAmountOut
      try {
        const { getMarketDataService } =
          await import('@/lib/services/market-data/RealMarketDataService');
        const mds = getMarketDataService();
        const data = await mds.getTokenPrice(asset);
        if (data.price > 0) {
          const usdcOut = assetAmount * data.price;
          return {
            asset,
            fromCoinType: fromCoinType || '',
            toCoinType,
            amountIn: amountInStr,
            expectedAmountOut: Math.floor(usdcOut * 1e6).toString(),
            priceImpact: 0,
            route: `${asset} → USDC (close BlueFin perps position)`,
            routerData: null,
            canSwapOnChain: false,
            hedgeVia: 'bluefin',
          };
        }
      } catch {
        /* fall through */
      }

      return {
        asset,
        fromCoinType: fromCoinType || '',
        toCoinType,
        amountIn: amountInStr,
        expectedAmountOut: '0',
        priceImpact: 0,
        route: `${asset} → USDC (close BlueFin perps position)`,
        routerData: null,
        canSwapOnChain: false,
        hedgeVia: 'bluefin',
      };
    }

    const amountInRaw = amountInStr;

    try {
      const quoteResponse = await bluefinGetQuote({
        tokenIn: fromCoinType,
        tokenOut: toCoinType,
        amountIn: amountInRaw,
        sources: quoteSources(),
      });

      if (!quoteResponse) {
        return {
          asset,
          fromCoinType,
          toCoinType,
          amountIn: amountInRaw,
          expectedAmountOut: '0',
          priceImpact: 0,
          route: `No route found for ${asset} → USDC`,
          routerData: null,
          canSwapOnChain: false,
        };
      }

      const routes = quoteResponse.routes || [];
      const routeDesc =
        routes.length > 0
          ? routes.map((r: any) => r.hops.map((h: any) => h.pool.type).join('→')).join(', ')
          : 'direct';

      return {
        asset,
        fromCoinType,
        toCoinType,
        amountIn: amountInRaw,
        expectedAmountOut: quoteResponse.returnAmount,
        priceImpact: Math.abs(quoteResponse.priceImpact || 0),
        route: `${asset} → USDC via ${routeDesc}`,
        routerData: quoteResponse,
        canSwapOnChain: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`[BluefinAggregator] Reverse quote failed for ${asset} → USDC`, {
        error: message,
      });
      return {
        asset,
        fromCoinType,
        toCoinType,
        amountIn: amountInRaw,
        expectedAmountOut: '0',
        priceImpact: 0,
        route: `Reverse quote failed: ${message}`,
        routerData: null,
        canSwapOnChain: false,
      };
    }
  }

  /**
   * Check if the admin wallet is configured and has sufficient SUI for gas.
   *
   * `hasGas` is conservative: a full rebalance cycle needs gas for
   * `open_hedge` + 1–3 swaps + `close_hedge`, each costing ~0.01–0.03 SUI.
   * We default to 0.1 SUI as the floor so we don't start cycles that will
   * fail mid-way. Override with `SUI_GAS_FLOOR_SUI` env if needed.
   */
  async checkAdminWallet(): Promise<{
    configured: boolean;
    address?: string;
    suiBalance?: string;
    hasGas: boolean;
    /** Floor used for the hasGas decision (in SUI) */
    gasFloorSui?: number;
  }> {
    const adminKey = (
      process.env.SUI_POOL_ADMIN_KEY ||
      process.env.BLUEFIN_PRIVATE_KEY ||
      ''
    ).trim();
    if (!adminKey) {
      return { configured: false, hasGas: false };
    }

    try {
      const { Ed25519Keypair } = await getSuiSdk();
      const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');

      const keypair = adminKey.startsWith('suiprivkey')
        ? Ed25519Keypair.fromSecretKey(adminKey)
        : Ed25519Keypair.fromSecretKey(Buffer.from(adminKey.replace(/^0x/, ''), 'hex'));
      const address = keypair.getPublicKey().toSuiAddress();

      const suiClient = createFailoverSuiClient(this.network);

      const balance = await suiClient.getBalance({ owner: address });
      const suiBalance = (Number(balance.totalBalance) / 1e9).toFixed(4);

      // Configurable gas floor — default 0.1 SUI is enough for one full
      // open_hedge → swap → close_hedge round-trip with safety margin.
      const gasFloorSui = Number(process.env.SUI_GAS_FLOOR_SUI || '0.1');
      const gasFloorMist = Math.floor(gasFloorSui * 1e9);
      const hasGas = Number(balance.totalBalance) >= gasFloorMist;

      return { configured: true, address, suiBalance, hasGas, gasFloorSui };
    } catch (err) {
      logger.error('[BluefinAggregator] Admin wallet check failed', { error: err });
      return { configured: true, hasGas: false };
    }
  }

  // ============================================
  // UTILITY
  // ============================================

  /** Get the USDC coin type for the current network */
  getUsdcCoinType(): string {
    return this.coinTypes.USDC;
  }

  /** Get the on-chain coin type for a pool asset */
  getAssetCoinType(asset: PoolAsset): string {
    const key = ASSET_TO_COIN_KEY[asset];
    return this.coinTypes[key] || '';
  }

  /** Check if an asset can be swapped on-chain (vs. hedged via perps) */
  canSwapOnChain(asset: PoolAsset): boolean {
    if (asset === 'CRO') return false; // No CRO liquidity on SUI
    const type = this.getAssetCoinType(asset);
    return !!type;
  }

  /** Get current network */
  getNetwork(): NetworkType {
    return this.network;
  }

  /** Cleanup resources (SuiClient, quote cache). Call on graceful shutdown. */
  destroy(): void {
    this.suiClient = null;
    stopQuoteCache();
    logger.info('[BluefinAggregator] Destroyed', { network: this.network });
  }
}

// ============================================
// SINGLETON
// ============================================

let mainnetInstance: BluefinAggregatorService | null = null;
let testnetInstance: BluefinAggregatorService | null = null;

export function getBluefinAggregatorService(
  network: NetworkType = 'mainnet'
): BluefinAggregatorService {
  if (network === 'mainnet') {
    if (!mainnetInstance) {
      mainnetInstance = new BluefinAggregatorService('mainnet');
    }
    return mainnetInstance;
  }

  if (!testnetInstance) {
    testnetInstance = new BluefinAggregatorService('testnet');
  }
  return testnetInstance;
}
