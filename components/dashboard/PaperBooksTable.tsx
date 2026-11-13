'use client';

/**
 * Every paper book in one table, from its rows: running or off, closed trades
 * over 30 days, open positions at their mark, and the assumed interest kept
 * apart from the trading result. Shown on the paper page and the dashboard's
 * paper panel, so the books that hold money are visible, not only the signal book.
 */
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { paperBooksQuery } from '@/lib/hooks/paper-status-query';
import { SkeletonBox } from '@/components/dashboard/community-pool/Skeletons';
import type { PaperBookSummary } from '@/lib/types/paper-books';

interface BooksResp {
  windowHours: number;
  books: PaperBookSummary[];
}

const usd = (n: number) => `${n < 0 ? '−' : ''}${Math.abs(n).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`;
const tone = (n: number) => (n > 0.5 ? 'text-green-700' : n < -0.5 ? 'text-red-700' : 'text-label-secondary');

/** Trading result: what closed plus what is open at its mark. Interest is never part of it. */
export function tradingResultUsd(b: Pick<PaperBookSummary, 'closed' | 'open'>): number {
  return b.closed.realizedUsd + b.open.openPnlUsd;
}

export function PaperBooksTable() {
  const t = useTranslations('paperBooks');
  const { data, isLoading, error } = useQuery(paperBooksQuery<BooksResp>());

  if (isLoading && !data) return <SkeletonBox className="h-72 rounded-2xl" />;
  if (!data) {
    return (
      <div className="p-4 rounded-2xl bg-white border border-black/5 text-sm text-red-700">
        {t('error', { error: error instanceof Error ? error.message : 'unknown' })}
      </div>
    );
  }

  const books = data.books;
  const tradingTotal = books.reduce((s, b) => s + tradingResultUsd(b), 0);
  const interestTotal = books.reduce((s, b) => s + (b.interestUsd ?? 0), 0);

  return (
    <section className="p-4 sm:p-5 rounded-2xl bg-white border border-black/5" aria-labelledby="paper-books-title">
      <h2 id="paper-books-title" className="text-callout font-semibold text-label-primary">{t('title')}</h2>
      <p className="text-sm text-label-secondary mt-1">{t('subtitle')}</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm tabular-nums">
          <thead>
            <tr className="text-left text-caption-1 uppercase tracking-wide text-label-tertiary">
              <th className="py-2 pr-3 font-medium">{t('book')}</th>
              <th className="py-2 pr-3 font-medium">{t('status')}</th>
              <th className="py-2 pr-3 font-medium text-right">{t('trades')}</th>
              <th className="py-2 pr-3 font-medium text-right">{t('booked')}</th>
              <th className="py-2 pr-3 font-medium text-right">{t('open')}</th>
              <th className="py-2 pr-3 font-medium text-right">{t('interest')}</th>
              <th className="py-2 font-medium text-right">{t('result')}</th>
            </tr>
          </thead>
          <tbody>
            {books.map((b) => {
              const result = tradingResultUsd(b);
              return (
                <tr key={b.portfolioId} className="border-t border-black/5 align-top">
                  <td className="py-2 pr-3">
                    <div className="font-medium text-label-primary">{b.name}</div>
                    <div className="text-xs text-label-tertiary">{t(`tests.b${-b.portfolioId}`)}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className={b.running ? 'text-green-700 font-medium' : 'text-label-tertiary'}>{b.running ? t('running') : t('off')}</span>
                  </td>
                  <td className="py-2 pr-3 text-right">{b.closed.trades}</td>
                  <td className={`py-2 pr-3 text-right ${tone(b.closed.realizedUsd)}`}>{b.closed.trades ? usd(b.closed.realizedUsd) : '—'}</td>
                  <td className="py-2 pr-3 text-right">
                    {b.open.positions ? (
                      <>
                        <div className={tone(b.open.openPnlUsd)}>{usd(b.open.openPnlUsd)}</div>
                        <div className="text-xs text-label-tertiary">{t('openOn', { notional: usd(b.open.notionalUsd) })}</div>
                      </>
                    ) : (
                      <span className="text-label-tertiary">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right text-label-secondary">{b.interestUsd !== undefined ? usd(b.interestUsd) : '—'}</td>
                  <td className={`py-2 text-right font-semibold ${tone(result)}`}>{usd(result)}</td>
                </tr>
              );
            })}
            <tr className="border-t-2 border-black/10 font-semibold">
              <td className="py-2 pr-3 text-label-primary" colSpan={5}>{t('total')}</td>
              <td className="py-2 pr-3 text-right text-label-secondary">{usd(interestTotal)}</td>
              <td className={`py-2 text-right ${tone(tradingTotal)}`}>{usd(tradingTotal)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-label-tertiary mt-3">{t('note')}</p>
    </section>
  );
}
