/**
 * BluefinService.closeHedge — extracted as a pure orchestrator.
 *
 * Was a 273-LOC method mixing position lookup, step-snap dust guard,
 * signed close submit, fill verification and DB persistence. Now takes
 * a CloseHedgeContext bundle so the service class stays thin and the
 * pipeline is unit-testable.
 *
 * Sibling of open-hedge-impl.ts, dry-run-hedge.ts.
 */
import crypto from 'crypto';
import { logger } from '@/lib/utils/logger';
import { BLUEFIN_PAIRS, BLUEFIN_NETWORKS, type BluefinHedgeResult, type BluefinPosition } from '@/lib/services/sui/BluefinService';
import * as HedgeResult from '@/lib/services/sui/bluefin/hedge-result';
import { snapToStepSize } from '@/lib/services/sui/bluefin-order-size';
import { checkMarkPriceDivergence } from '@/lib/services/sui/bluefin/markprice-divergence';
import type { OrderSignedFields } from '@/lib/services/sui/bluefin/sign-request';

/** How long the fill verification may poll before giving up. */
const VERIFY_POLL_DEADLINE_MS = 8_000;

export interface CloseHedgeContext {
  walletAddress: string | null;
  network: 'mainnet' | 'testnet';
  apiRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    apiType?: 'exchange' | 'trade',
  ): Promise<T>;
  getPositions(): Promise<BluefinPosition[]>;
  getMarketData(symbol: string): Promise<{ price: number; fundingRate: number } | null>;
  signOrder(fields: OrderSignedFields): Promise<string>;
}

export interface CloseHedgeParams {
  symbol: string;
  /** If not provided, closes entire position. */
  size?: number;
}

