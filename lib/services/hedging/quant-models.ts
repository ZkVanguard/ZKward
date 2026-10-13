/**
 * Quant-model primitives for the hedge sizing / trader gate.
 *
 * Three tools, all pure, all deterministic, all sharing the same GBM
 * foundation as Black-Scholes:
 *
 *   1. expectedValueUsd — trade EV net of funding + fees. The gate that
 *      answers "does this trade actually pay after we've held it through
 *      funding-time?" Currently missing — Kelly gates on edge > 0 but
 *      ignores that a 55% edge held 4h at 11% funding is negative-EV.
 *
 *   2. kellyFractionLeveraged — proper Kelly with payoff odds that
 *      reflect leverage AND adverse-move penalty. Existing kellyFraction
 *      assumes 1:1 (correct only for unlevered). At L=3× the adverse move
 *      is ~1/L before liquidation, so effective b = L×(1 − adverse), and
 *      f* = (p·b − q)/b. Falls back to legacy formula at leverage=1.
 *
 *   3. firstPassageProbability + maxLeverageForLiqCap — the probability
 *      that a GBM price path hits a barrier (stop-loss or liquidation)
 *      within a holding period. Same erf() primitive Black-Scholes uses
 *      for N(). Given a target max liq probability, invert to get the
 *      leverage cap that keeps us below it.
 *
 * Every function returns finite non-negative numbers or 0 on bad input.
 * No I/O, no globals, no side effects — trivially testable and safe to
 * call from cron hot-paths.
 */

// ─── erf / standard-normal CDF ──────────────────────────────────────────
// Abramowitz & Stegun 7.1.26 approximation, max |error| < 1.5e-7 over R.
// Black-Scholes' N() and the GBM first-passage formula both need this;
// keeping a single copy here avoids adding a dependency for one function.
export function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

/** Standard normal CDF Φ(x). Same primitive Black-Scholes calls N(). */
export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Inverse of Φ: the z whose normal CDF is `p`. Acklam's rational
 * approximation, relative error under 1.2e-9. Turns a quoted probability
 * back into a distance in standard deviations. NaN outside (0, 1).
 */
export function normalInv(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const tail = 0.02425;
  if (p < tail) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - tail) return -normalInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ─── 1. Funding-adjusted expected value ─────────────────────────────────

export interface EvInputs {
  /** Calibrated probability of the winning side, 0..1. */
  probability: number;
  /** Payoff odds b: profit per unit stake when we win. 1 = even money. */
  payoffOdds: number;
  /** Trade size in USD (collateral × leverage → notional; pass notional here). */
  notionalUsd: number;
  /** Expected holding period in hours. Used to prorate funding cost. */
  holdingHours: number;
  /** Annualized funding rate as fraction (e.g. 0.11 for 11% APR). */
  fundingRateApr: number;
  /** Round-trip fees + slippage as basis points (e.g. 15 bps = 0.15%). */
  feeBpsRoundTrip: number;
}

export interface EvResult {
  /** Expected profit in USD (can be negative). */
  evUsd: number;
  /** Breakdown for debug / discord logs. */
  edgeUsd: number;
  fundingCostUsd: number;
  feeCostUsd: number;
}

/**
 * Trade expected value in USD, net of funding + fees.
 *
 *   grossEdge = notional × (p × b − (1 − p))
 *   funding   = notional × fundingRateApr × (hours / 8760)
 *   fees      = notional × feeBps / 10_000
 *   ev        = grossEdge − funding − fees
 *
 * Returns 0 EV components on bad input (never throws). The GATE is EV > 0;
 * a marginal-edge signal at 55% held 4h at 11% funding is negative and
 * should be skipped even if calibration/consensus filters pass.
 */
