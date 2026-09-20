/**
 * ZKward Pricing Model
 *
 * Three revenue streams, each tied to actually-shipped code:
 *
 *   1. POOL_ECONOMICS — automatic on-chain fees on community-pool TVL
 *      (50 bps mgmt + 10% perf). No subscription required; charged via
 *      community_pool_usdc.move at the protocol layer.
 *
 *   2. PREMIUM_PRODUCT_FEES — consumption-based fees for the three premium
 *      products (Private Hedges, Private Portfolio Creator, Custody
 *      Attestations). Charged per use.
 *
 *   3. SUBSCRIPTION_TIERS — SaaS subscriptions bundling end-user product
 *      access + B2B API surface (Aladdin-as-a-Service). Stripe-ready.
 *
 * Every number in this file maps to either a deployed contract field, a
 * shipped API endpoint, or a documented Tranche-2/3 grant deliverable.
 * Do not invent new fees here without a corresponding code path.
 *
 * See docs/VISION.md for how the three streams stack into the
 * "BlackRock-for-Web3" trajectory.
 */

// ============================================================================
// 0. Agent registry — must match agents/ directory (7 agents)
// ============================================================================

export type AgentType =
  | 'lead'
  | 'risk'
  | 'hedging'
  | 'settlement'
  | 'reporting'
  | 'priceMonitor'
  | 'suiPool';

export const ALL_AGENTS: AgentType[] = [
  'lead', 'risk', 'hedging', 'settlement', 'reporting', 'priceMonitor', 'suiPool',
];

/** Agents available on lower SaaS tiers (entry-level subset). */
export const BASIC_AGENTS: AgentType[] = ['lead', 'risk', 'hedging'];

export const AGENT_INFO: Record<AgentType, { name: string; description: string }> = {
  lead: {
    name: 'Lead Agent',
    description: 'Orchestrates the other six agents, parses intent, drives 2/3 consensus for trades > $100K.',
  },
  risk: {
    name: 'Risk Agent',
    description: 'Multi-timeframe streak, correlation, and cascade detection via AIMarketIntelligence.',
  },
  hedging: {
    name: 'Hedging Agent',
    description: 'BlueFin V2 perpetual hedging with multi-venue routing and signal-flip exits.',
  },
  settlement: {
    name: 'Settlement Agent',
    description: 'x402 gasless settlement, batch processing, fee-routing.',
  },
  reporting: {
    name: 'Reporting Agent',
    description: 'Audit-ready records with embedded ZK proof references and per-fund statements.',
  },
  priceMonitor: {
    name: 'Price Monitor Agent',
    description: 'Threshold price watcher; subscribes to the proactive 5-min prediction ticker.',
  },
  suiPool: {
    name: 'SUI Pool Agent',
    description: 'On-chain SUI USDC pool manager — allocation, BlueFin aggregator swaps, hedge sizing.',
  },
};

// ============================================================================
// 1. POOL_ECONOMICS — automatic fees, no SaaS required
// ============================================================================

export const POOL_ECONOMICS = {
  /** Annual management fee on community-pool TVL. Set in community_pool_usdc.move. */
  managementFeeBps: 50, // 0.5%

  /** Performance fee charged only on profits above the high-water mark. */
  performanceFeePercent: 10, // 10%

  /** HWM is per-share, enforced on-chain. */
  highWaterMark: true,

  /** Live pool fee destination. FeeManagerCap currently on MSafe multisig. */
  feeRecipient: 'MSafe multisig (FeeManagerCap)',

  description:
    'Automatic on-chain fees on the SUI USDC Community Pool. Anyone who deposits pays these; no subscription required. Funds the protocol once TVL grows past ~$100K.',
} as const;

// ============================================================================
// 2. PREMIUM_PRODUCT_FEES — consumption-based fees on shipped premium products
// ============================================================================