export async function performCloseHedge(
  ctx: CloseHedgeContext,
  params: CloseHedgeParams,
): Promise<BluefinHedgeResult> {
  const hedgeId = `BF_CLOSE_${Date.now()}`;
  const startTime = Date.now();

  try {
    logger.info('🌊 Closing BlueFin position', { symbol: params.symbol, size: params.size });

    const positions = await ctx.getPositions();
    const position = positions.find((p) => p.symbol === params.symbol);
    if (!position) {
      throw new Error(`No open position found for ${params.symbol}`);
    }

    // Snap to per-symbol step size. Non-stepped quantities return an orderHash
    // but the matching engine drops the order silently (root cause 2026-05-30/31).
    const rawCloseSize = params.size || position.size;
    const pair = BLUEFIN_PAIRS[params.symbol as keyof typeof BLUEFIN_PAIRS];
    const stepSize = pair?.stepSize ?? 0.001;
    const closeSize = snapToStepSize(rawCloseSize, stepSize);
    if (closeSize <= 0 || closeSize < (pair?.minQuantity ?? 0)) {
      const dustInfo = {
        positionSize: rawCloseSize,
        minQty: pair?.minQuantity ?? 0,
        stepSize,
        stepMultiples: pair?.stepSize ? rawCloseSize / pair.stepSize : 0,
      };
      logger.warn('[BlueFin] closeHedge: DUST_LOCKED — position below minQty', {
        symbol: params.symbol, ...dustInfo, snappedTo: closeSize,
      });
      return HedgeResult.dustLocked(hedgeId, params.symbol, rawCloseSize, dustInfo.minQty, dustInfo);
    }

    const closeSide = position.side === 'LONG' ? 'SHORT' : 'LONG';
    const preCloseSize = position.size;

    const marketData = await ctx.getMarketData(params.symbol);
    const currentPrice = marketData?.price || position.markPrice;

    // Close leverage MUST match position leverage. Earlier this hard-coded 1x,
    // which required full notional as free margin (impossible for closes on
    // leveraged positions). Match-position-leverage lets the pre-trade risk
    // check see required margin = posted margin.
    const closeLeverage = Math.max(1, position.leverage || 1);
    const quantityE9 = Math.floor(closeSize * 1e9).toString();
    const priceE9 = '0';                     // MARKET orders require price=0
    const leverageE9 = Math.floor(closeLeverage * 1e9).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const signedAtMillis = Date.now();
    const salt = (Date.now() + crypto.randomInt(1000000)).toString();
    const networkConfig = BLUEFIN_NETWORKS[ctx.network];
    const signedFields: OrderSignedFields = {
      idsId: networkConfig.idsId,
      accountAddress: ctx.walletAddress!,
      symbol: params.symbol,
      priceE9,
      quantityE9,
      leverageE9,
      side: closeSide,
      isIsolated: true,   // ISOLATED only — see openHedge writeup
      expiresAtMillis: expiresAt,
      salt,
      signedAtMillis,
    };
    const signature = await ctx.signOrder(signedFields);

    // NOTE: BlueFin deprecated reduceOnly. Setting reduceOnly:true returns
    // orderHash but matching engine drops it (observed 2026-05-30/31).
    // Placing a plain MARKET opposite-side order nets against the position.
    const orderResponse = await ctx.apiRequest<{
      orderHash: string;
      txDigest?: string;
      avgFillPrice?: string;
      filledQty?: string;
      fee?: string;
      realizedPnl?: string;
    }>('POST', '/api/v1/trade/orders', {
      signedFields,
      signature,
      clientOrderId: hedgeId,
      type: 'MARKET',
      reduceOnly: false,
    }, 'trade');

    if (!orderResponse?.orderHash) {
      throw new Error('BlueFin returned no orderHash — close not accepted');
    }

    // Verify the close actually took effect. Three signals — any one confirms:
    //   1. filledQty >= 99% of closeSize in response
    //   2. realizedPnl non-zero (set only on actual close fill)
    //   3. getPositions() shows position shrunk by >= 99% within 5s polling
    let filledSize = parseFloat(orderResponse?.filledQty || '0');
    let positionShrunk = false;
    let postCloseSize = preCloseSize;
    let polled = false;
    let verificationReadOk = false;

    if (filledSize === 0 && (orderResponse?.realizedPnl ?? '') === '') {
      const POLL_MS = 500;
      const POLL_ATTEMPTS = 10;
      // Bounded by time as well as attempts: a read that retries inside the
      // client can take many seconds, and the callers run under a function limit.
      const pollDeadline = Date.now() + VERIFY_POLL_DEADLINE_MS;
      polled = true;
      for (let i = 0; i < POLL_ATTEMPTS && Date.now() < pollDeadline; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        // A failed read is not "the position is gone": keep polling.
        const fresh = await ctx.getPositions().catch(() => null);
        if (!fresh) continue;
        verificationReadOk = true;
        const stillThere = fresh.find((p) => p.symbol === params.symbol);
        postCloseSize = stillThere?.size ?? 0;
        const shrinkage = preCloseSize - postCloseSize;
        if (shrinkage >= closeSize * 0.99) {
          positionShrunk = true;
          filledSize = shrinkage;
          break;
        }
      }
    }

    const closedOk =
      filledSize >= closeSize * 0.99 ||
      positionShrunk ||
      parseFloat(orderResponse?.realizedPnl || '0') !== 0;

    if (!closedOk) {
      logger.error('❌ BlueFin close did NOT take effect — silent reject', {
        hedgeId, symbol: params.symbol,
        orderHash: orderResponse?.orderHash,
        requestedSize: closeSize, preCloseSize, postCloseSize,
        filledQty: orderResponse?.filledQty,
        realizedPnl: orderResponse?.realizedPnl,
        rawResponse: JSON.stringify(orderResponse).slice(0, 500),
      });
      // If no read succeeded we do not know that the venue rejected it.
      if (polled && !verificationReadOk) {
        return HedgeResult.unverified(hedgeId, params.symbol, orderResponse?.orderHash);
      }
      // Classify with a machine code so callers can TTL-suppress this
      // failure the same way they do DUST_LOCKED. Prior rev returned
      // an untyped {code:undefined} which forced the stale-close and
      // max-hold force-close loops to retry every 1h and 15min
      // respectively for the same silent-reject on hedge #190 — 96
      // failed BlueFin API calls/day producing zero closes.
      return HedgeResult.silentReject(
        hedgeId,
        params.symbol,
        orderResponse?.orderHash,
        preCloseSize,
        postCloseSize,
        orderResponse,
      );
    }

    logger.info('✅ BlueFin position closed', {
      hedgeId, symbol: params.symbol, orderHash: orderResponse?.orderHash,
      filledSize, realizedPnl: orderResponse?.realizedPnl,
      verifiedByPoll: positionShrunk,
      elapsed: `${Date.now() - startTime}ms`,
    });

    if (filledSize > 0 && filledSize < closeSize * 0.99) {
      logger.warn('⚠️ BlueFin partial fill on close order', {
        hedgeId, requestedSize: closeSize, filledSize,
        remainingSize: closeSize - filledSize, symbol: params.symbol,
      });
    }

    // Persist realized PnL + fees to DB. Best-effort — never blocks the close.
    // Without this, hedges.realized_pnl stays 0 and win-rate/signal validation break.
    try {
      const { closePerpHedgeBySymbolSide } = await import('@/lib/db/hedges');
      // BlueFin's MARKET-order response often omits realizedPnl (settles async).
      // Fall back to the pre-close position's unrealizedPnl — the instant the
      // opposite-side market order fills, that unrealized number becomes the
      // realized figure. Without this fallback, every profitable trade recorded
      // as $0 (root cause of 20/20 zero-PnL closes observed 2026-07-15 → 08-03).
      // For partial closes, scale by the fraction of the position we closed.
      const responsePnl = orderResponse?.realizedPnl;
      const hasResponsePnl = typeof responsePnl === 'string' && responsePnl !== '' && !isNaN(parseFloat(responsePnl));
      const closeFraction = preCloseSize > 0 ? Math.min(1, closeSize / preCloseSize) : 1;
      const realizedPnl = hasResponsePnl
        ? parseFloat(responsePnl!)
        : Number((position.unrealizedPnl ?? 0)) * closeFraction;
      const feesPaid = parseFloat(orderResponse?.fee || '0');

      // markPrice divergence check — silent-PnL-corruption barrier.
      // Only meaningful when we're using the unrealizedPnl fallback (since
      // that's the value derived from BlueFin's markPrice). If BlueFin's
      // response gave us realizedPnl directly, it's the venue-settled truth
      // and needs no cross-check.
      if (!hasResponsePnl && position.markPrice > 0) {
        try {
          const asset = params.symbol.replace('-PERP', '');
          const { getMarketDataService } = await import('@/lib/services/market-data/RealMarketDataService');
          const independent = await getMarketDataService().getTokenPrice(asset).catch(() => null);
          if (independent?.price) {
            const div = checkMarkPriceDivergence(position.markPrice, independent.price);
            if (div.warn) {
              logger.warn('[BlueFin] markPrice divergence at close — recorded PnL may be off', {
                symbol: params.symbol,
                bluefinMark: position.markPrice,
                independent: independent.price,
                divergencePct: div.divergencePct.toFixed(2),
                realizedPnl,
              });
              try {
                const { notifyDiscord } = await import('@/lib/utils/discord-notify');
                await notifyDiscord(
                  `⚠️ markPrice divergence: ${params.symbol} ${div.detail}. Recorded PnL: $${realizedPnl.toFixed(2)}`,
                  'WARN',
                  { symbol: params.symbol, bluefinMark: position.markPrice, independent: independent.price, divergencePct: div.divergencePct, realizedPnl },
                );
              } catch { /* discord is best-effort */ }
            }
          }
        } catch { /* independent-price check is best-effort; never block the write */ }
      }

      const originalSide: 'LONG' | 'SHORT' = closeSide === 'LONG' ? 'SHORT' : 'LONG';
      const updateResult = await closePerpHedgeBySymbolSide({
        symbol: params.symbol,
        side: originalSide,
        realizedPnl,
        feesPaid,
        closeOrderId: orderResponse?.orderHash,
        closeTxDigest: orderResponse?.txDigest,
      });
      if (updateResult.updated === 0) {
        logger.warn('[BlueFin] Close persisted to exchange but no DB row matched (possible orphan)', {
          symbol: params.symbol, originalSide, realizedPnl,
        });
      }
    } catch (dbErr) {
      logger.warn('[BlueFin] Failed to persist close PnL to DB (non-fatal)', {
        error: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    return {
      success: true,
      hedgeId,
      orderId: orderResponse?.orderHash,
      txDigest: orderResponse?.txDigest,
      executionPrice: parseFloat(orderResponse?.avgFillPrice || String(currentPrice)),
      filledSize: filledSize || closeSize,
      fees: parseFloat(orderResponse?.fee || '0'),
      timestamp: Date.now(),
    };
  } catch (error) {
    logger.error('❌ Failed to close BlueFin position', error instanceof Error ? error : undefined);
    return {
      success: false,
      hedgeId,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: Date.now(),
    };
  }
}