export function expectedValueUsd(inputs: EvInputs): EvResult {
  const {
    probability: p,
    payoffOdds: b,
    notionalUsd: n,
    holdingHours: h,
    fundingRateApr: fr,
    feeBpsRoundTrip: fees,
  } = inputs;

  const bad = (x: number, min = 0): boolean => !Number.isFinite(x) || x < min;
  if (bad(p) || p > 1 || bad(b) || bad(n) || bad(h) || bad(fr) || bad(fees)) {
    return { evUsd: 0, edgeUsd: 0, fundingCostUsd: 0, feeCostUsd: 0 };
  }

  const edgeUsd = n * (p * b - (1 - p));
  const fundingCostUsd = n * fr * (h / 8760);
  const feeCostUsd = n * (fees / 10_000);
  const evUsd = edgeUsd - fundingCostUsd - feeCostUsd;
  return { evUsd, edgeUsd, fundingCostUsd, feeCostUsd };
}

// ─── 2. Leverage-corrected Kelly ────────────────────────────────────────

export interface LeveragedKellyInputs {
  /** Calibrated probability of winning, 0..1 (exclusive endpoints). */
  probability: number;
  /** Position leverage (>= 1). */
  leverage: number;
  /**
   * Fraction of adverse move that triggers stop / liquidation (0..1).
   * At leverage L, a 1/L adverse move is a total loss; use a smaller
   * fraction (e.g. 0.5/L) if a stop-loss trims the loss.
   * Default: 1 / leverage (full-liquidation assumption).
   */
  adverseFraction?: number;
  /** Kelly divisor to stay conservative (e.g. 4 for quarter-Kelly). Default 4. */
  kellyDivisor?: number;
}

/**
 * Leverage-corrected Kelly fraction.
 *
 *   b = leverage × (1 − adverseFraction)      // net-of-liquidation payoff odds
 *   f* = (p·b − q) / b                        // full Kelly
 *   return clamp01(f*) / kellyDivisor         // fractional Kelly
 *
 * At leverage=1 with adverseFraction=0 this collapses to the classic
 * (p − q/b) form and matches kellyFraction's shape. The point of the
 * leverage term: the trader ALWAYS decides "leverage" separately from
 * "size" and Kelly was being computed as if leverage=1 — every levered
 * bet was over-sized by a factor that grew with L.
 */
export function kellyFractionLeveraged(inputs: LeveragedKellyInputs): number {
  const { probability: p } = inputs;
  const leverage = Math.max(1, Number.isFinite(inputs.leverage) ? inputs.leverage : 1);
  const adverse = Math.max(0, Math.min(1,
    inputs.adverseFraction ?? Math.min(1, 1 / leverage),
  ));
  const divisor = Math.max(1, inputs.kellyDivisor ?? 4);

  if (!Number.isFinite(p) || p <= 0.5 || p >= 1) return 0;

  const b = leverage * (1 - adverse);
  if (b <= 0) return 0;

  const q = 1 - p;
  const fullKelly = (p * b - q) / b;
  if (!Number.isFinite(fullKelly) || fullKelly <= 0) return 0;
  return Math.min(1, Math.max(0, fullKelly)) / divisor;
}

// ─── 3. GBM first-passage probability ───────────────────────────────────

export interface FirstPassageInputs {
  /** Current price. */
  priceNow: number;
  /**
   * Barrier price (stop-loss or liquidation). Direction inferred from
   * whether barrier is above (upper) or below (lower) priceNow.
   */
  barrierPrice: number;
  /** Annualized volatility (e.g. 0.80 for 80% annual vol, typical BTC). */
  annualVol: number;
  /** Holding period in hours. Converted to years internally. */
  holdingHours: number;
  /** Annualized drift μ (e.g. 0 for hedge-symmetric assumption). Default 0. */
  drift?: number;
}

/**
 * Probability a GBM price path with (μ, σ) hits `barrierPrice` at least
 * once within `holdingHours`. Uses the closed-form reflection principle:
 *
 *   Let x = ln(barrierPrice / priceNow)
 *   ν = μ − σ²/2
 *   For DOWN barrier (x < 0):
 *     P(hit) = Φ((x − νt)/(σ√t)) + exp(2νx/σ²) · Φ((x + νt)/(σ√t))
 *   For UP barrier (x > 0): symmetric — flip signs of ν & x.
 *
 * Returns 0 on invalid input, clamped to [0, 1] on output.
 *
 * This is the direct extension of Black-Scholes' Brownian motion
 * assumption to barrier events, letting us answer "what is P(hit stop)"
 * and "what leverage before liquidation P exceeds our tolerance."
 */
