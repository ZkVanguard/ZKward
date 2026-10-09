/**
 * BluefinService.openHedge — extracted as a pure orchestrator.
 *
 * Was a 435-LOC method mixing idempotency, guard checks, order build,
 * signed submit and fill verification in one body. Now takes an
 * OpenHedgeContext bundle so the caller class stays thin and the
 * pipeline is unit-testable / mockable without pulling in the full
 * BluefinService class.
 *
 * Sibling of dry-run-hedge.ts, close-hedge-impl.ts. Extraction pattern
 * documented in memory `project_cron_route_extraction_2026_07_18`.
 */
import crypto from 'crypto';
import { logger } from '@/lib/utils/logger';
import { envFlag } from '@/lib/utils/env-flag';
import { BLUEFIN_PAIRS, BLUEFIN_NETWORKS, type BluefinHedgeResult, type BluefinPosition } from '@/lib/services/sui/BluefinService';
import * as HedgeResult from '@/lib/services/sui/bluefin/hedge-result';
import { snapToStepSize } from '@/lib/services/sui/bluefin-order-size';
import type { OrderSignedFields } from '@/lib/services/sui/bluefin/sign-request';

export interface OpenHedgeContext {
  walletAddress: string | null;
  network: 'mainnet' | 'testnet';
  apiRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    apiType: 'exchange' | 'trade',
  ): Promise<T>;
  getPositions(): Promise<BluefinPosition[]>;
  getMarketData(symbol: string): Promise<{
    price: number;
    fundingRate: number;
    change24h?: number;
    openInterestUsd?: number;
  } | null>;
  signOrder(fields: OrderSignedFields): Promise<string>;
}

export interface OpenHedgeParams {
  symbol: string;
  side: 'LONG' | 'SHORT';
  size: number;
  leverage: number;
  portfolioId?: number;
  reason?: string;
  bypassFundingGuard?: boolean;
  bypassOiGuard?: boolean;
  clientOrderId?: string;
}

