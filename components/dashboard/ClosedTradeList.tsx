'use client';

/**
 * Closed trades as a list that fits any width: what was traded and which
 * way, why and when it closed, and the result. Replaces two wide tables
 * that scrolled sideways on phones (the paper page's eight columns and the
 * Platform track record).
 */

import { useTranslations } from 'next-intl';

export interface ClosedTrade {
  id: string | number;
  market: string;
  side: string;
  pnlUsd: number;
  notionalUsd: number;
  closedAt: string;
  /** Raw close reason as the books write it ("… | close: take-profit: …"). */
  reason?: string;
  heldHours?: number;
  entryPrice?: number;
}

const REASONS: Array<[RegExp, string]> = [
  [/take-profit/, 'takeProfit'],
  [/trailing/, 'trailingStop'],
  [/stop/, 'stop'],
  [/max-hold|time/, 'timeLimit'],
  [/flip/, 'signalFlip'],
];

function reasonKey(raw?: string): string | null {
  if (!raw) return null;
  const last = (raw.split('|').pop() ?? raw).toLowerCase();
  return REASONS.find(([re]) => re.test(last))?.[1] ?? null;
}

const money = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1000 ? a.toLocaleString(undefined, { maximumFractionDigits: 0 }) : a.toFixed(2);
  return `$${s}`;
};

export function ClosedTradeList({ trades, empty }: { trades: ClosedTrade[]; empty: string }) {
  const t = useTranslations('dashboard.trades');
  if (trades.length === 0) return <p className="py-6 text-center text-[13px] text-label-tertiary">{empty}</p>;
  return (
    <ul className="divide-y divide-black/5">
      {trades.map((tr) => {
        const up = tr.pnlUsd >= 0;
        const long = tr.side.toUpperCase() === 'LONG';
        const reason = reasonKey(tr.reason);
        const when = new Date(tr.closedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const detail = [reason ? t(`reasons.${reason}`) : null, when, tr.heldHours != null ? t('held', { h: tr.heldHours.toFixed(1) }) : null]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={tr.id} className="flex items-center gap-3 py-3 min-w-0">
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-[#f5f5f7] text-[11px] font-bold text-label-primary">
              {tr.market.replace(/-PERP$/i, '').slice(0, 4)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-semibold text-label-primary">{tr.market}</span>
                <span className={`flex-shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${long ? 'bg-green-700/10 text-green-800' : 'bg-red-700/10 text-red-800'}`}>
                  {long ? t('long') : t('short')}
                </span>
              </div>
              <p className="truncate text-[12px] text-label-tertiary">{detail}</p>
            </div>
            <div className="flex-shrink-0 text-right">
              <div className={`text-[15px] font-semibold tabular-nums ${up ? 'text-green-700' : 'text-red-700'}`}>
                {up ? '+' : '−'}
                {money(tr.pnlUsd)}
              </div>
              <div className="text-[12px] tabular-nums text-label-tertiary">
                {money(tr.notionalUsd)}
                {tr.entryPrice != null && <span className="hidden sm:inline"> · {t('entry', { price: tr.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 4 }) })}</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
