import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronRequest } from '@/lib/qstash';
import { getCronState } from '@/lib/db/cron-state';

// L11 — Reader for the training-data corpus written by the nightly
// /api/cron/training-data-export.
//
// The local GPU retraining script fetches from here, retrains the
// Qwen signal-interpreter on the fresh corpus, validates against a
// holdout, and — if the new model beats the prior AUROC — deploys.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await verifyCronRequest(request, 'training-data-latest');
  if (auth !== true) return auth;

  const blob = await getCronState<{
    summary: unknown;
    samples: unknown[];
  }>('training-data:latest-export');

  if (!blob) {
    return NextResponse.json({ error: 'no export yet — /api/cron/training-data-export never ran' }, { status: 404 });
  }
  return NextResponse.json(blob);
}
