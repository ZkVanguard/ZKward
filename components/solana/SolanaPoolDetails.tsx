'use client';

/**
 * Solana pool detail sections for the Pool tab: the trading sleeve and the
 * recent-deposit trail. Styled like the Hedera recent-activity rows so the
 * chains read the same.
 */
import { ArrowDownRight, ExternalLink, Loader2 } from 'lucide-react';
import { explorerAddress, explorerTx, shortAddr, useSolanaPoolStatus } from './status';
import { ChainLogo } from '@/components/wallet/ChainLogo';

const SOLANA_ACCENT = '#9945FF';

const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function relative(iso: string | null): string {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** In place of an empty state when the status read failed with nothing on screen: an outage is not an empty pool. */
function LoadFailed() {
  return (
    <div className="text-[12px] text-red-700 py-6 text-center" role="status">
      Could not load this from the pool right now. Trying again every 30 seconds.
    </div>
  );
}

/** Signal-driven sleeve: what the pool's trading engine is doing right now. */
export function SolanaSleevePanel() {
  const { data, isError } = useSolanaPoolStatus();
  const sleeve = data?.sleeve;
  if (!sleeve) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm sm:text-[15px] font-semibold text-label-primary pool-inner-heading">Trading sleeve</h3>
        {isError && !data ? <LoadFailed /> : <div className="text-[12px] text-label-tertiary">No trading activity yet.</div>}
      </div>
    );
  }
  const pos = sleeve.position;
  const provenCoins = Object.entries(sleeve.evidence ?? {}).filter(([, v]) => v === 'proven').map(([coin]) => coin);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap pool-inner-heading">
        <ChainLogo chain="solana" size={16} label="Solana" />
        <h3 className="text-sm sm:text-[15px] font-semibold text-label-primary">Trading sleeve</h3>
        <span
          className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide"
          style={{ background: `${SOLANA_ACCENT}15`, color: SOLANA_ACCENT }}
        >
          BTC · ETH · SOL
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-system-bg-secondary p-2.5">
          <div className="text-[15px] font-semibold tabular-nums text-label-primary">
            {sleeve.winRatePct != null ? `${sleeve.winRatePct}%` : '—'}
          </div>
          <div className="text-[11px] text-label-tertiary">Win rate</div>
        </div>
        <div className="rounded-xl bg-system-bg-secondary p-2.5">
          <div className="text-[15px] font-semibold tabular-nums text-label-primary">
            {sleeve.wins}/{sleeve.trades - sleeve.wins}
          </div>
          <div className="text-[11px] text-label-tertiary">Wins / losses</div>
        </div>
        <div className="rounded-xl bg-system-bg-secondary p-2.5">
          <div
            className={`text-[15px] font-semibold tabular-nums ${sleeve.pendingBuybackUsd >= 0 ? 'text-green-700' : 'text-red-700'}`}
          >
            {usd(sleeve.pendingBuybackUsd)}
          </div>
          <div className="text-[11px] text-label-tertiary">Realized P&amp;L</div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 rounded-xl bg-system-bg-secondary p-2.5 text-[12px]">
        <span className="text-label-tertiary">Open trade</span>
        {pos ? (
          <span className="tabular-nums text-label-primary">
            {pos.asset}{' '}
            <span className={pos.side === 'LONG' ? 'text-green-700 font-semibold' : 'text-red-700 font-semibold'}>{pos.side}</span>{' '}
            {usd(pos.notionalUsd)}
            {pos.unrealizedPnlUsd != null && (
              <span className={pos.unrealizedPnlUsd >= 0 ? 'text-green-700' : 'text-red-700'}> ({usd(pos.unrealizedPnlUsd)})</span>
            )}
          </span>
        ) : (
          <span className="text-label-secondary">{provenCoins.length ? `None — watching ${provenCoins.join(', ')}` : 'None — waiting for a proven signal'}</span>
        )}
      </div>
      <p className="text-[11px] text-label-tertiary leading-relaxed">
        Opens a trade on BTC, ETH or SOL only after the platform&apos;s signal for that coin has been proven against
        real price moves{provenCoins.length ? '' : '; none is proven yet, so it is not trading'}. Sized to the pool&apos;s
        value, with real trading fees counted. {data?.testnet !== false && 'It is simulated; '}profits would reach the
        vault as token buybacks.
      </p>
    </div>
  );
}

