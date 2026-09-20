import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { query } from '@/lib/db/postgres';
import { errMsg } from '@/lib/utils/error-handler';

// L3 — Per-source PnL attribution report.
//
// Reads hedges.metadata.attribution[] (written by PaperTrader.closeAtMark
// in the L1 shipping) and groups by (source, asset, side) to score which
// signal sources actually predicted correctly.
//
// This is the read-side foundation for:
//   • L4 — signal-decay auto-disable (kills sources whose recent win-rate
//     collapses below 48%).
//   • L5 — Bayesian source weight updater (Beta-posterior over these
//     win/loss counts).
//   • Human tuning — operator can see at a glance which sources earn
//     their weight.
//
// Query params:
//   window=Nd  — attribution window in days (default 7). Rolling window
//                keeps the report responsive to recent regime shifts
//                instead of averaging over ancient trades.
//   asset=BTC  — optional filter.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AttributionRow {
  key: string;
  dir: 'UP' | 'DOWN' | 'NEUTRAL';
  wasCorrect: boolean;
}

interface SourceScore {
  source: string;
  trades: number;
  correct: number;
  incorrect: number;
  winRate: number;
  netPnl: number;
  avgPnl: number;
}

export async function GET(request: NextRequest) {
  const auth = await verifyCronRequest(request, 'source-attribution');
  if (auth !== true) return auth;

  const windowDays = Math.max(1, Math.min(365, Number(request.nextUrl.searchParams.get('window') ?? 7)));
  const assetFilter = request.nextUrl.searchParams.get('asset')?.toUpperCase() || null;

  try {
    const params: unknown[] = [`${windowDays} days`];
    let filterSql = '';
    if (assetFilter) {
      params.push(assetFilter);
      filterSql = `AND asset = $2`;
    }
    const rows = await query<{ realized_pnl: string; metadata: unknown }>(
      `SELECT realized_pnl, metadata
       FROM hedges
       WHERE order_id LIKE 'paper_%'
         AND status = 'closed'
         AND closed_at > NOW() - $1::interval
         AND metadata ? 'attribution'
         ${filterSql}`,
      params,
    );

    // Aggregate: per source key, count correct/incorrect and sum the trade's
    // realized PnL. A source's "PnL contribution" is its share of trades where
    // it was on the winning side — imperfect but directional.
    const scores = new Map<string, SourceScore>();
    for (const row of rows) {
      const pnl = Number(row.realized_pnl);
      const md = row.metadata as { attribution?: AttributionRow[] } | null;
      const attr = md?.attribution ?? [];
      for (const a of attr) {
        if (a.dir === 'NEUTRAL') continue; // NEUTRAL is a no-op, ignore
        const s = scores.get(a.key) ?? {
          source: a.key,
          trades: 0,
          correct: 0,
          incorrect: 0,
          winRate: 0,
          netPnl: 0,
          avgPnl: 0,
        };
        s.trades += 1;
        if (a.wasCorrect) s.correct += 1;
        else s.incorrect += 1;
        s.netPnl += pnl;
        scores.set(a.key, s);
      }
    }
    for (const s of scores.values()) {
      s.winRate = s.trades > 0 ? s.correct / s.trades : 0;
      s.avgPnl = s.trades > 0 ? s.netPnl / s.trades : 0;
    }
    const sorted = Array.from(scores.values()).sort((a, b) => b.netPnl - a.netPnl);

    return NextResponse.json({
      windowDays,
      asset: assetFilter,
      totalTradesInWindow: rows.length,
      sources: sorted,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
