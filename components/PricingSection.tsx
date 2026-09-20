'use client';

import { useState } from 'react';
import {
  CheckIcon,
  SparklesIcon,
  ShieldCheckIcon,
  BoltIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import { useRouter } from '@/i18n/routing';
import { PRICING_TIERS, getAnnualSavings, type SubscriptionTier } from '@/lib/config/pricing';
interface PricingCardProps {
  tier: SubscriptionTier;
  isAnnual: boolean;
  onSelect: (tier: SubscriptionTier) => void;
}

const TIER_ICONS: Record<SubscriptionTier, typeof SparklesIcon> = {
  free: SparklesIcon,
  retail: BoltIcon,
  pro: ShieldCheckIcon,
  institutional: UserGroupIcon,
  enterprise: UserGroupIcon,
};

const TIER_COLORS: Record<SubscriptionTier, { icon: string; bg: string; border: string }> = {
  free: { icon: 'text-label-tertiary', bg: 'bg-[#86868b]/10', border: 'border-[#86868b]/20' },
  retail: { icon: 'text-[#007AFF]', bg: 'bg-[#007AFF]/10', border: 'border-[#007AFF]/20' },
  pro: { icon: 'text-[#34C759]', bg: 'bg-[#34C759]/10', border: 'border-[#34C759]/30' },
  institutional: { icon: 'text-[#AF52DE]', bg: 'bg-[#AF52DE]/10', border: 'border-[#AF52DE]/20' },
  enterprise: { icon: 'text-[#FF9500]', bg: 'bg-[#FF9500]/10', border: 'border-[#FF9500]/20' },
};

function PricingCard({ tier, isAnnual, onSelect }: PricingCardProps) {
  const tierData = PRICING_TIERS[tier];
  const Icon = TIER_ICONS[tier];
  const colors = TIER_COLORS[tier];
  const isPopular = tier === 'pro';
  const isEnterprise = tier === 'enterprise';

  const price = isAnnual ? tierData.priceAnnual / 12 : tierData.priceMonthly;
  const savings = getAnnualSavings(tier);

  return (
    <div
      className={`relative bg-white rounded-[20px] p-6 lg:p-8 border-2 transition-all hover:shadow-lg ${
        isPopular ? 'border-[#34C759] shadow-md' : colors.border
      }`}
    >
      {/* Popular Badge */}
      {isPopular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="bg-[#34C759] text-white text-xs font-semibold px-3 py-1 rounded-full">
            Most Popular
          </span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 rounded-[10px] ${colors.bg} flex items-center justify-center`}>
          <Icon className={`w-5 h-5 ${colors.icon}`} strokeWidth={1.5} />
        </div>
        <div>
          <h3 className="text-[20px] font-semibold text-[#1d1d1f] tracking-[-0.02em]">
            {tierData.name}
          </h3>
          <p className="text-[13px] text-label-tertiary">{tierData.targetAudience}</p>
        </div>
      </div>

      {/* Price */}
      <div className="mb-6">
        {isEnterprise ? (
          <div className="text-[32px] font-semibold text-[#1d1d1f] tracking-[-0.02em]">Custom</div>
        ) : (
          <>
            <div className="flex items-baseline gap-1">
              <span className="text-[40px] font-semibold text-[#1d1d1f] tracking-[-0.02em]">
                {price === 0 ? 'Free' : `$${Math.round(price)}`}
              </span>
              {price > 0 && <span className="text-[15px] text-label-tertiary">/mo</span>}
            </div>
            {isAnnual && savings > 0 && (
              <p className="text-[13px] text-[#34C759] mt-1">Save ${savings}/year</p>
            )}
          </>
        )}
      </div>

      {/* Description */}
      <p className="text-[15px] text-label-tertiary mb-6 leading-[1.47]">{tierData.description}</p>

      {/* Features */}
      <ul className="space-y-3 mb-8">
        {tierData.features.slice(0, 5).map((feature, index) => (
          <li key={index} className="flex items-start gap-2">
            <CheckIcon className="w-5 h-5 text-[#34C759] flex-shrink-0 mt-0.5" strokeWidth={2} />
            <span className="text-[14px] text-[#1d1d1f] leading-[1.4]">{feature}</span>
          </li>
        ))}
      </ul>

      {/* Limits Summary */}
      <div className="bg-[#f5f5f7] rounded-[12px] p-4 mb-6">
        <div className="grid grid-cols-2 gap-3 text-[13px]">
          <div>
            <span className="text-label-tertiary">AI Agents</span>
            <p className="text-[#1d1d1f] font-medium">
              {tierData.limits.maxAgents === 7 ? 'All 7' : tierData.limits.maxAgents}
            </p>
          </div>
          <div>
            <span className="text-label-tertiary">ZK Proofs</span>
            <p className="text-[#1d1d1f] font-medium">
              {tierData.limits.zkProofsPerMonth === -1
                ? 'Unlimited'
                : `${tierData.limits.zkProofsPerMonth}/mo`}
            </p>
          </div>
          <div>
            <span className="text-label-tertiary">Private hedges</span>
            <p className="text-[#1d1d1f] font-medium">
              {tierData.limits.privateHedgesAccess
                ? tierData.limits.maxPrivateHedgePositions === -1
                  ? 'Unlimited'
                  : `Up to ${tierData.limits.maxPrivateHedgePositions}`
                : '—'}
            </p>
          </div>
          <div>
            <span className="text-label-tertiary">API access</span>
            <p className="text-[#1d1d1f] font-medium capitalize">
              {tierData.limits.apiAccess === 'none' ? '—' : tierData.limits.apiAccess}
              {tierData.limits.apiRateLimitPerMin > 0 && (
                <span className="text-[11px] text-label-tertiary block">
                  {tierData.limits.apiRateLimitPerMin === -1
                    ? 'custom'
                    : `${tierData.limits.apiRateLimitPerMin.toLocaleString()} req/min`}
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* CTA Button */}
      <button
        onClick={() => onSelect(tier)}
        className={`w-full py-3 px-4 rounded-[12px] text-[15px] font-semibold transition-colors ${
          isPopular
            ? 'bg-[#34C759] text-white hover:bg-[#2fb551]'
            : tier === 'free'
              ? 'bg-[#f5f5f7] text-[#1d1d1f] hover:bg-[#e8e8ed]'
              : 'bg-[#007AFF] text-white hover:bg-[#0066d6]'
        }`}
      >
        {tier === 'free'
          ? 'Start Free Trial'
          : tier === 'enterprise'
            ? 'Contact Sales'
            : 'Get Started'}
      </button>
    </div>
  );
}

export function PricingSection() {
  const [isAnnual, setIsAnnual] = useState(true);
  const router = useRouter();

  const handleSelect = (tier: SubscriptionTier) => {
    if (tier === 'enterprise') {
      // No /contact route exists; matches the mailto: pattern used elsewhere
      // (see dashboard/custody/page.tsx enterprise CTA).
      window.location.href =
        'mailto:ashishregmi2017@gmail.com?subject=ZKward%20Enterprise%20plan%20inquiry';
    } else {
      router.push(`/subscribe?tier=${tier}&billing=${isAnnual ? 'annual' : 'monthly'}`);
    }
  };

  const displayTiers: SubscriptionTier[] = ['free', 'retail', 'pro', 'institutional'];

  return (
    <section className="py-16 lg:py-24">
      {/* Header */}
      <div className="text-center mb-12">
        <h2 className="text-[40px] lg:text-[56px] font-semibold text-[#1d1d1f] tracking-[-0.025em] leading-[1.08] mb-4">
          Simple, transparent pricing
        </h2>
        <p className="text-[19px] lg:text-[21px] text-label-tertiary leading-[1.47] max-w-[600px] mx-auto mb-8">
          Choose the plan that fits your portfolio size and trading needs.
        </p>

        {/* Billing Toggle */}
        <div className="inline-flex items-center gap-3 bg-[#f5f5f7] rounded-full p-1">
          <button
            onClick={() => setIsAnnual(false)}
            className={`px-4 py-2 rounded-full text-[14px] font-medium transition-colors ${
              !isAnnual ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-label-tertiary'
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setIsAnnual(true)}
            className={`px-4 py-2 rounded-full text-[14px] font-medium transition-colors ${
              isAnnual ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-label-tertiary'
            }`}
          >
            Annual
            <span className="ml-1 text-[#34C759] text-[12px]">Save 17%</span>
          </button>
        </div>
      </div>

      {/* Pricing Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto px-4">
        {displayTiers.map((tier) => (
          <PricingCard key={tier} tier={tier} isAnnual={isAnnual} onSelect={handleSelect} />
        ))}
      </div>

      {/* Enterprise CTA */}
      <div className="mt-12 text-center">
        <div className="inline-block bg-gradient-to-r from-[#FF9500]/10 to-[#FF3B30]/10 rounded-[16px] p-6 lg:p-8 max-w-2xl">
          <h3 className="text-[24px] font-semibold text-[#1d1d1f] mb-2">Enterprise Solutions</h3>
          <p className="text-[15px] text-label-tertiary mb-4">
            Need a custom solution for your fund, treasury, or platform? Get white-label deployment,
            dedicated support, and custom SLA guarantees.
          </p>
          <button
            onClick={() => handleSelect('enterprise')}
            className="bg-[#FF9500] text-white px-6 py-3 rounded-[12px] text-[15px] font-semibold hover:bg-[#e68600] transition-colors"
          >
            Contact Enterprise Sales
          </button>
        </div>
      </div>
    </section>
  );
}

export default PricingSection;