export function firstPassageProbability(inputs: FirstPassageInputs): number {
  const { priceNow: s0, barrierPrice: h, annualVol: sigma, holdingHours } = inputs;
  const mu = inputs.drift ?? 0;

  if (!Number.isFinite(s0) || s0 <= 0) return 0;
  if (!Number.isFinite(h) || h <= 0) return 0;
  if (!Number.isFinite(sigma) || sigma <= 0) return 0;
  if (!Number.isFinite(holdingHours) || holdingHours <= 0) return 0;
  if (!Number.isFinite(mu)) return 0;
  if (s0 === h) return 1; // trivial: already at barrier

  const t = holdingHours / 8760; // hours → years
  const x = Math.log(h / s0);    // log-distance to barrier
  const nu = mu - (sigma * sigma) / 2;
  const sqrtT = Math.sqrt(t);
  const denom = sigma * sqrtT;

  // For upper barrier (x > 0) reflect: reuse the down-formula with
  // (x, ν) → (−x, −ν). The closed form is symmetric under that map.
  const xEff = x < 0 ? x : -x;
  const nuEff = x < 0 ? nu : -nu;

  const term1 = normalCdf((xEff - nuEff * t) / denom);
  const term2Exp = (2 * nuEff * xEff) / (sigma * sigma);
  // Guard against overflow when |term2Exp| is huge — Math.exp(large) = Infinity
  // which produces NaN downstream. If exp saturates the "second reflection
  // path" contribution is by definition tiny (barrier unreachable) so 0 is
  // the correct limit.
  const term2 = Number.isFinite(Math.exp(term2Exp))
    ? Math.exp(term2Exp) * normalCdf((xEff + nuEff * t) / denom)
    : 0;

  const p = term1 + term2;
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(1, p));
}

/**
 * Maximum leverage that keeps liquidation probability under `targetLiqProb`
 * over `holdingHours`. Uses bisection on firstPassageProbability(1/L barrier)
 * because the closed-form doesn't invert cleanly.
 *
 * Returns integer leverage in [1, maxLeverage]. Conservative rounding
 * (floor) — never exceeds the target.
 *
 * `adverseFractionForLiq` lets caller model isolated-margin cushions
 * (e.g. maintenance margin means adverse move to liq is 0.95/L not 1/L).
 */
export function maxLeverageForLiqCap(inputs: {
  annualVol: number;
  holdingHours: number;
  targetLiqProb: number;      // e.g. 0.05 for 5%
  maxLeverage?: number;       // default 10
  adverseFractionForLiq?: number; // default 0.95 (5% maint margin buffer)
  drift?: number;
}): number {
  const { annualVol, holdingHours, targetLiqProb } = inputs;
  const maxL = Math.max(1, Math.floor(inputs.maxLeverage ?? 10));
  const cushion = Math.max(0.5, Math.min(1, inputs.adverseFractionForLiq ?? 0.95));

  if (!Number.isFinite(annualVol) || annualVol <= 0) return 1;
  if (!Number.isFinite(holdingHours) || holdingHours <= 0) return 1;
  if (!Number.isFinite(targetLiqProb) || targetLiqProb <= 0 || targetLiqProb >= 1) return 1;

  const priceNow = 100; // arbitrary — only ratios matter in the GBM formula
  // Walk leverage down from cap until liq prob is within budget.
  // At worst 10 iterations — cheap. Prefer this over bisection so the
  // returned integer is transparently the highest L that passes.
  for (let L = maxL; L >= 1; L--) {
    // At leverage L, an adverse move of cushion/L wipes collateral.
    // Model as a SHORT position: barrier = priceNow × (1 + cushion/L).
    // (Symmetric for LONG; the formula is direction-invariant.)
    const barrier = priceNow * (1 + cushion / L);
    const p = firstPassageProbability({
      priceNow, barrierPrice: barrier, annualVol,
      holdingHours, drift: inputs.drift ?? 0,
    });
    if (p <= targetLiqProb) return L;
  }
  return 1;
}
