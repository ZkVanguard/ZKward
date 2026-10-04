'use client';

/**
 * Risk first: how the vault is protected, in four safeguards that are live in
 * production (signal ledger scoring, profit-lock and halt gates, the
 * contract's deposit cap, on-chain records), and a live line read from the
 * production health check saying how many protections are switched on right
 * now. A dark band so it reads as the vault itself; the contrast line evokes
 * the big funds without naming anyone.
 */

import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Eye, Gauge, Lock, Users } from 'lucide-react';
import { Reveal } from '../ui/landing';

const ITEMS = [
  { key: 'crowd', Icon: Users, tint: 'from-[#5AC8FA] to-ios-blue' },
  { key: 'brakes', Icon: Gauge, tint: 'from-[#30D158] to-[#34C759]' },
  { key: 'limits', Icon: Lock, tint: 'from-[#FFD60A] to-[#FF9F0A]' },
  { key: 'open', Icon: Eye, tint: 'from-[#BF5AF2] to-[#AF52DE]' },
] as const;

interface Gates {
  portfolioDriverExecute: boolean;
  staleHedgeAutoClose: boolean;
  alertResponseExecute: boolean;
  alertResponseExecuteHalt: boolean;
  profitLockDisable: boolean;
}

/** The execution protections the health check reports, as on/off. */
function protections(g: Gates): boolean[] {
  return [g.portfolioDriverExecute, g.staleHedgeAutoClose, g.alertResponseExecute, g.alertResponseExecuteHalt, !g.profitLockDisable];
}

function LiveProtections() {
  const t = useTranslations('landing.safeguards');
  const { data } = useQuery({
    queryKey: ['health-gates'],
    queryFn: async (): Promise<Gates> => {
      const r = await fetch('/api/health/production');
      if (!r.ok) throw new Error(`health ${r.status}`);
      const j = (await r.json()) as { gates?: Gates };
      if (!j.gates) throw new Error('no gates');
      return j.gates;
    },
    staleTime: 60_000,
  });
  // The homepage shows this line only when every protection is on, read live.
  // Anything less (or a failed read) leaves it out; the dashboard's Platform
  // view carries the full detail.
  if (!data) return null;
  const list = protections(data);
  const on = list.filter(Boolean).length;
  if (on !== list.length) return null;
  return (
    <div className="mb-10 sm:mb-14 flex justify-center">
      <span className="inline-flex items-center gap-2.5 rounded-full border border-[#30D158]/40 bg-[#30D158]/10 px-4 h-9 text-[13px] font-semibold text-[#7CF2A4]">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-[#30D158] opacity-70 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-[#30D158]" />
        </span>
        {t('live', { on, total: list.length })}
      </span>
    </div>
  );
}

export function Safeguards() {
  const t = useTranslations('landing.safeguards');
  return (
    <section className="relative overflow-hidden px-4 sm:px-5 lg:px-8 py-20 sm:py-28 bg-[#070C18] text-white min-w-0">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(45% 60% at 15% 0%, rgba(0,105,217,0.38) 0%, transparent 70%), radial-gradient(40% 55% at 90% 100%, rgba(48,209,88,0.16) 0%, transparent 70%)' }}
      />
      {/* A faint grid: the vault's ledger lines. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)', backgroundSize: '56px 56px', maskImage: 'radial-gradient(70% 70% at 50% 40%, black, transparent)', WebkitMaskImage: 'radial-gradient(70% 70% at 50% 40%, black, transparent)' }}
      />
      <Reveal className="relative max-w-[1100px] mx-auto">
        <div className="text-center mb-10 sm:mb-12">
          <p className="text-[11px] sm:text-caption-1 font-semibold uppercase tracking-[0.18em] text-[#5AC8FA] mb-4">{t('eyebrow')}</p>
          <h2 className="text-[34px] sm:text-[52px] md:text-[64px] font-display font-semibold tracking-[-0.04em] leading-[1.0]">
            {t('title1')}
            <br />
            <span className="text-[#64D2FF]">{t('title2')}</span>
          </h2>
          <p className="mt-5 text-[17px] sm:text-[20px] text-white/70">{t('contrast')}</p>
        </div>
        <LiveProtections />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {ITEMS.map(({ key, Icon, tint }) => (
            <div key={key} className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur p-5 sm:p-6 hover:bg-white/[0.07] hover:border-white/20 hover:-translate-y-0.5 transition-all">
              <span className={`mb-4 inline-flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br ${tint} text-white shadow-[0_8px_20px_-8px_rgba(0,0,0,0.6)]`}>
                <Icon className="w-5 h-5" strokeWidth={2.25} />
              </span>
              <h3 className="text-[17px] font-semibold tracking-[-0.01em]">{t(`${key}.title`)}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-white/65">{t(`${key}.body`)}</p>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