export const PREMIUM_PRODUCT_FEES = {
  /** Per-hedge fee on private (confidential) hedges via zk_hedge_commitment.move. */
  privateHedge: {
    perHedgeUsd: 5,
    feeRateBps: 25, // 0.25% of notional, whichever is higher (subject to product flag)
    description: 'Charged per private-hedge open. Lower of $5 or 25 bps of notional.',
  },

  /** One-time fee to spin up a custom portfolio via the AdvancedPortfolioCreator wizard. */
  privatePortfolio: {
    creationFeeUsd: 100,
    ongoingMgmtFeeBps: 50, // 0.5% annual on portfolio value
    description: 'One-time creation fee + ongoing mgmt fee for custom portfolios backed by zk_proxy_vault PDA proxies.',
  },

  /** Custody attestation primitive — rwa_custody_attestor.move (Tranche 2-3 deliverable). */
  custodyAttestation: {
    custodianEnrollmentUsd: 2500, // one-time, paid by the custodian or sponsoring partner
    perAttestationSubmissionUsd: 0.5, // gas + indexer overhead pass-through
    description: 'Enrollment fee per institutional custodian; small per-attestation fee for indexer + on-chain submission overhead.',
  },
} as const;

// ============================================================================
// 3. SUBSCRIPTION_TIERS — SaaS for end users (premium product access) + B2B API
// ============================================================================

export type SubscriptionTier = 'free' | 'retail' | 'pro' | 'institutional' | 'enterprise';

export interface TierLimits {
  /** Number of agents accessible to this tier's UI. Pool agents always run on the protocol side. */
  maxAgents: number;
  availableAgents: AgentType[];

  /** Cap on ZK-attestation generations per month (off-chain prover compute). */
  zkProofsPerMonth: number; // -1 unlimited

  /** Access to the Private Hedges product surface. */
  privateHedgesAccess: boolean;
  maxPrivateHedgePositions: number; // -1 unlimited

  /** Access to the Private Portfolio Creator wizard. */
  privatePortfolioAccess: boolean;
  maxPrivatePortfolios: number; // -1 unlimited

  /** Access to the custody attestation flow (request + view). */
  custodyAttestationAccess: boolean;

  /** B2B API access — Aladdin-as-a-Service surface. */
  apiAccess: 'none' | 'read-only' | 'read-write';
  apiRateLimitPerMin: number; // 0 = no access

  /** Support tier. */
  dedicatedSupport: boolean;
  whiteLabel: boolean;

  /** Soft cap on personal portfolio value attributable to this tier (UI-only suggestion). */
  recommendedPortfolioCapUsd: number; // -1 unlimited
}

export interface TierPricing {
  tier: SubscriptionTier;
  name: string;
  description: string;
  priceMonthly: number; // USD, 0 free, -1 custom
  priceAnnual: number;
  limits: TierLimits;
  features: string[];
  targetAudience: string;
  portfolioRange: string;
  /** Pool fees still apply automatically when this tier holds pool shares. */
  poolFeesApply: boolean;
}

