/**
 * Canonical serialization and hashing of the inputs of a risk analysis.
 *
 * `inputsHash = SHA-256(canonical bytes)` fingerprints the exact inputs a
 * risk score was computed from. A risk-score proof commits to that digest
 * next to the score (`proveRiskScore` in `ProofGenerator.ts`), so the inputs
 * cannot be revised afterwards without the digest changing.
 *
 * The raw model output (`aiRiskScore`) enters as an opaque field: it is
 * folded into the digest, not recomputed by anyone.
 */

import crypto from 'crypto';

/** Version of the canonical layout; folded into the digest. */
export const RISK_CANONICAL_VERSION = 1 as const;

/** Sentiment codes: a fixed integer mapping, so the digest does not depend on a label's spelling. */
export const SENTIMENT_CODE = {
  bearish: 0,
  neutral: 1,
  bullish: 2,
} as const;

export type SentimentLabel = keyof typeof SENTIMENT_CODE;
export type SentimentCode = (typeof SENTIMENT_CODE)[SentimentLabel];

/**
 * The exact schema the digest covers. Every field is an integer or a
 * fixed-precision-scaled integer to keep serialization language-neutral.
 *
 * Precision conventions:
 *   - USDC-denominated values → integer cents ($1 = 100)
 *   - Ratios / percentages    → basis points (100% = 10000)
 *   - Scores                  → integers 0..100
 *   - Asset symbols           → uppercase ASCII
 *   - Sentiment               → integer code from SENTIMENT_CODE
 */
export interface CanonicalRiskInputs {
  version: typeof RISK_CANONICAL_VERSION;
  portfolioId: number;
  chain: string;
  /** ms epoch — floored to the nearest 1000 ms so proof and attestation share the same second. */
  timestampMs: number;
  /** Portfolio NAV in USDC cents (1 USDC = 100). */
  portfolioValueUsdc: number;
  /** Volatility fraction × 10000, rounded (0.25 → 2500). */
  volatilityBps: number;
  /** Sorted asc by asset symbol (ASCII) so lists in the same order across langs. */
  exposures: Array<{
    asset: string;
    /** Exposure "percentage points" × 100 (30 pp → 3000). Matches RiskAgent.exposure * 100. */
    exposureBps: number;
    /** Contribution to base risk × 100 (30 pp → 3000). Matches RiskAgent.contribution * 100. */
    contributionBps: number;
  }>;
  sentimentCode: SentimentCode;
  /** Deterministic score computed from volatility + exposures — 0..100. */
  baseRiskScore: number;
  /** LLM-adjusted score if AI ran, else null. 0..100. */
  aiRiskScore: number | null;
  /** Final published score = fuse(baseRiskScore, aiRiskScore). 0..100. */
  totalRisk: number;
  /** The bound a risk-score proof shows totalRisk stays within. */
  threshold: number;
}

/**
 * Canonical JSON serialization: the byte string the digest is taken over.
 *
 * Rules:
 *   1. Keys sorted lexicographically at every nesting level.
 *   2. No whitespace (compact separators).
 *   3. All floats are pre-rounded to integers at scaling time (bps/cents)
 *      so JSON never emits `1.0` vs `1`.
 *   4. Exposures list pre-sorted by `asset` ASCII order.
 *   5. Asset symbols uppercased; chain lowercased.
 *   6. `aiRiskScore: null` serializes as JSON `null`.
 */
export function serializeCanonical(inputs: CanonicalRiskInputs): string {
  const normalized: CanonicalRiskInputs = {
    version: RISK_CANONICAL_VERSION,
    portfolioId: Math.trunc(inputs.portfolioId),
    chain: inputs.chain.toLowerCase(),
    timestampMs: Math.floor(inputs.timestampMs / 1000) * 1000,
    portfolioValueUsdc: Math.round(inputs.portfolioValueUsdc),
    volatilityBps: Math.round(inputs.volatilityBps),
    exposures: [...inputs.exposures]
      .map((e) => ({
        asset: e.asset.toUpperCase(),
        exposureBps: Math.round(e.exposureBps),
        contributionBps: Math.round(e.contributionBps),
      }))
      .sort((a, b) => (a.asset < b.asset ? -1 : a.asset > b.asset ? 1 : 0)),
    sentimentCode: inputs.sentimentCode,
    baseRiskScore: Math.round(inputs.baseRiskScore),
    aiRiskScore: inputs.aiRiskScore === null ? null : Math.round(inputs.aiRiskScore),
    totalRisk: Math.round(inputs.totalRisk),
    threshold: Math.round(inputs.threshold),
  };
  return stringifySortedKeys(normalized);
}

/** JSON.stringify with sorted keys at every level, no whitespace. */
function stringifySortedKeys(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number: ${v}`);
    return Number.isInteger(v) ? v.toString() : v.toString();
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stringifySortedKeys).join(',')}]`;
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stringifySortedKeys(obj[k])}`).join(',')}}`;
  }
  throw new Error(`unserializable value: ${typeof v}`);
}

/**
 * SHA-256 of the canonical serialization, as 64 hex characters.
 */
export function computeInputsHash(inputs: CanonicalRiskInputs): string {
  const bytes = Buffer.from(serializeCanonical(inputs), 'utf8');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Deterministic base-risk formula.
 *
 * Units:
 *   - volatilityBps  = fraction × 10000 (0.25 → 2500)
 *   - contributionBps = percentage-points × 100 (30 pp → 3000)
 *
 * Formula (mirrors agents/specialized/RiskAgent.ts:202-205 with unit
 * conversion applied):
 *
 *   volFrac      = volatilityBps / 10000              // 0.25
 *   contribSum   = Σ (contributionBps / 100)          // percentage points
 *   raw          = volFrac × 50 + contribSum          // 0..∞
 *   baseRisk     = clamp(round(raw), 0, 100)
 */
export function computeBaseRiskScore(
  volatilityBps: number,
  exposures: Array<{ contributionBps: number }>,
): number {
  const volFrac = volatilityBps / 10_000;
  const contribSum = exposures.reduce((s, e) => s + e.contributionBps / 100, 0);
  const raw = volFrac * 50 + contribSum;
  return Math.max(0, Math.min(100, Math.round(raw)));
}