export async function performOpenHedge(
  ctx: OpenHedgeContext,
  params: OpenHedgeParams,
): Promise<BluefinHedgeResult> {
  const rawHedgeId = params.clientOrderId
    ? params.clientOrderId.replace(/[^A-Za-z0-9_\-:]/g, '_').slice(0, 64)
    : `BF_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const hedgeId =
    rawHedgeId.length > 0
      ? rawHedgeId
      : `BF_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const startTime = Date.now();

  try {
    logger.info('🌊 Opening BlueFin hedge', {
      symbol: params.symbol,
      side: params.side,
      size: params.size,
      leverage: params.leverage,
    });

    // Onboarding check (exchange API, not trade API).
    try {
      const acctResp = await ctx.apiRequest<{ canTrade?: boolean; freeCollateral?: string } | null>(
        'GET',
        `/api/v1/account?accountAddress=${ctx.walletAddress}`,
        undefined,
        'exchange',
      );
      if (!acctResp || !acctResp.canTrade) {
        throw new Error(
          `BlueFin account ${ctx.walletAddress} not found. Please onboard at https://trade.bluefin.io first.`,
        );
      }
    } catch (acctError) {
      const msg = acctError instanceof Error ? acctError.message : String(acctError);
      if (msg.includes('404') || msg.includes('not found') || msg.includes('not onboarded')) {
        throw new Error(
          `BlueFin account ${ctx.walletAddress} not onboarded. Visit https://trade.bluefin.io to register.`,
        );
      }
      throw acctError;
    }

    // Idempotency pre-flight — deterministic return for retried clientOrderIds.
    // Best-effort: if the GET endpoint is flaky we proceed with the submit
    // and rely on BlueFin's server-side uniqueness as the backstop.
    if (params.clientOrderId) {
      try {
        const existing = await ctx.apiRequest<Array<{
          orderHash?: string;
          orderId?: string;
          clientOrderId?: string;
          status?: string;
          txDigest?: string;
          avgFillPrice?: string;
          filledQty?: string;
        }> | null>(
          'GET',
          `/api/v1/trade/orders?clientOrderId=${encodeURIComponent(hedgeId)}`,
          undefined,
          'trade',
        );
        const match = Array.isArray(existing) ? existing.find((o) => o?.clientOrderId === hedgeId) : null;
        if (match) {
          logger.warn('🛡️  BlueFin idempotency hit — returning existing order instead of resubmitting', {
            hedgeId, orderHash: match.orderHash, status: match.status,
          });
          // An order that exists is not a fill. Only what the venue reports
          // as filled counts; the requested size is never assumed. Either way
          // the order is not sent again.
          const matchedFill = Number(match.filledQty);
          if (!(matchedFill > 0)) {
            return {
              success: false,
              hedgeId,
              orderId: match.orderHash || match.orderId,
              error: `Order ${hedgeId} already exists on the venue (status ${match.status ?? 'unknown'}) with no reported fill — not resubmitted`,
              timestamp: Date.now(),
            };
          }
          return {
            success: true,
            hedgeId,
            orderId: match.orderHash || match.orderId,
            txDigest: match.txDigest,
            executionPrice: parseFloat(match.avgFillPrice || '0'),
            filledSize: matchedFill,
            fees: 0,
            timestamp: Date.now(),
          };
        }
      } catch (idemErr) {
        logger.warn('[BlueFin] idempotency pre-flight failed (non-fatal)', {
          hedgeId,
          error: idemErr instanceof Error ? idemErr.message : String(idemErr),
        });
      }
    }

    // Pair + leverage validation.
    const pair = Object.values(BLUEFIN_PAIRS).find((p) => p.symbol === params.symbol);
    if (!pair) {
      throw new Error(
        `Invalid pair: ${params.symbol}. Available: ${Object.keys(BLUEFIN_PAIRS).join(', ')}`,
      );
    }
    if (params.leverage > pair.maxLeverage) {
      throw new Error(
        `Leverage ${params.leverage}x exceeds max ${pair.maxLeverage}x for ${params.symbol}`,
      );
    }

    // Size guards: dust-risk → below-minQty → step-snap → snapped-below-minQty.
    const OPEN_MIN_QTY_BUFFER = 1.5;
    const bypass = envFlag('BLUEFIN_ALLOW_DUST_RISK_OPEN');
    if (!bypass && params.size < pair.minQuantity * OPEN_MIN_QTY_BUFFER) {
      logger.warn('[BlueFin] openHedge: DUST_RISK — size below 1.5x minQty buffer', {
        symbol: params.symbol, size: params.size, minQty: pair.minQuantity,
        threshold: pair.minQuantity * OPEN_MIN_QTY_BUFFER,
      });
      return HedgeResult.dustRisk(hedgeId, params.symbol, params.size, pair.minQuantity, pair.stepSize);
    }
    if (params.size < pair.minQuantity) {
      return HedgeResult.belowMinQty(hedgeId, params.symbol, params.size, pair.minQuantity);
    }
    const steppedSize = snapToStepSize(params.size, pair.stepSize);
    if (steppedSize < pair.minQuantity) {
      return HedgeResult.belowMinQtySnapped(hedgeId, params.symbol, params.size, steppedSize, pair.minQuantity);
    }
    if (steppedSize !== params.size) {
      logger.info(
        `[BlueFin] Snapped order size ${params.size} → ${steppedSize} (step=${pair.stepSize}) for ${params.symbol}`,
      );
      params.size = steppedSize;
    }

    // Market data.
    const marketData = await ctx.getMarketData(params.symbol);
    const currentPrice = marketData?.price || 0;
    if (currentPrice <= 0) {
      throw new Error(`Could not get market price for ${params.symbol}`);
    }

    // Funding-rate guard — defensive against systematic funding bleed.
    // A SHORT pays funding when rate is POSITIVE; a LONG pays when NEGATIVE.
    // Threshold default 0.0001/8h ≈ 11% APR. Override via env or per-call bypass.
    const fundingGuardEnabled =
      (process.env.BLUEFIN_FUNDING_RATE_GUARD || 'true').toLowerCase() !== 'false';
    if (fundingGuardEnabled && !params.bypassFundingGuard) {
      const fundingRate = marketData?.fundingRate ?? 0;
      const maxFunding = Math.abs(Number(process.env.BLUEFIN_MAX_FUNDING_RATE) || 0.0001);
      const wouldPay =
        (params.side === 'SHORT' && fundingRate > maxFunding) ||
        (params.side === 'LONG' && fundingRate < -maxFunding);
      if (wouldPay) {
        logger.warn('[BlueFin] Funding-rate guard rejected hedge — would pay too much funding', {
          symbol: params.symbol, side: params.side, fundingRate, maxFunding,
          estimatedAPR: `${(Math.abs(fundingRate) * 3 * 365 * 100).toFixed(2)}%`,
        });
        return {
          success: false,
          hedgeId,
          error: `Funding rate ${fundingRate.toFixed(6)} (≈${(Math.abs(fundingRate) * 3 * 365 * 100).toFixed(1)}% APR) exceeds guard ${maxFunding} for ${params.side} ${params.symbol}. Skipping to avoid systematic bleed.`,
          timestamp: Date.now(),
        };
      }
    }

    // Open-interest guard (T3-B) — reject hedges too large vs venue OI.
    const oiGuardEnabled = (process.env.BLUEFIN_OI_GUARD || 'true').toLowerCase() !== 'false';
    if (oiGuardEnabled && !params.bypassOiGuard) {
      const oiUsd = marketData?.openInterestUsd ?? 0;
      if (oiUsd > 0) {
        const maxOiPct = Math.max(0.5, Number(process.env.BLUEFIN_MAX_OI_PCT) || 5);
        const notionalUsd = params.size * (marketData?.price ?? 0);
        const proposedPct = (notionalUsd / oiUsd) * 100;
        if (proposedPct > maxOiPct) {
          logger.warn('[BlueFin] OI guard rejected hedge — too large vs venue', {
            symbol: params.symbol, side: params.side,
            notionalUsd: notionalUsd.toFixed(2), oiUsd: oiUsd.toFixed(2),
            proposedPctOfOi: proposedPct.toFixed(2), maxOiPct,
          });
          return {
            success: false,
            hedgeId,
            error: `Hedge $${notionalUsd.toFixed(0)} is ${proposedPct.toFixed(2)}% of ${params.symbol} OI ($${oiUsd.toFixed(0)}) — exceeds ${maxOiPct}% guard. Reduce size, split execution, or use multi-venue routing.`,
            timestamp: Date.now(),
          };
        }
      }
    }

    // Build signed fields (BlueFin uses e9 scaling).
    const quantityE9 = Math.floor(params.size * 1e9).toString();
    const leverageE9 = Math.floor(params.leverage * 1e9).toString();
    const priceE9 = '0';                     // MARKET orders require price=0
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
      side: params.side,
      // BlueFin Pro currently supports ISOLATED margin only — CROSS orders
      // return orderHash but the matching engine silently drops them. Root
      // cause of months of silent-reject issues (f54d5b46, 2026-06-13).
      isIsolated: true,
      expiresAtMillis: expiresAt,
      salt,
      signedAtMillis,
    };

    const signature = await ctx.signOrder(signedFields);

    // Snapshot pre-open so we can verify the order took effect.
    const preOpenPositions = await ctx.getPositions();
    const prePos = preOpenPositions.find((p) => p.symbol === params.symbol);
    const preOpenSize = prePos?.size ?? 0;
    const preOpenSameSideSize = prePos?.side === params.side ? preOpenSize : 0;

    const orderResponse = await ctx.apiRequest<{
      orderHash: string;
      orderId?: string;
      txDigest?: string;
      avgFillPrice?: string;
      filledQty?: string;
      fee?: string;
    }>('POST', '/api/v1/trade/orders', {
      signedFields,
      signature,
      clientOrderId: hedgeId,
      type: 'MARKET',
      reduceOnly: false,
    }, 'trade');

    if (!orderResponse?.orderHash) {
      throw new Error('BlueFin returned no orderHash — open not accepted');
    }

    // Verify fill via position delta polling. Same silent-reject class of bug
    // as closeHedge; orderHash alone is not proof of fill.
    let filledSize = parseFloat(orderResponse?.filledQty || '0');
    let positionGrew = false;
    let postOpenSize = preOpenSize;

    if (filledSize === 0) {
      const POLL_MS = 500;
      const POLL_ATTEMPTS = 10;
      const pollDeadline = Date.now() + 8_000; // callers run under a function time limit
      for (let i = 0; i < POLL_ATTEMPTS && Date.now() < pollDeadline; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        // The order is already sent: a failed read here must not abort the
        // verification, so keep polling.
        const fresh = await ctx.getPositions().catch(() => null);
        if (!fresh) continue;
        const stillThere = fresh.find((p) => p.symbol === params.symbol);
        if (stillThere) {
          postOpenSize = stillThere.size;
          const sameSideSize = stillThere.side === params.side ? stillThere.size : 0;
          const growth = sameSideSize - preOpenSameSideSize;
          if (growth >= params.size * 0.99) {
            positionGrew = true;
            filledSize = growth;
            break;
          }
          const oppositeReduction =
            prePos?.side && prePos.side !== params.side
              ? Math.max(0, preOpenSize - stillThere.size)
              : 0;
          if (oppositeReduction >= params.size * 0.99) {
            positionGrew = true;
            filledSize = oppositeReduction;
            break;
          }
        } else if (prePos && prePos.side !== params.side && prePos.size > 0) {
          positionGrew = true;
          filledSize = preOpenSize;
          break;
        }
      }
    }

    const openedOk = filledSize >= params.size * 0.99 || positionGrew;

    if (!openedOk) {
      logger.error('❌ BlueFin open did NOT take effect — silent reject', {
        hedgeId, symbol: params.symbol, side: params.side,
        requestedSize: params.size, preOpenSize, postOpenSize,
        orderHash: orderResponse?.orderHash, filledQty: orderResponse?.filledQty,
        rawResponse: JSON.stringify(orderResponse).slice(0, 500),
      });
      return {
        success: false,
        hedgeId,
        orderId: orderResponse?.orderHash,
        error: `BlueFin accepted orderHash ${orderResponse?.orderHash?.slice(0, 12)}… but position did not appear (preSize=${preOpenSize}, postSize=${postOpenSize}, requested=${params.size}). Likely silent reject — check step size & free collateral.`,
        timestamp: Date.now(),
        rawResponse: orderResponse,
        preCloseSize: preOpenSize,
        postCloseSize: postOpenSize,
      };
    }

    logger.info('✅ BlueFin hedge opened', {
      hedgeId,
      orderHash: orderResponse?.orderHash,
      txDigest: orderResponse?.txDigest,
      filledSize,
      verifiedByPoll: positionGrew,
      elapsed: `${Date.now() - startTime}ms`,
    });

    return {
      success: true,
      hedgeId,
      orderId: orderResponse?.orderHash || orderResponse?.orderId,
      txDigest: orderResponse?.txDigest,
      executionPrice: parseFloat(orderResponse?.avgFillPrice || String(currentPrice)),
      filledSize: filledSize || params.size,
      fees: parseFloat(orderResponse?.fee || '0'),
      timestamp: Date.now(),
    };
  } catch (error) {
    logger.error('❌ Failed to open BlueFin hedge', error instanceof Error ? error : undefined);
    return {
      success: false,
      hedgeId,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: Date.now(),
    };
  }
}
