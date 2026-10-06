/**
 * BluefinHedgeResult failure constructors.
 *
 * openHedge/closeHedge return ~15 different failure shapes, each with
 * boilerplate: `{ success: false, hedgeId, error, code, timestamp: Date.now() }`
 * plus code-specific fields. Extracted here so:
 *   - Adding a new failure code = adding one function, not editing 4
 *     inline blocks
 *   - The error-message wording is one place to fix drift
 *   - The dust/preCloseSize shapes stay consistent across sites
 *
 * BluefinHedgeResult type stays in BluefinService.ts (canonical); this
 * module type-imports so no runtime dependency cycle.
 */
import type { BluefinHedgeResult } from '@/lib/services/sui/BluefinService';

interface DustInfo {
  positionSize: number;
  minQty: number;
  stepSize: number;
  stepMultiples: number;
}

function base(hedgeId: string): Pick<BluefinHedgeResult, 'success' | 'hedgeId' | 'timestamp'> {
  return { success: false, hedgeId, timestamp: Date.now() };
}

export function dustLocked(
  hedgeId: string,
  symbol: string,
  rawSize: number,
  minQty: number,
  dust: DustInfo,
): BluefinHedgeResult {
  return {
    ...base(hedgeId),
    error: `Position size ${rawSize} < minQty ${minQty} for ${symbol} — cannot close via reduce order (dust-locked at venue level)`,
    code: 'DUST_LOCKED',
    dust,
    preCloseSize: rawSize,
  };
}

export function dustRisk(
  hedgeId: string,
  symbol: string,
  size: number,
  minQty: number,
  stepSize: number,
): BluefinHedgeResult {
  return {
    ...base(hedgeId),
    error: `Size ${size} < 1.5× minQty ${minQty} for ${symbol} — would risk creating dust-locked position. Set BLUEFIN_ALLOW_DUST_RISK_OPEN=1 to bypass.`,
    code: 'DUST_RISK',
    dust: {
      positionSize: size,
      minQty,
      stepSize,
      stepMultiples: size / stepSize,
    },
  };
}

export function belowMinQty(hedgeId: string, symbol: string, size: number, minQty: number): BluefinHedgeResult {
  return {
    ...base(hedgeId),
    error: `Order size ${size} below minimum ${minQty} for ${symbol}`,
    code: 'BELOW_MIN_QTY',
  };
}

export function belowMinQtySnapped(
  hedgeId: string,
  symbol: string,
  size: number,
  steppedSize: number,
  minQty: number,
): BluefinHedgeResult {
  return {
    ...base(hedgeId),
    error: `Order size ${size} rounds to ${steppedSize} which is below minimum ${minQty} for ${symbol}`,
    code: 'BELOW_MIN_QTY_SNAPPED',
  };
}

/**
 * Silent-reject on close — BlueFin accepted the order (returned an
 * orderHash) but the position did not shrink within the polling window.
 * Root cause is typically a free-collateral shortfall on the closing
 * side: an ISOLATED close order that the matching engine treats as
 * needing new margin rather than reducing the existing position.
 *
 * Callers should treat this the same as DUST_LOCKED for suppression
 * purposes — the failure will persist across ticks until an external
 * event changes it (deposit, other hedge closing to free margin, or
 * BlueFin support). TTL-bounded retries prevent hourly Discord spam.
 */
/**
 * The order was accepted but no read of the venue succeeded afterwards, so
 * whether it took effect is unknown. Deliberately carries no `code`: callers
 * suppress retries for a day and raise an alert on SILENT_REJECT, and neither
 * is right for "we could not look".
 */
export function unverified(hedgeId: string, symbol: string, orderHash: string | undefined): BluefinHedgeResult {
  return {
    ...base(hedgeId),
    orderId: orderHash,
    error: `Order ${orderHash?.slice(0, 12) ?? '?'}… for ${symbol} was sent but the venue could not be read to verify it. Not confirmed either way.`,
  };
}

export function silentReject(
  hedgeId: string,
  symbol: string,
  orderHash: string | undefined,
  preSize: number,
  postSize: number,
  rawResponse: unknown,
): BluefinHedgeResult {
  return {
    ...base(hedgeId),
    orderId: orderHash,
    code: 'SILENT_REJECT',
    error: `BlueFin accepted orderHash ${orderHash?.slice(0, 12) ?? '?'}… but position did not shrink (preSize=${preSize}, postSize=${postSize}). Likely silent reject — usually a free-collateral shortfall on the closing side. Raw response surfaced in rawResponse.`,
    rawResponse,
    preCloseSize: preSize,
    postCloseSize: postSize,
  };
}