export const PRICING_TIERS: Record<SubscriptionTier, TierPricing> = {
  free: {
    tier: 'free',
    name: 'Free',
    description: 'Deposit in the community pool, read all public APIs, see your unified portfolio.',
    priceMonthly: 0,
    priceAnnual: 0,
    limits: {
      maxAgents: 7, // sees the 7-agent activity feed in the dashboard
      availableAgents: ALL_AGENTS,
      zkProofsPerMonth: 2,
      privateHedgesAccess: false,
      maxPrivateHedgePositions: 0,
      privatePortfolioAccess: false,
      maxPrivatePortfolios: 0,
      custodyAttestationAccess: false,
      apiAccess: 'read-only',
      apiRateLimitPerMin: 120, // matches readLimiter default
      dedicatedSupport: false,
      whiteLabel: false,
      recommendedPortfolioCapUsd: -1, // no cap from us; pool is contract-capped at $10K pre-audit
    },
    features: [
      'Deposit / withdraw USDC in the SUI Community Pool',
      'Unified portfolio view across all products',
      'Real-time risk dashboard + ZK attestation feed',
      'Public APIs (predictions, agent activity, risk overview) — 120 req/min',
      'Pool fees apply (50 bps mgmt + 10% perf via on-chain contract)',
    ],
    targetAudience: 'Crypto-native depositors trying the platform',
    portfolioRange: 'Any',
    poolFeesApply: true,
  },

  retail: {
    tier: 'retail',
    name: 'Retail',
    description: 'Private-hedge access + higher API limits for active traders.',
    priceMonthly: 99,
    priceAnnual: 990, // ~17% discount
    limits: {
      maxAgents: 7,
      availableAgents: ALL_AGENTS,
      zkProofsPerMonth: 25,
      privateHedgesAccess: true,
      maxPrivateHedgePositions: 5,
      privatePortfolioAccess: false,
      maxPrivatePortfolios: 0,
      custodyAttestationAccess: false,
      apiAccess: 'read-only',
      apiRateLimitPerMin: 600,
      dedicatedSupport: false,
      whiteLabel: false,
      recommendedPortfolioCapUsd: 100_000,
    },
    features: [
      'Everything in Free',
      'Private Hedges — open up to 5 confidential perp positions via zk_hedge_commitment.move',
      '25 ZK attestations per month (above quota = per-proof fee)',
      'API: 600 req/min read-only',
      'Email support',
    ],
    targetAudience: 'Active crypto-native traders',
    portfolioRange: '< $100K',
    poolFeesApply: true,
  },

  pro: {
    tier: 'pro',
    name: 'Pro',
    description: 'Private Portfolio Creator + write APIs for sophisticated users and small platforms.',
    priceMonthly: 499,
    priceAnnual: 4990, // ~17% discount
    limits: {
      maxAgents: 7,
      availableAgents: ALL_AGENTS,
      zkProofsPerMonth: -1, // unlimited
      privateHedgesAccess: true,
      maxPrivateHedgePositions: 50,
      privatePortfolioAccess: true,
      maxPrivatePortfolios: 5,
      custodyAttestationAccess: false,
      apiAccess: 'read-write',
      apiRateLimitPerMin: 2000,
      dedicatedSupport: false,
      whiteLabel: false,
      recommendedPortfolioCapUsd: 5_000_000,
    },
    features: [
      'Everything in Retail',
      'Private Portfolio Creator wizard (zk_proxy_vault PDA proxies, time-locked withdrawals)',
      'Up to 5 custom portfolios',
      'Unlimited ZK attestations',
      'Write APIs — open/close hedges, attest decisions, submit consensus tasks',
      'API: 2,000 req/min',
      'Priority email support + advanced analytics',
    ],
    targetAudience: 'Serious traders, family offices, indie Sui builders',
    portfolioRange: '$100K – $5M',
    poolFeesApply: true,
  },

  institutional: {
    tier: 'institutional',
    name: 'Institutional',
    description: 'Custody attestation requests, dedicated support, higher API rate limits.',
    priceMonthly: 2499,
    priceAnnual: 24990, // ~17% discount
    limits: {
      maxAgents: 7,
      availableAgents: ALL_AGENTS,
      zkProofsPerMonth: -1,
      privateHedgesAccess: true,
      maxPrivateHedgePositions: -1,
      privatePortfolioAccess: true,
      maxPrivatePortfolios: -1,
      custodyAttestationAccess: true,
      apiAccess: 'read-write',
      apiRateLimitPerMin: 10000,
      dedicatedSupport: true,
      whiteLabel: false,
      recommendedPortfolioCapUsd: -1,
    },
    features: [
      'Everything in Pro',
      'Unlimited private hedges + private portfolios',
      'Custody attestation request flow (rwa_custody_attestor.move) — coordinate with enrolled custodians',
      'API: 10,000 req/min, full read + write',
      'Dedicated support channel + SLA',
      'Quarterly transparency report with embedded ZK proofs',
    ],
    targetAudience: 'Hedge funds, treasuries, prop trading desks, Sui-ecosystem dApp partners',
    portfolioRange: '> $5M',
    poolFeesApply: true,
  },

  enterprise: {
    tier: 'enterprise',
    name: 'Enterprise',
    description: 'White-label deployment, custom rate limits, on-prem and revenue-share options.',
    priceMonthly: -1, // custom
    priceAnnual: -1,
    limits: {
      maxAgents: 7,
      availableAgents: ALL_AGENTS,
      zkProofsPerMonth: -1,
      privateHedgesAccess: true,
      maxPrivateHedgePositions: -1,
      privatePortfolioAccess: true,
      maxPrivatePortfolios: -1,
      custodyAttestationAccess: true,
      apiAccess: 'read-write',
      apiRateLimitPerMin: -1, // custom
      dedicatedSupport: true,
      whiteLabel: true,
      recommendedPortfolioCapUsd: -1,
    },
    features: [
      'Everything in Institutional',
      'Full white-label of the autonomous risk engine + agent stack',
      'Custom rate limits + dedicated infrastructure',
      'Custody attestor enrollment for your own institutional partners',
      'Optional on-prem deployment of the ZK-STARK prover',
      'Revenue-share + custom SLA terms',
    ],
    targetAudience: 'Funds, treasuries, and platforms running ZKward infrastructure as their own',
    portfolioRange: 'Custom',
    poolFeesApply: true,
  },
};

