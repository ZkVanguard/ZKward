import { NextRequest, NextResponse } from 'next/server';
import { DelphiMarketService, type PredictionMarket } from '@/lib/services/market-data/DelphiMarketService';
import { logger } from '@/lib/utils/logger';
import { readLimiter } from '@/lib/security/rate-limiter';

export const runtime = 'nodejs';
export const maxDuration = 15;
export const dynamic = 'force-dynamic';

/**
 * GET /api/predictions?assets=BTC,ETH,CRO
 * Fetch prediction market data for portfolio assets
 */
export async function GET(request: NextRequest) {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  try {
    const { searchParams } = new URL(request.url);
    // An explicit empty list means no assets; only a missing param gets the default.
    const assetsParam = searchParams.has('assets') ? searchParams.get('assets') || '' : 'BTC,ETH,CRO';
    const assets = assetsParam.split(',').map(a => a.trim().toUpperCase()).filter(Boolean);
    const top = Math.min(Number(searchParams.get('top')) || 0, 50);
    
    logger.info('Fetching predictions', top > 0 ? { top } : { assets });
    
    const predictions = top > 0
      ? await DelphiMarketService.getTopMarkets(top)
      : await DelphiMarketService.getRelevantMarkets(assets);
    
    // Analyze predictions
    const analysis = analyzePredictions(predictions, assets);
    
    return NextResponse.json({
      success: true,
      assets,
      predictions,
      analysis,
      timestamp: Date.now(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  } catch (error) {
    logger.error('Failed to fetch predictions', { error: String(error) });
    return NextResponse.json(
      { success: false, error: 'Failed to fetch prediction data', predictions: [] },
      { status: 500 }
    );
  }
}

/**
 * POST /api/predictions
 * Fetch predictions with body { assets: string[] }
 */
export async function POST(request: NextRequest) {
  const limited = readLimiter.check(request);
  if (limited) return limited;

  try {
    const body = await request.json();
    const assets = body.assets || ['BTC', 'ETH', 'CRO'];
    
    logger.info('Fetching predictions for assets (POST)', { assets });
    
    const predictions = await DelphiMarketService.getRelevantMarkets(assets);
    
    // Analyze predictions
    const analysis = analyzePredictions(predictions, assets);
    
    return NextResponse.json({
      success: true,
      assets,
      predictions,
      analysis,
      timestamp: Date.now(),
    });
  } catch (error) {
    logger.error('Failed to fetch predictions', { error: String(error) });
    return NextResponse.json(
      { success: false, error: 'Failed to fetch prediction data', predictions: [] },
      { status: 500 }
    );
  }
}

/**
 * Analyze predictions for risk assessment
 */
function analyzePredictions(predictions: PredictionMarket[], _assets: string[]) {
  const hedgeSignals = predictions.filter(p => p.recommendation === 'HEDGE');
  const highImpact = predictions.filter(p => p.impact === 'HIGH');
  const highProbRisk = predictions.filter(p => p.probability > 70 && p.impact !== 'LOW');
  
  // Calculate overall risk from predictions
  let predictionRiskScore = 0;
  for (const pred of predictions) {
    const impactWeight = pred.impact === 'HIGH' ? 3 : pred.impact === 'MODERATE' ? 2 : 1;
    const probWeight = pred.probability / 100;
    const recWeight = pred.recommendation === 'HEDGE' ? 2 : pred.recommendation === 'MONITOR' ? 1 : 0;
    predictionRiskScore += impactWeight * probWeight * recWeight;
  }
  // Normalize to 0-100
  predictionRiskScore = Math.min(100, Math.round(predictionRiskScore * 5));
  
  // Generate summary
  let summary = '';
  let overallSentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  
  if (hedgeSignals.length >= 2 || predictionRiskScore > 60) {
    summary = `⚠️ HIGH ALERT: ${hedgeSignals.length} hedge signals detected. Prediction markets indicate elevated risk.`;
    overallSentiment = 'bearish';
  } else if (hedgeSignals.length === 1 || predictionRiskScore > 30) {
    summary = `⚡ CAUTION: ${highImpact.length} high-impact events being monitored. Consider defensive positioning.`;
    overallSentiment = hedgeSignals.length > 0 ? 'bearish' : 'neutral';
  } else {
    summary = `✅ STABLE: No major adverse signals. ${predictions.length} markets being monitored.`;
    overallSentiment = 'neutral';
  }
  
  return {
    totalPredictions: predictions.length,
    hedgeSignals: hedgeSignals.length,
    highImpactEvents: highImpact.length,
    highProbabilityRisks: highProbRisk.length,
    predictionRiskScore,
    overallSentiment,
    summary,
    topRisks: hedgeSignals.slice(0, 3).map(p => ({
      question: p.question,
      probability: p.probability,
      impact: p.impact,
    })),
    sources: {
      polymarket: predictions.filter(p => p.source === 'polymarket').length,
      cryptoAnalysis: predictions.filter(p => p.source === 'crypto-analysis').length,
      delphi: predictions.filter(p => p.source === 'delphi').length,
    },
  };
}