/** Current shareholders from the pool ledger, largest first. */
export function SolanaMembers() {
  const { data, isPending, isError } = useSolanaPoolStatus();
  const rows = data?.members ?? [];
  const total = data?.memberCount ?? rows.length;
  const cluster = data?.cluster ?? 'devnet';
  const price = data?.sharePrice ?? 1;
  return (
    <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
      <div className="flex items-center gap-2 mb-3 flex-wrap pool-inner-heading">
        <ChainLogo chain="solana" size={16} label="Solana" />
        <h3 className="text-sm sm:text-[15px] font-semibold text-label-primary">Members</h3>
        {total > rows.length && <span className="text-[11px] text-label-tertiary">top {rows.length} of {total}</span>}
        {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-label-tertiary" />}
      </div>
      {isError && !data ? (
        <LoadFailed />
      ) : rows.length === 0 ? (
        <div className="text-[12px] text-label-tertiary py-6 text-center">
          {isPending ? 'Loading members…' : 'No members yet. Your first deposit makes you one.'}
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((m, i) => (
            <div key={m.wallet} className="flex items-center gap-2 p-2 rounded-lg bg-system-bg-secondary text-[12px]">
              <span className="w-5 text-center tabular-nums text-label-tertiary flex-shrink-0">{i + 1}</span>
              <a
                href={explorerAddress(m.wallet, cluster)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 inline-flex items-center gap-1 font-mono text-label-primary hover:underline truncate"
              >
                {shortAddr(m.wallet)} <ExternalLink className="w-2.5 h-2.5 flex-shrink-0 text-label-tertiary" />
              </a>
              <div className="text-right flex-shrink-0">
                <div className="tabular-nums font-semibold text-label-primary">
                  {(m.shares * price).toLocaleString(undefined, { maximumFractionDigits: 2 })} JIMP
                </div>
                <div className="text-[10px] text-label-tertiary tabular-nums">
                  {m.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })} shares · {m.percentage.toFixed(2)}%
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** On-chain deposit trail, newest first. */
export function SolanaRecentActivity() {
  const { data, isPending, isError } = useSolanaPoolStatus();
  const rows = data?.recentDeposits ?? [];
  const cluster = data?.cluster ?? 'devnet';
  return (
    <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
      <div className="flex items-center gap-2 mb-3 flex-wrap pool-inner-heading">
        <ChainLogo chain="solana" size={16} label="Solana" />
        <h3 className="text-sm sm:text-[15px] font-semibold text-label-primary">Recent activity</h3>
        <span
          className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide"
          style={{ background: `${SOLANA_ACCENT}15`, color: SOLANA_ACCENT }}
        >
          Live · on-chain
        </span>
        {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-label-tertiary" />}
      </div>
      {isError && !data ? (
        <LoadFailed />
      ) : rows.length === 0 ? (
        <div className="text-[12px] text-label-tertiary py-6 text-center">
          {isPending ? 'Loading deposits…' : 'No deposits yet. The first one shows up here within a minute.'}
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.signature} className="flex items-center gap-2 p-2 rounded-lg bg-system-bg-secondary text-[12px]">
              <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 bg-[#34C759]/10 text-[#34C759]">
                <ArrowDownRight className="w-3.5 h-3.5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-label-primary">Deposit</span>
                  <span className="text-label-tertiary text-[11px] font-mono truncate">by {shortAddr(r.sender)}</span>
                </div>
                <div className="text-[10px] text-label-tertiary">
                  {relative(r.blockTime)} · {r.shares.toLocaleString(undefined, { maximumFractionDigits: 2 })} shares
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="tabular-nums font-semibold text-label-primary">
                  {r.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} JIMP
                </div>
                <a
                  href={explorerTx(r.signature, cluster)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] text-label-tertiary hover:text-label-primary"
                >
                  tx <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