// ============================================================================
// On-chain fee configuration (consumed by lib/utils/fees.ts and FeeDisplay)
// ============================================================================

export interface OnChainFees {
  hedgeExecutor: {
    feeRateBps: number;
    maxFeeRateBps: number;
    minCollateralUsdc: number;
    description: string;
  };
  performanceFee: {
    feeRatePercent: number;
    highWaterMark: boolean;
    description: string;
  };
  x402Gasless: {
    feePerTransaction: string;
    feePerTransactionUsdc: number;
    description: string;
  };
  oracle: {
    feePerCallTcro: number;
    feeCro: number;
    description: string;
  };
  suiProtocol: {
    feeRateBps: number;
    description: string;
  };
}

/**
 * Live on-chain fee values. Aligned with deployed contracts.
 *
 * `performanceFee.feeRatePercent` was 20% in v1 of this file but the live
 * community_pool_usdc.move uses 10% — corrected here so the docs/UI match
 * the protocol.
 */
export const ON_CHAIN_FEES: OnChainFees = {
  hedgeExecutor: {
    feeRateBps: 10, // 0.1%
    maxFeeRateBps: 100,
    minCollateralUsdc: 1_000_000, // 1 USDC (6 decimals)
    description: 'Platform fee charged on hedge executions via HedgeExecutor.',
  },
  performanceFee: {
    feeRatePercent: 10, // matches POOL_ECONOMICS.performanceFeePercent
    highWaterMark: true,
    description: 'Pool performance fee on profits above the per-share high-water mark.',
  },
  x402Gasless: {
    feePerTransaction: '10000', // 0.01 USDC in 6 decimals
    feePerTransactionUsdc: 0.01,
    description: 'Fee per gasless transaction (sponsored by platform via ZKPaymaster).',
  },
  oracle: {
    feePerCallTcro: 0.06,
    feeCro: 0.06,
    description: 'Oracle fee for legacy Moonlander price feeds (Cronos testnet).',
  },
  suiProtocol: {
    feeRateBps: 50, // matches POOL_ECONOMICS.managementFeeBps
    description: 'Protocol mgmt fee on community_pool_usdc.move operations.',
  },
};

// ============================================================================
// Helper functions (preserved API surface)
// ============================================================================

export function getRecommendedTier(portfolioValueUsd: number): SubscriptionTier {
  if (portfolioValueUsd <= 10000) return 'free';
  if (portfolioValueUsd <= 100000) return 'retail';
  if (portfolioValueUsd <= 5_000_000) return 'pro';
  if (portfolioValueUsd <= 100_000_000) return 'institutional';
  return 'enterprise';
}

export function calculateHedgeFee(collateralUsdc: number): number {
  return (collateralUsdc * ON_CHAIN_FEES.hedgeExecutor.feeRateBps) / 10000;
}

export function calculateSuiProtocolFee(amountUsdc: number): number {
  return (amountUsdc * ON_CHAIN_FEES.suiProtocol.feeRateBps) / 10000;
}

/** Calculate performance fee on pool profits above the high-water mark. */
export function calculatePerformanceFee(
  profitUsdc: number,
  highWaterMark: number = 0,
): { fee: number; netProfit: number; feePercent: number } {
  const feePercent = ON_CHAIN_FEES.performanceFee.feeRatePercent;
  const chargeable = ON_CHAIN_FEES.performanceFee.highWaterMark
    ? Math.max(0, profitUsdc - highWaterMark)
    : profitUsdc;
  const fee = chargeable > 0 ? (chargeable * feePercent) / 100 : 0;
  return { fee, netProfit: profitUsdc - fee, feePercent };
}

