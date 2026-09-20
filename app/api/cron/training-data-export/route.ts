import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { query } from '@/lib/db/postgres';
import { setCronState } from '@/lib/db/cron-state';
import { logger } from '@/lib/utils/logger';
import { errMsg } from '@/lib/utils/error-handler';

// L11 — Signal Interpreter training-data exporter (data half of the loop).
//
// The fine-tuned Qwen signal interpreter parses prediction-market titles
// into structured direction/confidence JSON. Its accuracy compounds over
// live trade outcomes but never actually retrains — because model
// retraining requires a GPU that Vercel Fluid Compute doesn't have.
//
// This route closes half of the loop it can: nightly, extract every
// closed paper trade from the last 24h as (signal, actual outcome)
// pairs into a JSONL blob stored in cron_state. The blob is picked up
// by a nightly local GPU job that runs the actual fine-tune training
// against the fresh corpus.
//
// Nothing here retrains anything by itself; it produces the corpus that
// makes retraining possible.
//
// Trigger: daily at 06:00 UTC via jobs.zkward.com schedule
// (add via `curl -X POST $JOBS_URL/v1/schedules ...`).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const EXPORT_KEY = 'training-data:latest-export';
const LOG_LAST_RUN = 'cron:lastRun:training-data-export';

interface HedgeRow {
  order_id: string;
  asset: string;
  side: string;
  realized_pnl: string;
  entry_price: string;
  metadata: unknown;
  created_at: string;
  closed_at: string;
}

interface TrainingSample {
  orderId: string;
  ts: string;
  asset: string;
  side: string;
  realizedPnl: number;
  actualDir: 'UP' | 'DOWN' | 'NEUTRAL';
  attribution: Array<{ key: string; dir: string; wasCorrect: boolean }>;
  mfeUsd: number;
  maeUsd: number;
  wasWin: boolean;
}

export async function GET(request: NextRequest) {
  const auth = await verifyCronRequest(request, 'training-data-export');
  if (auth !== true) return auth;

  const startedAt = Date.now();
  try {
    // Pull every paper trade closed in the last 24h that has attribution
    // metadata. Skip pre-L1 trades — they'd contribute noise, not signal.
    const rows = await query<HedgeRow>(
      `SELECT order_id, asset, side, realized_pnl, entry_price, metadata,
              created_at, closed_at
       FROM hedges
       WHERE order_id LIKE 'paper_%'
         AND status = 'closed'
         AND closed_at > NOW() - INTERVAL '24 hours'
         AND metadata ? 'attribution'
       ORDER BY closed_at ASC`,
    );

    const samples: TrainingSample[] = rows.map((r) => {
      const md = (r.metadata ?? {}) as {
        attribution?: Array<{ key: string; dir: string; wasCorrect: boolean }>;
        mfeUsd?: number;
        maeUsd?: number;
        actualDir?: 'UP' | 'DOWN' | 'NEUTRAL';
      };
      const pnl = Number(r.realized_pnl);
      return {
        orderId: r.order_id,
        ts: r.closed_at,
        asset: r.asset,
        side: r.side,
        realizedPnl: pnl,
        actualDir: md.actualDir ?? 'NEUTRAL',
        attribution: md.attribution ?? [],
        mfeUsd: md.mfeUsd ?? 0,
        maeUsd: md.maeUsd ?? 0,
        wasWin: pnl > 0,
      };
    });

    const winCount = samples.filter((s) => s.wasWin).length;
    const summary = {
      exportedAt: new Date().toISOString(),
      windowHours: 24,
      totalSamples: samples.length,
      wins: winCount,
      losses: samples.length - winCount,
      winRate: samples.length > 0 ? winCount / samples.length : 0,
      elapsedMs: Date.now() - startedAt,
    };

    // Store the JSONL corpus in cron_state under a size-bounded key so
    // the nightly GPU job can fetch it via /api/admin/training-data-latest
    // (which returns the last stored blob).
    await setCronState(EXPORT_KEY, {
      summary,
      samples: samples.slice(0, 500), // cap for cron_state size sanity
    });
    await setCronState(LOG_LAST_RUN, Date.now());

    logger.info('[TrainingDataExport] complete', summary);
    return NextResponse.json({ success: true, ...summary });
  } catch (e) {
    logger.error('[TrainingDataExport] failed', { error: errMsg(e) });
    return NextResponse.json({ success: false, error: errMsg(e) }, { status: 500 });
  }
}
