/**
 * Pure aggregation math for PredictionAggregatorService. Extracted 2026-09-25.
 * No `this`, no static class state — takes sources in, returns AggregatedPrediction.
 */

import {
  determineRecommendation as determineRecommendationPure,
  calculateSizeMultiplier as calculateSizeMultiplierPure,
} from '@/lib/services/market-data/opportunity-scoring';
import type { PredictionSource, AggregatedPrediction } from './PredictionAggregatorService';

/**
 * Weighted-aggregate a source list into a single directional call.
 *
 * Consensus is fraction of sources AGREEING with the chosen aggregate direction
 * — not majority-dominance regardless of direction. Diagnosed 2026-09-18: the
 * majority-dominance version was returning direction=UP with consensus=57%
 * while the 57% majority actually pointed DOWN (root cause of 22% paper win rate).
 */
export function calculateAggregation(sources: PredictionSource[]): AggregatedPrediction {
  if (sources.length === 0) {
    return {
      direction: 'NEUTRAL',
      confidence: 0,
      probability: 50,
      consensus: 0,
      recommendation: 'WAIT',
      sizeMultiplier: 1.0,
      sources: [],
      reasoning: 'No prediction data available',
      timestamp: Date.now(),
    };
  }

  let directionScore = 0;
  let totalConfidenceWeight = 0;
  let upCount = 0;
  let downCount = 0;

  for (const source of sources) {
    const dirValue = source.direction === 'UP' ? 1 : source.direction === 'DOWN' ? -1 : 0;
    const effectiveWeight = source.weight * (source.confidence / 100);
    directionScore += dirValue * effectiveWeight;
    totalConfidenceWeight += effectiveWeight;

    if (source.direction === 'UP') upCount++;
    else if (source.direction === 'DOWN') downCount++;
  }

  const normalizedDirection = totalConfidenceWeight > 0 ? directionScore / totalConfidenceWeight : 0;

  const direction: 'UP' | 'DOWN' | 'NEUTRAL' =
    normalizedDirection > 0.15 ? 'UP' : normalizedDirection < -0.15 ? 'DOWN' : 'NEUTRAL';

  const totalSources = sources.length;
  const agreeCount = direction === 'UP' ? upCount : direction === 'DOWN' ? downCount : 0;
  const consensus =
    totalSources > 0 && direction !== 'NEUTRAL' ? (agreeCount / totalSources) * 100 : 0;

  const weightedConfidence = sources.reduce((sum, s) => sum + s.confidence * s.weight, 0);
  const weightedProbability = sources.reduce((sum, s) => sum + s.probability * s.weight, 0);

  const recommendation = determineRecommendationPure(
    direction,
    weightedConfidence,
    consensus,
    Math.abs(normalizedDirection),
  );

  const sizeMultiplier = calculateSizeMultiplierPure(
    weightedConfidence,
    consensus,
    Math.abs(normalizedDirection),
  );

  const reasoning = buildReasoning(sources, direction, consensus, recommendation);

  return {
    direction,
    confidence: weightedConfidence,
    probability: weightedProbability,
    consensus,
    recommendation,
    sizeMultiplier,
    sources,
    reasoning,
    timestamp: Date.now(),
  };
}

export function buildReasoning(
  sources: PredictionSource[],
  direction: 'UP' | 'DOWN' | 'NEUTRAL',
  consensus: number,
  recommendation: AggregatedPrediction['recommendation'],
): string {
  const parts: string[] = [];

  if (direction === 'NEUTRAL') {
    parts.push('Mixed signals from prediction markets - no clear direction.');
  } else {
    const upSources = sources.filter((s) => s.direction === 'UP').map((s) => s.name.split(':')[0]);
    const downSources = sources
      .filter((s) => s.direction === 'DOWN')
      .map((s) => s.name.split(':')[0]);

    if (direction === 'DOWN') {
      parts.push(
        `Bearish signals from ${downSources.length} sources (${downSources.slice(0, 3).join(', ')}).`,
      );
    } else {
      parts.push(
        `Bullish signals from ${upSources.length} sources (${upSources.slice(0, 3).join(', ')}).`,
      );
    }
  }

  if (consensus >= 75) parts.push('High consensus among prediction sources.');
  else if (consensus >= 50) parts.push('Moderate consensus - some disagreement between sources.');
  else parts.push('Low consensus - sources are divergent.');

  if (recommendation.includes('STRONG')) {
    parts.push('Strong hedge recommended due to aligned high-confidence signals.');
  } else if (recommendation === 'WAIT') {
    parts.push('Recommend waiting - signals are too weak or mixed.');
  }

  return parts.join(' ');
}