export function isFeatureAvailable(tier: SubscriptionTier, feature: keyof TierLimits): boolean {
  const limits = PRICING_TIERS[tier].limits;
  const value = limits[feature];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0 && value !== -1;
  if (typeof value === 'string') return value !== 'none';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function isAgentAvailable(tier: SubscriptionTier, agent: AgentType): boolean {
  return PRICING_TIERS[tier].limits.availableAgents.includes(agent);
}

export function getZkProofsRemaining(tier: SubscriptionTier, usedThisMonth: number): number {
  const limit = PRICING_TIERS[tier].limits.zkProofsPerMonth;
  if (limit === -1) return Infinity;
  return Math.max(0, limit - usedThisMonth);
}

export function formatPrice(price: number): string {
  if (price === 0) return 'Free';
  if (price === -1) return 'Custom';
  return `$${price.toLocaleString()}`;
}

export function getAnnualSavings(tier: SubscriptionTier): number {
  const { priceMonthly, priceAnnual } = PRICING_TIERS[tier];
  if (priceMonthly <= 0 || priceAnnual <= 0) return 0;
  return priceMonthly * 12 - priceAnnual;
}

/**
 * Conservative monthly value estimates per tier (used by the homepage ROI box).
 * Numbers below intentionally bottom-out at small dollar amounts to reflect
 * the current $57 pool NAV and grant-stage growth path — no inflated
 * "$30K/month savings" claims that don't survive due diligence.
 */
export function estimatedMonthlySavings(tier: SubscriptionTier): {
  gasFeeSavings: number;
  laborSavings: number;
  riskMitigation: number;
  total: number;
} {
  switch (tier) {
    case 'pro':
      return { gasFeeSavings: 200, laborSavings: 1500, riskMitigation: 500, total: 2200 };
    case 'institutional':
      return { gasFeeSavings: 1000, laborSavings: 8000, riskMitigation: 3000, total: 12000 };
    case 'enterprise':
      return { gasFeeSavings: 5000, laborSavings: 30000, riskMitigation: 15000, total: 50000 };
    default:
      return { gasFeeSavings: 50, laborSavings: 0, riskMitigation: 100, total: 150 };
  }
}

// ============================================================================
// Three-stream revenue summary (consumed by /pricing page + grant docs)
// ============================================================================

export interface RevenueStreamSummary {
  id: 'pool' | 'premium' | 'subscription';
  label: string;
  blurb: string;
  examples: string[];
  status: 'live' | 'tranche-2' | 'tranche-3';
}

export const REVENUE_STREAMS: RevenueStreamSummary[] = [
  {
    id: 'pool',
    label: 'Pool fees (passive, scales with TVL)',
    blurb:
      '50 bps mgmt + 10% perf charged automatically by the SUI Community Pool contract. No subscription needed; depositors pay these via on-chain accounting.',
    examples: [
      'Live SUI USDC vault: 50 bps annual mgmt',
      '10% of profits above per-share HWM',
      'Fees route to FeeManagerCap on MSafe multisig',
    ],
    status: 'live',
  },
  {
    id: 'premium',
    label: 'Premium product fees (consumption-based)',
    blurb:
      'Pay-per-use fees on the three premium products. Charged at the action that creates value.',
    examples: [
      'Private hedges: $5 or 25 bps of notional per hedge (lower)',
      'Private portfolios: $100 creation + 50 bps annual mgmt',
      'Custody attestations: $2,500 per custodian enrollment + $0.50 per submission',
    ],
    status: 'tranche-2',
  },
  {
    id: 'subscription',
    label: 'Subscriptions (end-user + B2B API)',
    blurb:
      'Free read-only access · Retail $99 (private hedges) · Pro $499 (private portfolios + write APIs) · Institutional $2,499 (custody requests, dedicated support) · Enterprise (white-label).',
    examples: [
      'Free: 120 req/min public APIs',
      'Pro: write APIs (open/close hedges programmatically) — Aladdin-as-a-Service entry tier',
      'Enterprise: white-label the autonomous risk engine',
    ],
    status: 'tranche-2',
  },
];
