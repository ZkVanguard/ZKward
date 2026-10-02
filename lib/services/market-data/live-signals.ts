/**
 * Live per-asset signal from the aggregator — the one read behind every
 * "live signal" the dashboard shows (Platform › Risk and Signals › Agents).
 * The Agents view used to render a stored directive snapshot that was last
 * written on 2026-09-22 and label it live, so the two views disagreed.
 */
export interface LiveAssetSignal {
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  confidence: number;
  recommendation: string;
}

export async function getLiveAssetSignals(timeoutMs = 9000): Promise<Record<string, LiveAssetSignal>> {
  const [{ PredictionAggregatorService }, { PAPER_UNIVERSE }] = await Promise.all([
    import('@/lib/services/market-data/PredictionAggregatorService'),
    import('@/lib/services/paper-trader/config'),
  ]);
  // A cold aggregator scan can take ~10 s; a dashboard read must not hang on it.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const preds = await Promise.race([
    PredictionAggregatorService.getPerAssetPredictions(PAPER_UNIVERSE),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);

  const out: Record<string, LiveAssetSignal> = {};
  for (const [asset, p] of Object.entries(preds ?? {})) {
    const dir = String(p.direction || 'NEUTRAL');
    out[asset] = {
      direction: dir === 'UP' || dir === 'DOWN' ? dir : 'NEUTRAL',
      confidence: Math.round(Number(p.confidence) || 0),
      recommendation: String(p.recommendation ?? ''),
    };
  }
  return out;
}
