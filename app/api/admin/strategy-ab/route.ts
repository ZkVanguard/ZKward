import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { query } from '@/lib/db/postgres';
import { errMsg } from '@/lib/utils/error-handler';

// L12 — Strategy A/B comparison report.
//
// Compares two portfolio_ids side by side on the metrics that matter:
// win rate, avg win, avg loss, win/loss ratio, sharpe-lite (mean/stddev),
// max drawdown, avg hold time.
//
// Consumers point their variant paper trader (see docs/AB_TESTING.md)
// at a distinct portfolio_id (default: A=-3, B=-4). The trader is
// unchanged; only entry gating + tuning knobs differ per portfolio.
//
// Query params:
//   a=-3         portfolio id for strategy A (default -3, prod paper)
//   b=-4         portfolio id for strategy B (default -4)
//   window=Nd    lookback window in days (default 7)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StrategyStats {
  portfolioId: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
  avgWin: number | null;
  avgLoss: number | null;
  winLossRatio: number | null;
  meanPnl: number | null;
  stddevPnl: number | null;
  sharpeLite: number | null;
  avgHoldMin: number | null;
  maxWin: number | null;
  maxLoss: number | null;
}

async function statsFor(portfolioId: number, windowDays: number): Promise<StrategyStats> {
  const rows = await query<{
    trades: string;
    wins: string;
    losses: string;
    net: string;
    avg_win: string | null;
    avg_loss: string | null;
    mean_pnl: string | null;
    stddev_pnl: string | null;
    avg_hold_min: string | null;
    max_win: string | null;
    max_loss: string | null;
  }>(
    `SELECT
       COUNT(*) AS trades,
       COUNT(*) FILTER (WHERE realized_pnl > 0) AS wins,
       COUNT(*) FILTER (WHERE realized_pnl < 0) AS losses,
       COALESCE(SUM(realized_pnl), 0) AS net,
       AVG(realized_pnl) FILTER (WHERE realized_pnl > 0) AS avg_win,
       AVG(realized_pnl) FILTER (WHERE realized_pnl < 0) AS avg_loss,
       AVG(realized_pnl) AS mean_pnl,
       STDDEV_POP(realized_pnl) AS stddev_pnl,
       AVG(EXTRACT(EPOCH FROM (closed_at - created_at))/60) AS avg_hold_min,
       MAX(realized_pnl) AS max_win,
       MIN(realized_pnl) AS max_loss
     FROM hedges
     WHERE portfolio_id = $1
       AND status = 'closed'
       AND closed_at > NOW() - $2::interval`,
    [portfolioId, `${windowDays} days`],
  );
  const r = rows[0] ?? {};
  const trades = Number(r.trades ?? 0);
  const wins = Number(r.wins ?? 0);
  const losses = Number(r.losses ?? 0);
  const avgWin = r.avg_win != null ? Number(r.avg_win) : null;
  const avgLoss = r.avg_loss != null ? Number(r.avg_loss) : null;
  const meanPnl = r.mean_pnl != null ? Number(r.mean_pnl) : null;
  const stddevPnl = r.stddev_pnl != null ? Number(r.stddev_pnl) : null;
  return {
    portfolioId,
    trades,
    wins,
    losses,
    winRate: trades > 0 ? wins / trades : 0,
    netPnl: Number(r.net ?? 0),
    avgWin,
    avgLoss,
    winLossRatio: avgWin != null && avgLoss != null && avgLoss !== 0
      ? avgWin / Math.abs(avgLoss)
      : null,
    meanPnl,
    stddevPnl,
    sharpeLite: meanPnl != null && stddevPnl && stddevPnl > 0 ? meanPnl / stddevPnl : null,
    avgHoldMin: r.avg_hold_min != null ? Number(r.avg_hold_min) : null,
    maxWin: r.max_win != null ? Number(r.max_win) : null,
    maxLoss: r.max_loss != null ? Number(r.max_loss) : null,
  };
}

export async function GET(request: NextRequest) {
  const auth = await verifyCronRequest(request, 'strategy-ab');
  if (auth !== true) return auth;

  const a = Number(request.nextUrl.searchParams.get('a') ?? -3);
  const b = Number(request.nextUrl.searchParams.get('b') ?? -4);
  const windowDays = Math.max(1, Math.min(365, Number(request.nextUrl.searchParams.get('window') ?? 7)));

  try {
    const [statsA, statsB] = await Promise.all([
      statsFor(a, windowDays),
      statsFor(b, windowDays),
    ]);

    // Head-to-head verdict: which strategy did better on each metric.
    const winner = (metric: keyof StrategyStats, higherIsBetter: boolean): 'A' | 'B' | 'tie' => {
      const av = statsA[metric] as number | null;
      const bv = statsB[metric] as number | null;
      if (av == null || bv == null) return 'tie';
      if (av === bv) return 'tie';
      return higherIsBetter ? (av > bv ? 'A' : 'B') : (av < bv ? 'A' : 'B');
    };

    return NextResponse.json({
      windowDays,
      A: statsA,
      B: statsB,
      verdict: {
        netPnl: winner('netPnl', true),
        winRate: winner('winRate', true),
        winLossRatio: winner('winLossRatio', true),
        sharpeLite: winner('sharpeLite', true),
        maxLoss: winner('maxLoss', true), // less negative wins
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ error: errMsg(e) }, { status: 500 });
  }
}
