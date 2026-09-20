'use client';

/**
 * Recent deposit / withdraw activity on the Hedera vault, pulled from
 * Hedera Mirror Node event logs. Replaces the SUI-specific RiskMetrics
 * + AutoHedge panels on the Hedera tab so the layout stays chain-native
 * instead of showing empty BlueFin cards.
 *
 * All data is real chain state via Mirror Node — no DB, no cache other
 * than react-query's 15s stale window.
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { formatUnits, hexToBigInt, keccak256, toHex } from 'viem';
import { ArrowDownRight, ArrowUpRight, ExternalLink, Loader2, Activity } from 'lucide-react';
import { HEDERA_CONTRACT_ADDRESSES } from '@/lib/contracts/addresses';

const HEDERA_ACCENT = '#00A79F';
const USDC_DECIMALS = 6;
const SHARES_DECIMALS = 6;
const POLL_MS = 15_000;

// Event topic hashes for SimpleUsdcVault.
const TOPIC_DEPOSITED = keccak256(toHex('Deposited(address,uint256,uint256)'));
const TOPIC_WITHDRAWN = keccak256(toHex('Withdrawn(address,uint256,uint256)'));

interface MirrorLog {
  data: string;
  topics: string[];
  timestamp: string;
  transaction_hash: string;
}

interface ActivityRow {
  kind: 'deposit' | 'withdraw';
  ts: Date;
  member: string;   // 0x… truncated for display; full below
  memberFull: string;
  amountUsdc: number;
  shares: number;
  txHash: string;
}

function decodeTopic(topic: string): string {
  // Topics are 32-byte hex. For an indexed address, the address is the
  // last 20 bytes with leading zero-padding.
  const stripped = topic.replace(/^0x/, '');
  return '0x' + stripped.slice(-40);
}

function twoWords(data: string): [string, string] {
  const stripped = data.replace(/^0x/, '');
  return [
    '0x' + stripped.slice(0, 64),
    '0x' + stripped.slice(64, 128),
  ];
}

async function fetchLogs(vaultAddress: string): Promise<MirrorLog[]> {
  const base = 'https://testnet.mirrornode.hedera.com/api/v1';
  const url = `${base}/contracts/${vaultAddress}/results/logs?order=desc&limit=25`;
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) return [];
  const j = (await r.json()) as { logs?: MirrorLog[] };
  return j.logs ?? [];
}

function mirrorTsToDate(ts: string): Date {
  const secs = parseInt(ts.split('.')[0] ?? '0', 10);
  return new Date(secs * 1000);
}

function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function truncate(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function HederaRecentActivity() {
  const vault = HEDERA_CONTRACT_ADDRESSES.testnet.communityPool;

  const { data, isPending } = useQuery({
    queryKey: ['hedera-recent-activity', vault],
    queryFn: async () => fetchLogs(vault),
    staleTime: POLL_MS,
    refetchInterval: POLL_MS,
  });

  const rows: ActivityRow[] = useMemo(() => {
    if (!data) return [];
    const out: ActivityRow[] = [];
    for (const log of data) {
      const topic0 = log.topics?.[0];
      if (!topic0) continue;

      if (topic0 === TOPIC_DEPOSITED) {
        // Deposited(address indexed member, uint256 amount, uint256 shares)
        const memberFull = decodeTopic(log.topics[1] ?? '0x0');
        const [amountHex, sharesHex] = twoWords(log.data);
        out.push({
          kind: 'deposit',
          ts: mirrorTsToDate(log.timestamp),
          member: truncate(memberFull),
          memberFull,
          amountUsdc: Number(formatUnits(hexToBigInt(amountHex as `0x${string}`), USDC_DECIMALS)),
          shares: Number(formatUnits(hexToBigInt(sharesHex as `0x${string}`), SHARES_DECIMALS)),
          txHash: log.transaction_hash,
        });
      } else if (topic0 === TOPIC_WITHDRAWN) {
        // Withdrawn(address indexed member, uint256 shares, uint256 amount)
        const memberFull = decodeTopic(log.topics[1] ?? '0x0');
        const [sharesHex, amountHex] = twoWords(log.data);
        out.push({
          kind: 'withdraw',
          ts: mirrorTsToDate(log.timestamp),
          member: truncate(memberFull),
          memberFull,
          amountUsdc: Number(formatUnits(hexToBigInt(amountHex as `0x${string}`), USDC_DECIMALS)),
          shares: Number(formatUnits(hexToBigInt(sharesHex as `0x${string}`), SHARES_DECIMALS)),
          txHash: log.transaction_hash,
        });
      }
    }
    return out.slice(0, 10);
  }, [data]);

  return (
    <div className="p-3 sm:p-4 border-b border-gray-100 dark:border-gray-700">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Activity className="w-4 h-4" style={{ color: HEDERA_ACCENT }} />
        <h3 className="text-sm sm:text-[15px] font-semibold text-label-primary">
          Recent activity
        </h3>
        <span
          className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wide"
          style={{ background: `${HEDERA_ACCENT}15`, color: HEDERA_ACCENT }}
        >
          Live · Mirror Node
        </span>
        {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin text-label-tertiary" />}
      </div>

      {rows.length === 0 ? (
        <div className="text-[12px] text-label-tertiary py-6 text-center">
          No activity yet. First deposit will appear here in seconds.
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.txHash} className="flex items-center gap-2 p-2 rounded-lg bg-system-bg-secondary text-[12px]">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: r.kind === 'deposit' ? '#34C75915' : '#FF3B3015',
                  color: r.kind === 'deposit' ? '#34C759' : '#FF3B30',
                }}
                title={r.kind}
              >
                {r.kind === 'deposit' ? (
                  <ArrowDownRight className="w-3.5 h-3.5" />
                ) : (
                  <ArrowUpRight className="w-3.5 h-3.5" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-semibold text-label-primary text-[12px] capitalize">
                    {r.kind}
                  </span>
                  <span className="text-label-tertiary text-[11px] font-mono truncate">
                    by {r.member}
                  </span>
                </div>
                <div className="text-[10px] text-label-tertiary">
                  {formatRelative(r.ts)} · {r.shares.toFixed(4)} shares
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="tabular-nums font-semibold text-label-primary text-[12px]">
                  ${r.amountUsdc.toFixed(2)}
                </div>
                <a
                  href={`https://hashscan.io/testnet/transaction/${r.txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[10px] text-label-tertiary hover:text-[color:var(--hedera)] transition-colors"
                  style={{ ['--hedera' as string]: HEDERA_ACCENT }}
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
